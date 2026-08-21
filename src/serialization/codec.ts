import type { Expr, SelectStmt, Statement } from "../ast/nodes.ts";
import { registerCodec } from "../api/database.ts";
import { PostgresError } from "../errors/error.ts";
import type { Clock } from "../runtime/clock.ts";
import type { Prng } from "../runtime/prng.ts";
import {
  type ColumnMeta,
  type ConstraintMeta,
  DatabaseState,
  type DomainData,
  type EnumData,
  type FunctionData,
  type IndexMeta,
  SchemaData,
  type SequenceData,
  TableData,
  type TriggerMeta,
  type ViewData,
} from "../storage/database-state.ts";
import type { Interval } from "../types/datetime.ts";
import { parseJsonText } from "../types/jsonb.ts";
import { jsonbText } from "../types/jsonb.ts";
import type { Numeric } from "../types/numeric.ts";
import type { Datum, PgArray, PgRecord, TypeId } from "../types/value.ts";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const utf8Encode = (s: string): Uint8Array => TEXT_ENCODER.encode(s);
const utf8Decode = (b: Uint8Array): string => TEXT_DECODER.decode(b);

const MAGIC = utf8Encode("PGMM");
/** Snapshot format v1: settings + schemas (tables/rows, views, sequences, enums, domains, functions, indexes) + PRNG state + clock ms. */
const VERSION = 1;

/** PRNG + clock captured alongside catalog/rows in a snapshot. */
export interface SnapshotRuntime {
  /** Unsigned 64-bit {@link Prng} state. */
  prngState: bigint;
  /** Clock instant as milliseconds since Unix epoch. */
  nowMs: number;
}

/** Result of {@link decodeDatabaseState}. */
export interface DecodedSnapshot {
  /** Restored catalog and table data. */
  state: DatabaseState;
  runtime: SnapshotRuntime | null;
}

