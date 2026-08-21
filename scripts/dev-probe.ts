/**
 * Dev tool: bulk differential probe. Runs (setup[], sql) cases against both
 * backends and prints mismatches. Not part of CI — contract tests are the
 * authoritative proof; this exists for fast engine iteration.
 *
 * Usage: bun run scripts/dev-probe.ts [filter-substring]
 */
import { InMemoryAdapter } from "../tests/adapters/in-memory.ts";
import { PgliteAdapter } from "../tests/adapters/pglite.ts";
import { deepCompareResults } from "../tests/harness/normalize.ts";

interface Case {
  name: string;
  setup?: string[];
  sql: string;
  /** run as script (exec) rather than single query */
  exec?: boolean;
}

const CASES: Case[] = JSON.parse(await Bun.file(new URL("./dev-probe-cases.json", import.meta.url).pathname).text());

const filter = process.argv[2];
let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of CASES) {
  if (filter && !c.name.includes(filter) && !c.sql.includes(filter)) continue;
  const memory = new InMemoryAdapter();
  const postgres = new PgliteAdapter();
  try {
    let setupFailed = false;
    for (const s of c.setup ?? []) {
      const a = await memory.exec(s);
      const b = await postgres.exec(s);
      if (!a.ok || !b.ok) {
        failures.push(
          `SETUP FAIL [${c.name}] ${s}\n  memory: ${a.error?.message ?? "ok"}\n  oracle: ${b.error?.message ?? "ok"}`,
        );
        setupFailed = true;
        fail++;
        break;
      }
    }
    if (setupFailed) continue;
    const a = c.exec ? await memory.exec(c.sql) : await memory.query(c.sql);
    const b = c.exec ? await postgres.exec(c.sql) : await postgres.query(c.sql);
    const cmp = deepCompareResults(a, b, { ignoreWriteCounters: true, ignoreErrorPhase: true, ignoreSession: true });
    if (cmp.equal) {
      pass++;
    } else {
      fail++;
      failures.push(`FAIL [${c.name}] ${c.sql}\n  ${cmp.reason}`);
    }
  } finally {
    await memory.close();
    await postgres.close();
  }
}

for (const f of failures) console.log(`\n${f}`);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
