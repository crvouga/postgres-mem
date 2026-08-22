import * as fc from "fast-check";
import { intArb, realArb, textArb } from "../config.ts";
import { sqlLiteral } from "../helpers.ts";

export type SchemaKind = "default" | "simple" | "with_view" | "with_matview" | "with_sequence" | "multi_schema";

export const DEFAULT_SCHEMA = "CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8)";
export const SIMPLE_SCHEMA = "CREATE TABLE t (id int PRIMARY KEY, a int, b text)";

export function schemaFor(kind: SchemaKind): string {
  if (kind === "simple") return SIMPLE_SCHEMA;
  if (kind === "with_view") {
    return (
      "CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8); " + "CREATE VIEW t_view AS SELECT id, a FROM t"
    );
  }
  if (kind === "with_matview") {
    return (
      "CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8); " +
      "CREATE MATERIALIZED VIEW t_mv AS SELECT id, a FROM t"
    );
  }
  if (kind === "with_sequence") {
    return "CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8)";
  }
  if (kind === "multi_schema") {
    return (
      "CREATE SCHEMA other; " +
      "CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8); " +
      "CREATE TABLE other.t (id int PRIMARY KEY, a int)"
    );
  }
  return DEFAULT_SCHEMA;
}

/**
 * Stateful DST op vocabulary. Ops are resolved against a {@link SimState} so
 * generated SQL is valid-by-construction: no statement can fail inside an open
 * transaction (postgres-mem has no aborted-transaction state), DML is
 * single-row only (no multi-row statement atomicity), and each savepoint is
 * rolled back to at most once (second ROLLBACK TO the same name diverges).
 */
export type StatefulOp =
  | { kind: "insert"; a: number | null; b: string | null; c: number | null }
  | { kind: "update"; pick: number; a: number | null; b: string | null; c: number | null }
  | { kind: "delete"; pick: number }
  | { kind: "select_scan" }
  | { kind: "select_agg" }
  | { kind: "begin" }
  | { kind: "commit" }
  | { kind: "rollback" }
  | { kind: "savepoint" }
  | { kind: "rollback_to" }
  | { kind: "release" }
  | { kind: "checkpoint" };

/** Mixed vocabulary: stateful ops plus occasional DDL (outside transactions only). */
export type MixedOp =
  | StatefulOp
  | { kind: "add_column"; def: string }
  | { kind: "create_index" }
  | { kind: "drop_index" }
  | { kind: "create_view" }
  | { kind: "drop_view" }
  | { kind: "create_matview" }
  | { kind: "refresh_matview" }
  | { kind: "create_partial_index" };

interface SavepointFrame {
  name: string;
  /** Visible row ids at SAVEPOINT time; restored on ROLLBACK TO. */
  ids: number[];
}

export interface SimState {
  schemaKind: SchemaKind;
  /** Monotonic id source — never rolled back, so ids never collide. */
  nextId: number;
  /** Currently visible row ids, ascending. */
  liveIds: number[];
  inTxn: boolean;
  /** Visible row ids at BEGIN time; restored on full ROLLBACK. */
  txnIds: number[] | null;
  /** Open savepoints, innermost last. Rolled-back-to savepoints are consumed (popped). */
  savepoints: SavepointFrame[];
  /** Monotonic savepoint name counter — names are never reused within a run. */
  nextSavepoint: number;
  hasNote: boolean;
  hasIndex: boolean;
  hasPartialIndex: boolean;
  hasView: boolean;
  hasMatView: boolean;
  hasSequence: boolean;
  /** Applied SQL statements (checkpoint context / repro emission). */
  sqlLog: string[];
  /** SELECT probes executed during the sequence (for snapshot checkpoint verification). */
  probeQueries: string[];
}

export function initialSimState(schemaKind: SchemaKind = "default"): SimState {
  return {
    schemaKind,
    nextId: 1,
    liveIds: [],
    inTxn: false,
    txnIds: null,
    savepoints: [],
    nextSavepoint: 1,
    hasNote: false,
    hasIndex: false,
    hasPartialIndex: false,
    hasView: schemaKind === "with_view",
    hasMatView: schemaKind === "with_matview",
    hasSequence: schemaKind === "with_sequence" || schemaKind === "default",
    sqlLog: [],
    probeQueries: [],
  };
}

