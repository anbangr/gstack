/**
 * Multi-round plan-review orchestration.
 *
 * Hosts the in-process round loop, triage gate, adaptive-cap logic, and
 * append-only history JSONL writer. Pairs with plan-reviewer.ts which
 * owns single-round parsing/reconciliation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { PlanReviewObjection, TriageDecision } from "./types";
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

// ---------------------------------------------------------------------------
// Triage Gate (TTY interactive)
// ---------------------------------------------------------------------------

export interface TriageGateInput {
  objections: PlanReviewObjection[];
  round: number;
  trajectory: number[];
  historyPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Indices of objections that match a prior-round rejection (for special framing). */
  reRaisedSet: Set<number>;
  /** Optional map from objection index → prior round's reject rationale. */
  priorRejectRationale?: Map<number, string>;
  /** Optional: pre-formatted reviewer assessment to show on [v]iew prose. */
  assessmentProse?: string;
}

export interface TriageGateResult {
  decisions: TriageDecision[];
  /** True when user picked [q]uit mid-triage. */
  quitEarly: boolean;
  /** True when user used [A]ccept-ALL or [R]eject-ALL. */
  fastPathed: boolean;
}

/**
 * Per-objection TTY triage gate.
 *
 * Prompts the user once per CRITICAL objection with an 8-key menu
 * (a/r/d/v/A/R/s/q). After each decision (except quit), optionally captures
 * a one-line rationale that lands in the resulting TriageDecision. Returns
 * a TriageGateResult that runPlanReviewLoop uses to write annotations and
 * decide convergence.
 *
 * Streams are injected for testability — caller is expected to pass process.stdin
 * and process.stdout in production.
 */
