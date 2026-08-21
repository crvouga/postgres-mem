import type {
  CommonTableExpr,
  Expr,
  FromItem,
  FuncCall,
  GroupItem,
  OrderByItem,
  SelectBody,
  SelectCore,
  SelectStmt,
  SelectTarget,
  SetOp,
  Statement,
  ValuesBody,
  WithClause,
} from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { EvalScope } from "../expressions/eval.ts";
import { evalExpr } from "../expressions/eval.ts";
import { createAggregate, isAggregateName, isOrderedSetAggregate, unifyAggType } from "../functions/aggregates.ts";
import { getSrfFunctions, isSrfName } from "../functions/srf.ts";
import { catalogRelation } from "../schema/catalog.ts";
import type { FunctionData } from "../storage/database-state.ts";
import { castTo, unifyTypes } from "../types/cast.ts";
import { datumCompare, datumKey } from "../types/compare.ts";
import { type Datum, type TypeId, type TypedValue, UNKNOWN, tv } from "../types/value.ts";
import {
  type ExecEnv,
  type ExecResult,
  type Relation,
  RowScope,
  childEnv,
  inferColumnName,
  relationResult,
} from "./relation.ts";
import { computeWindowValues } from "./window.ts";

// ---------------------------------------------------------------------------
// statement runner indirection (data-modifying CTEs, SQL function bodies)
// execute.ts registers itself here to avoid import cycles.
// ---------------------------------------------------------------------------

export type StatementRunner = (env: ExecEnv, stmt: Statement) => ExecResult;
let statementRunner: StatementRunner | null = null;
export function setStatementRunner(r: StatementRunner): void {
  statementRunner = r;
}
export function runStatement(env: ExecEnv, stmt: Statement): ExecResult {
  if (!statementRunner) throw pgError("internal", "statement runner not initialized");
  return statementRunner(env, stmt);
}

// ---------------------------------------------------------------------------
// structural expression equality (GROUP BY matching)
// ---------------------------------------------------------------------------

