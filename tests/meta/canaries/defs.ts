/**
 * Deliberate sabotages. Each must cause the listed probe tests to fail.
 * Restored after every run by scripts/run-canaries.ts.
 *
 * Survivors are documented proof holes in the differential suite.
 */
export interface Canary {
  id: string;
  description: string;
  file: string;
  find: string;
  replace: string;
  /** Focused bun test paths that exercise the sabotaged code. */
  probe: string[];
}

export const CANARIES: Canary[] = [
  {
    id: "limit-off-by-one",
    description: "LIMIT returns one extra row (main select path)",
    file: "src/executor/select.ts",
    find: "      rows = rows.slice(0, end);",
    replace: "      rows = rows.slice(0, end + 1);",
    probe: ["tests/contract/limits"],
  },
  {
    id: "null-eq-true",
    description: "NULL comparisons return true instead of unknown",
    file: "src/expressions/operators.ts",
    find: 'if (l.v === null || r.v === null) return tv("bool", null);',
    replace: 'if (l.v === null || r.v === null) return tv("bool", true);',
    probe: ["tests/contract/null"],
  },
  {
    id: "unique-skip",
    description: "UNIQUE / PRIMARY KEY enforcement is a no-op",
    file: "src/constraints/enforce.ts",
    find: "      if (other === key) {",
    replace: "      if (false && other === key) {",
    probe: ["tests/contract/constraints", "tests/contract/on-conflict"],
  },
  {
    id: "in-empty-null",
    description: "IN over an empty set returns NULL instead of false",
    file: "src/expressions/eval.ts",
    find: "  if (found) result = true;\n  else if (sawNull) result = null;\n  else result = false;",
    replace: "  if (found) result = true;\n  else result = null;",
    probe: ["tests/contract/aggregates/empty-groups.test.ts", "tests/contract/subqueries"],
  },
  {
    id: "numeric-add-scale",
    description: "numeric addition unifies to the smaller display scale",
    file: "src/types/numeric.ts",
    find: "  const scale = Math.max(a.dscale, b.dscale);\n  return makeNumeric(a.coef * pow10(scale - a.dscale) + b.coef * pow10(scale - b.dscale), scale);",
    replace:
      "  const scale = Math.min(a.dscale, b.dscale);\n  return makeNumeric(a.coef * pow10(scale - a.dscale) + b.coef * pow10(scale - b.dscale), scale);",
    probe: ["tests/contract/numeric"],
  },
  {
    id: "rowcount-zero",
    description: "Statement.run always reports rowCount 0",
    file: "src/api/statement.ts",
    find: "    return { rowCount: res.rowCount, command: res.command };",
    replace: "    return { rowCount: 0, command: res.command };",
    probe: ["tests/contract/api"],
  },
];
