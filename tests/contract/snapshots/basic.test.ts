import { expect, test } from "bun:test";
import { Database, PostgresError } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { expectStateParity } from "../../harness/state-dump.ts";
import { setupBoth } from "../helpers.ts";

/**
 * Behavioral A/B: both engines run the same ops; memory snapshot/restore must stay
 * lockstep with the live oracle under identical post-restore SQL.
 */
matrixBoth("post-restore DML stays in lockstep with oracle", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text UNIQUE, n int DEFAULT 0)",
    "CREATE INDEX t_n ON t (n)",
    "INSERT INTO t (name, n) VALUES ('a', 1), ('b', 0)",
  ]);
  await expectStateParity(memory, postgres);

  const snap = memory.snapshot();
  await memory.exec("INSERT INTO t (name, n) VALUES ('gone', 9)");
  memory.restore(snap);

  const ops = [
    "INSERT INTO t (name, n) VALUES ('c', 2)",
    "UPDATE t SET n = n + 1 WHERE name = 'b'",
    "DELETE FROM t WHERE name = 'a'",
  ];
  for (const sql of ops) {
    expectParity(await memory.exec(sql), await postgres.exec(sql));
  }
  expectParity(
    await memory.query("SELECT id, name, n FROM t ORDER BY id"),
    await postgres.query("SELECT id, name, n FROM t ORDER BY id"),
  );
  await expectStateParity(memory, postgres);
});

test("memory snapshot restores into a new adapter", async () => {
  const source = new InMemoryAdapter();
  const restored = new InMemoryAdapter();
  try {
    await source.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
    await source.exec("INSERT INTO t (name) VALUES ('a'), ('b')");
    restored.restore(source.snapshot());
    expectParity(
      await restored.query("SELECT * FROM t ORDER BY id"),
      await source.query("SELECT * FROM t ORDER BY id"),
    );
  } finally {
    await source.close();
    await restored.close();
  }
});

test("snapshot roundtrip discards later mutations", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (id int)");
  db.exec("INSERT INTO t VALUES (1), (2)");
  const bytes = db.snapshot();
  db.exec("INSERT INTO t VALUES (3)");
  db.restore(bytes);
  expect(db.query("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
});

test("snapshot preserves schema constraints and defaults", () => {
  const source = new Database();
  const restored = new Database();
  source.exec("CREATE TABLE t (id serial PRIMARY KEY, label text NOT NULL DEFAULT 'x')");
  restored.restore(source.snapshot());
  restored.exec("INSERT INTO t DEFAULT VALUES");
  expect(restored.query("SELECT * FROM t")).toEqual([{ id: 1, label: "x" }]);
  expect(() => restored.exec("INSERT INTO t (label) VALUES (NULL)")).toThrow(/null value/);
});

test("snapshot clone stays in lockstep under identical ops", () => {
  const source = new Database();
  const clone = new Database();
  source.exec("CREATE TABLE t (id serial PRIMARY KEY, name text UNIQUE, n int DEFAULT 0)");
  source.exec("CREATE INDEX t_n ON t (n)");
  source.exec("CREATE VIEW v AS SELECT id, name FROM t WHERE n > 0");
  source.exec("INSERT INTO t (name, n) VALUES ('a', 1), ('b', 0)");
  clone.restore(source.snapshot());

  const ops = [
    "INSERT INTO t (name, n) VALUES ('c', 2)",
    "UPDATE t SET n = n + 1 WHERE name = 'b'",
    "DELETE FROM t WHERE name = 'a'",
  ];
  for (const sql of ops) {
    source.exec(sql);
    clone.exec(sql);
    expect(source.changes).toBe(clone.changes);
  }
  expect(clone.query("SELECT id, name, n FROM t ORDER BY id")).toEqual(
    source.query("SELECT id, name, n FROM t ORDER BY id"),
  );
  expect(clone.query("SELECT * FROM v ORDER BY id")).toEqual(source.query("SELECT * FROM v ORDER BY id"));
});

test("snapshot preserves sequences, enums, domains, and functions", () => {
  const source = new Database();
  source.exec(`
    CREATE TYPE mood AS ENUM ('sad', 'happy');
    CREATE DOMAIN posint AS int CHECK (VALUE > 0);
    CREATE SEQUENCE sq START 100;
    CREATE TABLE t (id int DEFAULT nextval('sq'), m mood, p posint);
    INSERT INTO t (m, p) VALUES ('happy', 5);
    CREATE FUNCTION double_it(x int) RETURNS int LANGUAGE sql AS 'SELECT x * 2';
  `);
  const clone = new Database();
  clone.restore(source.snapshot());
  expect(clone.query("SELECT nextval('sq') AS n")[0]).toEqual({ n: 101n });
  expect(clone.query("SELECT double_it(21) AS d")[0]).toEqual({ d: 42 });
  expect(clone.query("SELECT m::text AS m FROM t")[0]).toEqual({ m: "happy" });
  expect(() => clone.exec("INSERT INTO t (m, p) VALUES ('sad', -1)")).toThrow(/check/i);
});

test("restore during a transaction is rejected", () => {
  const db = new Database();
  const snap = db.snapshot();
  db.exec("BEGIN");
  expect(() => db.restore(snap)).toThrow(/transaction/);
  db.exec("ROLLBACK");
  db.restore(snap);
});

test("restore rejects newer snapshot format version", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (id int)");
  const snap = db.snapshot();
  // PGMM + little-endian u32 version at offset 4
  const bumped = new Uint8Array(snap);
  const view = new DataView(bumped.buffer, bumped.byteOffset, bumped.byteLength);
  view.setUint32(4, view.getUint32(4, true) + 1, true);
  try {
    db.restore(bumped);
    expect.unreachable("expected restore to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(PostgresError);
    expect((err as PostgresError).category).toBe("snapshot_version");
  }
});

test("restore rejects corrupt magic with a distinct error", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (id int)");
  const corrupt = new Uint8Array(db.snapshot());
  corrupt[0] = "X".charCodeAt(0);
  try {
    db.restore(corrupt);
    expect.unreachable("expected restore to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(PostgresError);
    expect((err as PostgresError).message).toMatch(/magic/);
    expect((err as PostgresError).category).not.toBe("snapshot_version");
  }
});

test("restore rejects truncated payloads", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (id int, v text)");
  db.exec("INSERT INTO t VALUES (1, 'x')");
  const snap = db.snapshot();
  const truncated = snap.slice(0, snap.length - 10);
  expect(() => db.restore(truncated)).toThrow(PostgresError);
});

