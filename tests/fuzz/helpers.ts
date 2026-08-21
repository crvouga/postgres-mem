import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { deepCompareResults } from "../harness/normalize.ts";
import { createOracleAdapter } from "../harness/oracle.ts";
import type { ContractDb, QueryResult, SqlValue } from "../harness/types.ts";
import { fuzzSeed } from "./config.ts";

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Render a JS value as a PostgreSQL literal for generated SQL. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `'\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'::bytea`;
}

function replayHint(): string {
  return `Replay: POSTGRES_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz`;
}

export function compareOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
): void {
  const comparison = deepCompareResults(memory, postgres, {
    messageTier: "B",
    ignoreErrorPhase: true,
    ignoreWriteCounters: (memory.columns?.length ?? 0) > 0 || (postgres.columns?.length ?? 0) > 0,
  });
  if (comparison.equal) return;

  throw new Error(
    [
      `Differential mismatch (${label})`,
      `seed=${fuzzSeed()}`,
      replayHint(),
      `SQL: ${sql}`,
      `Setup: ${JSON.stringify(setup)}`,
      `Reason: ${comparison.reason}`,
      `memory: ${JSON.stringify(memory)}`,
      `postgres: ${JSON.stringify(postgres)}`,
    ].join("\n"),
  );
}

/**
 * Outcome-only compare for cases where PostgreSQL does not specify which
 * constraint error is reported first. Prefer compareOrReport otherwise.
 */
export function compareOutcomeOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
): void {
  const sameOutcome = memory.ok === postgres.ok && (memory.ok || memory.error?.category === postgres.error?.category);
  if (sameOutcome) return;

  throw new Error(
    [
      `Differential outcome mismatch (${label})`,
      `seed=${fuzzSeed()}`,
      replayHint(),
      `SQL: ${sql}`,
      `Setup: ${JSON.stringify(setup)}`,
      `memory: ${JSON.stringify(memory)}`,
      `postgres: ${JSON.stringify(postgres)}`,
    ].join("\n"),
  );
}

/** Full compare on success; category-only on failure (constraint races). */
export function compareWriteOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
): void {
  if (memory.ok && postgres.ok) {
    compareOrReport(label, sql, setup, memory, postgres);
    return;
  }
  compareOutcomeOrReport(label, sql, setup, memory, postgres);
}

const STATE_TABLES_SQL =
  "SELECT table_schema, table_name FROM information_schema.tables " +
  "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' " +
  "ORDER BY table_schema, table_name";

/** Dump every user table (rows text-rendered, ordered) as one comparable result. */
export async function dumpLogicalState(db: ContractDb): Promise<QueryResult> {
  const tables = await db.query(STATE_TABLES_SQL);
  if (!tables.ok) return tables;
  const chunks: string[] = [];
  for (const row of tables.values) {
    const schema = row[0]!;
    const name = row[1]!;
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns " +
        `WHERE table_schema = '${schema}' AND table_name = '${name}' ORDER BY ordinal_position`,
    );
    if (!cols.ok) return cols;
    const colList = cols.values.map((r) => quoteIdent(r[0]!));
    if (colList.length === 0) continue;
    const rendered = colList.map((c) => `coalesce(${c}::text, '<NULL>')`).join(" || '|' || ");
    chunks.push(
      `SELECT '${schema}.${name}' AS tbl, s FROM (SELECT ${rendered} AS s FROM ${quoteIdent(schema)}.${quoteIdent(name)} ORDER BY 1) x`,
    );
  }
  if (chunks.length === 0) return db.query("SELECT NULL::text AS tbl, NULL::text AS s WHERE false");
  return db.query(chunks.join(" UNION ALL "));
}

export async function compareStateOrReport(
  label: string,
  setup: unknown,
  memory: ContractDb,
  postgres: ContractDb,
): Promise<void> {
  compareOrReport(
    label,
    "<logical-state-dump>",
    setup,
    await dumpLogicalState(memory),
    await dumpLogicalState(postgres),
  );
}

export async function withDatabases(run: (memory: ContractDb, postgres: ContractDb) => Promise<void>): Promise<void> {
  const memory = new InMemoryAdapter();
  const postgres = createOracleAdapter();
  try {
    await run(memory, postgres);
  } finally {
    await memory.close();
    await postgres.close();
  }
}
