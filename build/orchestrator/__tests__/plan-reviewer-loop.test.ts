import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeConvergenceSnapshot,
  runPlanReviewLoop,
  type RunPlanReviewLoopResult,
} from "../plan-review-loop";
import { writeRoundAnnotation, type RoundAnnotation } from "../plan-reviewer";
import type { PlanReviewVerdict } from "../types";

function readableFrom(text: string): NodeJS.ReadableStream {
  const r = new Readable({ read() {} });
  r.push(Buffer.from(text));
  r.push(null);
  (r as any).isTTY = true; // simulate TTY for triage gate
  return r;
}

function captureWriter() {
  let buf = "";
  return {
    stream: new Writable({
      write(c, _e, cb) {
        buf += c.toString();
        cb();
      },
    }),
    read: () => buf,
  };
}

let tmpDir: string;
let planPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-test-"));
  planPath = path.join(tmpDir, "plan.md");
  fs.writeFileSync(
    planPath,
    `# Living Plan\n\n## Feature 1: x\n\n### Phase 1: Setup\n- [ ] task\n`,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPlanReviewLoop", () => {
  it("APPROVE on round 1 exits with verdict=APPROVE, no synth invocation", async () => {
    const reviewerStub = async (): Promise<PlanReviewVerdict> => ({
      verdict: "APPROVE",
      objections: [],
      assessment: "looks good",
      reviewedBy: "stub",
      round: 1,
    });
    let synthCalls = 0;
    const synthStub = async () => {
      synthCalls += 1;
      return { ok: true };
    };
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "test-slug",
      branch: "feat/test",
      reviewerFn: reviewerStub,
      synthFn: synthStub,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    expect(result.rounds).toBe(1);
    expect(synthCalls).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "history.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "convergence.jsonl"))).toBe(true);
  });

  it("bundle-1 trajectory 5→3→2→0 converges with three synth invocations", async () => {
    const verdicts: PlanReviewVerdict[] = [
      // Round 1: 5 CRITICAL
      {
        verdict: "REVISE",
        objections: Array.from({ length: 5 }, (_, i) => ({
          severity: "CRITICAL" as const,
          location: `F1, P${i + 1}`,
          issue: `r1-${i}`,
          suggestion: `fix r1-${i}`,
        })),
        assessment: "round 1",
        reviewedBy: "stub",
        round: 1,
      },
      // Round 2: 3 NEW CRITICAL (different locations)
      {
        verdict: "REVISE",
        objections: Array.from({ length: 3 }, (_, i) => ({
          severity: "CRITICAL" as const,
          location: `F1, P${i + 10}`,
          issue: `r2-${i}`,
          suggestion: `fix r2-${i}`,
        })),
        assessment: "round 2",
        reviewedBy: "stub",
        round: 2,
      },
      // Round 3: 2 NEW CRITICAL
      {
        verdict: "REVISE",
        objections: Array.from({ length: 2 }, (_, i) => ({
          severity: "CRITICAL" as const,
          location: `F1, P${i + 20}`,
          issue: `r3-${i}`,
          suggestion: `fix r3-${i}`,
        })),
        assessment: "round 3",
        reviewedBy: "stub",
        round: 3,
      },
      // Round 4: APPROVE
      {
        verdict: "APPROVE",
        objections: [],
        assessment: "approved",
        reviewedBy: "stub",
        round: 4,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async (): Promise<PlanReviewVerdict> => verdicts[rIdx++];
    let synthCalls = 0;
    const synthFn = async () => {
      synthCalls += 1;
      return { ok: true };
    };
    // Each round in TTY mode: accept-ALL the objections (single uppercase A).
    const input = readableFrom("A\nA\nA\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "bundle-1",
      branch: "feat/bundle-1",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    expect(result.rounds).toBe(4);
    expect(synthCalls).toBe(3);
    const aggLine = fs
      .readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8")
      .trim();
    const agg = JSON.parse(aggLine);
    expect(agg.trajectoryRaw).toEqual([5, 3, 2, 0]);
    expect(agg.finalVerdict).toBe("APPROVE");
  });

  it("counts RESOLUTION: disputed lines per round into disputedResolutions", async () => {
    // Round 1 reviewer raises 2 CRITICAL; user accepts both.
    // Synth marks one as RESOLUTION: disputed, the other RESOLUTION: synth fixed.
    // Round 2 reviewer approves.
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
          {
            severity: "CRITICAL",
            location: "F1, P2",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round: 1,
      },
      {
        verdict: "APPROVE",
        objections: [],
        assessment: "",
        reviewedBy: "stub",
        round: 2,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    const synthFn = async () => {
      // Read the plan, find the two RESOLUTION: pending lines, replace one with
      // "disputed — wrong suggestion" and the other with "synth applied the fix".
      // The plan file has the annotations Task 9 wrote in the order they appear
      // in `triageResult.decisions`, so we rewrite first occurrence to disputed,
      // second to applied.
      const text = fs.readFileSync(planPath, "utf8");
      let first = true;
      const out = text.replace(/RESOLUTION: pending/g, () => {
        if (first) {
          first = false;
          return "RESOLUTION: disputed — wrong suggestion";
        }
        return "RESOLUTION: synth applied the fix";
      });
      fs.writeFileSync(planPath, out, "utf8");
      return { ok: true };
    };
    // TTY: accept-ALL round 1's 2 objections (single A keypress).
    const input = readableFrom("A\n");
    const out = captureWriter();
    await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "test",
      branch: "feat/x",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    // Round 1 should record 1 disputed resolution; round 2 is APPROVE (no synth call).
    expect(agg.disputedResolutions[0]).toBe(1);
  });

  it("exits with rounds===maxRounds when reviewer keeps returning REVISE through MAX_ROUNDS", async () => {
    // Reviewer always returns REVISE with new objections at a unique location each time.
    let rIdx = 0;
    const reviewerFn = async (): Promise<PlanReviewVerdict> => ({
      verdict: "REVISE",
      objections: [
        {
          severity: "CRITICAL",
          location: `F1, P${++rIdx}`,
          issue: "x",
          suggestion: "y",
        },
      ],
      assessment: "",
      reviewedBy: "stub",
      round: rIdx,
    });
    const synthFn = async () => ({ ok: true });
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "max-rounds",
      branch: "feat/max-rounds",
      reviewerFn,
      synthFn,
      maxRounds: 3,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    // Non-TTY stalemate gate returns approve_as_is, so outcome is "approved".
    // But the rounds === maxRounds confirms we hit the cap.
    expect(result.rounds).toBe(3);
    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    expect(agg.trajectoryRaw.length).toBe(3);
  });

  it("bails out at round 2 when all are re-raises", async () => {
    // Round 1 raises one objection, user accepts, synth pretends to resolve.
    // Round 2 raises same one again, no new. Adaptive cap fires.
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "r1",
        reviewedBy: "stub",
        round: 1,
      },
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "r2",
        reviewedBy: "stub",
        round: 2,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    // Synth simulates fixing by replacing "RESOLUTION: pending" with a real value.
    const synthFn = async () => {
      const text = fs.readFileSync(planPath, "utf8");
      const updated = text.replace(
        /RESOLUTION: pending/g,
        "RESOLUTION: synth fixed",
      );
      fs.writeFileSync(planPath, updated, "utf8");
      return { ok: true };
    };
    // TTY: accept round 1's objection (a + rationale), accept round 2's (a + rationale).
    // Then at the bail-out gate, pick [m]anual mode.
    const input = readableFrom("a\nok\na\nok\nm\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "test",
      branch: "feat/x",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("user_manual");
    expect(result.exitCode).toBe(3);
  });

  it("TTY mode prompts per-IMPORTANT objection on REVISE-with-no-CRITICAL (not silent auto-accept)", async () => {
    // Reviewer returns REVISE with 2 IMPORTANT, 1 SUGGESTION, 0 CRITICAL.
    // Loop should hit the early-return branch but prompt the user in TTY mode.
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "IMPORTANT",
            location: "F1, P1",
            issue: "imp-1",
            suggestion: "fix-1",
          },
          {
            severity: "IMPORTANT",
            location: "F1, P2",
            issue: "imp-2",
            suggestion: "fix-2",
          },
          {
            severity: "SUGGESTION",
            location: "F1, P3",
            issue: "sug-1",
            suggestion: "fix-3",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round: 1,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    const synthFn = async () => ({ ok: true });
    // User answers: y (accept imp-1), n (reject imp-2). SUGGESTION auto-accepts.
    const input = readableFrom("y\nn\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "tty-important",
      branch: "feat/tty-important",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    expect(result.rounds).toBe(1);
    // Output must show the per-objection prompt (proves we didn't silently auto-accept).
    const written = out.read();
    expect(written).toContain("IMPORTANT objection 1 of 2");
    expect(written).toContain("IMPORTANT objection 2 of 2");
    expect(written).toContain("Apply?");
    // Plan must contain annotations for both IMPORTANTs (one accept, one reject)
    // plus the SUGGESTION (auto-accept). Read raw plan and check the USER: values.
    const plan = fs.readFileSync(planPath, "utf8");
    // The annotation block format includes "ROUND N USER: accept|reject".
    expect(plan).toMatch(/USER:\s*accept/);
    expect(plan).toMatch(/USER:\s*reject/);
  });

  it("TTY mode: [a]ll on IMPORTANT prompt accepts all remaining without further prompts", async () => {
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "IMPORTANT",
            location: "F1, P1",
            issue: "imp-1",
            suggestion: "fix-1",
          },
          {
            severity: "IMPORTANT",
            location: "F1, P2",
            issue: "imp-2",
            suggestion: "fix-2",
          },
          {
            severity: "IMPORTANT",
            location: "F1, P3",
            issue: "imp-3",
            suggestion: "fix-3",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round: 1,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    const synthFn = async () => ({ ok: true });
    // Only one keystroke: "a" (accept all). Subsequent IMPORTANTs must not prompt.
    const input = readableFrom("a\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "tty-all",
      branch: "feat/tty-all",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    const plan = fs.readFileSync(planPath, "utf8");
    // All three IMPORTANTs accepted; no rejects.
    const accepts = (plan.match(/USER:\s*accept/g) ?? []).length;
    const rejects = (plan.match(/USER:\s*reject/g) ?? []).length;
    expect(accepts).toBe(3);
    expect(rejects).toBe(0);
  });

  it("non-TTY auto-accept on REVISE-with-no-CRITICAL still annotates without prompting", async () => {
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "IMPORTANT",
            location: "F1, P1",
            issue: "imp-1",
            suggestion: "fix-1",
          },
          {
            severity: "SUGGESTION",
            location: "F1, P3",
            issue: "sug-1",
            suggestion: "fix-3",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round: 1,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    const synthFn = async () => ({ ok: true });
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "nonTty",
      branch: "feat/nonTty",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    const written = out.read();
    expect(written).not.toContain("Apply?");
  });

  it("resume after exit-3: starts round numbering from prior history.jsonl max + 1", async () => {
    // Seed history.jsonl with two prior round entries (as if a prior exit-3
    // run wrote them, then user re-launched).
    const historyPath = path.join(tmpDir, "history.jsonl");
    const seed = [
      {
        round: 1,
        ts: new Date().toISOString(),
        reviewedBy: "stub",
        verdict: "REVISE" as const,
        objectionCountRaw: 2,
        critical: 2,
        important: 0,
        suggestion: 0,
        triage: { accepted: [0, 1], rejected: [], deferred: [] },
        convergence: {
          delta: null,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 2,
        },
      },
      {
        round: 2,
        ts: new Date().toISOString(),
        reviewedBy: "stub",
        verdict: "REVISE" as const,
        objectionCountRaw: 1,
        critical: 1,
        important: 0,
        suggestion: 0,
        triage: { accepted: [0], rejected: [], deferred: [] },
        convergence: {
          delta: -1,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 1,
        },
      },
    ];
    fs.writeFileSync(
      historyPath,
      seed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    // Reviewer returns APPROVE immediately on the next call (round 3).
    const reviewerFn = async (): Promise<PlanReviewVerdict> => ({
      verdict: "APPROVE",
      objections: [],
      assessment: "",
      reviewedBy: "stub",
      round: 3,
    });
    const synthFn = async () => ({ ok: true });
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath,
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "resume",
      branch: "feat/resume",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    // result.rounds is the round number at exit; with prior entries 1+2,
    // the resumed APPROVE call must have been round 3.
    expect(result.rounds).toBe(3);

    // History should now have 3 lines (the 2 seeded + 1 new). All round
    // numbers must be unique and sequential (no duplicate "1" or "2").
    const lines = fs
      .readFileSync(historyPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { round: number });
    expect(lines.length).toBe(3);
    const rounds = lines.map((l) => l.round).sort((a, b) => a - b);
    expect(rounds).toEqual([1, 2, 3]);

    // Convergence aggregate should have trajectory of length 3 (prior 2
    // rehydrated + this round's 0). Verifies INFO #8 parity AND CRITICAL #6
    // rehydration.
    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    expect(agg.trajectoryRaw.length).toBe(3);
    expect(agg.trajectoryAccepted.length).toBe(3);
    expect(agg.reRaises.length).toBe(3);
    expect(agg.disputedResolutions.length).toBe(3);
  });

  it("synthFn throw routes through synth_failure exit (H2: thrown synth no longer silently survives)", async () => {
    // H2 contract: a synth that throws is a runtime failure. The loop must
    // exit with outcome=synth_failure and exit code 1 rather than silently
    // continuing to a round that would re-review the un-resynthed plan.
    let reviewCalls = 0;
    const reviewerFn = async (round: number): Promise<PlanReviewVerdict> => {
      reviewCalls += 1;
      return {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round,
      };
    };
    let synthCalls = 0;
    const synthFn = async () => {
      synthCalls += 1;
      throw new Error("synth boom");
    };
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "synthfail",
      branch: "feat/synthfail",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("synth_failure");
    expect(result.exitCode).toBe(1);
    expect(synthCalls).toBe(1);
    // Only the round-1 reviewer call ran — no wasted round-2 spend on a plan
    // the synth never got to revise.
    expect(reviewCalls).toBe(1);
    expect(result.rounds).toBe(1);
    // Convergence aggregate must still be written.
    expect(fs.existsSync(path.join(tmpDir, "convergence.jsonl"))).toBe(true);
  });

  it("H2: synthFn returning ok:false exits with synth_failure (no silent success)", async () => {
    // If runConfiguredRoleTask exits non-zero or times out, the cli.ts wrapper
    // returns { ok: false }. The loop must NOT silently treat that as a
    // successful round — it must route through synth_failure / exit 1.
    const reviewerFn = async (round: number): Promise<PlanReviewVerdict> => ({
      verdict: "REVISE",
      objections: [
        {
          severity: "CRITICAL",
          location: "F1, P1",
          issue: "x",
          suggestion: "y",
        },
      ],
      assessment: "",
      reviewedBy: "stub",
      round,
    });
    let synthCalls = 0;
    const synthFn = async () => {
      synthCalls += 1;
      return { ok: false };
    };
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "synth-ok-false",
      branch: "feat/synth-ok-false",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("synth_failure");
    expect(result.exitCode).toBe(1);
    // Synth was invoked exactly once — the loop didn't burn an additional
    // reviewer round after the failure.
    expect(synthCalls).toBe(1);
    expect(result.rounds).toBe(1);
  });

  // ─── Fix D + E: synth_failure_stalemate outcome / Exit 3 contract ─────
  // SKILL.md Step 5.5 contracts Exit 3 = STALEMATE. plan-review-loop's
  // synth_failure path now distinguishes "at the round cap" (stalemate,
  // exit 3) from "mid-loop" (transient, exit 1).
  //
  // NOTE: the cap-synth-failure path in plan-review-loop is defensive — in
  // practice, `shouldBailAdaptive` at line 380 routes `round >= maxRounds`
  // through the stalemate gate before the loop body's synth call fires, so
  // the cap branch is rarely entered. The PRIMARY restart-storm fix lives
  // in cli.ts (Fix B): promote `state.planReview.status === "synth_failure"`
  // to STALEMATE on resume if retries >= 1. See cli-synth-failure-resume.test.ts.

  it("Fix D+E (no false positive): mid-loop synth_failure keeps exit 1 + outcome synth_failure", async () => {
    // Pins the OPPOSITE invariant: a transient synth_failure mid-loop must
    // NOT be promoted to stalemate. Same shape as the H2 test above but
    // made explicit with maxRounds=5 and a synth failure at round 1.
    const reviewerFn = async (round: number): Promise<PlanReviewVerdict> => ({
      verdict: "REVISE",
      objections: [
        {
          severity: "CRITICAL",
          location: "F1, P1",
          issue: "x",
          suggestion: "y",
        },
      ],
      assessment: "",
      reviewedBy: "stub",
      round,
    });
    const synthFn = async () => ({ ok: false });
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "synth-midloop",
      branch: "feat/synth-midloop",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("synth_failure");
    expect(result.exitCode).toBe(1);
    expect(result.rounds).toBe(1);
  });

  it("H3: [c] Continue anyway at adaptive bail invokes synth before looping", async () => {
    // Round 1 raises objection X; user accepts; synth pretends to resolve.
    // Round 2 raises the same X (re-raise, no new objections). Adaptive bail
    // fires; user picks [c]ontinue. The loop MUST invoke synth on the
    // already-annotated plan so round 3's reviewer sees a fresh resolution
    // — without that, round 3 just re-raises the same X and burns spend.
    // Round 3 then approves.
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "r1",
        reviewedBy: "stub",
        round: 1,
      },
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "r2",
        reviewedBy: "stub",
        round: 2,
      },
      {
        verdict: "APPROVE",
        objections: [],
        assessment: "approved",
        reviewedBy: "stub",
        round: 3,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    let synthCalls = 0;
    const synthFn = async () => {
      synthCalls += 1;
      // Resolve all "pending" → "synth fixed" so successive re-raises track.
      const text = fs.readFileSync(planPath, "utf8");
      const updated = text.replace(
        /RESOLUTION: pending/g,
        "RESOLUTION: synth fixed",
      );
      fs.writeFileSync(planPath, updated, "utf8");
      return { ok: true };
    };
    // TTY input:
    //   Round 1: a (accept) + rationale ("ok")
    //   Round 2: a (accept) + rationale ("ok") → triggers adaptive bail
    //   Bail gate: c (continue anyway)
    //   Round 3: APPROVE (no triage)
    const input = readableFrom("a\nok\na\nok\nc\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "h3-continue-runs-synth",
      branch: "feat/h3",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    expect(result.rounds).toBe(3);
    // Synth must have been invoked THREE times:
    //   1. After round 1 triage (normal path)
    //   2. After [c]ontinue at the adaptive bail gate following round 2
    //   3. NOT after round 3 — round 3 is APPROVE which skips synth
    // So expect exactly 2 synth calls total. (Round 1 + continue-after-round-2.)
    expect(synthCalls).toBe(2);
  });

  it("H4 (post-Codex-P2 tightening): resume past maxRounds runs one verification reviewer call → APPROVE proceeds", async () => {
    // Seed history.jsonl with maxRounds entries so deriveRoundNumber returns
    // startRound = maxRounds + 1. The for-loop must NOT execute, but per the
    // Codex structured review P2 finding, auto-approving on history-length
    // alone is unsafe — a user who just typed `gstack-build resume` without
    // actually editing the plan would bypass the review gate. The guard
    // now runs ONE more reviewer call on the (potentially-edited) plan.
    const historyPath = path.join(tmpDir, "history.jsonl");
    const seed: any[] = [];
    for (let i = 1; i <= 5; i++) {
      seed.push({
        round: i,
        ts: new Date().toISOString(),
        reviewedBy: "stub",
        verdict: "REVISE",
        objectionCountRaw: 1,
        critical: 1,
        important: 0,
        suggestion: 0,
        triage: { accepted: [0], rejected: [], deferred: [] },
        convergence: {
          delta: null,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 1,
        },
      });
    }
    fs.writeFileSync(
      historyPath,
      seed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    let reviewCalls = 0;
    const reviewerFn = async (): Promise<PlanReviewVerdict> => {
      reviewCalls += 1;
      return {
        verdict: "APPROVE",
        objections: [],
        assessment: "verification reviewer cleared the manual edits",
        reviewedBy: "stub-verify",
        round: 6,
      };
    };
    let synthCalls = 0;
    const synthFn = async () => {
      synthCalls += 1;
      return { ok: true };
    };
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath,
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "resume-past-cap",
      branch: "feat/resume-past-cap",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("approved");
    expect(result.exitCode).toBe(0);
    // The verification reviewer call DID fire (exactly once); synth did not.
    expect(reviewCalls).toBe(1);
    expect(synthCalls).toBe(0);
    expect(result.finalVerdict).toBeDefined();
    expect(result.finalVerdict.verdict).toBe("APPROVE");
    expect(result.finalVerdict.reviewedBy).toBe("stub-verify");
    expect(fs.existsSync(path.join(tmpDir, "convergence.jsonl"))).toBe(true);
  });

  it("H4-P2: resume past maxRounds with REVISE from verification reviewer exits STALEMATE", async () => {
    // Same seed as above but the verification reviewer returns REVISE with
    // a CRITICAL objection — the user did NOT actually fix the plan, so
    // the loop must NOT auto-approve. Exit STALEMATE (exit code 3) so the
    // user must edit again or pass --no-plan-review.
    const historyPath = path.join(tmpDir, "history.jsonl");
    const seed: any[] = [];
    for (let i = 1; i <= 5; i++) {
      seed.push({
        round: i,
        ts: new Date().toISOString(),
        reviewedBy: "stub",
        verdict: "REVISE",
        objectionCountRaw: 1,
        critical: 1,
        important: 0,
        suggestion: 0,
        triage: { accepted: [0], rejected: [], deferred: [] },
        convergence: {
          delta: null,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 1,
        },
      });
    }
    fs.writeFileSync(
      historyPath,
      seed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const reviewerFn = async (): Promise<PlanReviewVerdict> => ({
      verdict: "REVISE",
      objections: [
        {
          severity: "CRITICAL",
          location: "F1, P1",
          issue: "still missing chainId after user edits",
          suggestion: "actually add chainId",
        },
      ],
      assessment: "user said they fixed it but didn't",
      reviewedBy: "stub-verify",
      round: 6,
    });
    const synthFn = async () => ({ ok: true });
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath,
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "resume-past-cap-revise",
      branch: "feat/resume-past-cap-revise",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    expect(result.outcome).toBe("user_manual");
    expect(result.exitCode).toBe(3);
    expect(result.finalVerdict.verdict).toBe("REVISE");
    expect(result.finalVerdict.reviewedBy).toBe("stub-verify");
  });
});

describe("isPriorAcceptedResolutionAttempt semantics (last-round-wins)", () => {
  it("returns false when last round is reject even if earlier round was accept", () => {
    // Sequence: round 1 user-accepted + synth-resolved, round 2 user rejected
    // (changed mind). Round 3 reviewer raises again. Per spec, this is NOT a
    // re-raise — the user's most-recent decision was reject, so the reviewer
    // re-raising is a prompt-fidelity signal, not a synth-failure signal.
    const ann: RoundAnnotation = {
      location: "F1, P1",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "",
          resolution: "synth fixed",
        },
        {
          round: 2,
          userDecision: "reject",
          userRationale: "changed mind",
        },
      ],
    };
    const snap = computeConvergenceSnapshot({
      round: 3,
      rawObjections: [
        {
          severity: "CRITICAL",
          location: "F1, P1",
          issue: "x",
          suggestion: "y",
        },
      ],
      acceptedIndices: [0],
      priorAnnotations: [ann],
    });
    // Old .some() semantics would classify as re-raise (reRaises=1). New
    // last-round-wins semantics classify as new (reRaises=0, newObjections=1).
    expect(snap.reRaises).toBe(0);
    expect(snap.newObjections).toBe(1);
  });

  it("still returns true when last round is the accept+resolved entry", () => {
    // Plain re-raise: round 1 accept+resolved, round 2 reviewer raises again.
    const ann: RoundAnnotation = {
      location: "F1, P1",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "",
          resolution: "synth fixed",
        },
      ],
    };
    const snap = computeConvergenceSnapshot({
      round: 2,
      rawObjections: [
        {
          severity: "CRITICAL",
          location: "F1, P1",
          issue: "x",
          suggestion: "y",
        },
      ],
      acceptedIndices: [0],
      priorAnnotations: [ann],
    });
    expect(snap.reRaises).toBe(1);
    expect(snap.newObjections).toBe(0);
  });
});

describe("disputed-resolution counting (case-insensitive)", () => {
  it("counts 'Disputed' (capital D) as a disputed resolution", async () => {
    // Round 1 reviewer raises 1 CRITICAL; user accepts. Synth marks
    // RESOLUTION: Disputed — wrong (capital D). Round 2 reviewer approves.
    // The pre-fix /^disputed\b/ regex (no i flag) would miss this and report
    // disputedResolutions[0] === 0. With the case-insensitive fix it should
    // report 1.
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round: 1,
      },
      {
        verdict: "APPROVE",
        objections: [],
        assessment: "",
        reviewedBy: "stub",
        round: 2,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    const synthFn = async () => {
      const text = fs.readFileSync(planPath, "utf8");
      // Capital "Disputed" — must still count.
      const out = text.replace(
        /RESOLUTION: pending/g,
        "RESOLUTION: Disputed — wrong suggestion",
      );
      fs.writeFileSync(planPath, out, "utf8");
      return { ok: true };
    };
    const input = readableFrom("A\n");
    const out = captureWriter();
    await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "test",
      branch: "feat/x",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });
    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    expect(agg.disputedResolutions[0]).toBe(1);
  });
});

describe("resume: priorRejectRationale hydration", () => {
  it("re-raise framing on resume shows the prior-round rejection rationale", async () => {
    // Seed plan with a round-1 user-rejected annotation that carries a
    // non-empty userRationale. Seed history.jsonl so the loop starts at
    // round 2 (the simulated post-Ctrl+C resume). The reviewer stub raises
    // the same objection again; the priorRejectRationale map should be
    // hydrated from the plan, and the TTY triage gate should print the
    // prior rationale in the re-raise framing.
    const historyPath = path.join(tmpDir, "history.jsonl");
    fs.writeFileSync(
      historyPath,
      JSON.stringify({
        round: 1,
        ts: new Date().toISOString(),
        reviewedBy: "stub",
        verdict: "REVISE",
        objectionCountRaw: 1,
        critical: 1,
        important: 0,
        suggestion: 0,
        triage: { accepted: [], rejected: [0], deferred: [] },
        convergence: {
          delta: null,
          noForwardProgress: false,
          reRaises: 0,
          newObjections: 1,
        },
      }) + "\n",
      "utf8",
    );

    // Write the round-1 rejection annotation into the plan file.
    const seededPlan = writeRoundAnnotation(fs.readFileSync(planPath, "utf8"), {
      location: "F1, P1",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 1,
          userDecision: "reject",
          userRationale: "intentional design choice from round 1",
        },
      ],
    });
    fs.writeFileSync(planPath, seededPlan, "utf8");

    // Round 2 reviewer raises the same objection again.
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "F1, P1",
            issue: "x",
            suggestion: "y",
          },
        ],
        assessment: "",
        reviewedBy: "stub",
        round: 2,
      },
      {
        verdict: "APPROVE",
        objections: [],
        assessment: "",
        reviewedBy: "stub",
        round: 3,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    const synthFn = async () => ({ ok: true });
    // TTY user accepts the re-raised objection (a + rationale) and APPROVE
    // terminates the loop.
    const input = readableFrom("a\nok\n");
    const out = captureWriter();
    await runPlanReviewLoop({
      planPath,
      historyPath,
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "resume-hydrate",
      branch: "feat/resume-hydrate",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      legacyPlanReview: true,
    });

    // The triage gate writes the prior-reject rationale into its prompt when
    // priorRejectRationale is populated. Without the hydration fix, the map
    // starts empty on resume and the output contains the empty-string form.
    const written = out.read();
    expect(written).toContain("RE-RAISED from prior round");
    expect(written).toContain("intentional design choice from round 1");
  });
});

describe("runPlanReviewLoop: default-skip behavior (Increment 2)", () => {
  it("skips planReviewer when legacyPlanReview is absent (default off)", async () => {
    // Verifies that the loop returns { status: "skipped" } without calling the
    // reviewerFn when legacyPlanReview is not set. This is the Increment 2
    // default: planReviewer replaced by specQualityGate in Phase A.
    let reviewerCalled = false;
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "skip-test",
      branch: "feat/test",
      reviewerFn: async () => {
        reviewerCalled = true;
        return {
          verdict: "APPROVE",
          objections: [],
          assessment: "",
          reviewedBy: "stub",
          round: 1,
        };
      },
      synthFn: async () => ({ ok: true }),
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub",
      synthesizerName: "stub-synth",
      // legacyPlanReview intentionally omitted — should default to skipped
    });
    expect("status" in result).toBe(true);
    expect((result as any).status).toBe("skipped");
    expect(reviewerCalled).toBe(false);
  });
});
