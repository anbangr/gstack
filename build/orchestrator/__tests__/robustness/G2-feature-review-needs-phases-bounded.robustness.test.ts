/**
 * G2 — feature-review FEATURE_NEEDS_PHASES loop is bounded by the cap.
 *
 * Failure mode (from BUILD_ROBUSTNESS_SUITE.md §G2): a flapping successful-
 * verdict loop. A feature reviewer that keeps returning FEATURE_NEEDS_PHASES
 * (each cycle a freshly-numbered phase block) appends phases to the plan
 * without bound, burning a long autonomous run's budget — every cycle adds
 * real phases that then get implemented + reviewed, so an unbounded loop is
 * far more expensive than a flat retry loop.
 *
 * Desired invariant: across the feature-review cycle, `fr.iterations` is
 * consumed each cycle (so the per-feature cap, `DEFAULT_FEATURE_REVIEW_MAX_ITER`,
 * actually fires) and the count of appended phases (`fr.phasesAdded`) never
 * exceeds that cap.
 *
 * ── The fix (was [RED] / .skip; now green) ──
 *
 * The cap-FIRING decision (`currentIter > cap`, where
 * `cap = args.featureReviewMaxIter`) used to live ONLY inline in the giant
 * `run()` outer loop (cli.ts), reading `featureState.featureReview.iterations`,
 * with no importable home — so the bounded-loop invariant could only be
 * reconstructed, never tested against production. The G2 fix extracts that
 * comparison into a pure, exported `featureReviewCapReached({ iterationsConsumed,
 * cap })` in phase-runner.ts, and rewires cli.ts run() to call it. This spec now
 * drives the REAL `featureReviewCapReached` (not a re-implementation) through a
 * faithful FEATURE_NEEDS_PHASES cycle built from the other real exported helpers
 * — `parseFeatureReviewVerdict` (feature-review.ts), `appendFeaturePhases`
 * (plan-mutator.ts), `parsePlan` (parser.ts), and the real cap constant
 * `DEFAULT_FEATURE_REVIEW_MAX_ITER` (phase-runner.ts) — driven by an
 * always-NEEDS_PHASES fake dispatcher, and asserts the bound the cap-firing
 * logic guarantees. An off-by-one or `>=`/`>` regression in the bound now fails
 * HERE instead of only surfacing as an unbounded mid-build plan explosion.
 *
 * Why not "drive runFeatureReviewIteration with a fake dispatcher" (the
 * design's literal plan)? That function is an internal `async function` with no
 * injectable dispatcher (it spawns the reviewer via `runCodexFeatureReview` /
 * `runRoleTask`), and the cap decision never lived inside it — it lived in the
 * run() loop. Extracting the pure decision is the minimal, behavior-preserving
 * seam that makes the bound testable without refactoring the whole run() loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkTmp } from "./helpers";
import {
  parseFeatureReviewVerdict,
  FEATURE_VERDICT_NEEDS_PHASES,
} from "../../feature-review";
import { appendFeaturePhases } from "../../plan-mutator";
import { parsePlan } from "../../parser";
import {
  DEFAULT_FEATURE_REVIEW_MAX_ITER,
  featureReviewCapReached,
} from "../../phase-runner";

// Minimal stand-in for the slice of FeatureState.featureReview the loop
// mutates. Mirrors the real fields (types.ts FeatureReview) that the
// production NEEDS_PHASES branch touches: `iterations` (cli.ts ~8467) and
// `phasesAdded` (cli.ts ~8619).
interface FeatureReviewCounters {
  iterations: number;
  phasesAdded: number;
}

/**
 * Fake reviewer dispatcher: ALWAYS returns a parseable FEATURE_NEEDS_PHASES
 * verdict with a freshly-numbered phase block (so the K-collision reconciler
 * never short-circuits the append). This is the worst-case flapping reviewer
 * the design's G2 row targets — it never converges to FEATURE_PASS, so only
 * the cap can stop it.
 */
function alwaysNeedsPhasesDispatcher(cycle: number): string {
  const k = cycle; // fresh K each cycle → no duplicate-phase-number rejection
  return [
    "## VERDICT",
    FEATURE_VERDICT_NEEDS_PHASES,
    "",
    "## Findings",
    `- cycle ${cycle}: another follow-up phase is needed (flapping reviewer)`,
    "",
    "## Additional phases",
    `### Phase 1.review-${k}: Follow-up ${k}`,
    "",
    `- [ ] **Implementation**: implement follow-up ${k}`,
    "- [ ] **Review**: review follow-up for correctness",
  ].join("\n");
}

const PLAN_HEADER = [
  "# Build Plan",
  "",
  "## Feature 1: Auth",
  "",
  "Build the auth flow.",
  "",
  "### Phase 1: Schema",
  "",
  "- [ ] **Implementation**: define the schema",
  "- [ ] **Review**: review the schema",
  "",
].join("\n");

