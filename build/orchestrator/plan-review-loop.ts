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

/**
 * Atomic file write via tmp-rename. The standard fs.writeFileSync is not
 * crash-safe: SIGINT (or any signal) between the open and the kernel buffer
 * flush leaves a half-written file. The plan file is read by parsers that
 * silently skip malformed annotation blocks, so a half-write becomes silent
 * data loss on the next round.
 *
 * Pattern: write to a sibling tmp file, then rename. rename(2) is atomic on
 * the same filesystem on every Unix and on Windows when the target exists.
 */
function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Set up a readline-based ask() helper that handles Bun's ERR_USE_AFTER_CLOSE
 * on multi-question sequences by using a lineQueue/waiter pattern instead of
 * rl.question(). Returns { ask, close }.
 */
function makeReadlineAsk(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): { ask: (q: string) => Promise<string>; close: () => void } {
  const rl = readline.createInterface({ input, terminal: false });
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
  const ask = (q: string): Promise<string> => {
    output.write(q);
    return new Promise((resolve) => {
      if (lineQueue.length > 0) resolve(lineQueue.shift()!);
      else if (streamClosed) resolve("");
      else waiters.push(resolve);
    });
  };
  return { ask, close: () => rl.close() };
}

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
  | "reviewer_unavailable"
  /** synthFn rejected or returned ok:false — runtime failure, exit code 1. */
  | "synth_failure";

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
function isPriorAcceptedResolutionAttempt(
  rounds: RoundAnnotationEntry[],
): boolean {
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
  let close: (() => void) | null = null;
  let ask: (q: string) => Promise<string>;
  if (opts.askFn) {
    ask = opts.askFn;
  } else {
    const helper = makeReadlineAsk(opts.input, opts.output);
    ask = helper.ask;
    close = helper.close;
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
        case "a":
          decision = "accept";
          break;
        case "r":
          decision = "reject";
          break;
        case "d":
          decision = "defer";
          break;
        case "v":
          opts.output.write(
            `\n  Reviewer's Overall Assessment:\n` +
              `  ${(opts.assessmentProse ?? "(no assessment captured)").replace(/\n/g, "\n  ")}\n\n`,
          );
          // Re-loop for an actual decision.
          break;
        case "A":
          fastPathed = true;
          decisions.push({
            objectionIndex: i,
            decision: "accept",
            rationale: "",
          });
          for (let j = i + 1; j < opts.objections.length; j++) {
            decisions.push({
              objectionIndex: j,
              decision: "accept",
              rationale: "",
            });
          }
          close?.();
          return { decisions, quitEarly: false, fastPathed: true };
        case "R":
          fastPathed = true;
          decisions.push({
            objectionIndex: i,
            decision: "reject",
            rationale: "",
          });
          for (let j = i + 1; j < opts.objections.length; j++) {
            decisions.push({
              objectionIndex: j,
              decision: "reject",
              rationale: "",
            });
          }
          close?.();
          return { decisions, quitEarly: false, fastPathed: true };
        case "s":
          // User wants to stop interacting. Default the current and all
          // remaining objections to accept WITHOUT prompting for a rationale —
          // the whole point of [s]top is "no more keystrokes from me." Push
          // the current decision directly and continue the outer loop.
          stopRemaining = true;
          decisions.push({
            objectionIndex: i,
            decision: "accept",
            rationale: "stop-and-default-accept",
          });
          // Use a sentinel that skips the rationale prompt below.
          decision = "__stop_no_rationale__" as TriageDecision["decision"];
          break;
        case "q":
          quitEarly = true;
          close?.();
          return { decisions, quitEarly: true, fastPathed: false };
        default:
          if (ans === "") {
            // Stream closed (Ctrl+D, pipe end, terminal disconnect). The
            // readline `close` event has set streamClosed=true and ask()
            // is now resolving with "" immediately. Without this guard,
            // the while-loop spins at 100% CPU forever printing "Invalid
            // input ''. Try again.". Treat as [q]uit.
            quitEarly = true;
            close?.();
            return { decisions, quitEarly: true, fastPathed: false };
          }
          opts.output.write(`  Invalid input '${ans}'. Try again.\n`);
      }
    }

    // [s]top path already pushed its decision; skip the rationale prompt.
    if ((decision as string) === "__stop_no_rationale__") continue;

    const rationale = (await ask("  Rationale (optional, one line): ")).trim();
    decisions.push({ objectionIndex: i, decision, rationale });
  }

  close?.();
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

