import type { Expr, SelectStmt } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parse } from "../parser/index.ts";
import type { FunctionData, TableData, TriggerMeta } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import type { Datum } from "../types/value.ts";
import { type ExecEnv, RowScope } from "./relation.ts";
import { evalPredicate, evalScalar } from "./select.ts";
import { setTriggerExecutor, type TriggerEvent } from "./triggers.ts";

/**
 * plpgsql-lite: a minimal interpreter for trigger function bodies. Supports
 * `BEGIN ... END` with `NEW.col := expr` assignments, `RETURN NEW|OLD|NULL`,
 * `IF/ELSIF/ELSE/END IF`, `NULL;`, and `RAISE EXCEPTION 'msg'`.
 */

type PlStmt =
  | { kind: "assign"; target: string[]; expr: Expr }
  | { kind: "return"; what: "new" | "old" | "null" }
  | { kind: "if"; branches: Array<{ cond: Expr; body: PlStmt[] }>; elseBody: PlStmt[] }
  | { kind: "null" }
  | { kind: "raise"; message: string };

interface Tok {
  type: string;
  value: string;
  pos: number;
}

class PlParser {
  private tokens: Tok[];
  private pos = 0;
  constructor(private readonly src: string) {
    this.tokens = tokenize(src);
  }

  private peek(offset = 0): Tok {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }
  private next(): Tok {
    const t = this.peek();
    if (t.type !== "eof") this.pos++;
    return t;
  }
  private atKw(kw: string): boolean {
    const t = this.peek();
    return t.type === "ident" && t.value === kw;
  }
  private expectKw(kw: string): void {
    if (!this.atKw(kw)) throw unsupported(`trigger body: expected "${kw.toUpperCase()}" near "${this.peek().value}"`);
    this.pos++;
  }
  private expectSemi(): void {
    const t = this.next();
    if (t.type !== "punct" || t.value !== ";") throw unsupported(`trigger body: expected ";" near "${t.value}"`);
  }

  parseBody(): PlStmt[] {
    if (this.atKw("declare")) throw unsupported("trigger body: DECLARE section");
    this.expectKw("begin");
    const stmts = this.parseStmts();
    this.expectKw("end");
    if (this.peek().type === "punct" && this.peek().value === ";") this.pos++;
    if (this.peek().type !== "eof") throw unsupported(`trigger body: trailing content near "${this.peek().value}"`);
    return stmts;
  }

  private parseStmts(): PlStmt[] {
    const out: PlStmt[] = [];
    while (!this.atKw("end") && !this.atKw("elsif") && !this.atKw("else") && this.peek().type !== "eof") {
      out.push(this.parseStmt());
    }
    return out;
  }

  private parseStmt(): PlStmt {
    if (this.atKw("return")) {
      this.pos++;
      const t = this.next();
      let what: "new" | "old" | "null";
      if (t.type === "ident" && (t.value === "new" || t.value === "old" || t.value === "null")) {
        what = t.value;
      } else {
        throw unsupported(`trigger body: RETURN ${t.value}`);
      }
      this.expectSemi();
      return { kind: "return", what };
    }
    if (this.atKw("if")) {
      this.pos++;
      const branches: Array<{ cond: Expr; body: PlStmt[] }> = [];
      let elseBody: PlStmt[] = [];
      const cond = this.parseExprUntilKw("then");
      branches.push({ cond, body: this.parseStmts() });
      while (this.atKw("elsif")) {
        this.pos++;
        const c = this.parseExprUntilKw("then");
        branches.push({ cond: c, body: this.parseStmts() });
      }
      if (this.atKw("else")) {
        this.pos++;
        elseBody = this.parseStmts();
      }
      this.expectKw("end");
      this.expectKw("if");
      this.expectSemi();
      return { kind: "if", branches, elseBody };
    }
    if (this.atKw("null")) {
      this.pos++;
      this.expectSemi();
      return { kind: "null" };
    }
    if (this.atKw("raise")) {
      this.pos++;
      // RAISE [EXCEPTION|NOTICE|...] 'message' [, args] [USING ...];
      if (this.peek().type === "ident") this.pos++;
      let message = "";
      while (!(this.peek().type === "punct" && this.peek().value === ";") && this.peek().type !== "eof") {
        const t = this.next();
        if (t.type === "string" && message === "") message = t.value;
      }
      this.expectSemi();
      return { kind: "raise", message: message || "raised exception" };
    }
    // assignment: target[.field] := expr ;
    const target: string[] = [];
    const first = this.next();
    if (first.type !== "ident" && first.type !== "quoted_ident") {
      throw unsupported(`trigger body statement near "${first.value}"`);
    }
    target.push(first.type === "ident" ? first.value : first.value);
    while (this.peek().type === "punct" && this.peek().value === ".") {
      this.pos++;
      const f = this.next();
      target.push(f.value);
    }
    const opTok = this.next();
    if (!(opTok.type === "op" && (opTok.value === ":=" || opTok.value === "="))) {
      throw unsupported(`trigger body: expected assignment near "${opTok.value}"`);
    }
    const expr = this.parseExprUntilSemi();
    return { kind: "assign", target, expr };
  }

