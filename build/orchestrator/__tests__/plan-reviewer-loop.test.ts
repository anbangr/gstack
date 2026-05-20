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
});
