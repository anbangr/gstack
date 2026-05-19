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
import type {
  PlanReviewObjection,
  PlanReviewVerdict,
  TriageDecision,
} from "./types";
import {
  parseRoundAnnotations,
  writeRoundAnnotation,
  updateRoundHistoryHeader,
  type RoundAnnotation,
  type RoundAnnotationEntry,
  type RoundHistoryEntry,
} from "./plan-reviewer";

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
  /**
   * Optional injected line-prompt function. When provided, this overrides the
   * built-in readline creation. The runPlanReviewLoop wires a single shared
   * readline through every gate call so the stream isn't consumed-and-closed
   * between rounds. Standalone callers (existing tests) leave this undefined
   * and the gate manages its own readline.
   */
  askFn?: (q: string) => Promise<string>;
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
  // When the caller injected askFn (runPlanReviewLoop case), reuse it so the
  // shared readline doesn't get torn down between rounds. Otherwise stand up
  // a local readline for backwards-compat with standalone-call tests.
  let rl: readline.Interface | null = null;
  let ask: (q: string) => Promise<string>;
  if (opts.askFn) {
    ask = opts.askFn;
  } else {
    rl = readline.createInterface({ input: opts.input, terminal: false });
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
    ask = (q: string): Promise<string> => {
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
  }

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
          rl?.close();
          return { decisions, quitEarly: false, fastPathed: true };
        case "R":
          fastPathed = true;
          decisions.push({ objectionIndex: i, decision: "reject", rationale: "" });
          for (let j = i + 1; j < opts.objections.length; j++) {
            decisions.push({ objectionIndex: j, decision: "reject", rationale: "" });
          }
          rl?.close();
          return { decisions, quitEarly: false, fastPathed: true };
        case "s":
          stopRemaining = true;
          decision = "accept";
          break;
        case "q":
          quitEarly = true;
          rl?.close();
          return { decisions, quitEarly: true, fastPathed: false };
        default:
          opts.output.write(`  Invalid input '${ans}'. Try again.\n`);
      }
    }

    const rationale = (await ask("  Rationale (optional, one line): ")).trim();
    decisions.push({ objectionIndex: i, decision, rationale });
  }

  rl?.close();
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

// ---------------------------------------------------------------------------
// The main in-process round loop
// ---------------------------------------------------------------------------

export interface RunPlanReviewLoopInput {
  planPath: string;
  historyPath: string;
  aggregatePath: string;
  slug: string;
  branch: string;
  /** Injected: invoke reviewer subagent and parse result. */
  reviewerFn: (round: number) => Promise<PlanReviewVerdict>;
  /** Injected: invoke synthesizer subagent against the plan file (which now has annotations). */
  synthFn: () => Promise<{ ok: boolean }>;
  maxRounds: number;
  adaptiveEnabled: boolean;
  nonInteractiveMode: NonInteractiveMode;
  isTTY: boolean;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  reviewerName: string;
  synthesizerName: string;
}

export type LoopOutcome =
  | "approved"
  | "adaptive_cap_re_raises_only"
  | "adaptive_cap_regression"
  | "max_rounds_hit"
  | "user_manual"
  | "user_abort"
  | "sigint"
  | "reviewer_unavailable";

export interface RunPlanReviewLoopResult {
  outcome: LoopOutcome;
  rounds: number;
  exitCode: 0 | 1 | 3 | 4 | 130;
  /** Final verdict for the legacy plan-review-report.json file in cli.ts. */
  finalVerdict: PlanReviewVerdict;
}

/**
 * In-process plan-review loop. Eliminates re-launch overhead between rounds.
 *
 * Composes:
 * - reviewerFn (cli.ts wraps runPlanReview from plan-reviewer.ts)
 * - runTriageGateTTY / runTriageGateNonTTY (depending on isTTY)
 * - writeRoundAnnotation per accepted/rejected/deferred decision
 * - updateRoundHistoryHeader (top-of-plan summary block)
 * - computeConvergenceSnapshot + shouldBailAdaptive
 * - appendHistoryEntry (per-round JSONL)
 * - synthFn (cli.ts wraps runConfiguredRoleTask with SYNTH_REVISION_PROMPT)
 * - runStalemateGate on adaptive bail OR MAX_ROUNDS
 * - writeConvergenceAggregate on every exit path
 *
 * Returns RunPlanReviewLoopResult with exit code + outcome + final verdict.
 */