/** Ops compared outcome-only (`changes` / command tags legitimately differ). */
export const OUTCOME_KINDS = new Set<MixedOp["kind"]>([
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "rollback_to",
  "release",
  "add_column",
  "create_index",
  "drop_index",
  "create_view",
  "drop_view",
  "create_matview",
  "refresh_matview",
  "create_partial_index",
]);

export const READ_ONLY_QUERY_KINDS = new Set<MixedOp["kind"]>(["select_scan", "select_agg"]);

export const QUERY_KINDS = READ_ONLY_QUERY_KINDS;

function scanColumns(state: SimState): string[] {
  const cols = ["id", "a", "b"];
  if (state.schemaKind === "default") cols.push("c");
  if (state.hasNote) cols.push("note");
  return cols;
}

function pickId(state: SimState, pick: number): number | null {
  if (state.liveIds.length === 0) return null;
  return state.liveIds[pick % state.liveIds.length] ?? null;
}

export interface ResolvedOp {
  sql: string;
  isQuery: boolean;
  /** Emit BEGIN before this statement (SAVEPOINT outside a transaction). */
  beginFirst?: boolean;
}

/** Resolve op to SQL + simulated side effects, or null to skip. */
export function resolveOp(op: MixedOp, state: SimState): ResolvedOp | null {
  if (op.kind === "insert") {
    const id = state.nextId++;
    state.liveIds.push(id);
    if (state.schemaKind === "default") {
      return {
        sql: `INSERT INTO t (id, a, b, c) VALUES (${id}, ${sqlLiteral(op.a)}, ${sqlLiteral(op.b)}, ${sqlLiteral(op.c)})`,
        isQuery: false,
      };
    }
    return {
      sql: `INSERT INTO t (id, a, b) VALUES (${id}, ${sqlLiteral(op.a)}, ${sqlLiteral(op.b)})`,
      isQuery: false,
    };
  }
  if (op.kind === "update") {
    const id = pickId(state, op.pick);
    if (id === null) return null;
    const setC = state.schemaKind === "default" ? `, c = ${sqlLiteral(op.c)}` : "";
    return {
      sql: `UPDATE t SET a = ${sqlLiteral(op.a)}, b = ${sqlLiteral(op.b)}${setC} WHERE id = ${id}`,
      isQuery: false,
    };
  }
  if (op.kind === "delete") {
    const id = pickId(state, op.pick);
    if (id === null) return null;
    state.liveIds = state.liveIds.filter((x) => x !== id);
    return { sql: `DELETE FROM t WHERE id = ${id}`, isQuery: false };
  }
  if (op.kind === "select_scan") {
    // id leads the ORDER BY, so the ordering is total regardless of text collation.
    const cols = scanColumns(state).join(", ");
    return { sql: `SELECT ${cols} FROM t ORDER BY ${cols}`, isQuery: true };
  }
  if (op.kind === "select_agg") {
    const cAggs = state.schemaKind === "default" ? ", min(c) AS mnc, max(c) AS mxc" : "";
    return {
      sql: `SELECT count(*) AS n, count(a) AS ca, sum(a) AS sa, min(a) AS mna, max(a) AS mxa${cAggs} FROM t`,
      isQuery: true,
    };
  }
  if (op.kind === "begin") {
    if (state.inTxn) return null;
    state.inTxn = true;
    state.txnIds = [...state.liveIds];
    return { sql: "BEGIN", isQuery: false };
  }
  if (op.kind === "commit") {
    if (!state.inTxn) return null;
    state.inTxn = false;
    state.txnIds = null;
    state.savepoints = [];
    return { sql: "COMMIT", isQuery: false };
  }
  if (op.kind === "rollback") {
    if (!state.inTxn) return null;
    state.liveIds = state.txnIds ?? [];
    state.inTxn = false;
    state.txnIds = null;
    state.savepoints = [];
    return { sql: "ROLLBACK", isQuery: false };
  }
  if (op.kind === "savepoint") {
    const beginFirst = !state.inTxn;
    if (beginFirst) {
      state.inTxn = true;
      state.txnIds = [...state.liveIds];
    }
    const name = `sp${state.nextSavepoint++}`;
    state.savepoints.push({ name, ids: [...state.liveIds] });
    return { sql: `SAVEPOINT ${name}`, isQuery: false, beginFirst };
  }
  if (op.kind === "rollback_to") {
    // Each savepoint is rolled back to at most once, then treated as consumed
    // (rolling back to the same savepoint twice is a known divergence).
    const frame = state.savepoints.pop();
    if (!frame) return null;
    state.liveIds = [...frame.ids];
    return { sql: `ROLLBACK TO ${frame.name}`, isQuery: false };
  }
  if (op.kind === "release") {
    const frame = state.savepoints.pop();
    if (!frame) return null;
    return { sql: `RELEASE ${frame.name}`, isQuery: false };
  }
  if (op.kind === "add_column") {
    if (state.hasNote || state.inTxn) return null;
    state.hasNote = true;
    return { sql: `ALTER TABLE t ADD COLUMN note text DEFAULT ${sqlLiteral(op.def)}`, isQuery: false };
  }
  if (op.kind === "create_index") {
    if (state.hasIndex || state.inTxn) return null;
    state.hasIndex = true;
    return { sql: "CREATE INDEX t_a_idx ON t (a)", isQuery: false };
  }
  if (op.kind === "drop_index") {
    if (!state.hasIndex || state.inTxn) return null;
    state.hasIndex = false;
    return { sql: "DROP INDEX t_a_idx", isQuery: false };
  }
  if (op.kind === "create_view") {
    if (state.hasView || state.inTxn || state.schemaKind === "multi_schema") return null;
    state.hasView = true;
    return { sql: "CREATE VIEW t_view AS SELECT id, a FROM t", isQuery: false };
  }
  if (op.kind === "drop_view") {
    if (!state.hasView || state.inTxn) return null;
    state.hasView = false;
    return { sql: "DROP VIEW t_view", isQuery: false };
  }
  if (op.kind === "create_matview") {
    if (state.hasMatView || state.inTxn || state.schemaKind === "multi_schema") return null;
    state.hasMatView = true;
    return { sql: "CREATE MATERIALIZED VIEW t_mv AS SELECT id, a FROM t", isQuery: false };
  }
  if (op.kind === "refresh_matview") {
    if (!state.hasMatView || state.inTxn) return null;
    return { sql: "REFRESH MATERIALIZED VIEW t_mv", isQuery: false };
  }
  if (op.kind === "create_partial_index") {
    if (state.hasPartialIndex || state.inTxn || state.schemaKind === "multi_schema") return null;
    state.hasPartialIndex = true;
    return { sql: "CREATE INDEX t_partial_idx ON t (a) WHERE a > 0", isQuery: false };
  }
  if (op.kind === "checkpoint") {
    return { sql: "<checkpoint>", isQuery: false };
  }
  return null;
}