// --- binary writer / reader ---------------------------------------------------

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(needed: number): void {
    if (this.len + needed <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }
  u32(value: number): void {
    this.ensure(4);
    this.buf[this.len++] = value & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = (value >>> 16) & 0xff;
    this.buf[this.len++] = (value >>> 24) & 0xff;
  }
  i32(value: number): void {
    this.u32(value | 0);
  }
  u64(value: bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
    this.raw(bytes);
  }
  i64(value: bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    this.raw(bytes);
  }
  f64(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.raw(bytes);
  }
  raw(value: Uint8Array): void {
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
  }
  text(value: string): void {
    const bytes = utf8Encode(value);
    this.u32(bytes.length);
    this.raw(bytes);
  }
  json(value: unknown): void {
    this.text(JSON.stringify(value, jsonReplacer) ?? "null");
  }
  datum(value: Datum): void {
    if (value === null) {
      this.u8(0);
      return;
    }
    if (typeof value === "boolean") {
      this.u8(1);
      this.u8(value ? 1 : 0);
      return;
    }
    if (typeof value === "number") {
      this.u8(2);
      this.f64(value);
      return;
    }
    if (typeof value === "bigint") {
      this.u8(3);
      this.i64(value);
      return;
    }
    if (typeof value === "string") {
      this.u8(4);
      this.text(value);
      return;
    }
    if (value instanceof Uint8Array) {
      this.u8(5);
      this.u32(value.length);
      this.raw(value);
      return;
    }
    switch (value.kind) {
      case "numeric": {
        this.u8(6);
        this.text(value.coef.toString());
        this.u32(value.dscale);
        this.u8(value.special === null ? 0 : value.special === "nan" ? 1 : value.special === "inf" ? 2 : 3);
        return;
      }
      case "interval": {
        this.u8(7);
        this.i32(value.months);
        this.i32(value.days);
        this.i64(value.micros);
        return;
      }
      case "pgarray": {
        this.u8(8);
        this.text(value.elem);
        this.u32(value.dims.length);
        for (const d of value.dims) this.i32(d);
        for (const l of value.lbs) this.i32(l);
        this.u32(value.items.length);
        for (const item of value.items) this.datum(item);
        return;
      }
      case "pgrecord": {
        this.u8(9);
        this.json(value.types);
        this.json(value.names ?? null);
        this.u32(value.values.length);
        for (const item of value.values) this.datum(item);
        return;
      }
      case "jsonb": {
        // canonical jsonb text round-trips numeric scale via parseJsonText
        this.u8(10);
        this.text(jsonbText(value.value));
        return;
      }
      default: {
        // timetz datums are stored as { micros, offsetSec } objects
        const tz = value as unknown as { micros?: bigint; offsetSec?: number };
        if (typeof tz.micros === "bigint" && typeof tz.offsetSec === "number") {
          this.u8(11);
          this.i64(tz.micros);
          this.i32(tz.offsetSec);
          return;
        }
        throw snapshotError();
      }
    }
  }
  finish(): Uint8Array {
    if (this.len === this.buf.length) return this.buf;
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u8(): number {
    if (this.offset >= this.bytes.length) this.fail();
    return this.bytes[this.offset++]!;
  }
  u32(): number {
    if (this.offset + 4 > this.bytes.length) this.fail();
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return value;
  }
  i32(): number {
    return this.u32() | 0;
  }
  u64(): bigint {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }
  i64(): bigint {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
  }
  f64(): number {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }
  raw(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) this.fail();
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string {
    return utf8Decode(this.raw(this.u32()));
  }
  json<T>(): T {
    try {
      return JSON.parse(this.text(), jsonReviver) as T;
    } catch {
      throw snapshotError();
    }
  }
  datum(): Datum {
    const tag = this.u8();
    switch (tag) {
      case 0:
        return null;
      case 1:
        return this.u8() !== 0;
      case 2:
        return this.f64();
      case 3:
        return this.i64();
      case 4:
        return this.text();
      case 5:
        return this.raw(this.u32());
      case 6: {
        const coef = BigInt(this.text());
        const dscale = this.u32();
        const specialTag = this.u8();
        const special = specialTag === 0 ? null : specialTag === 1 ? "nan" : specialTag === 2 ? "inf" : "-inf";
        return { kind: "numeric", coef, dscale, special } satisfies Numeric;
      }
      case 7: {
        const months = this.i32();
        const days = this.i32();
        const micros = this.i64();
        return { kind: "interval", months, days, micros } satisfies Interval;
      }
      case 8: {
        const elem = this.text() as TypeId;
        const ndims = this.u32();
        const dims: number[] = [];
        for (let i = 0; i < ndims; i++) dims.push(this.i32());
        const lbs: number[] = [];
        for (let i = 0; i < ndims; i++) lbs.push(this.i32());
        const count = this.u32();
        const items: Datum[] = [];
        for (let i = 0; i < count; i++) items.push(this.datum());
        return { kind: "pgarray", elem, dims, lbs, items } satisfies PgArray;
      }
      case 9: {
        const types = this.json<TypeId[]>();
        const names = this.json<string[] | null>();
        const count = this.u32();
        const values: Datum[] = [];
        for (let i = 0; i < count; i++) values.push(this.datum());
        const rec: PgRecord = names ? { kind: "pgrecord", types, values, names } : { kind: "pgrecord", types, values };
        return rec;
      }
      case 10:
        return { kind: "jsonb", value: parseJsonText(this.text()) };
      case 11: {
        const micros = this.i64();
        const offsetSec = this.i32();
        return { micros, offsetSec } as unknown as Datum;
      }
      default:
        this.fail();
    }
  }
  remaining(): number {
    return this.bytes.length - this.offset;
  }
  done(): boolean {
    return this.offset === this.bytes.length;
  }
  private fail(): never {
    throw snapshotError();
  }
}

// --- schema object metadata (JSON with bigint/bytes tagging) ------------------

interface TableMetaJson {
  name: string;
  schema: string;
  columns: ColumnMeta[];
  constraints: ConstraintMeta[];
  triggers: TriggerMeta[];
  temp: boolean;
  oid: number;
}

interface ViewMetaJson {
  name: string;
  schema: string;
  query: SelectStmt;
  columns: string[] | null;
  materialized: boolean;
  matColumns: Array<{ name: string; type: TypeId }> | null;
  temp: boolean;
  oid: number;
}

interface FunctionMetaJson {
  name: string;
  schema: string;
  argNames: (string | null)[];
  argTypes: TypeId[];
  argDefaults: (Expr | null)[];
  returns: TypeId | null;
  returnsSet: boolean;
  returnsTable: Array<{ name: string; type: TypeId }> | null;
  language: string;
  body: Statement[] | null;
  rawBody: string | null;
  strict: boolean;
  oid: number;
}

// --- encode --------------------------------------------------------------------

/**
 * Encode catalog, rows, and runtime into a postgres-mem `PGMM` snapshot blob
 * (not an on-disk PostgreSQL format).
 *
 * Prefer {@link Database.snapshot} unless you are serializing engine state directly.
 */
export function encodeDatabaseState(state: DatabaseState, runtime: SnapshotRuntime): Uint8Array {
  const w = new Writer();
  w.raw(MAGIC);
  w.u32(VERSION);
  w.u32((state as unknown as { oidCounter: number }).oidCounter);
  w.u32(state.changes);
  // session settings, sorted for byte-identical snapshots
  const settings = [...state.settings.entries()].sort((a, b) => compareNames(a[0], b[0]));
  w.u32(settings.length);
  for (const [k, v] of settings) {
    w.text(k);
    w.text(v);
  }
  const schemas = [...state.schemas.values()].sort((a, b) => compareNames(a.name, b.name));
  w.u32(schemas.length);
  for (const schema of schemas) {
    w.text(schema.name);
    w.u32(schema.oid);

    const tables = sortedValues(schema.tables);
    w.u32(tables.length);
    for (const t of tables) {
      w.json({
        name: t.name,
        schema: t.schema,
        columns: t.columns,
        constraints: t.constraints,
        triggers: t.triggers,
        temp: t.temp,
        oid: t.oid,
      } satisfies TableMetaJson);
      w.u32(t.rows.length);
      for (const row of t.rows) {
        w.u32(row.length);
        for (const d of row) w.datum(d);
      }
    }

    const views = sortedValues(schema.views);
    w.u32(views.length);
    for (const v of views) {
      w.json({
        name: v.name,
        schema: v.schema,
        query: v.query,
        columns: v.columns,
        materialized: v.materialized,
        matColumns: v.matColumns,
        temp: v.temp,
        oid: v.oid,
      } satisfies ViewMetaJson);
      if (v.matRows === null) {
        w.u8(0);
      } else {
        w.u8(1);
        w.u32(v.matRows.length);
        for (const row of v.matRows) {
          w.u32(row.length);
          for (const d of row) w.datum(d);
        }
      }
    }

    const sequences = sortedValues(schema.sequences);
    w.u32(sequences.length);
    for (const s of sequences) w.json(s);

    const enums = sortedValues(schema.enums);
    w.u32(enums.length);
    for (const e of enums) w.json(e);

    const domains = sortedValues(schema.domains);
    w.u32(domains.length);
    for (const d of domains) w.json(d);

    const functionKeys = [...schema.functions.keys()].sort(compareNames);
    w.u32(functionKeys.length);
    for (const key of functionKeys) {
      w.text(key);
      const overloads = schema.functions.get(key)!;
      w.u32(overloads.length);
      for (const f of overloads) w.json(f satisfies FunctionMetaJson);
    }

    const indexes = sortedValues(schema.indexes);
    w.u32(indexes.length);
    for (const idx of indexes) w.json(idx);
  }
  if (state.lastSequence === null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.text(state.lastSequence.schema);
    w.text(state.lastSequence.name);
  }
  w.u64(runtime.prngState);
  w.i64(BigInt(Math.trunc(runtime.nowMs)));
  return w.finish();
}

// --- decode --------------------------------------------------------------------

/**
 * Decode a blob from {@link encodeDatabaseState} / {@link Database.snapshot}.
 *
 * @throws {PostgresError} If the magic, version, or payload is invalid.
 */
export function decodeDatabaseState(snapshot: Uint8Array, prng: Prng, clock: Clock): DecodedSnapshot {
  try {
    return decodeInner(snapshot, prng, clock);
  } catch (error) {
    if (error instanceof PostgresError) throw error;
    throw snapshotError();
  }
}

function decodeInner(snapshot: Uint8Array, prng: Prng, clock: Clock): DecodedSnapshot {
  const r = new Reader(snapshot);
  const magic = r.raw(4);
  if (!magic.every((byte, index) => byte === MAGIC[index])) {
    throw new PostgresError("snapshot_format", "invalid postgres-mem snapshot magic", "XX000");
  }
  const version = r.u32();
  if (version !== VERSION) {
    throw new PostgresError("snapshot_version", `unsupported postgres-mem snapshot version: ${version}`, "XX000");
  }
  const state = new DatabaseState(prng, clock);
  (state as unknown as { oidCounter: number }).oidCounter = r.u32();
  state.changes = r.u32();
  state.settings = new Map();
  const settingCount = r.u32();
  for (let i = 0; i < settingCount; i++) {
    const k = r.text();
    state.settings.set(k, r.text());
  }
  state.schemas = new Map();
  const schemaCount = r.u32();
  for (let si = 0; si < schemaCount; si++) {
    const schema = new SchemaData(r.text(), r.u32());

    const tableCount = r.u32();
    for (let i = 0; i < tableCount; i++) {
      const meta = r.json<TableMetaJson>();
      const table = new TableData(meta.schema, meta.name, meta.columns, meta.oid, meta.temp);
      table.constraints = meta.constraints;
      table.triggers = meta.triggers;
      const rowCount = r.u32();
      for (let ri = 0; ri < rowCount; ri++) {
        const width = r.u32();
        if (width !== meta.columns.length) throw snapshotError();
        const row: Datum[] = [];
        for (let ci = 0; ci < width; ci++) row.push(r.datum());
        table.rows.push(row);
      }
      schema.tables.set(table.name, table);
    }

    const viewCount = r.u32();
    for (let i = 0; i < viewCount; i++) {
      const meta = r.json<ViewMetaJson>();
      let matRows: Datum[][] | null = null;
      if (r.u8() === 1) {
        matRows = [];
        const rowCount = r.u32();
        for (let ri = 0; ri < rowCount; ri++) {
          const width = r.u32();
          const row: Datum[] = [];
          for (let ci = 0; ci < width; ci++) row.push(r.datum());
          matRows.push(row);
        }
      }
      const view: ViewData = { ...meta, matRows };
      schema.views.set(view.name, view);
    }

    const seqCount = r.u32();
    for (let i = 0; i < seqCount; i++) {
      const seq = r.json<SequenceData>();
      schema.sequences.set(seq.name, seq);
    }

    const enumCount = r.u32();
    for (let i = 0; i < enumCount; i++) {
      const e = r.json<EnumData>();
      schema.enums.set(e.name, e);
    }

    const domainCount = r.u32();
    for (let i = 0; i < domainCount; i++) {
      const d = r.json<DomainData>();
      schema.domains.set(d.name, d);
    }

    const fnCount = r.u32();
    for (let i = 0; i < fnCount; i++) {
      const key = r.text();
      const overloadCount = r.u32();
      const overloads: FunctionData[] = [];
      for (let oi = 0; oi < overloadCount; oi++) overloads.push(r.json<FunctionMetaJson>());
      schema.functions.set(key, overloads);
    }

    const indexCount = r.u32();
    for (let i = 0; i < indexCount; i++) {
      const idx = r.json<IndexMeta>();
      schema.indexes.set(idx.name, idx);
    }

    state.schemas.set(schema.name, schema);
  }
  state.lastSequence = r.u8() === 1 ? { schema: r.text(), name: r.text() } : null;
  if (r.remaining() < 16) throw snapshotError();
  const runtime: SnapshotRuntime = { prngState: r.u64(), nowMs: Number(r.i64()) };
  if (!r.done()) throw new PostgresError("snapshot_format", "snapshot has trailing data", "XX000");
  return { state, runtime };
}

// --- helpers -------------------------------------------------------------------

function snapshotError(): PostgresError {
  return new PostgresError("snapshot_format", "invalid or truncated postgres-mem snapshot", "XX000");
}

/** Locale-independent UTF-16 code-unit order for stable snapshot encoding. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedValues<T extends { name: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => compareNames(a.name, b.name));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $pgmm: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) return { $pgmm: "bytes", value: Array.from(value) };
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || !("$pgmm" in value)) return value;
  const tagged = value as { $pgmm: string; value: string | number[] };
  if (tagged.$pgmm === "bigint") return BigInt(tagged.value as string);
  if (tagged.$pgmm === "bytes") return Uint8Array.from(tagged.value as number[]);
  return value;
}

registerCodec({ encodeDatabaseState, decodeDatabaseState });
