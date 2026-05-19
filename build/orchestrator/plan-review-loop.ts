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

// ---------------------------------------------------------------------------
// Convergence aggregate (cross-build telemetry)
// ---------------------------------------------------------------------------

/**
 * Why a build's plan-review loop exited. Routed into `convergence.jsonl` for
 * tuning analysis — each value names a distinct exit path so post-hoc queries
 * can distinguish "stuck loop" from "user gave up" from "model error".
 */
export type ExitReason =
  | "approved"
  | "adaptive_cap_re_raises_only"
  | "adaptive_cap_regression"
  | "max_rounds_hit"
  | "user_manual"
  | "user_abort"
  | "sigint"
  | "reviewer_unavailable";

/**
 * One row written to `~/.gstack/analytics/convergence.jsonl` per completed build.
 * Aggregates the per-round HistoryEntry data into a build-level summary so
 * cross-build trends (median round count, stalemate rate, etc.) can be computed
 * with simple jq queries.
 *
 * Per-round detail lives in plan-review-history.jsonl; this is the summary.
 */
export interface ConvergenceAggregate {
  /** ISO 8601 UTC timestamp of build completion. */
  ts: string;
  slug: string;
  branch: string;
  /** Number of reviewer rounds executed (including final APPROVE round, if any). */
  rounds: number;
  finalVerdict: "APPROVE" | "STALEMATE" | "ABORTED" | "INTERRUPTED";
  exitReason: ExitReason;
  /** Raw CRITICAL count per round (pre-triage). */
  trajectoryRaw: number[];
  /** Accepted CRITICAL per round (post-triage). */
  trajectoryAccepted: number[];
  reRaises: number[];
  reRejected: number[];
  disputedResolutions: number[];
  totalAccepted: number;
  totalRejected: number;
  totalDeferred: number;
  reviewer: string;
  synthesizer: string;
  wallTimeS: number;
  reviewerWallTimeS: number;
  synthWallTimeS: number;
  planFileSizeBytes: number[];
  interrupted: boolean;
  annotationParseErrors: number;
}

/**
 * Append one aggregate record to the analytics file.
 *
 * Best-effort: write failures (disk full, permission denied, parent path is a
 * regular file, etc.) log a console.warn but never throw. Aggregate analytics
 * are nice-to-have for tuning; a failed write must not crash a build that just
 * succeeded.
 */
export function writeConvergenceAggregate(
  aggregatePath: string,
  agg: ConvergenceAggregate,
): void {
  try {
    fs.mkdirSync(path.dirname(aggregatePath), { recursive: true });
    fs.appendFileSync(aggregatePath, `${JSON.stringify(agg)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[plan-review-loop] failed to write convergence aggregate: ${(err as Error).message}`,
    );
  }
}