export function exprEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => exprEq(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!exprEq(ao[k], bo[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// eval scope plumbing
// ---------------------------------------------------------------------------

export interface ScopeExtras {
  aggMap?: Map<FuncCall, TypedValue> | null;
  windowAt?: (call: FuncCall) => TypedValue | undefined;
  exprOverride?: (e: Expr) => TypedValue | undefined;
  groupingValue?: (e: Expr) => TypedValue | undefined;
  /** grouped context: bare column refs that survive overrides are errors */
  strictGrouping?: boolean;
}

export function makeEvalScope(env: ExecEnv, scope: RowScope | null, extras?: ScopeExtras): EvalScope {
  return {
    lookupColumn(parts) {
      const v = scope?.lookup(parts);
      if (v === undefined) return undefined;
      if (extras?.strictGrouping) {
        throw pgError(
          "grouping_error",
          `column "${parts.join(".")}" must appear in the GROUP BY clause or be used in an aggregate function`,
          "42803",
        );
      }
      return v;
    },
    exprOverride: extras?.exprOverride,
    param(index) {
      const p = env.params?.[index - 1];
      if (p === undefined) throw pgError("undefined_parameter", `there is no parameter $${index}`, "42P02");
      return p;
    },
    execScalarSubquery(q) {
      const rel = executeSelectStmt(childEnv(env, scope), q);
      if (rel.columns.length !== 1) {
        throw pgError("cardinality_violation", "subquery must return only one column", "42601");
      }
      if (rel.rows.length > 1) {
        throw pgError(
          "cardinality_violation",
          "more than one row returned by a subquery used as an expression",
          "21000",
        );
      }
      const t = rel.columns[0]!.type;
      return tv(t === UNKNOWN ? "text" : t, rel.rows[0]?.[0] ?? null);
    },
    execExistsSubquery(q) {
      const rel = executeSelectStmt(childEnv(env, scope), q);
      return rel.rows.length > 0;
    },
    execColumnSubquery(q) {
      const rel = executeSelectStmt(childEnv(env, scope), q);
      if (rel.columns.length !== 1) {
        throw pgError("cardinality_violation", "subquery has too many columns", "42601");
      }
      const t = rel.columns[0]!.type;
      return { type: t === UNKNOWN ? "text" : t, values: rel.rows.map((r) => r[0] ?? null) };
    },
    aggValue(node) {
      return extras?.aggMap?.get(node);
    },
    windowValue(node) {
      if (!node.over) return undefined;
      return extras?.windowAt?.(node);
    },
    groupingValue(node) {
      return extras?.groupingValue?.(node);
    },
    callUserFunction(name, args, node) {
      void node;
      const fn = resolveUserFunction(env, name, args.length);
      if (!fn) return undefined;
      return callSqlFunctionScalar(env, fn, args);
    },
    callStatefulFunction: undefined,
  };
}

export function evalScalar(env: ExecEnv, scope: RowScope | null, e: Expr, extras?: ScopeExtras): TypedValue {
  return evalExpr(env.ctx, makeEvalScope(env, scope, extras), e);
}

/** SQL three-valued predicate: null → false */
export function evalPredicate(env: ExecEnv, scope: RowScope | null, e: Expr, extras?: ScopeExtras): boolean {
  const v = evalScalar(env, scope, e, extras);
  if (v.v === null) return false;
  const b = castTo(env.ctx, v, "bool", {});
  return b.v === true;
}

// ---------------------------------------------------------------------------
// user-defined LANGUAGE sql functions
// ---------------------------------------------------------------------------

export function resolveUserFunction(env: ExecEnv, name: string[], argCount: number): FunctionData | null {
  const candidates = env.ctx.state.findFunctions(name);
  for (const fn of candidates) {
    const required = fn.argDefaults.filter((d) => d === null).length;
    if (argCount >= required && argCount <= fn.argTypes.length) return fn;
  }
  return null;
}

function functionEnv(env: ExecEnv, fn: FunctionData, args: TypedValue[]): ExecEnv {
  // cast args to declared types; fill defaults
  const bound: TypedValue[] = [];
  for (let i = 0; i < fn.argTypes.length; i++) {
    if (i < args.length) {
      bound.push(castTo(env.ctx, args[i]!, fn.argTypes[i]!, {}));
    } else {
      const dflt = fn.argDefaults[i];
      if (!dflt) throw pgError("undefined_function", `function ${fn.name} argument ${i + 1} missing`, "42883");
      bound.push(castTo(env.ctx, evalScalar(env, null, dflt), fn.argTypes[i]!, {}));
    }
  }
  const fnEnv: ExecEnv = { ctx: env.ctx, params: bound, ctes: new Map(), outer: null };
  // named args resolve like columns of a phantom row
  const namedCols = fn.argNames.map((n, i) => ({ n, i })).filter((x): x is { n: string; i: number } => x.n !== null);
  if (namedCols.length > 0) {
    const cols = namedCols.map(({ n, i }) => ({ name: n, type: fn.argTypes[i] ?? "text", table: null }));
    const row = namedCols.map(({ i }) => bound[i]!.v);
    fnEnv.outer = new RowScope(cols, row, null);
  }
  return fnEnv;
}

function runFunctionBody(env: ExecEnv, fn: FunctionData, args: TypedValue[]): ExecResult | null {
  if (fn.strict && args.some((a) => a.v === null)) return null;
  if (!fn.body || fn.body.length === 0) {
    throw pgError("unsupported", `function ${fn.name} has no executable body`);
  }
  const fnEnv = functionEnv(env, fn, args);
  let last: ExecResult | null = null;
  for (const stmt of fn.body) {
    last = runStatement(fnEnv, stmt);
  }
  return last;
}

export function callSqlFunctionScalar(env: ExecEnv, fn: FunctionData, args: TypedValue[]): TypedValue {
  const retT = fn.returns ?? "text";
  const last = runFunctionBody(env, fn, args);
  if (last === null) return tv(retT, null);
  if (fn.returnsSet || fn.returnsTable) {
    throw pgError("feature_not_supported", `set-returning function ${fn.name} called in scalar context`, "0A000");
  }
  const raw = last.rows[0]?.[0] ?? null;
  const rawT = last.columns[0]?.type ?? retT;
  if (raw === null) return tv(retT, null);
  return castTo(env.ctx, tv(rawT, raw), retT, {});
}

export function callSqlFunctionSet(env: ExecEnv, fn: FunctionData, args: TypedValue[]): Relation {
  const last = runFunctionBody(env, fn, args);
  if (last === null) return { columns: [], rows: [] };
  if (fn.returnsTable) {
    const cols = fn.returnsTable.map((c) => ({ name: c.name, type: c.type, table: null }));
    const rows = last.rows.map((r) =>
      fn.returnsTable!.map((c, i) => {
        const raw = r[i] ?? null;
        if (raw === null) return null;
        const srcT = last.columns[i]?.type ?? c.type;
        return castTo(env.ctx, tv(srcT, raw), c.type, {}).v;
      }),
    );
    return { columns: cols, rows };
  }
  const retT = fn.returns ?? "text";
  const rows = last.rows.map((r) => {
    const raw = r[0] ?? null;
    if (raw === null) return [null];
    const srcT = last.columns[0]?.type ?? retT;
    return [castTo(env.ctx, tv(srcT, raw), retT, {}).v];
  });
  return { columns: [{ name: fn.name, type: retT, table: null }], rows };
}

// ---------------------------------------------------------------------------
// WITH (CTEs)
// ---------------------------------------------------------------------------

function referencesRelation(node: unknown, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => referencesRelation(n, name));
  const o = node as Record<string, unknown>;
  if (o.type === "from_table" && Array.isArray(o.name) && o.name.length === 1 && o.name[0] === name) return true;
  for (const k of Object.keys(o)) {
    if (referencesRelation(o[k], name)) return true;
  }
  return false;
}

function applyCteColumnNames(rel: Relation, cte: CommonTableExpr): Relation {
  const columns = rel.columns.map((c, i) => ({
    name: cte.columns?.[i] ?? c.name,
    type: c.type,
    table: null as string | null,
  }));
  if (cte.columns && cte.columns.length > rel.columns.length) {
    throw pgError(
      "syntax",
      `WITH query "${cte.name}" has ${rel.columns.length} columns available but ${cte.columns.length} columns specified`,
      "42P10",
    );
  }
  return { columns, rows: rel.rows };
}

export function applyWith(env: ExecEnv, w: WithClause | null): ExecEnv {
  if (!w) return env;
  const ctes = new Map(env.ctes);
  for (const cte of w.ctes) {
    const scopedEnv: ExecEnv = { ctx: env.ctx, params: env.params, ctes, outer: env.outer };
    let rel: Relation;
    if (
      w.recursive &&
      cte.query.type === "select" &&
      cte.query.body.type === "setop" &&
      cte.query.body.op === "union" &&
      referencesRelation(cte.query.body.right, cte.name)
    ) {
      rel = executeRecursiveCte(scopedEnv, cte, cte.query);
    } else if (cte.query.type === "select") {
      rel = executeSelectStmt(scopedEnv, cte.query);
    } else {
      // data-modifying CTE
      const res = runStatement(scopedEnv, cte.query);
      rel = {
        columns: res.columns.map((c) => ({ name: c.name, type: c.type, table: null })),
        rows: res.rows,
      };
    }
    ctes.set(cte.name, applyCteColumnNames(rel, cte));
  }
  return { ctx: env.ctx, params: env.params, ctes, outer: env.outer };
}

const MAX_RECURSION_ITERATIONS = 200_000;
const MAX_RECURSION_ROWS = 5_000_000;

function executeRecursiveCte(env: ExecEnv, cte: CommonTableExpr, query: SelectStmt): Relation {
  const body = query.body as SetOp;
  const base = executeBody(env, body.left);
  const columns = base.columns.map((c, i) => ({
    name: cte.columns?.[i] ?? c.name,
    type: c.type === UNKNOWN ? ("text" as TypeId) : c.type,
    table: null as string | null,
  }));
  const seen = new Set<string>();
  const keyOf = (row: Datum[]) =>
    row.map((v, i) => (v === null ? "\u0000N" : datumKey(columns[i]!.type, v))).join("\u0001");

  let result: Datum[][] = [];
  let working: Datum[][] = [];
  for (const row of base.rows) {
    if (!body.all) {
      const k = keyOf(row);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    result.push(row);
    working.push(row);
  }

  let iterations = 0;
  while (working.length > 0) {
    if (++iterations > MAX_RECURSION_ITERATIONS) {
      throw pgError("program_limit_exceeded", "recursive query iteration limit exceeded", "54000");
    }
    const iterCtes = new Map(env.ctes);
    iterCtes.set(cte.name, { columns, rows: working });
    const iterEnv: ExecEnv = { ctx: env.ctx, params: env.params, ctes: iterCtes, outer: env.outer };
    const step = executeBody(iterEnv, body.right);
    if (step.columns.length !== columns.length) {
      throw pgError("syntax", "each UNION query must have the same number of columns", "42601");
    }
    const next: Datum[][] = [];
    for (const raw of step.rows) {
      const row = raw.map((v, i) => {
        if (v === null) return null;
        const srcT = step.columns[i]!.type;
        return castTo(env.ctx, tv(srcT === UNKNOWN ? "text" : srcT, v), columns[i]!.type, {}).v;
      });
      if (!body.all) {
        const k = keyOf(row);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      next.push(row);
    }
    result = result.concat(next);
    if (result.length > MAX_RECURSION_ROWS) {
      throw pgError("program_limit_exceeded", "recursive query result too large", "54000");
    }
    working = next;
  }

  let rel: Relation = { columns, rows: result };
  if (query.orderBy.length > 0 || query.limit || query.offset) {
    // outer ORDER BY / LIMIT of the recursive CTE query itself
    const sortSpecs = outputOrderSpecs(env, rel, query.orderBy);
    if (sortSpecs.length > 0) sortRows(env, rel, sortSpecs);
    rel = applyLimitOffset(env, rel, query.limit, query.offset);
  }
  return rel;
}

// ---------------------------------------------------------------------------
// FROM clause
// ---------------------------------------------------------------------------

interface Source {
  rel: Relation;
  rangeVars: Set<string>;
}

function renameWithAliases(rel: Relation, label: string | null, colAliases: string[] | null, what: string): Relation {
  if (colAliases && colAliases.length > rel.columns.length) {
    throw pgError(
      "invalid_column_reference",
      `table "${what}" has ${rel.columns.length} columns available but ${colAliases.length} columns specified`,
      "42P10",
    );
  }
  const columns = rel.columns.map((c, i) => ({
    name: colAliases?.[i] ?? c.name,
    type: c.type === UNKNOWN ? ("text" as TypeId) : c.type,
    table: label,
  }));
  return { columns, rows: rel.rows };
}

function materializeItem(env: ExecEnv, item: FromItem, scope: RowScope | null): Source {
  switch (item.type) {
    case "from_table": {
      const label = item.alias ?? item.name[item.name.length - 1]!;
      // CTE reference (single-part names only)
      if (item.name.length === 1) {
        const cteRel = env.ctes.get(item.name[0]!);
        if (cteRel) {
          return { rel: renameWithAliases(cteRel, label, item.colAliases, label), rangeVars: new Set([label]) };
        }
      }
      const state = env.ctx.state;
      const table = state.findTable(item.name);
      if (table) {
        const rel: Relation = {
          columns: table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label })),
          rows: table.rows,
        };
        return { rel: renameWithAliases(rel, label, item.colAliases, label), rangeVars: new Set([label]) };
      }
      const view = state.findView(item.name);
      if (view) {
        let rel: Relation;
        if (view.materialized) {
          if (view.matRows === null || view.matColumns === null) {
            throw pgError(
              "object_not_in_prerequisite_state",
              `materialized view "${view.name}" has not been populated`,
              "55000",
            );
          }
          rel = {
            columns: view.matColumns.map((c) => ({ name: c.name, type: c.type, table: label })),
            rows: view.matRows,
          };
        } else {
          const viewEnv: ExecEnv = { ctx: env.ctx, params: null, ctes: new Map(), outer: null };
          rel = executeSelectStmt(viewEnv, view.query);
          rel = {
            columns: rel.columns.map((c, i) => ({
              name: view.columns?.[i] ?? c.name,
              type: c.type,
              table: label,
            })),
            rows: rel.rows,
          };
        }
        return { rel: renameWithAliases(rel, label, item.colAliases, label), rangeVars: new Set([label]) };
      }
      const resolved = state.resolveRelationSchema(item.name);
      if (resolved) {
        const cat = catalogRelation(env.ctx, resolved.schema, resolved.name);
        if (cat) {
          return { rel: renameWithAliases(cat, label, item.colAliases, label), rangeVars: new Set([label]) };
        }
      }
      throw pgError("undefined_table", `relation "${item.name.join(".")}" does not exist`, "42P01");
    }
    case "from_subquery": {
      const subEnv = childEnv(env, item.lateral ? scope : env.outer);
      const rel = executeSelectStmt(subEnv, item.query);
      const label = item.alias ?? "unnamed_subquery";
      return { rel: renameWithAliases(rel, label, item.colAliases, label), rangeVars: new Set([label]) };
    }
    case "from_func":
      return materializeFunc(env, item, scope);
    case "from_join": {
      return joinSource(env, item, scope);
    }
  }
}

function srfCallRelation(env: ExecEnv, call: Expr, scope: RowScope | null, alias: string | null): Relation {
  if (call.type !== "func") {
    // e.g. FROM (expression) is not valid; parser shouldn't produce it
    throw pgError("syntax", "unexpected expression in FROM function position");
  }
  const bare =
    call.name.length === 1
      ? call.name[0]!
      : call.name.length === 2 && call.name[0] === "pg_catalog"
        ? call.name[1]!
        : call.name[call.name.length - 1]!;
  const evalScope = makeEvalScope(env, scope);
  const args = call.args.map((a) => evalExpr(env.ctx, evalScope, a));
  const srf = getSrfFunctions().get(bare);
  if (srf) {
    const res = srf(env.ctx, args, alias ?? bare);
    return {
      columns: res.columns.map((c) => ({ name: c.name, type: c.type, table: null })),
      rows: res.rows,
    };
  }
  const userFn = resolveUserFunction(env, call.name, args.length);
  if (userFn) {
    if (userFn.returnsSet || userFn.returnsTable) {
      return callSqlFunctionSet(env, userFn, args);
    }
    const v = callSqlFunctionScalar(env, userFn, args);
    return { columns: [{ name: userFn.name, type: v.t === UNKNOWN ? "text" : v.t, table: null }], rows: [[v.v]] };
  }
  // scalar builtin in FROM: one row, one column
  const v = evalExpr(env.ctx, evalScope, call);
  return { columns: [{ name: bare, type: v.t === UNKNOWN ? "text" : v.t, table: null }], rows: [[v.v]] };
}

function materializeFunc(env: ExecEnv, item: Extract<FromItem, { type: "from_func" }>, scope: RowScope | null): Source {
  const effScope = scope ?? env.outer;
  let rel: Relation;
  if (item.rowsFrom) {
    const parts = item.rowsFrom.map((c) => srfCallRelation(env, c, effScope, null));
    const maxLen = Math.max(0, ...parts.map((p) => p.rows.length));
    const columns = parts.flatMap((p) => p.columns);
    const rows: Datum[][] = [];
    for (let i = 0; i < maxLen; i++) {
      const row: Datum[] = [];
      for (const p of parts) {
        for (let c = 0; c < p.columns.length; c++) {
          row.push(p.rows[i]?.[c] ?? null);
        }
      }
      rows.push(row);
    }
    rel = { columns, rows };
  } else {
    rel = srfCallRelation(env, item.call, effScope, item.alias);
  }
  if (item.withOrdinality) {
    rel = {
      columns: [...rel.columns, { name: "ordinality", type: "int8", table: null }],
      rows: rel.rows.map((r, i) => [...r, BigInt(i + 1)]),
    };
  }
  const label =
    item.alias ?? (item.call.type === "func" ? item.call.name[item.call.name.length - 1]! : "unnamed_function");
  return { rel: renameWithAliases(rel, label, item.colAliases, label), rangeVars: new Set([label]) };
}

function isLateralItem(item: FromItem): boolean {
  switch (item.type) {
    case "from_subquery":
      return item.lateral;
    case "from_func":
      return true; // functions in FROM may implicitly reference earlier items
    case "from_join":
      return isLateralItem(item.left) || isLateralItem(item.right);
    default:
      return false;
  }
}

function joinSource(env: ExecEnv, join: Extract<FromItem, { type: "from_join" }>, scope: RowScope | null): Source {
  const left = materializeItem(env, join.left, scope);

  let usingCols: string[] | null = join.using;
  const kind = join.kind;

  const rightIsLateral = isLateralItem(join.right);
  const buildRight = (leftScope: RowScope | null): Source => materializeItem(env, join.right, leftScope ?? scope);

  // natural join: common visible column names
  let right: Source | null = null;
  if (!rightIsLateral) right = buildRight(null);
  if (join.natural) {
    const r = right ?? buildRight(null);
    const leftNames = new Set(left.rel.columns.filter((c) => !c.hidden).map((c) => c.name));
    usingCols = r.rel.columns.filter((c) => !c.hidden && leftNames.has(c.name)).map((c) => c.name);
    right = r;
  }

  if (rightIsLateral && (kind === "right" || kind === "full")) {
    throw pgError("syntax", `LATERAL is not allowed on the right side of a ${kind.toUpperCase()} JOIN`, "42601");
  }

  const rangeVars = new Set([...left.rangeVars, ...(right ? right.rangeVars : [])]);
  if (join.usingAlias) rangeVars.add(join.usingAlias);

  const combine = (rightSrc: Source): Relation =>
    combineJoin(env, kind, left.rel, rightSrc.rel, join.on, usingCols, join.usingAlias, rangeVars);

  if (!rightIsLateral) {
    const r = right ?? buildRight(null);
    for (const rv of r.rangeVars) rangeVars.add(rv);
    return { rel: combine(r), rangeVars };
  }

  // lateral: evaluate the right side per left row
  let outColumns: Relation["columns"] | null = null;
  const rows: Datum[][] = [];
  let rvs: Set<string> | null = null;
  for (const lrow of left.rel.rows) {
    const lscope = new RowScope(left.rel.columns, lrow, env.outer, left.rangeVars);
    const r = buildRight(lscope);
    if (rvs === null) {
      rvs = r.rangeVars;
      for (const rv of r.rangeVars) rangeVars.add(rv);
    }
    const single: Relation = { columns: left.rel.columns, rows: [lrow] };
    const combined = combineJoin(env, kind, single, r.rel, join.on, usingCols, join.usingAlias, rangeVars);
    if (outColumns === null) outColumns = combined.columns;
    rows.push(...combined.rows);
  }
  if (outColumns === null) {
    // zero left rows: build the right shape once to know the columns
    const r = buildRight(
      new RowScope(
        left.rel.columns,
        left.rel.columns.map(() => null),
        env.outer,
        left.rangeVars,
      ),
    );
    for (const rv of r.rangeVars) rangeVars.add(rv);
    const combined = combineJoin(
      env,
      kind,
      { columns: left.rel.columns, rows: [] },
      r.rel,
      join.on,
      usingCols,
      join.usingAlias,
      rangeVars,
    );
    outColumns = combined.columns;
  }
  return { rel: { columns: outColumns, rows }, rangeVars };
}

function combineJoin(
  env: ExecEnv,
  kind: "inner" | "left" | "right" | "full" | "cross",
  left: Relation,
  right: Relation,
  on: Expr | null,
  using: string[] | null,
  usingAlias: string | null,
  rangeVars: Set<string>,
): Relation {
  const ctx = env.ctx;
  let columns: Relation["columns"];
  let usingLeftIdx: number[] = [];
  let usingRightIdx: number[] = [];

  if (using && using.length > 0) {
    usingLeftIdx = using.map((u) => {
      const i = left.columns.findIndex((c) => !c.hidden && c.name === u);
      if (i === -1) {
        throw pgError(
          "undefined_column",
          `column "${u}" specified in USING clause does not exist in left table`,
          "42703",
        );
      }
      return i;
    });
    usingRightIdx = using.map((u) => {
      const i = right.columns.findIndex((c) => !c.hidden && c.name === u);
      if (i === -1) {
        throw pgError(
          "undefined_column",
          `column "${u}" specified in USING clause does not exist in right table`,
          "42703",
        );
      }
      return i;
    });
    const merged = using.map((u, k) => {
      const lt = left.columns[usingLeftIdx[k]!]!.type;
      const rt = right.columns[usingRightIdx[k]!]!.type;
      const t = unifyTypes(lt, rt);
      if (t === null) {
        throw pgError("datatype_mismatch", `JOIN/USING types ${lt} and ${rt} cannot be matched`, "42804");
      }
      return { name: u, type: t, table: usingAlias, hidden: false };
    });
    const usingSet = new Set(using);
    columns = [
      ...merged,
      ...left.columns.map((c) => ({ ...c, hidden: c.hidden || usingSet.has(c.name) })),
      ...right.columns.map((c) => ({ ...c, hidden: c.hidden || usingSet.has(c.name) })),
    ];
  } else {
    columns = [...left.columns, ...right.columns];
  }

  const mergedCount = using?.length ?? 0;
  const rows: Datum[][] = [];
  const rightMatched: boolean[] = new Array(right.rows.length).fill(false);

  const emit = (lrow: Datum[] | null, rrow: Datum[] | null) => {
    const row: Datum[] = [];
    for (let k = 0; k < mergedCount; k++) {
      const lv = lrow?.[usingLeftIdx[k]!] ?? null;
      const rv = rrow?.[usingRightIdx[k]!] ?? null;
      row.push(lrow !== null ? lv : rv);
    }
    for (let i = 0; i < left.columns.length; i++) row.push(lrow?.[i] ?? null);
    for (let i = 0; i < right.columns.length; i++) row.push(rrow?.[i] ?? null);
    rows.push(row);
  };

  const matchRows = (lrow: Datum[], rrow: Datum[]): boolean => {
    if (using && using.length > 0) {
      for (let k = 0; k < using.length; k++) {
        const lv = lrow[usingLeftIdx[k]!] ?? null;
        const rv = rrow[usingRightIdx[k]!] ?? null;
        if (lv === null || rv === null) return false;
        const t = columns[k]!.type;
        const lc = castTo(ctx, tv(left.columns[usingLeftIdx[k]!]!.type, lv), t, {}).v;
        const rc = castTo(ctx, tv(right.columns[usingRightIdx[k]!]!.type, rv), t, {}).v;
        if (lc === null || rc === null) return false;
        if (datumCompare(t, lc, rc, ctx) !== 0) return false;
      }
      return true;
    }
    if (on === null) return true; // cross join
    const row: Datum[] = [];
    for (let k = 0; k < mergedCount; k++) row.push(null);
    for (let i = 0; i < left.columns.length; i++) row.push(lrow[i] ?? null);
    for (let i = 0; i < right.columns.length; i++) row.push(rrow[i] ?? null);
    const jscope = new RowScope(columns, row, env.outer, rangeVars);
    return evalPredicate(env, jscope, on);
  };

  for (const lrow of left.rows) {
    let matched = false;
    for (let ri = 0; ri < right.rows.length; ri++) {
      const rrow = right.rows[ri]!;
      if (matchRows(lrow, rrow)) {
        matched = true;
        rightMatched[ri] = true;
        emit(lrow, rrow);
      }
    }
    if (!matched && (kind === "left" || kind === "full")) {
      emit(lrow, null);
    }
  }
  if (kind === "right" || kind === "full") {
    for (let ri = 0; ri < right.rows.length; ri++) {
      if (!rightMatched[ri]) emit(null, right.rows[ri]!);
    }
  }
  return { columns, rows };
}

export function buildFrom(env: ExecEnv, items: FromItem[]): Source {
  if (items.length === 0) {
    return { rel: { columns: [], rows: [[]] }, rangeVars: new Set() };
  }
  let acc: Source | null = null;
  for (const item of items) {
    if (acc === null) {
      acc = materializeItem(env, item, env.outer);
      continue;
    }
    const accRel: Relation = acc.rel;
    const accVars: Set<string> = acc.rangeVars;
    if (isLateralItem(item)) {
      // per-row evaluation with the accumulated columns in scope
      let cols: Relation["columns"] | null = null;
      const rows: Datum[][] = [];
      let vars: Set<string> = accVars;
      for (const lrow of accRel.rows) {
        const lscope = new RowScope(accRel.columns, lrow, env.outer, accVars);
        const src = materializeItem(env, item, lscope);
        vars = new Set([...accVars, ...src.rangeVars]);
        if (cols === null) cols = [...accRel.columns, ...src.rel.columns];
        for (const rrow of src.rel.rows) {
          rows.push([...lrow, ...rrow]);
        }
      }
      if (cols === null) {
        const probe = materializeItem(
          env,
          item,
          new RowScope(
            accRel.columns,
            accRel.columns.map(() => null),
            env.outer,
            accVars,
          ),
        );
        cols = [...accRel.columns, ...probe.rel.columns];
        vars = new Set([...accVars, ...probe.rangeVars]);
      }
      acc = { rel: { columns: cols, rows }, rangeVars: vars };
    } else {
      const src = materializeItem(env, item, env.outer);
      const cols = [...accRel.columns, ...src.rel.columns];
      const rows: Datum[][] = [];
      for (const lrow of accRel.rows) {
        for (const rrow of src.rel.rows) {
          rows.push([...lrow, ...rrow]);
        }
      }
      acc = { rel: { columns: cols, rows }, rangeVars: new Set([...accVars, ...src.rangeVars]) };
    }
  }
  return acc!;
}

// ---------------------------------------------------------------------------
// aggregate / grouping machinery
// ---------------------------------------------------------------------------

interface AggCollector {
  aggs: FuncCall[];
  windows: FuncCall[];
  groupings: Expr[];
}

function collectCalls(e: Expr | null | undefined, out: AggCollector): void {
  if (!e || typeof e !== "object") return;
  if (e.type === "subquery_expr") return; // separate query level
  if (e.type === "func") {
    const name = e.name[e.name.length - 1]!;
    if (e.over) {
      if (!out.windows.includes(e)) out.windows.push(e);
      // window args/spec may contain aggregates
      for (const a of e.args) collectCalls(a, out);
      if (e.filter) collectCalls(e.filter, out);
      for (const p of e.over.partitionBy ?? []) collectCalls(p, out);
      for (const ob of e.over.orderBy ?? []) collectCalls(ob.expr, out);
      return;
    }
    if (isAggregateName(name)) {
      if (!out.aggs.includes(e)) out.aggs.push(e);
      // do not descend into aggregate arguments
      if (e.filter) collectCalls(e.filter, out);
      return;
    }
  }
  if (e.type === "grouping_func") {
    out.groupings.push(e);
    return;
  }
  for (const value of Object.values(e as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v && typeof v === "object" && "type" in (v as object)) collectCalls(v as Expr, out);
        else if (v && typeof v === "object") {
          // OrderByItem / when-then pairs etc.
          for (const inner of Object.values(v as Record<string, unknown>)) {
            if (inner && typeof inner === "object" && "type" in (inner as object)) collectCalls(inner as Expr, out);
          }
        }
      }
    } else if (value && typeof value === "object" && "type" in (value as object)) {
      collectCalls(value as Expr, out);
    }
  }
}

