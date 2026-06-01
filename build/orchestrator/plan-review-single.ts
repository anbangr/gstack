/**
 * Single-round plan review.
 *
 * Replaces the legacy multi-round plan-review-loop. The loop ran up to N rounds
 * and made the user triage every objection every round; this runs ONCE and only
 * escalates genuine reviewer-vs-synthesizer disagreements to the user.
 *
 * Flow:
 *   1. Reviewer runs once  → objections (CRITICAL / IMPORTANT / SUGGESTION).
 *   2. Synthesizer "checks" each CRITICAL/IMPORTANT objection → ACCEPT (agrees,
 *      will fix) or DISPUTE (disagrees, with a one-line reason).
 *   3. ACCEPTs are queued for one revision. SUGGESTIONs are annotated, never
 *      prompted (matches the legacy behavior).
 *   4. Each DISPUTE escalates to the user via a TTY readline gate:
 *        [r] side with reviewer (apply the fix)
 *        [s] side with synthesizer (drop the objection)
 *        [d] defer (annotate, drop from this build)
 *        [q] abort the build
 *      Non-TTY (CI): resolved by the --plan-review-noninteractive policy.
 *   5. One synthesizer revision applies (ACCEPTs + reviewer-sided disputes).
 *
 * No rounds, no adaptive cap, no convergence tracking, no stalemate gate — all
 * of that existed only to manage non-convergence ACROSS rounds, which a single
 * round cannot have.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import type { PlanReviewObjection, PlanReviewVerdict } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObjectionStance = "ACCEPT" | "DISPUTE";

export interface SynthStance {
  /** 0-based index into the reviewable (CRITICAL+IMPORTANT) objection list. */
  index: number;
  stance: ObjectionStance;
  /** Synthesizer's one-line rebuttal. Present (best-effort) when DISPUTE. */
  reason?: string;
}

export type DisputeResolution = "reviewer" | "synth" | "defer";

/** CI behavior when a DISPUTE lands without a TTY to prompt a human. */
export type NonInteractiveMode = "auto-accept" | "auto-reject" | "fail-fast";

export type SingleReviewOutcome =
  | "approved"
  | "revised"
  | "user_abort"
  | "synth_failure"
  | "critical_dispute";

export interface PlanReviewSingleResult {
  outcome: SingleReviewOutcome;
  /** 0 success, 1 synth failure, 3 unresolved CRITICAL dispute (CI), 4 user abort. */
  exitCode: 0 | 1 | 3 | 4;
  finalVerdict: PlanReviewVerdict;
  /** Objections that will be fixed (accepted by synth or sided-with-reviewer). */
  toFix: PlanReviewObjection[];
}

export interface RunPlanReviewSingleInput {
  planPath: string;
  /** Reviewer pass — one call, returns the verdict + objections. */
  reviewerFn: () => Promise<PlanReviewVerdict>;
  /**
   * Synthesizer check — given the reviewable objections, returns the raw agent
   * output classifying each (parsed by parseSynthCheckOutput). ok:false means
   * the agent crashed / timed out (→ synth_failure).
   */
  synthCheckFn: (
    objections: PlanReviewObjection[],
  ) => Promise<{ ok: boolean; raw: string }>;
  /**
   * Synthesizer revision — applies fixes for the given objections. ok:false
   * means the agent crashed / timed out (→ synth_failure). Not called when
   * toFix is empty.
   */
  synthFn: (toFix: PlanReviewObjection[]) => Promise<{ ok: boolean }>;
  isTTY: boolean;
  nonInteractiveMode: NonInteractiveMode;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Parse the synthesizer-check agent output into a stance per reviewable
 * objection. Expected line format (1-based index matching the prompt):
 *
 *   - STANCE 1: ACCEPT
 *   - STANCE 2: DISPUTE — <one-line reason>
 *
 * Tolerant of the em-dash or a hyphen as the reason separator, extra
 * whitespace, and a missing "- " bullet. An objection the agent classified
 * SOME but not all of defaults the unclassified ones to ACCEPT: a reviewer
 * concern the synth ignored should be fixed, not silently dropped.
 *
 * Returns `parsedCount` (how many distinct objections the agent actually
 * classified). The caller MUST treat parsedCount === 0 with objections > 0 as
 * a synth FAILURE, not unanimous agreement — a successful-but-unparseable
 * response (the agent narrated instead of emitting STANCE lines) would
 * otherwise default EVERY objection to ACCEPT and auto-rewrite the plan with
 * no human ever adjudicating, silently bypassing the dispute gate.
 */
export function parseSynthCheckOutput(
  raw: string,
  objectionCount: number,
): { stances: SynthStance[]; parsedCount: number } {
  const byIndex = new Map<number, SynthStance>();
  // Horizontal-whitespace classes ([ \t]) — never \s — so a greedy run can't
  // cross a newline and swallow the next line's "- " bullet as this line's
  // reason separator (which merged two STANCE lines into one match).
  const re =
    /^[ \t]*-?[ \t]*STANCE[ \t]+(\d+)[ \t]*:[ \t]*(ACCEPT|DISPUTE)\b[ \t]*(?:[—–-][ \t]*(.*\S))?[ \t]*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const oneBased = parseInt(m[1], 10);
    const idx = oneBased - 1;
    if (idx < 0 || idx >= objectionCount) continue;
    const stance = m[2].toUpperCase() as ObjectionStance;
    byIndex.set(idx, {
      index: idx,
      stance,
      reason: stance === "DISPUTE" ? m[3]?.trim() || undefined : undefined,
    });
  }
  const stances: SynthStance[] = [];
  for (let i = 0; i < objectionCount; i++) {
    stances.push(byIndex.get(i) ?? { index: i, stance: "ACCEPT" });
  }
  return { stances, parsedCount: byIndex.size };
}

