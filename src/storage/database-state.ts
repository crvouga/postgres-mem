import type { CreateTriggerStmt, Expr, SelectStmt, Statement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { PG_CATALOG_RELATIONS } from "../schema/catalog.ts";
import type { Clock } from "../runtime/clock.ts";
import type { Prng } from "../runtime/prng.ts";
import { type ColumnType, type Datum, TYPE_OIDS, type TypeId, typeDisplayName } from "../types/value.ts";

// --- table / relation metadata ---------------------------------------------

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  notNull: boolean;
  defaultExpr: Expr | null;
  identity: { always: boolean; sequence: string } | null; // sequence = qualified seq key "schema.name"
  generated: Expr | null; // GENERATED ALWAYS AS (...) STORED
  collate: string | null;
  /** resolved domain name when column type came from a domain */
  domain: string | null; // "schema.name"
}

export type ConstraintMeta =
  | { kind: "primary_key"; name: string; columns: string[] }
  | { kind: "unique"; name: string; columns: string[]; nullsNotDistinct: boolean }
  | { kind: "check"; name: string; expr: Expr }
  | {
      kind: "foreign_key";
      name: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete: string | null;
      onUpdate: string | null;
      match: "full" | "simple";
    };

export interface IndexMeta {
  name: string;
  schema: string;
  table: string;
  unique: boolean;
  /** simple column indexes store names; expression indexes store the AST */
  columns: Array<{ column: string | null; expr: Expr | null; dir: "asc" | "desc"; nulls: "first" | "last" }>;
  where: Expr | null;
  nullsNotDistinct: boolean;
  /** true when this index backs a constraint (pkey / unique constraint) */
  isConstraint: boolean;
}

export interface TriggerMeta {
  name: string;
  timing: "before" | "after" | "instead_of";
  events: CreateTriggerStmt["events"];
  forEachRow: boolean;
  when: Expr | null;
  funcSchema: string;
  funcName: string;
  funcArgs: string[];
}

export class TableData {
  name: string;
  schema: string;
  columns: ColumnMeta[];
  rows: Datum[][];
  constraints: ConstraintMeta[];
  triggers: TriggerMeta[];
  temp: boolean;
  /** monotonically increasing oid-like id for catalog output */
  readonly oid: number;

  constructor(schema: string, name: string, columns: ColumnMeta[], oid: number, temp = false) {
    this.schema = schema;
    this.name = name;
    this.columns = columns;
    this.rows = [];
    this.constraints = [];
    this.triggers = [];
    this.temp = temp;
    this.oid = oid;
  }

  columnIndex(name: string): number {
    return this.columns.findIndex((c) => c.name === name);
  }

  clone(): TableData {
    const t = new TableData(
      this.schema,
      this.name,
      this.columns.map((c) => ({ ...c })),
      this.oid,
      this.temp,
    );
    t.rows = this.rows.map((r) => r.slice());
    t.constraints = this.constraints.map((c) => ({ ...c }));
    t.triggers = this.triggers.map((tr) => ({ ...tr }));
    return t;
  }
}

export interface ViewData {
  name: string;
  schema: string;
  query: SelectStmt;
  columns: string[] | null;
  materialized: boolean;
  /** materialized contents; null = WITH NO DATA (not populated) */
  matRows: Datum[][] | null;
  matColumns: Array<{ name: string; type: TypeId }> | null;
  temp: boolean;
  oid: number;
}

export interface SequenceData {
  name: string;
  schema: string;
  increment: bigint;
  minValue: bigint;
  maxValue: bigint;
  startValue: bigint;
  cache: bigint;
  cycle: boolean;
  lastValue: bigint;
  isCalled: boolean;
  ownedBy: { table: string; column: string } | null;
  dataType: TypeId;
  temp: boolean;
  oid: number;
}

export interface EnumData {
  name: string;
  schema: string;
  labels: string[];
  oid: number;
}

export interface DomainData {
  name: string;
  schema: string;
  baseType: ColumnType;
  notNull: boolean;
  defaultExpr: Expr | null;
  checks: Array<{ name: string; expr: Expr }>;
  oid: number;
}

