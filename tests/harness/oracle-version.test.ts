import { describe, expect, test } from "bun:test";
import { PgliteAdapter } from "../adapters/pglite.ts";
import { SUPPORTED_ORACLE_VERSIONS } from "./oracle-versions.ts";

describe("oracle version pin", () => {
  test("PGlite server_version is on the allow-list", async () => {
    const db = new PgliteAdapter();
    try {
      const res = await db.query("SELECT current_setting('server_version') AS v");
      expect(res.ok).toBe(true);
      const version = res.values[0]?.[0];
      expect(SUPPORTED_ORACLE_VERSIONS as readonly string[]).toContain(version as string);
    } finally {
      await db.close();
    }
  });
});