/** expand GROUP BY items into grouping sets (lists of key expressions) */
function expandGroupItems(
  items: GroupItem[],
  targets: SelectTarget[],
  canResolve: (parts: string[]) => boolean,
): Expr[][] {
  const resolveExpr = (e: Expr): Expr => {
    if (e.type === "number_lit" && /^\d+$/.test(e.raw)) {
      const k = Number(e.raw);
      const t = targets[k - 1];
      if (!t || t.expr.type === "star") {
        throw pgError("invalid_column_reference", `GROUP BY position ${k} is not in select list`, "42P10");
      }
      return t.expr;
    }
    if (e.type === "colref" && e.parts.length === 1 && !canResolve(e.parts)) {
      const alias = e.parts[0]!;
      const matches = targets.filter((t) => t.alias === alias);
      if (matches.length === 1) return matches[0]!.expr;
      if (matches.length > 1) {
        throw pgError("ambiguous_column", `column reference "${alias}" is ambiguous`, "42702");
      }
    }
    return e;
  };

  const setsOfItem = (item: GroupItem): Expr[][] => {
    switch (item.kind) {
      case "expr":
        return [[resolveExpr(item.expr)]];
      case "empty":
        return [[]];
      case "rollup": {
        const lists = item.items.map((group) => group.map(resolveExpr));
        const out: Expr[][] = [];
        for (let k = lists.length; k >= 0; k--) {
          out.push(lists.slice(0, k).flat());
        }
        return out;
      }
      case "cube": {
        const lists = item.items.map((group) => group.map(resolveExpr));
        const out: Expr[][] = [];
        const n = lists.length;
        for (let mask = (1 << n) - 1; mask >= 0; mask--) {
          const set: Expr[] = [];
          for (let i = 0; i < n; i++) {
            if (mask & (1 << (n - 1 - i))) set.push(...lists[i]!);
          }
          out.push(set);
        }
        return out;
      }
      case "grouping_sets": {
        const out: Expr[][] = [];
        for (const sub of item.sets) {
          // each element of GROUPING SETS is itself a list of group items
          let subSets: Expr[][] = [[]];
          for (const gi of sub) {
            const s = setsOfItem(gi);
            const next: Expr[][] = [];
            for (const a of subSets) {
              for (const b of s) next.push([...a, ...b]);
            }
            subSets = next;
          }
          out.push(...subSets);
        }
        return out;
      }
    }
  };

  // multiple top-level items combine via cartesian product
  let sets: Expr[][] = [[]];
  for (const item of items) {
    const s = setsOfItem(item);
    const next: Expr[][] = [];
    for (const a of sets) {
      for (const b of s) next.push([...a, ...b]);
    }
    sets = next;
  }
  return sets;
}