export async function runPlanReviewLoop(
  input: RunPlanReviewLoopInput,
): Promise<RunPlanReviewLoopResult> {
  // Single shared readline + ask function for the entire loop. The gates
  // (TTY triage + stalemate) reuse this so the input stream isn't consumed
  // and torn down between rounds — a per-call readline would drain the
  // whole buffered stream on the first close, starving later rounds. Only
  // created when isTTY; non-TTY paths never call ask().
  let sharedRl: readline.Interface | null = null;
  let sharedAsk: ((q: string) => Promise<string>) | undefined;
  if (input.isTTY) {
    sharedRl = readline.createInterface({ input: input.input, terminal: false });
    const lineQueue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    let streamClosed = false;
    sharedRl.on("line", (line) => {
      if (waiters.length > 0) waiters.shift()!(line);
      else lineQueue.push(line);
    });
    sharedRl.on("close", () => {
      streamClosed = true;
      while (waiters.length > 0) waiters.shift()!("");
    });
    sharedAsk = (q: string): Promise<string> => {
      input.output.write(q);
      return new Promise((resolve) => {
        if (lineQueue.length > 0) resolve(lineQueue.shift()!);
        else if (streamClosed) resolve("");
        else waiters.push(resolve);
      });
    };
  }

  const startMs = Date.now();
  const trajectoryRaw: number[] = [];
  const trajectoryAccepted: number[] = [];
  const reRaisesArr: number[] = [];
  const reRejectedArr: number[] = [];
  // disputed_resolutions placeholder — Task 11 wires the real count after synth.
  const disputedResolutions: number[] = [];
  const planFileSizeBytes: number[] = [];
  let totalAccepted = 0;
  let totalRejected = 0;
  let totalDeferred = 0;
  let reviewerWallTimeS = 0;
  let synthWallTimeS = 0;
  const annotationParseErrors = 0;
  const interrupted = false;
  let lastVerdict: PlanReviewVerdict | null = null;

  // Track per-objection rejection rationales across rounds for re-raise framing.
  // Key: `${location}|${severity}`. Value: rationale string the user provided.
  const priorRejectRationale = new Map<string, string>();

  const finalResult = (
    outcome: LoopOutcome,
    rounds: number,
    exitCode: 0 | 1 | 3 | 4 | 130,
    finalVerdict: PlanReviewVerdict,
  ): RunPlanReviewLoopResult => {
    sharedRl?.close();
    return { outcome, rounds, exitCode, finalVerdict };
  };

  const writeAggregate = (args: {
    outcome: LoopOutcome;
    round: number;
    verdict: "APPROVE" | "STALEMATE" | "ABORTED" | "INTERRUPTED";
  }) => {
    const totalWall = Math.round((Date.now() - startMs) / 1000);
    writeConvergenceAggregate(input.aggregatePath, {
      ts: new Date().toISOString(),
      slug: input.slug,
      branch: input.branch,
      rounds: args.round,
      finalVerdict: args.verdict,
      exitReason: args.outcome as ExitReason,
      trajectoryRaw,
      trajectoryAccepted,
      reRaises: reRaisesArr,
      reRejected: reRejectedArr,
      disputedResolutions,
      totalAccepted,
      totalRejected,
      totalDeferred,
      reviewer: input.reviewerName,
      synthesizer: input.synthesizerName,
      wallTimeS: totalWall,
      reviewerWallTimeS,
      synthWallTimeS,
      planFileSizeBytes,
      interrupted,
      annotationParseErrors,
    });
  };

  for (let round = 1; round <= input.maxRounds; round++) {
    // 1. Reviewer call.
    const reviewStart = Date.now();
    const verdict = await input.reviewerFn(round);
    reviewerWallTimeS += Math.round((Date.now() - reviewStart) / 1000);
    lastVerdict = verdict;

    planFileSizeBytes.push(
      fs.existsSync(input.planPath) ? fs.statSync(input.planPath).size : 0,
    );

    // Reviewer unavailable: exit clean as APPROVE (existing semantics).
    if (verdict.reviewedBy === "skipped-unavailable") {
      appendHistoryEntry(input.historyPath, {
        round,
        ts: new Date().toISOString(),
        reviewedBy: verdict.reviewedBy,
        verdict: "APPROVE",
        objectionCountRaw: 0,
        critical: 0,
        important: 0,
        suggestion: 0,
        triage: null,
        convergence: {
          delta: null,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 0,
        },
      });
      writeAggregate({ outcome: "reviewer_unavailable", round, verdict: "APPROVE" });
      return finalResult("reviewer_unavailable", round, 0, verdict);
    }

    const critical = verdict.objections.filter((o) => o.severity === "CRITICAL");
    trajectoryRaw.push(critical.length);

    // APPROVE round — write history, write aggregate, exit clean.
    if (verdict.verdict === "APPROVE" || critical.length === 0) {
      appendHistoryEntry(input.historyPath, {
        round,
        ts: new Date().toISOString(),
        reviewedBy: verdict.reviewedBy,
        verdict: "APPROVE",
        objectionCountRaw: 0,
        critical: 0,
        important: 0,
        suggestion: 0,
        triage: null,
        convergence: {
          delta: null,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 0,
        },
      });
      trajectoryAccepted.push(0);
      reRaisesArr.push(0);
      reRejectedArr.push(0);
      disputedResolutions.push(0);
      input.output.write(`[plan-review] APPROVED after ${round} round(s)\n`);
      writeAggregate({ outcome: "approved", round, verdict: "APPROVE" });
      return finalResult("approved", round, 0, verdict);
    }

    // 2. Parse prior annotations from the plan for re-raise detection.
    const planText = fs.readFileSync(input.planPath, "utf8");
    const priorAnnotations = parseRoundAnnotations(planText);
    const reRaisedIdx = new Set<number>();
    critical.forEach((c, i) => {
      const match = priorAnnotations.find(
        (ann) => ann.location === c.location && ann.severity === c.severity,
      );
      if (match) {
        const lastRound = match.rounds[match.rounds.length - 1];
        if (lastRound?.userDecision === "reject") reRaisedIdx.add(i);
      }
    });

    // 3. Triage gate (TTY or non-TTY).
    let triageResult: { decisions: TriageDecision[]; quitEarly: boolean };
    if (input.isTTY) {
      const priorRejectMap = new Map<number, string>();
      for (const i of reRaisedIdx) {
        const c = critical[i];
        const key = `${c.location}|${c.severity}`;
        priorRejectMap.set(i, priorRejectRationale.get(key) ?? "");
      }
      const ttyResult = await runTriageGateTTY({
        objections: critical,
        round,
        trajectory: trajectoryRaw,
        historyPath: input.historyPath,
        input: input.input,
        output: input.output,
        reRaisedSet: reRaisedIdx,
        priorRejectRationale: priorRejectMap,
        assessmentProse: verdict.assessment,
        askFn: sharedAsk,
      });
      triageResult = { decisions: ttyResult.decisions, quitEarly: ttyResult.quitEarly };
    } else {
      const ntty = runTriageGateNonTTY({
        objections: critical,
        mode: input.nonInteractiveMode,
      });
      if (ntty.shouldFailFast) {
        appendHistoryEntry(input.historyPath, {
          round,
          ts: new Date().toISOString(),
          reviewedBy: verdict.reviewedBy,
          verdict: "REVISE",
          objectionCountRaw: critical.length,
          critical: critical.length,
          important: 0,
          suggestion: 0,
          triage: null,
          convergence: {
            delta: null,
            noForwardProgress: false,
            reRaises: 0,
            newObjections: 0,
          },
        });
        writeAggregate({ outcome: "user_manual", round, verdict: "STALEMATE" });
        return finalResult("user_manual", round, 3, verdict);
      }
      triageResult = { decisions: ntty.decisions, quitEarly: false };
    }

    if (triageResult.quitEarly) {
      writeAggregate({ outcome: "user_abort", round, verdict: "ABORTED" });
      return finalResult("user_abort", round, 4, verdict);
    }

    // 4. Apply triage decisions to plan annotations.
    let updatedPlan = fs.readFileSync(input.planPath, "utf8");
    const acceptedIdx: number[] = [];
    const rejectedIdx: number[] = [];
    const deferredIdx: number[] = [];
    for (const d of triageResult.decisions) {
      const o = critical[d.objectionIndex];
      const ann: RoundAnnotation = {
        location: o.location,
        severity: o.severity,
        issue: o.issue,
        suggestion: o.suggestion,
        rounds: [
          {
            round,
            userDecision: d.decision,
            userRationale: d.rationale ?? "",
            resolution: d.decision === "accept" ? "pending" : undefined,
            reviewerOutcome: reRaisedIdx.has(d.objectionIndex)
              ? "re-raised"
              : undefined,
          },
        ],
      };
      updatedPlan = writeRoundAnnotation(updatedPlan, ann);
      if (d.decision === "accept") acceptedIdx.push(d.objectionIndex);
      if (d.decision === "reject") {
        rejectedIdx.push(d.objectionIndex);
        priorRejectRationale.set(`${o.location}|${o.severity}`, d.rationale ?? "");
      }
      if (d.decision === "defer") deferredIdx.push(d.objectionIndex);
    }
    fs.writeFileSync(input.planPath, updatedPlan, "utf8");
    totalAccepted += acceptedIdx.length;
    totalRejected += rejectedIdx.length;
    totalDeferred += deferredIdx.length;
    trajectoryAccepted.push(acceptedIdx.length);

    // 5. Compute convergence snapshot.
    const snap = computeConvergenceSnapshot({
      round,
      rawObjections: critical,
      acceptedIndices: acceptedIdx,
      priorAnnotations,
    });
    reRaisesArr.push(snap.reRaises);
    // re-rejected = round-k REJECTED objections whose index is in reRaisedIdx.
    const reRejCount = rejectedIdx.filter((i) => reRaisedIdx.has(i)).length;
    reRejectedArr.push(reRejCount);

    // 6. Append per-round history line.
    appendHistoryEntry(input.historyPath, {
      round,
      ts: new Date().toISOString(),
      reviewedBy: verdict.reviewedBy,
      verdict: "REVISE",
      objectionCountRaw: critical.length,
      critical: critical.length,
      important: 0,
      suggestion: 0,
      triage: {
        accepted: acceptedIdx,
        rejected: rejectedIdx,
        deferred: deferredIdx,
      },
      convergence: {
        delta: snap.delta,
        noForwardProgress: snap.noForwardProgress,
        reRaises: snap.reRaises,
        newObjections: snap.newObjections,
      },
    });

    // 7. Update top-of-plan history header.
    const histEntry: RoundHistoryEntry = {
      round,
      ts: new Date().toISOString(),
      reviewer: verdict.reviewedBy,
      verdict: "REVISE",
      criticalCount: critical.length,
      accepted: acceptedIdx.length,
      rejected: rejectedIdx.length,
      deferred: deferredIdx.length,
    };
    const planAfterHistory = updateRoundHistoryHeader(
      fs.readFileSync(input.planPath, "utf8"),
      histEntry,
    );
    fs.writeFileSync(input.planPath, planAfterHistory, "utf8");

    // 8. Check adaptive cap.
    const decision = shouldBailAdaptive({
      round,
      maxRounds: input.maxRounds,
      adaptiveEnabled: input.adaptiveEnabled,
      acceptedCount: acceptedIdx.length,
      priorAcceptedCount: snap.priorRoundAccepted,
      reRaises: snap.reRaises,
      newObjections: snap.newObjections,
    });
    if (decision.action !== "continue") {
      const userChoice = await runStalemateGate({
        round,
        trajectoryRaw,
        trajectoryAccepted,
        reRaises: reRaisesArr,
        reason: decision.exitReason!,
        isTTY: input.isTTY,
        nonInteractiveMode: input.nonInteractiveMode,
        input: input.input,
        output: input.output,
        askFn: sharedAsk,
      });
      if (userChoice === "continue") {
        disputedResolutions.push(0); // synth not invoked this iteration
        continue;
      }
      let exitCode: 0 | 3 | 4 = 0;
      let outcome: LoopOutcome = "approved";
      if (userChoice === "approve_as_is") {
        outcome = "approved";
        exitCode = 0;
      } else if (userChoice === "manual") {
        outcome = "user_manual";
        exitCode = 3;
      } else if (userChoice === "abort") {
        outcome = "user_abort";
        exitCode = 4;
      }
      const aggVerdict =
        outcome === "approved" ? "APPROVE" :
        outcome === "user_abort" ? "ABORTED" : "STALEMATE";
      disputedResolutions.push(0);
      writeAggregate({ outcome, round, verdict: aggVerdict });
      return finalResult(outcome, round, exitCode, verdict);
    }

    // 9. Invoke synthesizer (Task 11 will instrument disputed-resolution counting here).
    const synthStart = Date.now();
    await input.synthFn();
    synthWallTimeS += Math.round((Date.now() - synthStart) / 1000);
    disputedResolutions.push(0); // placeholder; Task 11 replaces with real count
  }

  // MAX_ROUNDS reached without hitting earlier exits — fire stalemate gate.
  const userChoice = await runStalemateGate({
    round: input.maxRounds,
    trajectoryRaw,
    trajectoryAccepted,
    reRaises: reRaisesArr,
    reason: "max_rounds_hit",
    isTTY: input.isTTY,
    nonInteractiveMode: input.nonInteractiveMode,
    input: input.input,
    output: input.output,
    askFn: sharedAsk,
  });
  let exitCode: 0 | 3 | 4 = 0;
  let outcome: LoopOutcome = "max_rounds_hit";
  if (userChoice === "approve_as_is") {
    outcome = "approved";
    exitCode = 0;
  } else if (userChoice === "manual") {
    outcome = "user_manual";
    exitCode = 3;
  } else if (userChoice === "abort") {
    outcome = "user_abort";
    exitCode = 4;
  }
  const aggVerdict =
    outcome === "approved" ? "APPROVE" :
    outcome === "user_abort" ? "ABORTED" :
    "STALEMATE";
  writeAggregate({ outcome, round: input.maxRounds, verdict: aggVerdict });
  return finalResult(outcome, input.maxRounds, exitCode, lastVerdict!);
}