export async function runTriageGateTTY(
  opts: TriageGateInput,
): Promise<TriageGateResult> {
  const rl = readline.createInterface({
    input: opts.input,
    terminal: false,
  });

  // Buffer lines as they arrive so ask() can dequeue synchronously or wait.
  const lineQueue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let streamClosed = false;

  rl.on("line", (line) => {
    if (waiters.length > 0) {
      const resolve = waiters.shift()!;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on("close", () => {
    streamClosed = true;
    // Drain any pending waiters with empty string (EOF).
    while (waiters.length > 0) {
      const resolve = waiters.shift()!;
      resolve("");
    }
  });

  const ask = (q: string): Promise<string> => {
    opts.output.write(q);
    return new Promise((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift()!);
      } else if (streamClosed) {
        resolve("");
      } else {
        waiters.push(resolve);
      }
    });
  };

  const decisions: TriageDecision[] = [];
  let quitEarly = false;
  let fastPathed = false;
  let stopRemaining = false;

  opts.output.write(
    `\n═══════════════════════════════════════════════════════════════════════\n` +
      `[plan-review] Round ${opts.round} — ${opts.objections.length} CRITICAL objection(s)\n` +
      `Trajectory so far: ${opts.trajectory.join(" → ")}\n` +
      `History: ${opts.historyPath}\n` +
      `═══════════════════════════════════════════════════════════════════════\n`,
  );

  for (let i = 0; i < opts.objections.length; i++) {
    const o = opts.objections[i];
    if (stopRemaining) {
      decisions.push({ objectionIndex: i, decision: "accept", rationale: "" });
      continue;
    }
    const isReRaise = opts.reRaisedSet.has(i);
    const reRaiseFraming = isReRaise
      ? `\nObjection ${i + 1} of ${opts.objections.length} — CRITICAL (RE-RAISED from prior round)\n` +
        (opts.priorRejectRationale?.has(i)
          ? `  Prior round: user rejected with rationale:\n               "${opts.priorRejectRationale.get(i)}"\n`
          : "")
      : `\nObjection ${i + 1} of ${opts.objections.length} — CRITICAL\n`;

    opts.output.write(
      `${reRaiseFraming}` +
        `  Location:    ${o.location}\n` +
        `  Issue:       ${o.issue}\n` +
        `  Suggestion:  ${o.suggestion}\n\n` +
        `  [a]ccept  [r]eject  [d]efer  [v]iew prose  [A]ccept ALL  [R]eject ALL  [s]top  [q]uit\n`,
    );

    let decision: TriageDecision["decision"] | null = null;
    while (decision === null) {
      const ans = (await ask("  Decision (a/r/d/v/A/R/s/q): ")).trim();
      switch (ans) {
        case "a": decision = "accept"; break;
        case "r": decision = "reject"; break;
        case "d": decision = "defer"; break;
        case "v":
          opts.output.write(
            `\n  Reviewer's Overall Assessment:\n` +
              `  ${(opts.assessmentProse ?? "(no assessment captured)").replace(/\n/g, "\n  ")}\n\n`,
          );
          // Re-loop for an actual decision.
          break;
        case "A":
          fastPathed = true;
          decisions.push({ objectionIndex: i, decision: "accept", rationale: "" });
          for (let j = i + 1; j < opts.objections.length; j++) {
            decisions.push({ objectionIndex: j, decision: "accept", rationale: "" });
          }
          rl.close();
          return { decisions, quitEarly: false, fastPathed: true };
        case "R":
          fastPathed = true;
          decisions.push({ objectionIndex: i, decision: "reject", rationale: "" });
          for (let j = i + 1; j < opts.objections.length; j++) {
            decisions.push({ objectionIndex: j, decision: "reject", rationale: "" });
          }
          rl.close();
          return { decisions, quitEarly: false, fastPathed: true };
        case "s":
          stopRemaining = true;
          decision = "accept";
          break;
        case "q":
          quitEarly = true;
          rl.close();
          return { decisions, quitEarly: true, fastPathed: false };
        default:
          opts.output.write(`  Invalid input '${ans}'. Try again.\n`);
      }
    }

    const rationale = (await ask("  Rationale (optional, one line): ")).trim();
    decisions.push({ objectionIndex: i, decision, rationale });
  }

  rl.close();
  opts.output.write(
    `\n═══════════════════════════════════════════════════════════════════════\n` +
      `[plan-review] Round ${opts.round} triage complete.\n` +
      `  Accepted: ${decisions.filter((d) => d.decision === "accept").length}\n` +
      `  Rejected: ${decisions.filter((d) => d.decision === "reject").length}\n` +
      `  Deferred: ${decisions.filter((d) => d.decision === "defer").length}\n` +
      `═══════════════════════════════════════════════════════════════════════\n`,
  );
  return { decisions, quitEarly: false, fastPathed };
}

// ---------------------------------------------------------------------------
// Triage Gate (non-TTY: CI, scripts, agent harnesses)
// ---------------------------------------------------------------------------

/**
 * Non-interactive triage mode. Mirrors the existing IMPORTANT-objection
 * auto-accept default in plan-reviewer.ts, extended to CRITICAL objections
 * for the multi-round loop.
 *
 * - "auto-accept": accept every CRITICAL, proceed to re-synth (recommended for CI)
 * - "fail-fast": exit code 3 immediately on first round with CRITICAL (stricter CI)
 * - "auto-reject": reject every CRITICAL, annotate, proceed (escape hatch)
 */
export type NonInteractiveMode = "auto-accept" | "fail-fast" | "auto-reject";

export interface NonTTYTriageResult {
  decisions: TriageDecision[];
  shouldFailFast: boolean;
}

/**
 * Non-interactive triage gate. Synchronous — no readline, no streams.
 *
 * Called by runPlanReviewLoop when process.stdin is not a TTY (typical for
 * CI runs and agent harnesses). The mode is set via the
 * --plan-review-noninteractive CLI flag (default: auto-accept).
 *
 * Returns:
 * - decisions: per-objection TriageDecision[] (one per input objection, or
 *   empty for fail-fast / empty input)
 * - shouldFailFast: true only when mode === "fail-fast" AND objections is non-empty
 */
export function runTriageGateNonTTY(opts: {
  objections: PlanReviewObjection[];
  mode: NonInteractiveMode;
}): NonTTYTriageResult {
  if (opts.objections.length === 0) {
    return { decisions: [], shouldFailFast: false };
  }
  if (opts.mode === "fail-fast") {
    return { decisions: [], shouldFailFast: true };
  }
  const decision: TriageDecision["decision"] =
    opts.mode === "auto-accept" ? "accept" : "reject";
  return {
    decisions: opts.objections.map((_o, i) => ({
      objectionIndex: i,
      decision,
      rationale: `non-interactive ${opts.mode}`,
    })),
    shouldFailFast: false,
  };
}