test("current snapshot version round-trips with PGMM magic", () => {
  const a = new Database({ seed: 7 });
  a.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
  a.prepare("INSERT INTO t (name) VALUES ($1)").run("Ada");
  const snap = a.snapshot();
  expect(String.fromCharCode(snap[0]!, snap[1]!, snap[2]!, snap[3]!)).toBe("PGMM");
  const version = new DataView(snap.buffer, snap.byteOffset, snap.byteLength).getUint32(4, true);
  expect(version).toBe(1);
  const b = new Database();
  b.restore(snap);
  expect(b.query("SELECT name FROM t")).toEqual([{ name: "Ada" }]);
});

test("all datum kinds round-trip through a snapshot", () => {
  const db = new Database();
  db.exec(`
    CREATE TABLE kinds (
      b bool, i2 int2, i4 int4, i8 int8, f4 float4, f8 float8,
      n numeric(12,4), t text, by bytea, d date, ts timestamp, tz timestamptz,
      iv interval, u uuid, j json, jb jsonb, arr int[], txts text[]
    );
    INSERT INTO kinds VALUES (
      true, 1, 2, 9007199254740993, 1.5, 2.5,
      1234.5678, 'hello', '\\xcafe', '2024-06-01', '2024-06-01 12:00:00', '2024-06-01 12:00:00+00',
      interval '1 year 2 days 3 hours', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      '{"a": 1}', '{"b": [1, 2.50]}', ARRAY[1, 2, 3], ARRAY['x', NULL, 'z']
    );
    INSERT INTO kinds DEFAULT VALUES;
  `);
  const clone = new Database();
  clone.restore(db.snapshot());
  const cols =
    "b, i2, i4, i8, f4, f8, n::text AS n, t, by, d::text AS d, ts::text AS ts, tz::text AS tz, " +
    "iv::text AS iv, u::text AS u, j::text AS j, jb::text AS jb, arr::text AS arr, txts::text AS txts";
  expect(clone.query(`SELECT ${cols} FROM kinds ORDER BY i4 NULLS LAST`)).toEqual(
    db.query(`SELECT ${cols} FROM kinds ORDER BY i4 NULLS LAST`),
  );
  // snapshots of source and clone are byte-identical
  expect([...clone.snapshot()]).toEqual([...db.snapshot()]);
});