interface GroupExprDef {
  expr: Expr;
  /** resolved source column index for plain column references */
  colIdx: number | null;
}

function resolveColIdx(columns: Relation["columns"], parts: string[]): number | null {
  if (parts.length === 1) {
    const name = parts[0]!;
    let found = -1;
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i]!;
      if (!c.hidden && c.name === name) {
        if (found !== -1) return null;
        found = i;
      }
    }
    return found === -1 ? null : found;
  }
  const table = parts[parts.length - 2]!;
  const name = parts[parts.length - 1]!;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]!;
    if (c.table === table && c.name === name) return i;
  }
  return null;
}

function groupDefMatches(def: GroupExprDef, e: Expr, columns: Relation["columns"]): boolean {
  if (def.colIdx !== null && e.type === "colref") {
    return resolveColIdx(columns, e.parts) === def.colIdx;
  }
  return exprEq(def.expr, e);
}

/** one output row context: either a plain source row or an aggregated group */
interface RowCtx {
  scope: RowScope;
  grouped: boolean;
  aggMap: Map<FuncCall, TypedValue> | null;
  /** values of all group exprs; null datum when expr not in the active set */
  groupValues: TypedValue[] | null;
  activeSet: boolean[] | null;
}

function computeAggregate(env: ExecEnv, call: FuncCall, rows: RowScope[]): TypedValue {
  const ctx = env.ctx;
  const name = call.name[call.name.length - 1]!;
  const orderedSet = isOrderedSetAggregate(name);

  interface Tuple {
    args: TypedValue[];
    sortKey: TypedValue[] | null;
  }
  const orderBy = orderedSet ? (call.withinGroupOrderBy ?? []) : (call.orderBy ?? []);
  const tuples: Tuple[] = [];

  for (const rscope of rows) {
    const scope = makeEvalScope(env, rscope);
    if (call.filter) {
      const f = evalExpr(ctx, scope, call.filter);
      if (f.v !== true) continue;
    }
    let args: TypedValue[];
    if (call.star) {
      args = [];
    } else if (orderedSet) {
      const direct = call.args.map((a) => evalExpr(ctx, scope, a));
      const value = evalExpr(ctx, scope, orderBy[0]!.expr);
      args = [...direct, value];
    } else {
      args = call.args.map((a) => evalExpr(ctx, scope, a));
    }
    const sortKey = orderBy.length > 0 && !orderedSet ? orderBy.map((ob) => evalExpr(ctx, scope, ob.expr)) : null;
    tuples.push({ args, sortKey });
  }

  // ORDER BY inside aggregate
  if (orderBy.length > 0 && !orderedSet) {
    tuples.sort((a, b) => {
      for (let i = 0; i < orderBy.length; i++) {
        const ob = orderBy[i]!;
        const av = a.sortKey![i]!;
        const bv = b.sortKey![i]!;
        const dir = ob.dir ?? "asc";
        const nullsFirst = ob.nulls ? ob.nulls === "first" : dir === "desc";
        if (av.v === null || bv.v === null) {
          if (av.v === null && bv.v === null) continue;
          const nullCmp = av.v === null ? -1 : 1;
          const c = nullsFirst ? nullCmp : -nullCmp;
          if (c !== 0) return c;
          continue;
        }
        const t = unifyAggType(av.t, bv.t);
        let c = datumCompare(t === UNKNOWN ? "text" : t, av.v, bv.v, ctx);
        if (dir === "desc") c = -c;
        if (c !== 0) return c;
      }
      return 0;
    });
  }

  // ordered-set aggregates sort by the within-group value
  if (orderedSet && tuples.length > 0) {
    const ob = orderBy[0]!;
    const dir = ob.dir ?? "asc";
    const nullsFirst = ob.nulls ? ob.nulls === "first" : dir === "desc";
    const vi = call.args.length;
    tuples.sort((a, b) => {
      const av = a.args[vi]!;
      const bv = b.args[vi]!;
      if (av.v === null || bv.v === null) {
        if (av.v === null && bv.v === null) return 0;
        const nullCmp = av.v === null ? -1 : 1;
        return nullsFirst ? nullCmp : -nullCmp;
      }
      const t = unifyAggType(av.t, bv.t);
      let c = datumCompare(t === UNKNOWN ? "text" : t, av.v, bv.v, ctx);
      if (dir === "desc") c = -c;
      return c;
    });
    // nulls in the within-group value are ignored by these aggregates
  }

  // DISTINCT
  let effective = tuples;
  if (call.distinct) {
    const seen = new Set<string>();
    effective = [];
    for (const t of tuples) {
      const key = t.args
        .map((a) => (a.v === null ? "\u0000N" : datumKey(a.t === UNKNOWN ? "text" : a.t, a.v)))
        .join("\u0001");
      if (seen.has(key)) continue;
      seen.add(key);
      effective.push(t);
    }
  }

  const argCount = call.star ? 0 : orderedSet ? call.args.length + 1 : call.args.length;
  const argTypes: TypeId[] = [];
  for (let i = 0; i < argCount; i++) {
    let t: TypeId = UNKNOWN;
    for (const tuple of effective) {
      t = unifyAggType(t, tuple.args[i]!.t);
    }
    argTypes.push(t);
  }

  const acc = createAggregate(ctx, name, argTypes);
  for (const t of effective) acc.step(t.args);
  return acc.result();
}

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

