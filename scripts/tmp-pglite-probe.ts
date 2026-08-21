import { PGlite, types } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec("SET TIME ZONE 'UTC'");

// Build identity parsers for every known OID
const identity = (x: string) => x;
const parsers: Record<number, (x: string) => string> = {};
for (const v of Object.values(types)) {
  if (typeof v === "number") parsers[v] = identity;
}
console.log("known oids:", Object.keys(parsers).length);

const q = (sql: string) => db.query(sql, [], { parsers } as any);

const samples = [
  "select true a, false b, null c",
  "select 1.5::numeric, 2::numeric, 2.50::numeric, 1e10::numeric",
  "select 0.1::float8, 1e300::float8, 123456789012345680000::float8, 1.5::float4, 'NaN'::float8, 'Infinity'::float8",
  "select now()::timestamp, now(), '2024-01-02 03:04:05.5'::timestamp, '2024-01-02'::date, '03:04:05'::time",
  "select interval '1 year 2 months 3 days 4 hours 5 minutes 6 seconds', interval '90 minutes', interval '-3 days'",
  "select array[1,2,3], array['a','b c','d\"e', null], array[]::int[], '{{1,2},{3,4}}'::int[]",
  "select 'abc'::bytea, '\\xdeadbeef'::bytea",
  'select \'{"b":1,"a":[1,2,true,null]}\'::jsonb, \'{"b":1,"a":2}\'::json',
  "select 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
  "select 12.5::money",
  "select row(1,'a',true)",
  "select 10/4, 10%4, 10.0/4, 2^10, |/25.0",
  "select 'x'||1, 1::text||'x'",
];
for (const sql of samples) {
  try {
    const r = await q(sql);
    console.log(
      sql,
      "=>",
      JSON.stringify(r.rows[0]),
      "oids:",
      (r as any).fields.map((f: any) => f.dataTypeID).join(","),
    );
  } catch (e: any) {
    console.log(sql, "ERR", e.code, e.message);
  }
}
await db.close();
