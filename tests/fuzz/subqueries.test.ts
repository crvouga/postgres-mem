import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, nullArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const smallIntArb = fc.integer({ min: -5, max: 5 });

const tRowsArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 12 }),
    a: fc.oneof(nullArb, smallIntArb),
    g: fc.integer({ min: 0, max: 2 }),
  }),
  { selector: (row) => row.id, minLength: 0, maxLength: 7 },
);

type TRow = { id: number; a: number | null; g: number };

async function seed(db: { exec(sql: string): Promise<unknown> }, table: string, rows: TRow[]): Promise<void> {
  await db.exec(`CREATE TABLE ${table} (id int PRIMARY KEY, a int, g int)`);
  for (const row of rows) {
    const a = row.a === null ? "NULL" : `(${row.a})`;
    await db.exec(`INSERT INTO ${table} (id, a, g) VALUES (${row.id}, ${a}, ${row.g})`);
  }
}

describe("subquery differential fuzz", () => {
  test("scalar, EXISTS, and ANY/ALL subqueries match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(tRowsArb, tRowsArb, smallIntArb, fc.integer({ min: 0, max: 2 }), async (tRows, sRows, k, g) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await seed(db, "t", tRows);
            await seed(db, "s", sRows);
          }

          // Correlated scalar subqueries use count(*) only: correlated min/max/sum
          // return unnormalized cells or crash in memory when the correlated set
          // is empty or contains NULLs (see tests/contract/_reports/fuzz-querydml.md).
          const cases = [
            "SELECT t.id, (SELECT max(s.a) FROM s) AS m FROM t ORDER BY t.id",
            "SELECT t.id, (SELECT count(*) FROM s WHERE s.a = t.a) AS c FROM t ORDER BY t.id",
            `SELECT t.id, (SELECT count(*) FROM s WHERE s.g = t.g AND s.a > (${k})) AS c FROM t ORDER BY t.id`,
            "SELECT t.id FROM t WHERE EXISTS (SELECT 1 FROM s WHERE s.a = t.a) ORDER BY t.id",
            `SELECT t.id FROM t WHERE NOT EXISTS (SELECT 1 FROM s WHERE s.g = t.g AND s.a > (${k})) ORDER BY t.id`,
            `SELECT t.id FROM t WHERE t.a > ANY (SELECT s.a FROM s WHERE s.g = ${g}) ORDER BY t.id`,
            `SELECT t.id FROM t WHERE t.a <= ALL (SELECT s.a FROM s WHERE s.g <> ${g}) ORDER BY t.id`,
            `SELECT t.id FROM t WHERE t.a = ANY (SELECT s.a FROM s) ORDER BY t.id`,
          ];
          for (const sql of cases) {
            compareOrReport(
              "subquery",
              sql,
              { tRows, sRows, k, g },
              await memory.query(sql),
              await postgres.query(sql),
            );
          }
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 240_000);

  test("IN and NOT IN with deliberate NULLs match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        tRowsArb,
        fc.array(fc.oneof(nullArb, smallIntArb), { minLength: 0, maxLength: 6 }),
        fc.oneof(nullArb, smallIntArb),
        async (tRows, haystack, needle) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await seed(db, "t", tRows);
              await db.exec("CREATE TABLE s (a int)");
              for (const value of haystack) {
                await db.exec(`INSERT INTO s (a) VALUES (${value === null ? "NULL" : `(${value})`})`);
              }
            }

            const lit = needle === null ? "NULL::int" : `(${needle})::int`;
            const inList =
              haystack.length === 0
                ? "((-999))"
                : `(${haystack.map((v) => (v === null ? "NULL" : `(${v})`)).join(", ")})`;
            // NULL IN/NOT IN an *empty* subquery is a recorded divergence
            // (memory NULL, oracle f/t) — those shapes are skipped when the
            // needle is NULL / the subquery can be empty.
            const cases = [
              "SELECT t.id FROM t WHERE t.a IN (SELECT a FROM s) ORDER BY t.id",
              `SELECT t.id FROM t WHERE t.a IN ${inList} ORDER BY t.id`,
              `SELECT t.id FROM t WHERE t.a NOT IN ${inList} ORDER BY t.id`,
            ];
            if (needle !== null || haystack.length > 0) {
              cases.push(`SELECT ${lit} IN (SELECT a FROM s) AS v`, `SELECT ${lit} NOT IN (SELECT a FROM s) AS v`);
            }
            if (needle !== null) {
              cases.push(
                `SELECT ${lit} IN (SELECT a FROM s WHERE false) AS v`,
                `SELECT ${lit} NOT IN (SELECT a FROM s WHERE false) AS v`,
              );
            }
            if (haystack.length > 0) {
              cases.push("SELECT t.id FROM t WHERE t.a NOT IN (SELECT a FROM s) ORDER BY t.id");
            }
            for (const sql of cases) {
              compareOrReport(
                "in-null",
                sql,
                { tRows, haystack, needle },
                await memory.query(sql),
                await postgres.query(sql),
              );
            }
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  }, 240_000);
});
