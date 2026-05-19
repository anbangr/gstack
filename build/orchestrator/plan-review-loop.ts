/**
 * Multi-round plan-review orchestration.
 *
 * Hosts the in-process round loop, triage gate, adaptive-cap logic, and
 * append-only history JSONL writer. Pairs with plan-reviewer.ts which
 * owns single-round parsing/reconciliation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface HistoryEntry {
  round: number;
  /** ISO 8601 UTC timestamp. */
  ts: string;
  reviewedBy: string;
  verdict: "APPROVE" | "REVISE" | "INTERRUPTED";
  /** Raw CRITICAL count before triage. */
  objectionCountRaw: number;
  critical: number;
  important: number;
  suggestion: number;
  /** Triage decisions for this round, or null when no triage happened (APPROVE / INTERRUPTED). */
  triage: {
    accepted: number[];
    rejected: number[];
    deferred: number[];
  } | null;
  convergence: {
    /** N(k) - N(k-1) where N = accepted count. null on round 1. */
    delta: number | null;
    noForwardProgress: boolean;
    reRaises: number;
    newObjections: number;
  };
}

/**
 * Append one history entry as a single JSON line.
 *
 * Creates the file (and parent directory) if absent. Atomic per-line via
 * appendFileSync — partial writes during crash would corrupt at most the
 * tail line, which readHistoryEntries skips.
 */
export function appendHistoryEntry(
  historyPath: string,
  entry: HistoryEntry,
): void {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Read all valid history entries. Corrupt lines are skipped with a console.warn.
 */
export function readHistoryEntries(historyPath: string): HistoryEntry[] {
  if (!fs.existsSync(historyPath)) return [];
  const text = fs.readFileSync(historyPath, "utf8");
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as HistoryEntry);
    } catch {
      console.warn(
        `[plan-review-loop] skipping corrupt history line: ${trimmed.slice(0, 80)}`,
      );
    }
  }
  return out;
}

/**
 * Round number for the next reviewer call. Reads history.jsonl; falls back to 1 when empty.
 *
 * Mirrors plan-reviewer.ts::readPlanReviewRound but uses the new history file
 * as source of truth. Cross-launch resume safe: if user Ctrl+Cs after round 2
 * and re-launches, history has 2 lines, deriveRoundNumber returns 3.
 */
export function deriveRoundNumber(entries: HistoryEntry[]): number {
  if (entries.length === 0) return 1;
  return Math.max(...entries.map((e) => e.round)) + 1;
}
