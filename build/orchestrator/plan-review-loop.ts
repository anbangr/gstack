/**
 * Multi-round plan-review orchestration.
 *
 * Hosts the in-process round loop, triage gate, adaptive-cap logic, and
 * append-only history JSONL writer. Pairs with plan-reviewer.ts which
 * owns single-round parsing/reconciliation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanReviewObjection } from "./types";
import type { RoundAnnotation, RoundAnnotationEntry } from "./plan-reviewer";

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

// ---------------------------------------------------------------------------
// Adaptive cap (set-aware: re-raises vs new objections)
// ---------------------------------------------------------------------------

export interface ConvergenceSnapshotInput {
  round: number;
  rawObjections: PlanReviewObjection[];
  /** Indices into rawObjections that the user accepted in this round. */
  acceptedIndices: number[];
  /** All round annotations parsed from the plan file BEFORE this round wrote. */
  priorAnnotations: RoundAnnotation[];
}

export interface RoundConvergenceSnapshot {
  priorRoundAccepted: number | null;
  delta: number | null;
  reRaises: number;
  newObjections: number;
  noForwardProgress: boolean;
}

/**
 * Whether a prior-round annotation entry represents a previously-accepted concern
 * that the synth was supposed to resolve. These are the entries that, if re-raised,
 * indicate the synth isn't getting the fixes done.
 */
function isPriorAcceptedResolutionAttempt(rounds: RoundAnnotationEntry[]): boolean {
  // Any round where user accepted AND the synth produced a non-pending resolution.
  return rounds.some(
    (r) =>
      r.userDecision === "accept" &&
      r.resolution !== undefined &&
      r.resolution !== "pending",
  );
}

/**
 * Compute the per-round convergence snapshot from this round's reviewer output,
 * the user's triage decisions, and the prior rounds' plan-file annotations.
 *
 * Distinguishes:
 * - re-raises: round-k accepted objections that match a prior-round
 *   accepted-and-synth-resolved entry by (location, severity)
 * - new objections: round-k accepted objections with no prior-round match
 *
 * Round-k objections whose prior match was REJECTED by the user are neither
 * re-raises nor new — the reviewer is repeating something the user already
 * dismissed, which is a reviewer-prompt-fidelity signal, not a synth-failure signal.
 */
export function computeConvergenceSnapshot(
  input: ConvergenceSnapshotInput,
): RoundConvergenceSnapshot {
  const acceptedObjections = input.acceptedIndices.map(
    (i) => input.rawObjections[i],
  );

  // Prior accepted count: for round k>=2, count prior annotations whose LAST
  // round had a userDecision === "accept".
  const priorRoundAccepted =
    input.round === 1
      ? null
      : input.priorAnnotations.reduce((sum, ann) => {
          const lastRound = ann.rounds[ann.rounds.length - 1];
          return lastRound?.userDecision === "accept" ? sum + 1 : sum;
        }, 0);

  let reRaises = 0;
  let newObjections = 0;
  for (const obj of acceptedObjections) {
    const match = input.priorAnnotations.find(
      (ann) => ann.location === obj.location && ann.severity === obj.severity,
    );
    if (match && isPriorAcceptedResolutionAttempt(match.rounds)) {
      // Prior match was accepted AND the synth produced a resolution attempt —
      // the synth failed to fix it. Count as a re-raise.
      reRaises += 1;
    } else {
      // No prior match, OR prior match was rejected by the user (not a synth
      // fix failure — user previously dismissed this, reviewer is re-raising
      // it, which is a reviewer-prompt-fidelity signal). Both count as new.
      newObjections += 1;
    }
  }

  const delta =
    priorRoundAccepted === null
      ? null
      : acceptedObjections.length - priorRoundAccepted;

  // Strict set-aware rule from the design spec: bail only when re-raises > 0
  // AND zero new objections were found. Forward progress in a new dimension
  // (any newObjections > 0) counts as progress even if re-raises are also present.
  const noForwardProgress = reRaises > 0 && newObjections === 0;

  return {
    priorRoundAccepted,
    delta,
    reRaises,
    newObjections,
    noForwardProgress,
  };
}

export interface AdaptiveCapInput {
  round: number;
  maxRounds: number;
  adaptiveEnabled: boolean;
  acceptedCount: number;
  priorAcceptedCount: number | null;
  reRaises: number;
  newObjections: number;
}

export interface AdaptiveCapDecision {
  action: "continue" | "bail_out_gate" | "stalemate_gate";
  /** Set only when action is bail_out_gate or stalemate_gate. */
  exitReason?: ExitReason;
}

/**
 * Decide whether to continue the loop, fire the bail-out gate, or fire the
 * stalemate gate. Implements the decision table from the design spec §"Adaptive
 * cap + stalemate exit".
 *
 * Precedence (hard cap > round-1 short-circuit > adaptive disabled > regression > stall):
 * - At MAX_ROUNDS, always stalemate (regardless of state).
 * - On round 1 (no prior round to compare), always continue.
 * - If adaptiveEnabled is false, only the hard cap fires.
 * - Regression (accepted count strictly increased) triggers adaptive_cap_regression.
 * - Set-aware stall (reRaises > 0 AND newObjections === 0) triggers
 *   adaptive_cap_re_raises_only.
 */
export function shouldBailAdaptive(
  input: AdaptiveCapInput,
): AdaptiveCapDecision {
  if (input.round >= input.maxRounds) {
    return { action: "stalemate_gate", exitReason: "max_rounds_hit" };
  }
  if (input.round === 1 || input.priorAcceptedCount === null) {
    return { action: "continue" };
  }
  if (!input.adaptiveEnabled) {
    return { action: "continue" };
  }
  if (input.acceptedCount > input.priorAcceptedCount) {
    return { action: "bail_out_gate", exitReason: "adaptive_cap_regression" };
  }
  if (input.reRaises > 0 && input.newObjections === 0) {
    return {
      action: "bail_out_gate",
      exitReason: "adaptive_cap_re_raises_only",
    };
  }
  return { action: "continue" };
}