  /** Slice raw source from the current token to the terminator and parse as a SQL expression. */
  private parseExprUntilSemi(): Expr {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw unsupported("trigger body: unterminated statement");
      if (t.type === "punct" && t.value === "(") depth++;
      if (t.type === "punct" && t.value === ")") depth--;
      if (t.type === "punct" && t.value === ";" && depth === 0) {
        const text = this.src.slice(start, t.pos);
        this.pos++;
        return parseSqlExpr(text);
      }
      this.pos++;
    }
  }

  private parseExprUntilKw(kw: string): Expr {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw unsupported(`trigger body: expected "${kw.toUpperCase()}"`);
      if (t.type === "punct" && t.value === "(") depth++;
      if (t.type === "punct" && t.value === ")") depth--;
      if (t.type === "ident" && t.value === kw && depth === 0) {
        const text = this.src.slice(start, t.pos);
        this.pos++;
        return parseSqlExpr(text);
      }
      this.pos++;
    }
  }
}

function parseSqlExpr(text: string): Expr {
  const stmts = parse(`SELECT ${text}`);
  const sel = stmts[0] as SelectStmt;
  const body = sel.body as { targets?: Array<{ expr: Expr }> };
  const target = body.targets?.[0];
  if (!target) throw unsupported(`trigger body expression "${text}"`);
  return target.expr;
}

const bodyCache = new Map<string, PlStmt[]>();

function compiledBody(fn: FunctionData): PlStmt[] {
  const raw = fn.rawBody;
  if (raw === null) throw unsupported(`trigger function ${fn.name} has no body`);
  let cached = bodyCache.get(raw);
  if (cached === undefined) {
    cached = new PlParser(raw).parseBody();
    bodyCache.set(raw, cached);
  }
  return cached;
}

class ReturnSignal {
  constructor(readonly row: Datum[] | null) {}
}

function runTriggerBody(
  env: ExecEnv,
  table: TableData,
  stmts: PlStmt[],
  vars: { newRow: Datum[] | null; oldRow: Datum[] | null },
): void {
  const scope = (): RowScope => triggerScope(table, vars.newRow, vars.oldRow);

  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assign": {
        if (stmt.target.length !== 2 || stmt.target[0] !== "new") {
          throw unsupported(`trigger body: assignment to "${stmt.target.join(".")}"`);
        }
        if (vars.newRow === null) {
          throw pgError("object_not_in_prerequisite_state", `record "new" is not assigned yet`, "55000");
        }
        const colName = stmt.target[1]!;
        const idx = table.columns.findIndex((c) => c.name === colName);
        if (idx === -1) {
          throw pgError("undefined_column", `record "new" has no field "${colName}"`, "42703");
        }
        const v = evalScalar(env, scope(), stmt.expr);
        vars.newRow = vars.newRow.slice();
        vars.newRow[idx] =
          v.v === null ? null : castTo(env.ctx, v, table.columns[idx]!.type.id, { assignment: true }).v;
        break;
      }
      case "return":
        throw new ReturnSignal(stmt.what === "new" ? vars.newRow : stmt.what === "old" ? vars.oldRow : null);
      case "if": {
        let taken = false;
        for (const b of stmt.branches) {
          if (evalPredicate(env, scope(), b.cond)) {
            runTriggerBody(env, table, b.body, vars);
            taken = true;
            break;
          }
        }
        if (!taken) runTriggerBody(env, table, stmt.elseBody, vars);
        break;
      }
      case "null":
        break;
      case "raise":
        throw pgError("raise_exception", stmt.message, "P0001");
    }
  }
}

function triggerScope(table: TableData, newRow: Datum[] | null, oldRow: Datum[] | null): RowScope {
  const cols: Array<{ name: string; type: import("../types/value.ts").TypeId; table: string | null }> = [];
  const row: Datum[] = [];
  const rangeVars = new Set<string>();
  if (newRow) {
    rangeVars.add("new");
    for (let i = 0; i < table.columns.length; i++) {
      cols.push({ name: table.columns[i]!.name, type: table.columns[i]!.type.id, table: "new" });
      row.push(newRow[i] ?? null);
    }
  }
  if (oldRow) {
    rangeVars.add("old");
    for (let i = 0; i < table.columns.length; i++) {
      cols.push({ name: table.columns[i]!.name, type: table.columns[i]!.type.id, table: "old" });
      row.push(oldRow[i] ?? null);
    }
  }
  return new RowScope(cols, row, null, rangeVars);
}

function executeTrigger(
  env: ExecEnv,
  table: TableData,
  trigger: TriggerMeta,
  _event: TriggerEvent,
  oldRow: Datum[] | null,
  newRow: Datum[] | null,
): Datum[] | null {
  const state = env.ctx.state;
  if (trigger.when !== null && !evalPredicate(env, triggerScope(table, newRow, oldRow), trigger.when)) {
    return newRow; // WHEN false: trigger does not fire; row passes through unchanged
  }
  const fns = state.schemas.get(trigger.funcSchema)?.functions.get(trigger.funcName);
  const fn = fns?.[0];
  if (!fn) {
    throw pgError("undefined_function", `function ${trigger.funcSchema}.${trigger.funcName}() does not exist`, "42883");
  }
  const stmts = compiledBody(fn);
  const vars = { newRow: newRow ? newRow.slice() : null, oldRow };
  try {
    runTriggerBody(env, table, stmts, vars);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.row;
    throw e;
  }
  throw pgError("invalid_function_definition", `control reached end of trigger procedure without RETURN`, "2F005");
}

setTriggerExecutor(executeTrigger);
