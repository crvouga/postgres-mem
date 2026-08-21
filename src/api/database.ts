import { PostgresError, pgError } from "../errors/error.ts";
import type { ExecEnv } from "../executor/relation.ts";
import { executeCopyFromData, txManagerFor } from "../executor/session.ts";
import { EngineCtx } from "../expressions/context.ts";
import { parse } from "../parser/index.ts";
import {
  type Clock,
  type DatabaseOptions,
  DEFAULT_DATABASE_SEED,
  OsEntropy,
  Prng,
  type RandomMode,
  resolveClock,
} from "../runtime/index.ts";
import { DatabaseState } from "../storage/database-state.ts";
import type { TransactionManager } from "../transactions/manager.ts";
import type { BindValue, QueryRow } from "./bind.ts";
import { Statement } from "./statement.ts";

/**
 * Pure TypeScript in-memory PostgreSQL database.
 *
 * Deterministic by default: `random()` / `gen_random_uuid()` use a seeded PRNG
 * (`seed` defaults to `1`) and `now()` / `current_timestamp` use a fixed clock
 * (`2000-01-01T00:00:00.000Z`). Pass `{ random: "os" }` and `{ now: "system" }`
 * for PostgreSQL-like entropy and wall-clock time. No filesystem, no WASM.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/postgres-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL)");
 * db.prepare("INSERT INTO users (name) VALUES ($1)").run("Alice");
 * const users = db.query<{ id: number; name: string }>("SELECT * FROM users");
 * ```
 */
export class Database {
  /** @internal Engine catalog, tables, session settings. */
  readonly state: DatabaseState;
  /** Seed used to construct the PRNG. Ignored when {@link randomMode} is `"os"`. */
  readonly seed: number | bigint;
  /** Entropy mode for `random()` / `gen_random_uuid()`. */
  readonly randomMode: RandomMode;
  /** @internal true when `now` follows the wall clock. */
  readonly systemClock: boolean;
  /** @internal PRNG backing `random()` and friends. */
  readonly prng: Prng;
  /** @internal Clock used by `now()` / `current_timestamp`. */
  now: Clock;
  /** @internal Transaction / savepoint manager. */
  readonly transactions: TransactionManager;
  private closed = false;
  private transactionSequence = 0;
  private apiTransactionDepth = 0;

  constructor(options: DatabaseOptions = {}) {
    this.seed = options.seed ?? DEFAULT_DATABASE_SEED;
    this.randomMode = options.random ?? "deterministic";
    this.systemClock = options.now === "system";
    this.prng = this.randomMode === "os" ? new OsEntropy() : new Prng(this.seed);
    this.now = resolveClock(options.now);
    this.state = new DatabaseState(this.prng, () => this.now());
    this.transactions = txManagerFor(this.state);
  }

  /**
   * Execute SQL for its side effects. Multiple semicolon-separated statements
   * are allowed. Does not accept bind parameters — use {@link prepare} / {@link query}.
   */
  exec(sql: string): void {
    this.assertOpen();
    // biome-ignore lint/complexity/noArguments: intentional arity check for the frozen exec(sql) signature
    if (arguments.length > 1) {
      throw pgError("misuse", "exec() does not accept parameters; use prepare() or query()", "XX000");
    }
    Statement.createFromSql(this, sql).run();
  }

  /** Execute a single-statement query and return all rows keyed by column name. */
  query<T = QueryRow>(sql: string, params: readonly BindValue[] = []): T[] {
    this.assertOpen();
    return this.prepareSingle(sql).all<T>(...params);
  }

  /** Compile a single SQL statement into a reusable {@link Statement}. */
  prepare(sql: string): Statement {
    this.assertOpen();
    return this.prepareSingle(sql);
  }

