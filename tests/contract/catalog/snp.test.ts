import { expect } from "bun:test";
import { SNP_SECTION } from "../../../compat/sections/snp.ts";
import { Database, PostgresError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

function restoredClone(source: Database): Database {
  const clone = new Database();
  clone.restore(source.snapshot());
  return clone;
}

runCatalog(SNP_SECTION, [
  {
    id: "SNP-rt-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
      db.exec("INSERT INTO t (name) VALUES ('a'), ('b')");
      const clone = restoredClone(db);
      expect(clone.query("SELECT id, name FROM t ORDER BY id")).toEqual(db.query("SELECT id, name FROM t ORDER BY id"));
    },
  },
  {
    id: "SNP-rt-02",
    kind: "divergence",
    fn: (db) => {
      db.exec(`CREATE TABLE k (b bool, i8 int8, n numeric(10,3), by bytea, ts timestamptz, iv interval,
        u uuid, jb jsonb, arr text[])`);
      db.exec(`INSERT INTO k VALUES (true, 9007199254740993, 12.345, '\\x00ff', '2024-06-01 12:00:00+00',
        interval '1 day 2 hours', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"x": [1, 2.5]}', ARRAY['a', NULL])`);
      const clone = restoredClone(db);
      const sql =
        "SELECT b, i8, n::text AS n, by, ts::text AS ts, iv::text AS iv, u::text AS u, jb::text AS jb, arr::text AS arr FROM k";
      expect(clone.query(sql)).toEqual(db.query(sql));
    },
  },
  {
    id: "SNP-rt-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE SEQUENCE sq START 5");
      db.exec("CREATE TABLE t (id serial PRIMARY KEY)");
      db.exec("INSERT INTO t DEFAULT VALUES");
      db.query("SELECT nextval('sq')");
      const clone = restoredClone(db);
      expect(clone.query("SELECT nextval('sq') AS n")[0]).toEqual({ n: 6n });
      clone.exec("INSERT INTO t DEFAULT VALUES");
      expect(clone.query("SELECT max(id)::int AS m FROM t")[0]).toEqual({ m: 2 });
    },
  },
  {
    id: "SNP-rt-04",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 11 });
      a.query("SELECT random()");
      const b = new Database({ seed: 11 });
      b.restore(a.snapshot());
      expect(String(b.query<{ v: number }>("SELECT random() AS v")[0]!.v)).toBe(
        String(a.query<{ v: number }>("SELECT random() AS v")[0]!.v),
      );
      expect(b.query("SELECT now()::text AS t")).toEqual(a.query("SELECT now()::text AS t"));
    },
  },
  {
    id: "SNP-rt-05",
    kind: "divergence",
    fn: (db) => {
      db.exec(`
        CREATE TYPE mood AS ENUM ('sad', 'happy');
        CREATE DOMAIN posint AS int CHECK (VALUE > 0);
        CREATE TABLE t (m mood, p posint);
        INSERT INTO t VALUES ('happy', 3);
        CREATE VIEW v AS SELECT m FROM t;
        CREATE FUNCTION dbl(x int) RETURNS int LANGUAGE sql AS 'SELECT x * 2';
      `);
      const clone = restoredClone(db);
      expect(clone.query("SELECT m::text AS m FROM v")).toEqual([{ m: "happy" }]);
      expect(clone.query("SELECT dbl(4) AS d")).toEqual([{ d: 8 }]);
      expect(() => clone.exec("INSERT INTO t VALUES ('sad', -1)")).toThrow(/check/i);
    },
  },
  {
    id: "SNP-byte-01",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 3 });
      const b = new Database({ seed: 3 });
      for (const db of [a, b]) {
        db.exec("CREATE TABLE t (id int)");
        db.exec("INSERT INTO t VALUES (1), (2)");
      }
      expect([...a.snapshot()]).toEqual([...b.snapshot()]);
    },
  },
  {
    id: "SNP-hdr-01",
    kind: "divergence",
    fn: (db) => {
      const snap = db.snapshot();
      expect(String.fromCharCode(snap[0]!, snap[1]!, snap[2]!, snap[3]!)).toBe("PGMM");
      expect(new DataView(snap.buffer, snap.byteOffset).getUint32(4, true)).toBe(1);
    },
  },
  {
    id: "SNP-hdr-02",
    kind: "divergence",
    fn: (db) => {
      const bad = new Uint8Array(db.snapshot());
      bad[0] = 0x58;
      try {
        db.restore(bad);
        expect.unreachable("expected restore to throw");
      } catch (err) {
        expect((err as PostgresError).message).toMatch(/magic/);
      }
    },
  },
  {
    id: "SNP-hdr-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.exec("INSERT INTO t VALUES (1, 'hello')");
      const snap = db.snapshot();
      expect(() => db.restore(snap.slice(0, snap.length - 8))).toThrow(PostgresError);
    },
  },
  {
    id: "SNP-hdr-04",
    kind: "divergence",
    fn: (db) => {
      const bumped = new Uint8Array(db.snapshot());
      const view = new DataView(bumped.buffer, bumped.byteOffset);
      view.setUint32(4, view.getUint32(4, true) + 1, true);
      try {
        db.restore(bumped);
        expect.unreachable("expected restore to throw");
      } catch (err) {
        expect((err as PostgresError).category).toBe("snapshot_version");
      }
    },
  },
  {
    id: "SNP-txn-01",
    kind: "divergence",
    fn: (db) => {
      const snap = db.snapshot();
      db.exec("BEGIN");
      expect(() => db.restore(snap)).toThrow(/transaction/);
      db.exec("ROLLBACK");
    },
  },
  {
    id: "SNP-rep-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE keepme (id int)");
      const snap = db.snapshot();
      db.exec("DROP TABLE keepme");
      db.exec("CREATE TABLE other (id int)");
      db.restore(snap);
      expect(db.query("SELECT count(*)::int AS c FROM keepme")[0]).toEqual({ c: 0 });
      expect(() => db.query("SELECT * FROM other")).toThrow(/does not exist/);
    },
  },
]);
