import { type CatalogSection, section } from "../scenario-types.ts";

const D = "documented_divergence" as const;
const SNAP_NOTE = "custom PGMM codec, no oracle analog";
const EXTRA = ["tests/contract/snapshots/"];

export const SNP_SECTION: CatalogSection = section("SNP", "Snapshot / restore", true, [
  ["rt-01", "round-trip schema and rows", D, SNAP_NOTE, EXTRA],
  ["rt-02", "round-trip all datum kinds", D, SNAP_NOTE, EXTRA],
  ["rt-03", "round-trip sequence counters", D, SNAP_NOTE, EXTRA],
  ["rt-04", "round-trip PRNG and clock", D, SNAP_NOTE, EXTRA],
  ["rt-05", "round-trip enums domains views functions", D, SNAP_NOTE, EXTRA],
  ["byte-01", "byte-identical snapshots for equivalent state", D, SNAP_NOTE, EXTRA],
  ["hdr-01", "PGMM magic and LE u32 version", D, SNAP_NOTE, EXTRA],
  ["hdr-02", "corrupt magic errors distinctly", D, SNAP_NOTE, EXTRA],
  ["hdr-03", "truncated blob errors", D, SNAP_NOTE, EXTRA],
  ["hdr-04", "future version raises snapshot_version", D, SNAP_NOTE, EXTRA],
  ["txn-01", "restore during transaction errors", D, SNAP_NOTE, EXTRA],
  ["rep-01", "restore replaces entire state", D, SNAP_NOTE, EXTRA],
]);