const nullableIntArb: fc.Arbitrary<number | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: intArb },
);
const nullableTextArb: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: textArb },
);
const nullableRealArb: fc.Arbitrary<number | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: realArb },
);
const pickArb: fc.Arbitrary<number> = fc.nat({ max: 999 });

export const statefulOpArb: fc.Arbitrary<StatefulOp> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("insert" as const),
      a: nullableIntArb,
      b: nullableTextArb,
      c: nullableRealArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("update" as const),
      pick: pickArb,
      a: nullableIntArb,
      b: nullableTextArb,
      c: nullableRealArb,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("delete" as const), pick: pickArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("select_scan" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("select_agg" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("begin" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("commit" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rollback" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("savepoint" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rollback_to" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("release" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("checkpoint" as const) }) },
);

export const mixedOpArb: fc.Arbitrary<MixedOp> = fc.oneof(
  { weight: 12, arbitrary: statefulOpArb },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("add_column" as const), def: textArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_view" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop_view" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_matview" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("refresh_matview" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_partial_index" as const) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("checkpoint" as const) }) },
);

export const schemaKindArb: fc.Arbitrary<SchemaKind> = fc.constantFrom(
  "default",
  "simple",
  "with_view",
  "with_matview",
  "with_sequence",
  "multi_schema",
);
