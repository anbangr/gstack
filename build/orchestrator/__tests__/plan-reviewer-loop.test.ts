import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runPlanReviewLoop,
  type RunPlanReviewLoopResult,
} from "../plan-review-loop";
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
      write(c, _e, cb) { buf += c.toString(); cb(); },
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
    const input = readableFrom(
      "A\nA\nA\n",
    );
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
    });
    expect(result.outcome).toBe("approved");
    expect(result.rounds).toBe(4);
    expect(synthCalls).toBe(3);
    const aggLine = fs.readFileSync(
      path.join(tmpDir, "convergence.jsonl"),
      "utf8",
    ).trim();
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
          { severity: "CRITICAL", location: "F1, P1", issue: "x", suggestion: "y" },
          { severity: "CRITICAL", location: "F1, P2", issue: "x", suggestion: "y" },
        ],
        assessment: "", reviewedBy: "stub", round: 1,
      },
      {
        verdict: "APPROVE", objections: [], assessment: "", reviewedBy: "stub", round: 2,
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
      slug: "test", branch: "feat/x",
      reviewerFn, synthFn,
      maxRounds: 5, adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept", isTTY: true,
      input, output: out.stream,
      reviewerName: "stub", synthesizerName: "stub-synth",
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
      objections: [{
        severity: "CRITICAL",
        location: `F1, P${++rIdx}`,
        issue: "x",
        suggestion: "y",
      }],
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
      slug: "max-rounds", branch: "feat/max-rounds",
      reviewerFn, synthFn,
      maxRounds: 3,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: false,
      input: readableFrom(""),
      output: out.stream,
      reviewerName: "stub", synthesizerName: "stub-synth",
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
        objections: [{ severity: "CRITICAL", location: "F1, P1", issue: "x", suggestion: "y" }],
        assessment: "r1", reviewedBy: "stub", round: 1,
      },
      {
        verdict: "REVISE",
        objections: [{ severity: "CRITICAL", location: "F1, P1", issue: "x", suggestion: "y" }],
        assessment: "r2", reviewedBy: "stub", round: 2,
      },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    // Synth simulates fixing by replacing "RESOLUTION: pending" with a real value.
    const synthFn = async () => {
      const text = fs.readFileSync(planPath, "utf8");
      const updated = text.replace(/RESOLUTION: pending/g, "RESOLUTION: synth fixed");
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
      slug: "test", branch: "feat/x",
      reviewerFn, synthFn,
      maxRounds: 5, adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept", isTTY: true,
      input, output: out.stream,
      reviewerName: "stub", synthesizerName: "stub-synth",
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
          { severity: "IMPORTANT", location: "F1, P1", issue: "imp-1", suggestion: "fix-1" },
          { severity: "IMPORTANT", location: "F1, P2", issue: "imp-2", suggestion: "fix-2" },
          { severity: "SUGGESTION", location: "F1, P3", issue: "sug-1", suggestion: "fix-3" },
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
          { severity: "IMPORTANT", location: "F1, P1", issue: "imp-1", suggestion: "fix-1" },
          { severity: "IMPORTANT", location: "F1, P2", issue: "imp-2", suggestion: "fix-2" },
          { severity: "IMPORTANT", location: "F1, P3", issue: "imp-3", suggestion: "fix-3" },
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
          { severity: "IMPORTANT", location: "F1, P1", issue: "imp-1", suggestion: "fix-1" },
          { severity: "SUGGESTION", location: "F1, P3", issue: "sug-1", suggestion: "fix-3" },
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

  it("synthFn rejection is caught and the loop continues to the next round", async () => {
    let reviewCalls = 0;
    const reviewerFn = async (round: number): Promise<PlanReviewVerdict> => {
      reviewCalls += 1;
      if (round >= 2) {
        // Second call: approve so the loop terminates cleanly.
        return {
          verdict: "APPROVE",
          objections: [],
          assessment: "",
          reviewedBy: "stub",
          round,
        };
      }
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
    });
    // Loop survived the synth failure and continued to round 2's APPROVE.
    expect(result.outcome).toBe("approved");
    expect(synthCalls).toBe(1);
    expect(reviewCalls).toBe(2);
    expect(result.rounds).toBe(2);
    // Convergence aggregate must still be written.
    expect(
      fs.existsSync(path.join(tmpDir, "convergence.jsonl")),
    ).toBe(true);
  });
});
