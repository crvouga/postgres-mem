import { expect } from "bun:test";
import { expectParity } from "./assert.ts";
import type { ContractDb } from "./types.ts";

/**
 * Compare full user-table state across both backends: same table list, and
 * for each table the same rows (ordered by every column, text-rendered).
 */
export async function expectStateParity(memory: ContractDb, postgres: ContractDb): Promise<void> {
  const listSql =
    "SELECT table_schema, table_name FROM information_schema.tables " +
    "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' " +
    "ORDER BY table_schema, table_name";
  const ta = await memory.query(listSql);
  const tb = await postgres.query(listSql);
  expectParity(ta, tb, { ignoreWriteCounters: true });
  if (!ta.ok) return;

  for (const row of ta.values) {
    const schema = row[0]!;
    const name = row[1]!;
    const colsSql =
      "SELECT column_name FROM information_schema.columns " +
      `WHERE table_schema = '${schema}' AND table_name = '${name}' ORDER BY ordinal_position`;
    const ca = await memory.query(colsSql);
    const cb = await postgres.query(colsSql);
    expectParity(ca, cb, { ignoreWriteCounters: true });
    expect(ca.ok).toBe(true);
    const cols = ca.values.map((r) => `"${r[0]!.replaceAll('"', '""')}"`);
    if (cols.length === 0) continue;
    const dumpSql = `SELECT ${cols.join(", ")} FROM "${schema}"."${name}"`;
    const da = await memory.query(dumpSql);
    const db = await postgres.query(dumpSql);
    expectParity(da, db, { ignoreWriteCounters: true, unordered: true });
  }
}
