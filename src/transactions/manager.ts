import { pgError } from "../errors/error.ts";
import type { DatabaseState } from "../storage/database-state.ts";

interface Snapshot {
  state: DatabaseState;
  prngState: bigint;
}

/**
 * Single-session transaction manager: BEGIN clones the whole state (datums are
 * immutable; rows are copied), ROLLBACK restores it. Savepoints stack inner
 * snapshots. The PRNG state participates so `random()` draws rewind on
 * rollback (determinism invariant, mirrors sqlite-mem).
 */
export class TransactionManager {
  private base: Snapshot | null = null;
  private savepoints: Array<{ name: string; snap: Snapshot }> = [];

  constructor(private readonly state: DatabaseState) {}

  get inTransaction(): boolean {
    return this.base !== null;
  }

  private takeSnapshot(): Snapshot {
    return { state: this.state.clone(), prngState: this.state.prng.getState() };
  }

  private restore(snap: Snapshot): void {
    this.state.restoreFrom(snap.state);
    this.state.prng.setState(snap.prngState);
  }

  begin(): void {
    if (this.base !== null) {
      // PG raises a WARNING and keeps the transaction; we mirror the no-op
      return;
    }
    this.base = this.takeSnapshot();
    this.state.inTransaction = true;
  }

  commit(): void {
    // COMMIT outside a transaction is a WARNING no-op in PG
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.state.localSettings.clear();
  }

  rollback(): void {
    if (this.base !== null) {
      this.restore(this.base);
    }
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.state.localSettings.clear();
  }

  savepoint(name: string): void {
    if (this.base === null) {
      throw pgError("transaction_state", "SAVEPOINT can only be used in transaction blocks", "25P01");
    }
    this.savepoints.push({ name, snap: this.takeSnapshot() });
  }

  releaseSavepoint(name: string): void {
    const idx = this.findSavepoint(name);
    this.savepoints.splice(idx);
  }

  rollbackToSavepoint(name: string): void {
    const idx = this.findSavepoint(name);
    const sp = this.savepoints[idx]!;
    this.restore(sp.snap);
    // the savepoint itself survives ROLLBACK TO
    this.savepoints.splice(idx + 1);
  }

  private findSavepoint(name: string): number {
    if (this.base === null) {
      throw pgError("transaction_state", `SAVEPOINT can only be used in transaction blocks`, "25P01");
    }
    for (let i = this.savepoints.length - 1; i >= 0; i--) {
      if (this.savepoints[i]!.name === name) return i;
    }
    throw pgError("invalid_savepoint_specification", `savepoint "${name}" does not exist`, "3B001");
  }

  /** abort any open transaction without restoring (used by Database.close) */
  reset(): void {
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
  }
}