/**
 * Resolve a DISPUTE without a TTY, per the CI policy:
 *   - auto-accept: side with the reviewer (apply the fix). Conservative default —
 *     a flagged concern gets fixed rather than silently dropped.
 *   - auto-reject: side with the synthesizer (drop the objection).
 *   - fail-fast:   side with the reviewer for IMPORTANT, but signal a hard stop
 *     for CRITICAL (caller exits 3). The boolean failFast is true only for a
 *     CRITICAL dispute under fail-fast.
 */
export function resolveDisputeNonInteractive(
  mode: NonInteractiveMode,
  severity: PlanReviewObjection["severity"],
): { resolution: DisputeResolution; failFast: boolean } {
  if (mode === "auto-reject") return { resolution: "synth", failFast: false };
  if (mode === "fail-fast" && severity === "CRITICAL") {
    return { resolution: "reviewer", failFast: true };
  }
  // auto-accept, or fail-fast on a non-CRITICAL dispute.
  return { resolution: "reviewer", failFast: false };
}

// ---------------------------------------------------------------------------
// Readline helper (moved from plan-review-loop.ts — handles Bun's
// ERR_USE_AFTER_CLOSE on multi-question sequences via a lineQueue/waiter
// pattern instead of rl.question()).
// ---------------------------------------------------------------------------

export function makeReadlineAsk(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): {
  ask: (q: string) => Promise<string>;
  close: () => void;
  closed: () => boolean;
} {
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
  return { ask, close: () => rl.close(), closed: () => streamClosed };
}

/** Safety cap on re-prompts per disputed objection (prevents a livelock if a
 *  non-closing stream emits endless invalid input). Hitting it aborts the gate. */
const MAX_DISPUTE_PROMPTS = 100;

// ---------------------------------------------------------------------------
// Dispute gate (TTY interactive)
// ---------------------------------------------------------------------------

export interface DisputeGateInput {
  /** Indices into `objections` that the synth disputed. */
  disputedIndices: number[];
  objections: PlanReviewObjection[];
  stances: SynthStance[];
  output: NodeJS.WritableStream;
  ask: (q: string) => Promise<string>;
  /**
   * Reports whether the input stream has closed (EOF). When the stream closes
   * mid-gate, the gate ABORTS rather than defaulting unanswered disputes to
   * "apply the fix" — a dropped terminal must not silently rewrite the plan.
   */
  isStreamClosed?: () => boolean;
}

export interface DisputeGateResult {
  /** Resolution per disputed index (same order as disputedIndices). */
  resolutions: Map<number, DisputeResolution>;
  /** True when the user picked [q]uit. */
  aborted: boolean;
}