describe("[PIN] G2 feature-review NEEDS_PHASES helpers compose (sanity)", () => {
  // These PINs guard the building blocks the bounded-loop fix will reuse —
  // they assert behavior that is ALREADY correct in the exported helpers, so
  // a regression in the parser or the plan mutator would be caught even
  // before the RED loop-bound fix lands.
  let tmp: string;
  let planFile: string;

  beforeEach(() => {
    tmp = mkTmp("gstack-g2-pin-");
    planFile = `${tmp}/PLAN.md`;
    fs.writeFileSync(planFile, PLAN_HEADER);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses a fresh FEATURE_NEEDS_PHASES verdict and captures the phase block", () => {
    const parsed = parseFeatureReviewVerdict(alwaysNeedsPhasesDispatcher(1));
    expect(parsed.verdict).toBe("FEATURE_NEEDS_PHASES");
    expect(parsed.additionalPhasesMd).toContain(
      "### Phase 1.review-1: Follow-up 1",
    );
    expect(parsed.additionalPhasesMd).toContain("implement follow-up 1");
  });

  it("appendFeaturePhases inserts the block under Feature 1 and re-parse sees the new phase", () => {
    const parsed = parseFeatureReviewVerdict(alwaysNeedsPhasesDispatcher(1));
    appendFeaturePhases({
      planFile,
      featureNumber: "1",
      phasesMd: parsed.additionalPhasesMd,
    });
    const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"));
    const numbers = reparsed.phases.map((p) => p.number);
    // Original phase 1 plus the appended follow-up are both present.
    expect(numbers).toContain("1");
    expect(numbers).toContain("1.review-1");
  });

  it("the production cap constant is a positive integer (the loop bound exists)", () => {
    expect(Number.isInteger(DEFAULT_FEATURE_REVIEW_MAX_ITER)).toBe(true);
    expect(DEFAULT_FEATURE_REVIEW_MAX_ITER).toBeGreaterThan(0);
  });
});

describe("[RED→FIXED] G2 feature-review-needs-phases-bounded", () => {
  let tmp: string;
  let planFile: string;

  beforeEach(() => {
    tmp = mkTmp("gstack-g2-red-");
    planFile = `${tmp}/PLAN.md`;
    fs.writeFileSync(planFile, PLAN_HEADER);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Reconstruct the production FEATURE_NEEDS_PHASES outer-loop cycle out of
   * the real exported helpers, driven by the always-NEEDS_PHASES fake
   * dispatcher. Mirrors cli.ts run()'s feature-review loop:
   *   - currentIter = fr.iterations + 1
   *   - if currentIter > cap → STOP (cap fired). Non-TTY declines extension.
   *   - else: dispatch → parse → on NEEDS_PHASES append + bump counters →
   *     loop again.
   *
   * This is the function the fix MUST make importable/unit-testable. Until
   * then this whole describe is .skip and the loop driver lives here as the
   * spec of desired behavior.
   *
   * A `hardCeiling` (> any sane cap) exists ONLY to keep a buggy unbounded
   * implementation from spinning forever in CI; the assertions below prove
   * the CAP (not the ceiling) is what stopped us.
   */
  function driveNeedsPhasesLoop(
    cap: number,
    hardCeiling = 1000,
  ): {
    fr: FeatureReviewCounters;
    stoppedBy: "cap" | "ceiling";
  } {
    const fr: FeatureReviewCounters = { iterations: 0, phasesAdded: 0 };
    let stoppedBy: "cap" | "ceiling" = "ceiling";
    for (let guard = 0; guard < hardCeiling; guard++) {
      // Drive the SAME cap-firing decision production uses (cli.ts run()
      // routes its `if (currentIter > cap)` check through this exported pure
      // function). Testing the real seam — not a re-implementation — is the
      // point of the G2 fix: an off-by-one regression in the bound now fails
      // here instead of silently growing the plan mid-build.
      if (featureReviewCapReached({ iterationsConsumed: fr.iterations, cap })) {
        // The cap fired: production declines the extension on a non-TTY run
        // (CI / piped stdin) and writes BLOCKED-feature-N.md — the loop ends.
        stoppedBy = "cap";
        break;
      }
      // Reviewer subprocess "ran" this cycle. The cycle number production
      // logs is `iterations + 1`; mirror it for the dispatcher's fresh K.
      const currentIter = fr.iterations + 1;
      const raw = alwaysNeedsPhasesDispatcher(currentIter);
      const verdict = parseFeatureReviewVerdict(raw);
      // fr.iterations is consumed each cycle (cli.ts ~8467 — unconditional
      // bump after the dispatch, regardless of verdict shape).
      fr.iterations += 1;
      if (
        verdict.verdict === "FEATURE_NEEDS_PHASES" &&
        verdict.additionalPhasesMd
      ) {
        appendFeaturePhases({
          planFile,
          featureNumber: "1",
          phasesMd: verdict.additionalPhasesMd,
        });
        // cli.ts ~8619 — phasesAdded bumps once per appended cycle.
        fr.phasesAdded += 1;
      }
    }
    return { fr, stoppedBy };
  }

  it("consumes one iteration per cycle and the cap fires (does not run unbounded)", () => {
    const cap = DEFAULT_FEATURE_REVIEW_MAX_ITER;
    const { fr, stoppedBy } = driveNeedsPhasesLoop(cap);
    // The loop terminated because the CAP fired, not because the safety
    // ceiling caught a runaway. This is the core of the bounded invariant.
    expect(stoppedBy).toBe("cap");
    // fr.iterations was consumed each cycle and stopped exactly at the cap.
    expect(fr.iterations).toBe(cap);
  });

  it("phasesAdded never exceeds the per-feature cap", () => {
    const cap = DEFAULT_FEATURE_REVIEW_MAX_ITER;
    const { fr } = driveNeedsPhasesLoop(cap);
    expect(fr.phasesAdded).toBeLessThanOrEqual(cap);
  });

  it("the appended plan never holds more than (original + cap) phases", () => {
    const cap = DEFAULT_FEATURE_REVIEW_MAX_ITER;
    driveNeedsPhasesLoop(cap);
    const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"));
    // 1 original phase + at most `cap` appended follow-ups.
    expect(reparsed.phases.length).toBeLessThanOrEqual(1 + cap);
  });
});