export interface SortSpec {
  colIdx: number;
  dir: "asc" | "desc";
  nullsFirst: boolean;
}

export function sortRows(env: ExecEnv, rel: Relation, specs: SortSpec[]): void {
  const ctx = env.ctx;
  const indexed = rel.rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    for (const s of specs) {
      const av = a.row[s.colIdx] ?? null;
      const bv = b.row[s.colIdx] ?? null;
      if (av === null || bv === null) {
        if (av === null && bv === null) continue;
        const nullCmp = av === null ? -1 : 1;
        const c = s.nullsFirst ? nullCmp : -nullCmp;
        if (c !== 0) return c;
        continue;
      }
      const t = rel.columns[s.colIdx]!.type;
      let c = datumCompare(t === UNKNOWN ? "text" : t, av, bv, ctx);
      if (s.dir === "desc") c = -c;
      if (c !== 0) return c;
    }
    return a.i - b.i; // stable
  });
  rel.rows = indexed.map((x) => x.row);
}

function orderDirection(ob: OrderByItem): { dir: "asc" | "desc"; nullsFirst: boolean } {
  let dir: "asc" | "desc" = ob.dir ?? "asc";
  if (ob.using === ">") dir = "desc";
  else if (ob.using === "<") dir = "asc";
  const nullsFirst = ob.nulls ? ob.nulls === "first" : dir === "desc";
  return { dir, nullsFirst };
}