/**
 * Prompt the user once per disputed objection. Shows the reviewer's objection
 * and the synthesizer's rebuttal, then asks who's right.
 */
export async function runDisputeGateTTY(
  opts: DisputeGateInput,
): Promise<DisputeGateResult> {
  const resolutions = new Map<number, DisputeResolution>();
  opts.output.write(
    `\n═══════════════════════════════════════════════════════════════════════\n` +
      `[plan-review] ${opts.disputedIndices.length} disagreement(s) between reviewer and synthesizer\n` +
      `═══════════════════════════════════════════════════════════════════════\n`,
  );
  for (let i = 0; i < opts.disputedIndices.length; i++) {
    const idx = opts.disputedIndices[i];
    const obj = opts.objections[idx];
    const reason = opts.stances[idx]?.reason ?? "(no reason given)";
    opts.output.write(
      `\n[${i + 1}/${opts.disputedIndices.length}] ${obj.severity} — ${obj.location}\n` +
        `  Reviewer:     ${obj.issue}\n` +
        `  Reviewer fix: ${obj.suggestion}\n` +
        `  Synth disputes: ${reason}\n`,
    );
    let answer = "";
    let attempts = 0;
    while (!["r", "s", "d", "q"].includes(answer)) {
      if (attempts++ >= MAX_DISPUTE_PROMPTS) {
        // Livelock guard: a non-closing stream emitting endless invalid input.
        // Abort rather than apply an unapproved fix.
        return { resolutions, aborted: true };
      }
      answer = (
        await opts.ask(
          `  Who's right? [r] reviewer (apply fix)  [s] synthesizer (drop)  [d] defer  [q] abort: `,
        )
      )
        .trim()
        .toLowerCase();
      // Empty answer: if the stream closed (EOF — dropped terminal, supervisor
      // closed stdin), ABORT so a resume re-runs the review. Never default a
      // closed stream to "apply the fix" — that rewrites the plan with no human
      // present. A bare enter on a LIVE stream just re-prompts.
      if (answer === "" && opts.isStreamClosed?.()) {
        return { resolutions, aborted: true };
      }
    }
    if (answer === "q") return { resolutions, aborted: true };
    resolutions.set(
      idx,
      answer === "s" ? "synth" : answer === "d" ? "defer" : "reviewer",
    );
  }
  return { resolutions, aborted: false };
}

// ---------------------------------------------------------------------------
// Plan annotation (top-of-file outcome summary)
// ---------------------------------------------------------------------------