export type LoopOutcome = ExitReason;

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
  let sharedClose: (() => void) | null = null;
  let sharedAsk: ((q: string) => Promise<string>) | undefined;
  if (input.isTTY) {
    const helper = makeReadlineAsk(input.input, input.output);
    sharedAsk = helper.ask;
    sharedClose = helper.close;
  }

  const startMs = Date.now();
  const trajectoryRaw: number[] = [];
  const trajectoryAccepted: number[] = [];
  const reRaisesArr: number[] = [];
  const reRejectedArr: number[] = [];
  // Per-round count of synth-marked "disputed — <reason>" resolutions.
  // Populated in step 9a after each synthFn call.
  const disputedResolutions: number[] = [];
  const planFileSizeBytes: number[] = [];
  let totalAccepted = 0;
  let totalRejected = 0;
  let totalDeferred = 0;
  let reviewerWallTimeS = 0;
  let synthWallTimeS = 0;
  let annotationParseErrors = 0;
  let lastVerdict: PlanReviewVerdict | null = null;

  // Track per-objection rejection rationales across rounds for re-raise framing.
  // Key: `${location}|${severity}`. Value: rationale string the user provided.
  const priorRejectRationale = new Map<string, string>();

  // Resume support: if history.jsonl already has entries (because a prior
  // invocation exited via code 3 / user_manual / max_rounds_hit and the user
  // re-launched), derive the next round number AND rehydrate the per-round
  // telemetry arrays so the convergence aggregate's trajectory isn't reset.
  //
  // Without this, every resume restarts round=1 and produces duplicate
  // round numbers in history.jsonl + truncated trajectory arrays in
  // convergence.jsonl — breaking re-raise detection (priorAnnotations
  // looks at the plan file, which IS persisted, so re-raise still fires;
  // but the trajectory analysis loses prior-round signal).
  //
  // Full reRejected / disputedResolutions preservation across resume
  // requires extending HistoryEntry (out of scope here); default to 0
  // for missing fields.
  const priorEntries = readHistoryEntries(input.historyPath);
  const startRound = deriveRoundNumber(priorEntries);
  for (const e of priorEntries) {
    trajectoryRaw.push(e.critical);
    trajectoryAccepted.push(e.triage?.accepted.length ?? 0);
    reRaisesArr.push(e.convergence.reRaises);
    reRejectedArr.push(0);
    disputedResolutions.push(0);
    if (e.triage) {
      totalAccepted += e.triage.accepted.length;
      totalRejected += e.triage.rejected.length;
      totalDeferred += e.triage.deferred.length;
    }
  }

  const finalResult = (
    outcome: LoopOutcome,
    rounds: number,
    exitCode: 0 | 1 | 3 | 4 | 130,
    finalVerdict: PlanReviewVerdict,
  ): RunPlanReviewLoopResult => {
    sharedClose?.();
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
      exitReason: args.outcome,
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
      annotationParseErrors,
    });
  };

  for (let round = startRound; round <= input.maxRounds; round++) {
    // 1. Reviewer call.
    const reviewStart = Date.now();
    const verdict = await input.reviewerFn(round);
    reviewerWallTimeS += Math.round((Date.now() - reviewStart) / 1000);
    lastVerdict = verdict;

    try {
      planFileSizeBytes.push(fs.statSync(input.planPath).size);
    } catch {
      planFileSizeBytes.push(0);
    }

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
      // Maintain parallel-array length invariants with planFileSizeBytes
      // (pushed above unconditionally). Without these, downstream consumers
      // that zip these arrays by index walk off the end on the
      // reviewer_unavailable exit branch.
      trajectoryRaw.push(0);
      trajectoryAccepted.push(0);
      reRaisesArr.push(0);
      reRejectedArr.push(0);
      disputedResolutions.push(0);
      writeAggregate({
        outcome: "reviewer_unavailable",
        round,
        verdict: "APPROVE",
      });
      return finalResult("reviewer_unavailable", round, 0, verdict);
    }

    const critical = verdict.objections.filter(
      (o) => o.severity === "CRITICAL",
    );
    const important = verdict.objections.filter(
      (o) => o.severity === "IMPORTANT",
    );
    const suggestion = verdict.objections.filter(
      (o) => o.severity === "SUGGESTION",
    );
    trajectoryRaw.push(critical.length);

    // APPROVE round (or REVISE with no CRITICAL) — handle IMPORTANT/SUGGESTION
    // inline (annotate-and-proceed), write history, write aggregate, exit clean.
    if (verdict.verdict === "APPROVE" || critical.length === 0) {
      // Annotate IMPORTANT/SUGGESTION objections so the reviewer sees them next
      // round and the plan file has a record.
      //
      // Contract (mirrors pre-loop reconcilePlanReview):
      // - SUGGESTION: always auto-accepted (annotate-and-proceed), no prompt.
      // - IMPORTANT in non-TTY: auto-accept (CI / scripts contract).
      // - IMPORTANT in TTY: prompt per-objection [y]es/[n]o/[a]ll/[s]kip-all.
      //   Reject -> annotate with userDecision: "reject" (matches CRITICAL reject behavior).
      //
      // The prior version unconditionally wrote userDecision: "accept" in TTY,
      // which silently bypassed the interactive contract the user expects from
      // the pre-loop path (promptImportantObjections in plan-reviewer.ts).
      if (important.length > 0 || suggestion.length > 0) {
        // Resolve per-IMPORTANT decisions first (TTY prompt or auto-accept).
        type ImportantDecision = "accept" | "reject";
        const importantDecisions: ImportantDecision[] = new Array(
          important.length,
        ).fill("accept");

        if (input.isTTY && important.length > 0) {
          // Use shared readline if available; otherwise stand up a local one.
          let localClose: (() => void) | null = null;
          let ask: (q: string) => Promise<string>;
          if (sharedAsk) {
            ask = sharedAsk;
          } else {
            const helper = makeReadlineAsk(input.input, input.output);
            ask = helper.ask;
            localClose = helper.close;
          }
          let acceptAll = false;
          let skipAll = false;
          for (let i = 0; i < important.length; i++) {
            if (acceptAll) {
              importantDecisions[i] = "accept";
              continue;
            }
            if (skipAll) {
              importantDecisions[i] = "reject";
              continue;
            }
            const o = important[i];
            input.output.write(
              `\n[plan-review] IMPORTANT objection ${i + 1} of ${important.length}\n` +
                `  Location:   ${o.location}\n` +
                `  Issue:      ${o.issue}\n` +
                `  Fix:        ${o.suggestion}\n`,
            );
            let resolved = false;
            while (!resolved) {
              const ans = (
                await ask(`  Apply? [y]es / [n]o / [a]ll / [s]kip-all: `)
              )
                .trim()
                .toLowerCase();
              if (ans === "y" || ans === "yes") {
                importantDecisions[i] = "accept";
                resolved = true;
              } else if (ans === "n" || ans === "no") {
                importantDecisions[i] = "reject";
                resolved = true;
              } else if (ans === "a" || ans === "all") {
                importantDecisions[i] = "accept";
                acceptAll = true;
                resolved = true;
              } else if (ans === "s" || ans === "skip" || ans === "skip-all") {
                importantDecisions[i] = "reject";
                skipAll = true;
                resolved = true;
              } else if (ans === "") {
                // EOF on stdin (Ctrl+D, pipe closed) — treat as skip-all so
                // the loop doesn't spin forever printing "Invalid ''" once
                // makeReadlineAsk resolves with "" indefinitely.
                importantDecisions[i] = "reject";
                skipAll = true;
                resolved = true;
              } else {
                input.output.write(`  Invalid '${ans}'. Try again.\n`);
              }
            }
          }
          localClose?.();
        }

        let updatedPlan = fs.readFileSync(input.planPath, "utf8");
        let importantAccepted = 0;
        let importantRejected = 0;

        // Annotate IMPORTANTs with the resolved decision.
        for (let i = 0; i < important.length; i++) {
          const o = important[i];
          const dec = importantDecisions[i];
          const ann: RoundAnnotation = {
            location: o.location,
            severity: o.severity,
            issue: o.issue,
            suggestion: o.suggestion,
            rounds: [
              {
                round,
                userDecision: dec,
                userRationale: "",
                resolution: dec === "accept" ? undefined : undefined,
                reviewerOutcome: undefined,
              },
            ],
          };
          updatedPlan = writeRoundAnnotation(updatedPlan, ann);
          if (dec === "accept") importantAccepted += 1;
          else importantRejected += 1;
        }

        // SUGGESTIONs always auto-accept (no prompt).
        for (const o of suggestion) {
          const ann: RoundAnnotation = {
            location: o.location,
            severity: o.severity,
            issue: o.issue,
            suggestion: o.suggestion,
            rounds: [
              {
                round,
                userDecision: "accept",
                userRationale: `non-critical (${o.severity})`,
                resolution: undefined,
                reviewerOutcome: undefined,
              },
            ],
          };
          updatedPlan = writeRoundAnnotation(updatedPlan, ann);
        }

        atomicWriteFile(input.planPath, updatedPlan);
        input.output.write(
          `[plan-review] IMPORTANT: ${importantAccepted} accepted, ${importantRejected} rejected. SUGGESTION: ${suggestion.length} annotated.\n`,
        );
      }

      appendHistoryEntry(input.historyPath, {
        round,
        ts: new Date().toISOString(),
        reviewedBy: verdict.reviewedBy,
        verdict: verdict.verdict === "APPROVE" ? "APPROVE" : "REVISE",
        objectionCountRaw: critical.length,
        critical: 0,
        important: important.length,
        suggestion: suggestion.length,
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
      triageResult = {
        decisions: ttyResult.decisions,
        quitEarly: ttyResult.quitEarly,
      };
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
          important: important.length,
          suggestion: suggestion.length,
          triage: null,
          convergence: {
            delta: null,
            noForwardProgress: false,
            reRaises: 0,
            newObjections: 0,
          },
        });
        // Maintain parallel-array invariant on convergence aggregate.
        // trajectoryRaw already pushed above; pad the rest with sentinels.
        trajectoryAccepted.push(0);
        reRaisesArr.push(0);
        reRejectedArr.push(0);
        disputedResolutions.push(0);
        writeAggregate({ outcome: "user_manual", round, verdict: "STALEMATE" });
        return finalResult("user_manual", round, 3, verdict);
      }
      triageResult = { decisions: ntty.decisions, quitEarly: false };
    }

    if (triageResult.quitEarly) {
      // Maintain parallel-array invariant on convergence aggregate.
      // trajectoryRaw already pushed above; pad the rest with sentinels.
      trajectoryAccepted.push(0);
      reRaisesArr.push(0);
      reRejectedArr.push(0);
      disputedResolutions.push(0);
      writeAggregate({ outcome: "user_abort", round, verdict: "ABORTED" });
      return finalResult("user_abort", round, 4, verdict);
    }

    // 4. Apply triage decisions to plan annotations. Reuse planText (read above
    //    for re-raise detection) — no writes happened in between.
    let updatedPlan = planText;
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
        priorRejectRationale.set(
          `${o.location}|${o.severity}`,
          d.rationale ?? "",
        );
      }
      if (d.decision === "defer") deferredIdx.push(d.objectionIndex);
    }
    atomicWriteFile(input.planPath, updatedPlan);
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
      important: important.length,
      suggestion: suggestion.length,
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
    // updatedPlan was just written to disk; reuse the in-memory string.
    const planAfterHistory = updateRoundHistoryHeader(updatedPlan, histEntry);
    atomicWriteFile(input.planPath, planAfterHistory);

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
        outcome === "approved"
          ? "APPROVE"
          : outcome === "user_abort"
            ? "ABORTED"
            : "STALEMATE";
      disputedResolutions.push(0);
      writeAggregate({ outcome, round, verdict: aggVerdict });
      return finalResult(outcome, round, exitCode, verdict);
    }

    // 9. Invoke synthesizer.
    //
    // Wrap in try/catch so a synth failure doesn't crash the entire loop
    // mid-iteration (which would leave convergence.jsonl unwritten and the
    // plan file in whatever state the synth left it). Instead, log + push
    // a telemetry sentinel + continue. The next round's reviewer will re-read
    // the plan file and surface any structural damage as fresh objections.
    const synthStart = Date.now();
    try {
      await input.synthFn();
    } catch (err) {
      console.warn(
        `[plan-review-loop] synth failed at round ${round}: ${(err as Error).message}`,
      );
      synthWallTimeS += Math.round((Date.now() - synthStart) / 1000);
      // Push placeholder for telemetry parity. Skip step 9a (annotation
      // parse) because the plan file may be half-written from a crashed synth.
      disputedResolutions.push(0);
      continue;
    }
    synthWallTimeS += Math.round((Date.now() - synthStart) / 1000);

    // 9a. Count disputed resolutions in this round's annotations.
    // The synth writes RESOLUTION: disputed — <reason> when it disagrees
    // with a user-accepted objection. Each disputed entry surfaces in the
    // next round's triage so the user can re-decide; the aggregate count
    // is a tuning signal for "how often does synth disagree with user accepts".
    let disputedThisRound = 0;
    try {
      const postSynthText = fs.readFileSync(input.planPath, "utf8");
      const postSynthAnns = parseRoundAnnotations(postSynthText);
      for (const ann of postSynthAnns) {
        for (const r of ann.rounds) {
          if (
            r.round === round &&
            r.resolution !== undefined &&
            /^disputed\b/.test(r.resolution)
          ) {
            disputedThisRound += 1;
          }
        }
      }
    } catch (err) {
      annotationParseErrors += 1;
      console.warn(
        `[plan-review-loop] annotation parse error after synth round ${round}: ${(err as Error).message}`,
      );
    }
    disputedResolutions.push(disputedThisRound);
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
    outcome === "approved"
      ? "APPROVE"
      : outcome === "user_abort"
        ? "ABORTED"
        : "STALEMATE";
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
  let close: (() => void) | null = null;
  let ask: (q: string) => Promise<string>;
  if (opts.askFn) {
    ask = opts.askFn;
  } else {
    const helper = makeReadlineAsk(opts.input, opts.output);
    ask = helper.ask;
    close = helper.close;
  }

  const validKeys = isMaxRounds ? ["a", "m", "q"] : ["a", "c", "m", "q"];
  try {
    while (true) {
      const ans = (await ask(`  Decision (${validKeys.join("/")}): `)).trim();
      if (ans === "") {
        // EOF on stdin — treat as abort so the loop doesn't spin forever
        // printing "Invalid ''" once makeReadlineAsk's streamClosed flag
        // makes ask() resolve with "" indefinitely.
        return "abort";
      }
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
    close?.();
  }
}