/** ORDER BY over a set-op/VALUES output: names, positions, or exprs over output columns */
function outputOrderSpecs(env: ExecEnv, rel: Relation, orderBy: OrderByItem[]): SortSpec[] {
  if (orderBy.length === 0) return [];
  const specs: SortSpec[] = [];
  const extraCols: Array<{ name: string; type: TypeId; table: null; hidden: true }> = [];
  const extraExprs: Expr[] = [];
  for (const ob of orderBy) {
    const { dir, nullsFirst } = orderDirection(ob);
    const pos = orderPosition(ob.expr, rel);
    if (pos !== null) {
      specs.push({ colIdx: pos, dir, nullsFirst });
      continue;
    }
    specs.push({ colIdx: rel.columns.length + extraCols.length, dir, nullsFirst });
    extraCols.push({ name: `__ord${extraCols.length}`, type: UNKNOWN, table: null, hidden: true });
    extraExprs.push(ob.expr);
  }
  if (extraExprs.length > 0) {
    const baseCols = rel.columns.slice();
    rel.columns = [...rel.columns, ...extraCols];
    rel.rows = rel.rows.map((row) => {
      const scope = new RowScope(baseCols, row, env.outer);
      const extras = extraExprs.map((e) => evalScalar(env, scope, e));
      for (let k = 0; k < extras.length; k++) {
        const col = rel.columns[baseCols.length + k]! as { type: TypeId };
        col.type = unifyAggType(col.type, extras[k]!.t);
      }
      return [...row, ...extras.map((x) => x.v)];
    });
  }
  return specs;
}

function orderPosition(e: Expr, rel: Relation): number | null {
  const visible = rel.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.hidden);
  if (e.type === "number_lit" && /^\d+$/.test(e.raw)) {
    const k = Number(e.raw);
    const v = visible[k - 1];
    if (!v) {
      throw pgError("invalid_column_reference", `ORDER BY position ${k} is not in select list`, "42P10");
    }
    return v.i;
  }
  if (e.type === "colref" && e.parts.length === 1) {
    const name = e.parts[0]!;
    const matches = visible.filter(({ c }) => c.name === name);
    if (matches.length === 1) return matches[0]!.i;
    if (matches.length > 1) {
      throw pgError("ambiguous_column", `ORDER BY "${name}" is ambiguous`, "42702");
    }
  }
  return null;
}

function stripHidden(rel: Relation): Relation {
  if (!rel.columns.some((c) => c.hidden)) return rel;
  const keep = rel.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.hidden);
  return {
    columns: keep.map(({ c }) => c),
    rows: rel.rows.map((row) => keep.map(({ i }) => row[i] ?? null)),
  };
}

function applyLimitOffset(
  env: ExecEnv,
  rel: Relation,
  limit: Expr | null,
  offset: Expr | null,
  tieSpecs?: SortSpec[],
): Relation {
  let rows = rel.rows;
  if (offset) {
    const v = evalScalar(env, env.outer, offset);
    if (v.v !== null) {
      const n = Number(castTo(env.ctx, v, "int8", {}).v as bigint);
      if (n < 0) throw pgError("invalid_row_count", "OFFSET must not be negative", "2201X");
      rows = rows.slice(n);
    }
  }
  if (limit) {
    const v = evalScalar(env, env.outer, limit);
    if (v.v !== null) {
      const n = Number(castTo(env.ctx, v, "int8", {}).v as bigint);
      if (n < 0) throw pgError("invalid_row_count", "LIMIT must not be negative", "2201W");
      let end = Math.min(n, rows.length);
      if (tieSpecs && end > 0 && end < rows.length) {
        // FETCH ... WITH TIES: extend past the limit while sort keys stay equal
        const boundary = rows[end - 1]!;
        while (end < rows.length && sortKeysEqual(env, rel, tieSpecs, boundary, rows[end]!)) end++;
      }
      rows = rows.slice(0, end);
    }
  }
  return { columns: rel.columns, rows };
}