function prependOutcomeAnnotation(planPath: string, lines: string[]): void {
  try {
    const content = fs.readFileSync(planPath, "utf8");
    const block = `<!-- PLAN REVIEW (single-round)\n${lines.map((l) => `     ${l}`).join("\n")} -->\n`;
    fs.writeFileSync(planPath, block + content, "utf8");
  } catch {
    // Best-effort: the annotation is informational. A plan that can't be read
    // back (deleted mid-run) is a bigger problem the caller surfaces elsewhere.
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const REVIEWABLE = new Set<PlanReviewObjection["severity"]>([
  "CRITICAL",
  "IMPORTANT",
]);

export async function runPlanReviewSingle(
  input: RunPlanReviewSingleInput,
): Promise<PlanReviewSingleResult> {
  const verdict = await input.reviewerFn();
  const reviewable = verdict.objections.filter((o) =>
    REVIEWABLE.has(o.severity),
  );
  const suggestions = verdict.objections.filter(
    (o) => o.severity === "SUGGESTION",
  );

  // No actionable objections — approve.
  if (reviewable.length === 0) {
    prependOutcomeAnnotation(input.planPath, [
      `APPROVE — reviewer (${verdict.reviewedBy}) raised no CRITICAL/IMPORTANT objections.`,
      ...(suggestions.length
        ? [`${suggestions.length} suggestion(s) noted, not blocking.`]
        : []),
    ]);
    return {
      outcome: "approved",
      exitCode: 0,
      finalVerdict: verdict,
      toFix: [],
    };
  }

  // Synthesizer check.
  const check = await input.synthCheckFn(reviewable);
  if (!check.ok) {
    return {
      outcome: "synth_failure",
      exitCode: 1,
      finalVerdict: verdict,
      toFix: [],
    };
  }
  const { stances, parsedCount } = parseSynthCheckOutput(
    check.raw,
    reviewable.length,
  );
  // The agent exited 0 but classified NOTHING — it narrated instead of emitting
  // STANCE lines, or returned empty. Defaulting every objection to ACCEPT here
  // would auto-rewrite the plan with no human adjudication, silently bypassing
  // the dispute gate. Treat a fully-unparseable check as a synth FAILURE.
  if (parsedCount === 0) {
    return {
      outcome: "synth_failure",
      exitCode: 1,
      finalVerdict: verdict,
      toFix: [],
    };
  }

  const toFix: PlanReviewObjection[] = [];
  const deferred: PlanReviewObjection[] = [];
  const disputedIndices: number[] = [];
  for (let i = 0; i < reviewable.length; i++) {
    if (stances[i].stance === "ACCEPT") toFix.push(reviewable[i]);
    else disputedIndices.push(i);
  }
  const acceptedCount = toFix.length; // synth agreed; before dispute resolution
  let sidedReviewerCount = 0; // disputes the user/CI sent back to the reviewer's fix
  let droppedCount = 0; // disputes resolved in the synthesizer's favor

  // Resolve disputes.
  if (disputedIndices.length > 0) {
    if (input.isTTY) {
      const helper = makeReadlineAsk(input.input, input.output);
      let gate: DisputeGateResult;
      try {
        gate = await runDisputeGateTTY({
          disputedIndices,
          objections: reviewable,
          stances,
          output: input.output,
          ask: helper.ask,
          isStreamClosed: helper.closed,
        });
      } finally {
        helper.close();
      }
      if (gate.aborted) {
        return {
          outcome: "user_abort",
          exitCode: 4,
          finalVerdict: verdict,
          toFix: [],
        };
      }
      for (const idx of disputedIndices) {
        const res = gate.resolutions.get(idx) ?? "reviewer";
        if (res === "reviewer") {
          toFix.push(reviewable[idx]);
          sidedReviewerCount++;
        } else if (res === "defer") {
          deferred.push(reviewable[idx]);
        } else {
          droppedCount++; // "synth"
        }
      }
    } else {
      // Non-TTY: apply the CI policy per dispute.
      for (const idx of disputedIndices) {
        const obj = reviewable[idx];
        const { resolution, failFast } = resolveDisputeNonInteractive(
          input.nonInteractiveMode,
          obj.severity,
        );
        if (failFast) {
          input.output.write(
            `[plan-review] CRITICAL dispute under --plan-review-noninteractive=fail-fast — exiting 3.\n` +
              `  ${obj.location}: ${obj.issue}\n`,
          );
          return {
            outcome: "critical_dispute",
            exitCode: 3,
            finalVerdict: verdict,
            toFix: [],
          };
        }
        if (resolution === "reviewer") {
          toFix.push(obj);
          sidedReviewerCount++;
        } else {
          droppedCount++; // "synth" (defer is never produced non-interactively)
        }
      }
    }
  }

  // Apply fixes (one revision) or approve as-is.
  const annotation = [
    `Reviewer: ${verdict.reviewedBy}`,
    `Synth-accepted: ${acceptedCount}  Sided-reviewer: ${sidedReviewerCount}  Dropped: ${droppedCount}  Deferred: ${deferred.length}`,
    ...deferred.map(
      (o) => `DEFERRED [${o.location}]: ${o.issue} → ${o.suggestion}`,
    ),
  ];

  if (toFix.length === 0) {
    prependOutcomeAnnotation(input.planPath, [
      `APPROVE — no fixes applied (all objections dropped or deferred).`,
      ...annotation,
    ]);
    return {
      outcome: "approved",
      exitCode: 0,
      finalVerdict: verdict,
      toFix: [],
    };
  }

  const synthRes = await input.synthFn(toFix);
  if (!synthRes.ok) {
    return {
      outcome: "synth_failure",
      exitCode: 1,
      finalVerdict: verdict,
      toFix,
    };
  }
  prependOutcomeAnnotation(input.planPath, [
    `REVISED — synthesizer applied ${toFix.length} fix(es).`,
    ...annotation,
  ]);
  return { outcome: "revised", exitCode: 0, finalVerdict: verdict, toFix };
}