export interface FunctionData {
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

export class SchemaData {
  name: string;
  tables = new Map<string, TableData>();
  views = new Map<string, ViewData>();
  sequences = new Map<string, SequenceData>();
  enums = new Map<string, EnumData>();
  domains = new Map<string, DomainData>();
  functions = new Map<string, FunctionData[]>();
  indexes = new Map<string, IndexMeta>();
  oid: number;

  constructor(name: string, oid: number) {
    this.name = name;
    this.oid = oid;
  }

  /** all relation names (tables, views, sequences, indexes share pg_class namespace) */
  hasRelation(name: string): boolean {
    return this.tables.has(name) || this.views.has(name) || this.sequences.has(name) || this.indexes.has(name);
  }

  clone(): SchemaData {
    const s = new SchemaData(this.name, this.oid);
    for (const [k, v] of this.tables) s.tables.set(k, v.clone());
    for (const [k, v] of this.views) {
      s.views.set(k, {
        ...v,
        matRows: v.matRows ? v.matRows.map((r) => r.slice()) : null,
        matColumns: v.matColumns ? v.matColumns.map((c) => ({ ...c })) : null,
      });
    }
    for (const [k, v] of this.sequences) s.sequences.set(k, { ...v });
    for (const [k, v] of this.enums) s.enums.set(k, { ...v, labels: v.labels.slice() });
    for (const [k, v] of this.domains) s.domains.set(k, { ...v, checks: v.checks.map((c) => ({ ...c })) });
    for (const [k, v] of this.functions)
      s.functions.set(
        k,
        v.map((f) => ({ ...f })),
      );
    for (const [k, v] of this.indexes) s.indexes.set(k, { ...v, columns: v.columns.map((c) => ({ ...c })) });
    return s;
  }
}

export interface PreparedStatement {
  name: string;
  argTypes: TypeId[] | null;
  stmt: Statement;
}

// --- database state -----------------------------------------------------------

export class DatabaseState {
  schemas = new Map<string, SchemaData>();
  settings = new Map<string, string>();
  /** SET LOCAL values, cleared on COMMIT/ROLLBACK */
  localSettings = new Map<string, string>();
  prepared = new Map<string, PreparedStatement>();
  prng: Prng;
  clock: Clock;
  changes = 0;
  private oidCounter = 16384;
  inTransaction = false;
  /** most recent sequence touched by nextval/setval, for lastval() */
  lastSequence: { schema: string; name: string } | null = null;

  constructor(prng: Prng, clock: Clock) {
    this.prng = prng;
    this.clock = clock;
    this.schemas.set("public", new SchemaData("public", this.nextOid()));
    this.settings.set("timezone", "UTC");
    this.settings.set("search_path", '"$user", public');
    this.settings.set("datestyle", "ISO, MDY");
    this.settings.set("intervalstyle", "postgres");
    this.settings.set("bytea_output", "hex");
    this.settings.set("standard_conforming_strings", "on");
    this.settings.set("client_encoding", "UTF8");
    this.settings.set("server_encoding", "UTF8");
    this.settings.set("integer_datetimes", "on");
    this.settings.set("transaction_isolation", "read committed");
    this.settings.set("application_name", "");
    this.settings.set("extra_float_digits", "1");
    this.settings.set("client_min_messages", "notice");
    this.settings.set("max_identifier_length", "63");
    this.settings.set("server_version", "18.3");
    this.settings.set("server_version_num", "180003");
    this.settings.set("lc_messages", "C");
    this.settings.set("lc_monetary", "C");
    this.settings.set("lc_numeric", "C");
    this.settings.set("lc_time", "C");
    this.settings.set("default_transaction_isolation", "read committed");
    this.settings.set("statement_timeout", "0");
    this.settings.set("array_nulls", "on");
    this.settings.set("backslash_quote", "safe_encoding");
  }

  nextOid(): number {
    return this.oidCounter++;
  }

  getSetting(name: string): string | undefined {
    return this.localSettings.get(name) ?? this.settings.get(name);
  }

  /** effective search path: existing schemas from search_path setting */
  effectiveSearchPath(): string[] {
    const raw = this.getSetting("search_path") ?? "public";
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
      .filter((p) => p.length > 0);
    const out: string[] = [];
    for (const p of parts) {
      const name = p === "$user" ? "postgres" : p;
      if (this.schemas.has(name)) out.push(name);
    }
    return out;
  }