function sortKeysEqual(env: ExecEnv, rel: Relation, specs: SortSpec[], a: Datum[], b: Datum[]): boolean {
  for (const s of specs) {
    const av = a[s.colIdx] ?? null;
    const bv = b[s.colIdx] ?? null;
    if (av === null || bv === null) {
      if (av !== bv) return false;
      continue;
    }
    const t = rel.columns[s.colIdx]!.type;
    if (datumCompare(t === UNKNOWN ? "text" : t, av, bv, env.ctx) !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// set operations / VALUES
// ---------------------------------------------------------------------------

function executeValues(env: ExecEnv, body: ValuesBody): Relation {
  const width = body.rows[0]?.length ?? 0;
  const columns: Relation["columns"] = [];
  for (let i = 0; i < width; i++) {
    columns.push({ name: `column${i + 1}`, type: UNKNOWN, table: null });
  }
  const rows: Datum[][] = [];
  const types: TypeId[] = new Array(width).fill(UNKNOWN);
  const rawRows: TypedValue[][] = [];
  for (const exprRow of body.rows) {
    if (exprRow.length !== width) {
      throw pgError("syntax", "VALUES lists must all be the same length", "42601");
    }
    const vals = exprRow.map((e) => evalScalar(env, env.outer, e));
    for (let i = 0; i < width; i++) {
      const t = unifyTypes(types[i]!, vals[i]!.t);
      if (t !== null) types[i] = t;
    }
    rawRows.push(vals);
  }
  for (const vals of rawRows) {
    rows.push(
      vals.map((v, i) => {
        const t = types[i]!;
        if (v.v === null || t === UNKNOWN) return v.v;
        return castTo(env.ctx, v, t, {}).v;
      }),
    );
  }
  for (let i = 0; i < width; i++) {
    columns[i]!.type = types[i] === UNKNOWN ? "text" : types[i]!;
  }
  return { columns, rows };
}

function setOpRelation(env: ExecEnv, op: SetOp): Relation {
  const ctx = env.ctx;
  const left = executeBody(env, op.left);
  const right = executeBody(env, op.right);
  if (left.columns.length !== right.columns.length) {
    throw pgError("syntax", `each ${op.op.toUpperCase()} query must have the same number of columns`, "42601");
  }
  const types: TypeId[] = left.columns.map((lc, i) => {
    const rc = right.columns[i]!;
    const t = unifyTypes(lc.type, rc.type);
    if (t === null) {
      throw pgError(
        "datatype_mismatch",
        `${op.op.toUpperCase()} types ${lc.type} and ${rc.type} cannot be matched`,
        "42804",
      );
    }
    return t === UNKNOWN ? "text" : t;
  });
  const columns = left.columns.map((c, i) => ({ name: c.name, type: types[i]!, table: null as string | null }));

  const normalize = (rel: Relation): Datum[][] =>
    rel.rows.map((row) =>
      row.map((v, i) => {
        if (v === null) return null;
        const srcT = rel.columns[i]!.type;
        if (srcT === types[i]) return v;
        return castTo(ctx, tv(srcT === UNKNOWN ? "text" : srcT, v), types[i]!, {}).v;
      }),
    );
  const lrows = normalize(left);
  const rrows = normalize(right);
  const keyOf = (row: Datum[]) => row.map((v, i) => (v === null ? "\u0000N" : datumKey(types[i]!, v))).join("\u0001");

  let rows: Datum[][];
  switch (op.op) {
    case "union": {
      rows = [...lrows, ...rrows];
      if (!op.all) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const k = keyOf(r);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      break;
    }
    case "intersect": {
      const rightCounts = new Map<string, number>();
      for (const r of rrows) {
        const k = keyOf(r);
        rightCounts.set(k, (rightCounts.get(k) ?? 0) + 1);
      }
      rows = [];
      const emitted = new Set<string>();
      for (const r of lrows) {
        const k = keyOf(r);
        const avail = rightCounts.get(k) ?? 0;
        if (avail <= 0) continue;
        if (op.all) {
          rightCounts.set(k, avail - 1);
          rows.push(r);
        } else if (!emitted.has(k)) {
          emitted.add(k);
          rows.push(r);
        }
      }
      break;
    }
    case "except": {
      const rightCounts = new Map<string, number>();
      for (const r of rrows) {
        const k = keyOf(r);
        rightCounts.set(k, (rightCounts.get(k) ?? 0) + 1);
      }
      rows = [];
      const emitted = new Set<string>();
      for (const r of lrows) {
        const k = keyOf(r);
        if (op.all) {
          const avail = rightCounts.get(k) ?? 0;
          if (avail > 0) {
            rightCounts.set(k, avail - 1);
            continue;
          }
          rows.push(r);
        } else {
          if (rightCounts.has(k) || emitted.has(k)) continue;
          emitted.add(k);
          rows.push(r);
        }
      }
      break;
    }
  }
  return { columns, rows };
}

export function executeBody(env: ExecEnv, body: SelectBody): Relation {
  switch (body.type) {
    case "select_core":
      return stripHidden(executeCore(env, body, []));
    case "setop":
      return setOpRelation(env, body);
    case "values":
      return executeValues(env, body);
  }
}

// ---------------------------------------------------------------------------
// SELECT core
// ---------------------------------------------------------------------------

interface ProjItem {
  name: string;
  kind: "col" | "expr" | "srf";
  colIdx: number;
  expr: Expr | null;
  hidden: boolean;
}

function expandTargets(core: SelectCore, columns: Relation["columns"]): ProjItem[] {
  const items: ProjItem[] = [];
  for (const t of core.targets) {
    if (t.expr.type === "star") {
      if (t.expr.table) {
        const label = t.expr.table[t.expr.table.length - 1]!;
        let any = false;
        for (let i = 0; i < columns.length; i++) {
          const c = columns[i]!;
          if (c.table === label) {
            any = true;
            items.push({ name: c.name, kind: "col", colIdx: i, expr: null, hidden: false });
          }
        }
        if (!any) {
          throw pgError("undefined_table", `missing FROM-clause entry for table "${label}"`, "42P01");
        }
      } else {
        for (let i = 0; i < columns.length; i++) {
          const c = columns[i]!;
          if (!c.hidden) {
            items.push({ name: c.name, kind: "col", colIdx: i, expr: null, hidden: false });
          }
        }
      }
      continue;
    }
    const name = t.alias ?? inferColumnName(t.expr);
    const isSrf =
      t.expr.type === "func" &&
      !t.expr.over &&
      t.expr.name.length === 1 &&
      isSrfName(t.expr.name[0]!) &&
      !isAggregateName(t.expr.name[0]!);
    items.push({ name, kind: isSrf ? "srf" : "expr", colIdx: -1, expr: t.expr, hidden: false });
  }
  return items;
}

export function executeCore(env0: ExecEnv, core: SelectCore, orderBy: OrderByItem[]): Relation {
  const env = env0;
  const ctx = env.ctx;

  // 1. FROM
  const source = buildFrom(env, core.from);
  const srcCols = source.rel.columns;
  const rangeVars = source.rangeVars;

  const rowScope = (row: Datum[]) => new RowScope(srcCols, row, env.outer, rangeVars);

  // 2. WHERE
  let srcRows = source.rel.rows;
  if (core.where) {
    const where = core.where;
    srcRows = srcRows.filter((row) => evalPredicate(env, rowScope(row), where));
  }

  // 3. collect aggregate / window / grouping calls
  const collector: AggCollector = { aggs: [], windows: [], groupings: [] };
  for (const t of core.targets) collectCalls(t.expr.type === "star" ? null : t.expr, collector);
  collectCalls(core.having, collector);
  for (const ob of orderBy) collectCalls(ob.expr, collector);
  if (core.distinct?.on) {
    for (const e of core.distinct.on) collectCalls(e, collector);
  }

  const grouped = core.groupBy !== null || collector.aggs.length > 0 || core.having !== null;

  // 4. build row contexts
  let ctxs: RowCtx[];
  let groupDefs: GroupExprDef[] = [];

  if (!grouped) {
    ctxs = srcRows.map((row) => ({
      scope: rowScope(row),
      grouped: false,
      aggMap: null,
      groupValues: null,
      activeSet: null,
    }));
  } else {
    const canResolve = (parts: string[]) => resolveColIdx(srcCols, parts) !== null;
    let sets: Expr[][] = core.groupBy === null ? [[]] : expandGroupItems(core.groupBy, core.targets, canResolve);
    if (core.groupDistinct) {
      const sigs = new Set<string>();
      sets = sets.filter((s) => {
        const sig = JSON.stringify(s);
        if (sigs.has(sig)) return false;
        sigs.add(sig);
        return true;
      });
    }
    // all distinct group exprs across sets
    for (const set of sets) {
      for (const e of set) {
        if (!groupDefs.some((d) => exprEq(d.expr, e))) {
          groupDefs.push({ expr: e, colIdx: e.type === "colref" ? resolveColIdx(srcCols, e.parts) : null });
        }
      }
    }
    groupDefs = groupDefs.map((d) => ({
      expr: d.expr,
      colIdx: d.expr.type === "colref" ? resolveColIdx(srcCols, d.expr.parts) : null,
    }));

    ctxs = [];
    for (const set of sets) {
      const activeSet = groupDefs.map((d) => set.some((e) => exprEq(d.expr, e)));
      // group rows by key over this set
      const groups = new Map<string, Datum[][]>();
      if (set.length === 0) {
        groups.set("", srcRows);
      } else {
        for (const row of srcRows) {
          const scope = rowScope(row);
          const key = set
            .map((e) => {
              const v = evalScalar(env, scope, e);
              return v.v === null ? "\u0000N" : datumKey(v.t === UNKNOWN ? "text" : v.t, v.v);
            })
            .join("\u0001");
          const list = groups.get(key);
          if (list) list.push(row);
          else groups.set(key, [row]);
        }
      }
      for (const rows of groups.values()) {
        const repRow = rows[0] ?? srcCols.map(() => null);
        const repScope = rowScope(repRow);
        const groupValues: TypedValue[] = groupDefs.map((d, di) => {
          if (!activeSet[di]) {
            // probe the type from the representative row when possible
            if (rows.length > 0) {
              const probe = evalScalar(env, repScope, d.expr);
              return tv(probe.t, null);
            }
            return tv(UNKNOWN, null);
          }
          if (rows.length === 0) return tv(UNKNOWN, null);
          return evalScalar(env, repScope, d.expr);
        });
        const aggMap = new Map<FuncCall, TypedValue>();
        const groupScopes = rows.map((r) => rowScope(r));
        for (const agg of collector.aggs) {
          aggMap.set(agg, computeAggregate(env, agg, groupScopes));
        }
        ctxs.push({
          scope: repScope,
          grouped: true,
          aggMap,
          groupValues,
          activeSet,
        });
      }
    }
  }

  const extrasFor = (rc: RowCtx, windowAt?: (call: FuncCall) => TypedValue | undefined): ScopeExtras => ({
    aggMap: rc.aggMap,
    windowAt,
    strictGrouping: rc.grouped,
    exprOverride: rc.grouped
      ? (e) => {
          for (let di = 0; di < groupDefs.length; di++) {
            if (groupDefMatches(groupDefs[di]!, e, srcCols)) {
              return rc.groupValues![di]!;
            }
          }
          return undefined;
        }
      : undefined,
    groupingValue: rc.grouped
      ? (e) => {
          const g = e as Extract<Expr, { type: "grouping_func" }>;
          let mask = 0;
          for (const arg of g.args) {
            const di = groupDefs.findIndex((d) => groupDefMatches(d, arg, srcCols));
            if (di === -1) {
              throw pgError(
                "grouping_error",
                "arguments to GROUPING must be grouping expressions of the associated query level",
                "42803",
              );
            }
            mask = (mask << 1) | (rc.activeSet![di] ? 0 : 1);
          }
          return tv("int4", mask);
        }
      : undefined,
  });

  // 5. HAVING
  if (core.having) {
    const having = core.having;
    ctxs = ctxs.filter((rc) => evalPredicate(env, rc.scope, having, extrasFor(rc)));
  }

  // 6. window functions
  const windowMaps = new Map<FuncCall, TypedValue[]>();
  if (collector.windows.length > 0) {
    const evalAt = (i: number, e: Expr): TypedValue => {
      const rc = ctxs[i]!;
      return evalScalar(env, rc.scope, e, extrasFor(rc));
    };
    const maps = computeWindowValues(ctx, collector.windows, ctxs.length, evalAt, core.windows);
    for (const [call, values] of maps) windowMaps.set(call, values);
  }

  // 7. projection plan
  const projItems = expandTargets(core, srcCols);
  const visibleCount = projItems.length;

  // ORDER BY resolution
  const sortSpecs: SortSpec[] = [];
  const orderExprs: Array<{ item: ProjItem; spec: SortSpec }> = [];
  for (const ob of orderBy) {
    const { dir, nullsFirst } = orderDirection(ob);
    // position
    if (ob.expr.type === "number_lit" && /^\d+$/.test(ob.expr.raw)) {
      const k = Number(ob.expr.raw);
      if (k < 1 || k > visibleCount) {
        throw pgError("invalid_column_reference", `ORDER BY position ${k} is not in select list`, "42P10");
      }
      sortSpecs.push({ colIdx: k - 1, dir, nullsFirst });
      continue;
    }
    // output name
    if (ob.expr.type === "colref" && ob.expr.parts.length === 1) {
      const name = ob.expr.parts[0]!;
      const matches = projItems.map((p, i) => ({ p, i })).filter(({ p }) => !p.hidden && p.name === name);
      if (matches.length === 1) {
        sortSpecs.push({ colIdx: matches[0]!.i, dir, nullsFirst });
        continue;
      }
      if (matches.length > 1) {
        // PG resolves ambiguous ORDER BY names against the FROM list instead
        const idx = resolveColIdx(srcCols, ob.expr.parts);
        if (idx === null) {
          throw pgError("ambiguous_column", `ORDER BY "${name}" is ambiguous`, "42702");
        }
      }
    }
    const item: ProjItem = { name: `__ord${orderExprs.length}`, kind: "expr", colIdx: -1, expr: ob.expr, hidden: true };
    const spec: SortSpec = { colIdx: projItems.length, dir, nullsFirst };
    projItems.push(item);
    sortSpecs.push(spec);
    orderExprs.push({ item, spec });
  }

  // DISTINCT ON hidden columns
  const distinctOnIdx: number[] = [];
  if (core.distinct?.on) {
    for (const e of core.distinct.on) {
      // reuse an output column when the expression matches positionally/by name
      let matched: number | null = null;
      if (e.type === "number_lit" && /^\d+$/.test(e.raw)) {
        const k = Number(e.raw);
        if (k >= 1 && k <= visibleCount) matched = k - 1;
      } else if (e.type === "colref" && e.parts.length === 1) {
        const ms = projItems
          .slice(0, visibleCount)
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p.name === e.parts[0]);
        if (ms.length === 1) {
          const cand = ms[0]!;
          if (cand.p.kind === "col" && resolveColIdx(srcCols, e.parts) === cand.p.colIdx) matched = cand.i;
          else if (cand.p.expr && exprEq(cand.p.expr, e)) matched = cand.i;
        }
      } else {
        const ms = projItems
          .slice(0, visibleCount)
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p.expr && exprEq(p.expr, e));
        if (ms.length > 0) matched = ms[0]!.i;
      }
      if (matched !== null) {
        distinctOnIdx.push(matched);
      } else {
        distinctOnIdx.push(projItems.length);
        projItems.push({ name: `__don${distinctOnIdx.length}`, kind: "expr", colIdx: -1, expr: e, hidden: true });
      }
    }
  }

  // 8. evaluate projection
  const outColumns: Relation["columns"] = projItems.map((p) => ({
    name: p.name,
    type: p.kind === "col" ? srcCols[p.colIdx]!.type : UNKNOWN,
    table: null,
    hidden: p.hidden,
  }));

  const outRows: Datum[][] = [];
  for (let i = 0; i < ctxs.length; i++) {
    const rc = ctxs[i]!;
    const extras = extrasFor(rc, (call) => windowMaps.get(call)?.[i]);
    const cells: Array<{ values: Datum[]; type: TypeId }> = [];
    let expansion = 1;
    for (const p of projItems) {
      if (p.kind === "col") {
        if (rc.grouped) {
          // a bare source column in a grouped query must be a grouping column
          const c = srcCols[p.colIdx]!;
          const pseudo: Expr = { type: "colref", parts: c.table ? [c.table, c.name] : [c.name] };
          const v = evalScalar(env, rc.scope, pseudo, extras);
          cells.push({ values: [v.v], type: v.t });
        } else {
          cells.push({ values: [rc.scope.row[p.colIdx] ?? null], type: srcCols[p.colIdx]!.type });
        }
        continue;
      }
      if (p.kind === "srf") {
        const call = p.expr as FuncCall;
        const scope = makeEvalScope(env, rc.scope, extras);
        const args = call.args.map((a) => evalExpr(ctx, scope, a));
        const srf = getSrfFunctions().get(call.name[0]!)!;
        const res = srf(ctx, args, p.name);
        if (res.columns.length === 1) {
          cells.push({ values: res.rows.map((r) => r[0] ?? null), type: res.columns[0]!.type });
        } else {
          cells.push({
            values: res.rows.map((r) => ({
              kind: "pgrecord" as const,
              types: res.columns.map((c) => c.type),
              values: r.slice(),
              names: res.columns.map((c) => c.name),
            })),
            type: "record",
          });
        }
        expansion = Math.max(expansion, res.rows.length);
        if (res.rows.length === 0) expansion = Math.max(expansion, 0);
        continue;
      }
      const v = evalScalar(env, rc.scope, p.expr!, extras);
      cells.push({ values: [v.v], type: v.t });
    }
    const hasSrf = projItems.some((p) => p.kind === "srf");
    if (hasSrf) {
      const srfLens = projItems
        .map((p, k) => ({ p, k }))
        .filter(({ p }) => p.kind === "srf")
        .map(({ k }) => cells[k]!.values.length);
      const maxLen = Math.max(0, ...srfLens);
      expansion = maxLen;
    }
    for (let e = 0; e < expansion; e++) {
      const row: Datum[] = [];
      for (let k = 0; k < projItems.length; k++) {
        const cell = cells[k]!;
        if (projItems[k]!.kind === "srf") {
          row.push(cell.values[e] ?? null);
        } else {
          row.push(cell.values[0] ?? null);
        }
      }
      outRows.push(row);
    }
    // unify column types
    for (let k = 0; k < projItems.length; k++) {
      const col = outColumns[k]!;
      col.type = unifyAggType(col.type, cells[k]!.type);
    }
  }

  // resolve UNKNOWN output types via a null probe when there were no rows
  if (ctxs.length === 0) {
    for (let k = 0; k < projItems.length; k++) {
      const p = projItems[k]!;
      if (outColumns[k]!.type !== UNKNOWN || p.kind === "col") continue;
      try {
        const probeScope = new RowScope(
          srcCols,
          srcCols.map(() => null),
          env.outer,
          rangeVars,
        );
        const v = evalScalar(env, probeScope, p.expr!, {
          aggMap: new Map(),
          windowAt: () => tv(UNKNOWN, null),
        });
        outColumns[k]!.type = v.t;
      } catch {
        outColumns[k]!.type = "text";
      }
    }
  }
  for (const c of outColumns) {
    if (c.type === UNKNOWN) c.type = "text";
  }

  let rel: Relation = { columns: outColumns, rows: outRows };

  // 9. sort
  if (sortSpecs.length > 0) {
    sortRows(env, rel, sortSpecs);
  }

  // 10. DISTINCT / DISTINCT ON
  if (core.distinct) {
    if (core.distinct.on) {
      const seen = new Set<string>();
      rel.rows = rel.rows.filter((row) => {
        const k = distinctOnIdx
          .map((ci) => {
            const v = row[ci] ?? null;
            return v === null ? "\u0000N" : datumKey(rel.columns[ci]!.type, v);
          })
          .join("\u0001");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    } else {
      const visible = rel.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.hidden);
      const seen = new Set<string>();
      rel.rows = rel.rows.filter((row) => {
        const k = visible
          .map(({ c, i }) => {
            const v = row[i] ?? null;
            return v === null ? "\u0000N" : datumKey(c.type, v);
          })
          .join("\u0001");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }

  rel = stripHidden(rel);
  return rel;
}

// ---------------------------------------------------------------------------
// top-level SELECT
// ---------------------------------------------------------------------------

export function executeSelectStmt(env0: ExecEnv, stmt: SelectStmt): Relation {
  const env = applyWith(env0, stmt.with);
  let rel: Relation;
  if (stmt.body.type === "select_core") {
    rel = executeCore(env, stmt.body, stmt.orderBy);
  } else {
    rel = executeBody(env, stmt.body);
    const specs = outputOrderSpecs(env, rel, stmt.orderBy);
    if (specs.length > 0) sortRows(env, rel, specs);
    rel = stripHidden(rel);
  }
  if (stmt.limitWithTies) {
    if (stmt.orderBy.length === 0) {
      throw pgError("syntax", "WITH TIES cannot be specified without ORDER BY clause", "42601");
    }
    // rows are already sorted; re-derive the sort key columns over the output
    const tieSpecs = outputOrderSpecs(env, rel, stmt.orderBy);
    return stripHidden(applyLimitOffset(env, rel, stmt.limit, stmt.offset, tieSpecs));
  }
  return applyLimitOffset(env, rel, stmt.limit, stmt.offset);
}

export function selectResult(env: ExecEnv, stmt: SelectStmt): ExecResult {
  return relationResult(executeSelectStmt(env, stmt), "SELECT");
}