// ---------------------------------------------------------------------------
// Stalemate / bail-out gate (single AskUser at end of loop)
// ---------------------------------------------------------------------------

export type StalemateChoice = "approve_as_is" | "continue" | "manual" | "abort";

/**
 * AskUser at the bail-out or hard-cap exit. TTY uses readline; non-TTY maps
 * deterministically based on nonInteractiveMode.
 *
 * Uses the same line-queue/waiter pattern as runTriageGateTTY (Task 6) to
 * work around Bun's readline ERR_USE_AFTER_CLOSE when an output stream is
 * passed to createInterface and multiple .question() calls run in sequence.
 */
export async function runStalemateGate(opts: {
  round: number;
  trajectoryRaw: number[];
  trajectoryAccepted: number[];
  reRaises: number[];
  reason: ExitReason;
  isTTY: boolean;
  nonInteractiveMode: NonInteractiveMode;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /**
   * Optional injected line-prompt function. Same reasoning as TriageGateInput.askFn:
   * runPlanReviewLoop passes a shared readline-backed ask through so the bail-out
   * gate doesn't have to re-open the stream after the per-round triage gate
   * already consumed it.
   */
  askFn?: (q: string) => Promise<string>;
}): Promise<StalemateChoice> {
  const isMaxRounds = opts.reason === "max_rounds_hit";

  // Non-TTY: deterministic map per spec.
  if (!opts.isTTY) {
    if (opts.nonInteractiveMode === "fail-fast") return "manual";
    return "approve_as_is"; // auto-accept + auto-reject both land here
  }

  opts.output.write(
    `\n═══════════════════════════════════════════════════════════════════════\n` +
      (isMaxRounds
        ? `[plan-review] Hard cap reached: ${opts.round} rounds completed.\n`
        : `[plan-review] Convergence stalled at round ${opts.round}.\n`) +
      `\nTrajectory raw:      ${opts.trajectoryRaw.join(" → ")}\n` +
      `Trajectory accepted: ${opts.trajectoryAccepted.join(" → ")}\n` +
      `Re-raises:           ${opts.reRaises.join(" → ")}\n` +
      `\n[a] Approve as-is — concerns annotated in plan, proceed to implementation\n` +
      (isMaxRounds ? "" : `[c] Continue anyway — try one more round\n`) +
      `[m] Manual mode — exit 3, drop to SKILL.md.tmpl Step 5.5\n` +
      `[q] Abort — exit 4, leave state intact\n`,
  );

  // Bun readline workaround: don't pass output, use a line-queue/waiter so
  // we can call ask() multiple times without ERR_USE_AFTER_CLOSE.
  let rl: readline.Interface | null = null;
  let ask: (q: string) => Promise<string>;
  if (opts.askFn) {
    ask = opts.askFn;
  } else {
    rl = readline.createInterface({ input: opts.input, terminal: false });
    const lineQueue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    let streamClosed = false;
    rl.on("line", (line) => {
      if (waiters.length > 0) waiters.shift()!(line);
      else lineQueue.push(line);
    });
    rl.on("close", () => {
      streamClosed = true;
      while (waiters.length > 0) waiters.shift()!("");
    });
    ask = (q: string): Promise<string> => {
      opts.output.write(q);
      return new Promise((resolve) => {
        if (lineQueue.length > 0) resolve(lineQueue.shift()!);
        else if (streamClosed) resolve("");
        else waiters.push(resolve);
      });
    };
  }

  const validKeys = isMaxRounds ? ["a", "m", "q"] : ["a", "c", "m", "q"];
  try {
    while (true) {
      const ans = (await ask(`  Decision (${validKeys.join("/")}): `)).trim();
      if (!validKeys.includes(ans)) {
        opts.output.write(`  Invalid '${ans}'. Try again.\n`);
        continue;
      }
      if (ans === "a") return "approve_as_is";
      if (ans === "c") return "continue";
      if (ans === "m") return "manual";
      if (ans === "q") return "abort";
    }
  } finally {
    rl?.close();
  }
}