  /**
   * Run `fn` inside a transaction. Commits on success; rolls back if `fn`
   * throws. Nested calls use savepoints.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.apiTransactionDepth++;
    try {
      if (!this.transactions.inTransaction) {
        this.transactions.begin();
        try {
          const value = fn();
          this.transactions.commit();
          return value;
        } catch (error) {
          this.transactions.rollback();
          throw error;
        }
      }
      const name = `__api_transaction_${++this.transactionSequence}`;
      this.transactions.savepoint(name);
      try {
        const value = fn();
        this.transactions.releaseSavepoint(name);
        return value;
      } catch (error) {
        this.transactions.rollbackToSavepoint(name);
        this.transactions.releaseSavepoint(name);
        throw error;
      }
    } finally {
      this.apiTransactionDepth--;
    }
  }

  /**
   * Serialize schema, rows, PRNG state, and clock into a `PGMM` snapshot blob.
   * Restore with {@link restore}. Not an on-disk PostgreSQL format.
   */
  snapshot(): Uint8Array {
    this.assertOpen();
    const { encodeDatabaseState } = requireCodec();
    return encodeDatabaseState(this.state, {
      prngState: this.prng.getState(),
      nowMs: this.now().getTime(),
    });
  }

  /** Replace this database's contents with a blob from {@link snapshot}. */
  restore(snapshot: Uint8Array): void {
    this.assertOpen();
    if (this.transactions.inTransaction) {
      throw pgError("transaction_state", "cannot restore during a transaction", "25P01");
    }
    const { decodeDatabaseState } = requireCodec();
    const decoded = decodeDatabaseState(snapshot, this.prng, () => this.now());
    this.state.restoreFrom(decoded.state);
    if (decoded.runtime) {
      this.prng.setState(decoded.runtime.prngState);
      if (!this.systemClock) {
        const ms = decoded.runtime.nowMs;
        this.now = () => new Date(ms);
      }
    }
  }

  /** Close the database. Further SQL throws. Idempotent. */
  close(): void {
    if (this.closed) return;
    if (this.apiTransactionDepth > 0) {
      throw pgError("misuse", "cannot close database inside transaction()", "XX000");
    }
    if (this.transactions.inTransaction) this.transactions.rollback();
    this.closed = true;
  }

  /**
   * Execute `COPY table [(cols)] FROM STDIN` with the given text/csv payload
   * (the API-level analog of psql's `\copy` / the wire-protocol copy-in stream).
   * Returns the number of rows copied.
   *
   * @example
   * ```ts
   * db.copyFrom("COPY t (a, b) FROM STDIN", "1\tx\n2\ty\n");
   * ```
   */
  copyFrom(sql: string, data: string): number {
    this.assertOpen();
    const statements = parse(sql);
    const stmt = statements[0];
    if (statements.length !== 1 || !stmt || stmt.type !== "copy" || stmt.direction !== "from") {
      throw pgError("misuse", "copyFrom() requires a single COPY ... FROM STDIN statement", "XX000");
    }
    const env: ExecEnv = { ctx: new EngineCtx(this.state), params: null, ctes: new Map(), outer: null };
    return executeCopyFromData(env, stmt, data).rowCount;
  }

  /** Rows affected by the most recent INSERT / UPDATE / DELETE. */
  get changes(): number {
    this.assertOpen();
    return this.state.changes;
  }

  /** @internal */
  assertOpen(): void {
    if (this.closed) throw pgError("misuse", "Database is closed", "XX000");
  }

  private prepareSingle(sql: string): Statement {
    const statements = parse(sql);
    if (statements.length === 0) {
      throw pgError("misuse", "empty statement", "XX000");
    }
    if (statements.length > 1) {
      throw pgError("misuse", "query()/prepare() accept a single statement only; use exec() for scripts", "XX000");
    }
    return Statement.create(this, sql, statements);
  }
}

/**
 * Snapshot codec indirection: implemented by src/serialization/codec.ts
 * (registered at module load); throws until that module is present.
 * @internal
 */
interface CodecModule {
  encodeDatabaseState(state: DatabaseState, runtime: { prngState: bigint; nowMs: number }): Uint8Array;
  decodeDatabaseState(
    bytes: Uint8Array,
    prng: Prng,
    clock: Clock,
  ): { state: DatabaseState; runtime: { prngState: bigint; nowMs: number } | null };
}

let codec: CodecModule | null = null;

/** @internal registered by serialization/codec.ts */
export function registerCodec(m: CodecModule): void {
  codec = m;
}

function requireCodec(): CodecModule {
  if (!codec) {
    throw new PostgresError("unsupported", "snapshot codec not loaded");
  }
  return codec;
}

const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
if (typeof disposeKey === "symbol") {
  Object.defineProperty(Database.prototype, disposeKey, {
    value: function (this: Database): void {
      this.close();
    },
    writable: true,
    configurable: true,
  });
}

export type { DatabaseOptions };