  currentSchema(): string {
    const path = this.effectiveSearchPath();
    return path[0] ?? "public";
  }

  getSchema(name: string): SchemaData {
    const s = this.schemas.get(name);
    if (!s) throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
    return s;
  }

  /** Resolve a possibly-qualified relation name to its schema. */
  resolveRelationSchema(parts: string[]): { schema: string; name: string } | null {
    if (parts.length === 2) {
      const [schema, name] = parts as [string, string];
      return { schema, name };
    }
    if (parts.length === 3) {
      // database.schema.name — database must match
      const [, schema, name] = parts as [string, string, string];
      return { schema, name };
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      if (schema === "pg_catalog" && PG_CATALOG_RELATIONS.has(name)) return { schema, name };
      const s = this.schemas.get(schema);
      if (s?.hasRelation(name)) return { schema, name };
    }
    return null;
  }

  findTable(parts: string[]): TableData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.tables.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const t = this.schemas.get(schema)?.tables.get(name);
      if (t) return t;
    }
    return null;
  }

  requireTable(parts: string[]): TableData {
    const t = this.findTable(parts);
    if (!t) {
      throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`);
    }
    return t;
  }

  findView(parts: string[]): ViewData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.views.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const v = this.schemas.get(schema)?.views.get(name);
      if (v) return v;
    }
    return null;
  }

  findSequence(parts: string[]): SequenceData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.sequences.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const s = this.schemas.get(schema)?.sequences.get(name);
      if (s) return s;
    }
    return null;
  }

  findEnum(parts: string[]): EnumData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.enums.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      const e = this.schemas.get(schema)?.enums.get(name);
      if (e) return e;
    }
    return null;
  }

  findDomain(parts: string[]): DomainData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.domains.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      const d = this.schemas.get(schema)?.domains.get(name);
      if (d) return d;
    }
    return null;
  }

  findFunctions(parts: string[]): FunctionData[] {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      if (schema === "pg_catalog") return [];
      return this.schemas.get(schema)?.functions.get(name) ?? [];
    }
    const name = parts[0]!;
    const out: FunctionData[] = [];
    for (const schema of this.effectiveSearchPath()) {
      const fns = this.schemas.get(schema)?.functions.get(name);
      if (fns) out.push(...fns);
    }
    return out;
  }

  findEnumByKey(key: string): EnumData | null {
    const dot = key.indexOf(".");
    if (dot === -1) return this.findEnum([key]);
    return this.schemas.get(key.slice(0, dot))?.enums.get(key.slice(dot + 1)) ?? null;
  }

  /** format_type()-style display name for a type OID (builtin or enum). */
  typeNameForOid(oid: number): string | null {
    for (const [name, o] of Object.entries(TYPE_OIDS)) {
      if (o === oid) return typeDisplayName(name);
    }
    for (const schema of this.schemas.values()) {
      for (const e of schema.enums.values()) {
        if (e.oid === oid) return e.name;
      }
    }
    return null;
  }

  /** deep clone for transaction snapshots (datums are immutable; rows copied) */
  clone(): DatabaseState {
    const s = new DatabaseState(this.prng, this.clock);
    s.schemas = new Map();
    for (const [k, v] of this.schemas) s.schemas.set(k, v.clone());
    s.settings = new Map(this.settings);
    s.localSettings = new Map(this.localSettings);
    s.prepared = new Map(this.prepared);
    s.changes = this.changes;
    s.inTransaction = this.inTransaction;
    s.lastSequence = this.lastSequence ? { ...this.lastSequence } : null;
    (s as any).oidCounter = this.oidCounter;
    return s;
  }

  /** copy the contents of `other` into this state (rollback restore) */
  restoreFrom(other: DatabaseState): void {
    this.schemas = other.schemas;
    this.settings = other.settings;
    this.localSettings = other.localSettings;
    this.prepared = other.prepared;
    this.changes = other.changes;
    this.lastSequence = other.lastSequence;
    (this as any).oidCounter = (other as any).oidCounter;
  }
}
