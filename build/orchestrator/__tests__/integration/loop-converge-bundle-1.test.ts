/**
 * Integration test: bundle-1 trajectory 5→3→2→0.
 *
 * Drives runPlanReviewLoop with stub subagents (no real Codex). The reviewer
 * stub replays fixture data captured from the original bundle-1 production
 * shape; the synth stub replaces "RESOLUTION: pending" with
 * "RESOLUTION: synth applied" on every invocation.
 *
 * Verifies the end-to-end story:
 * - 4 rounds, 3 synth invocations, exit APPROVE
 * - history JSONL has 4 lines (one per round)
 * - convergence aggregate has correct trajectory and totals
 * - plan file accumulates ROUND 1/2/3 annotations + top-of-plan history block
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPlanReviewLoop } from "../../plan-review-loop";
import type { PlanReviewVerdict } from "../../types";

function readableFrom(text: string): NodeJS.ReadableStream {
  const r = new Readable({ read() {} });
  r.push(Buffer.from(text));
  r.push(null);
  (r as any).isTTY = true;
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

const FIXTURE_DIR = path.resolve(
  __dirname,
  "../../../../test/fixtures/build-convergence",
);

describe("integration: bundle-1 trajectory 5→3→2→0", () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle1-"));
    planPath = path.join(tmpDir, "plan.md");
    fs.copyFileSync(path.join(FIXTURE_DIR, "bundle-1-plan.md"), planPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("converges in 4 rounds, three synth invocations, exits APPROVE", async () => {
    const stub = JSON.parse(
      fs.readFileSync(
        path.join(FIXTURE_DIR, "bundle-1-reviewer-stub.json"),
        "utf8",
      ),
    );
    let rIdx = 0;
    const reviewerFn = async (): Promise<PlanReviewVerdict> => {
      const r = stub.rounds[rIdx++];
      return {
        verdict: r.verdict,
        objections: r.objections,
        assessment: r.assessment,
        reviewedBy: "stub-reviewer",
        round: r.round,
      };
    };
    let synthInvocations = 0;
    const synthFn = async () => {
      synthInvocations += 1;
      const text = fs.readFileSync(planPath, "utf8");
      fs.writeFileSync(
        planPath,
        text.replace(/RESOLUTION: pending/g, "RESOLUTION: synth applied"),
        "utf8",
      );
      return { ok: true };
    };
    // TTY: [A]ccept-ALL three times (rounds 1, 2, 3); round 4 approves automatically.
    const input = readableFrom("A\nA\nA\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      legacyPlanReview: true,
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "bundle-1",
      branch: "feat/bundle-1-crypto",
      reviewerFn,
      synthFn,
      maxRounds: 5,
      adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept",
      isTTY: true,
      input,
      output: out.stream,
      reviewerName: "stub-reviewer",
      synthesizerName: "stub-synth",
    });

    expect(result.outcome).toBe("approved");
    expect(result.rounds).toBe(4);
    expect(synthInvocations).toBe(3);

    // Verify aggregate.
    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    expect(agg.trajectoryRaw).toEqual([5, 3, 2, 0]);
    expect(agg.trajectoryAccepted).toEqual([5, 3, 2, 0]);
    expect(agg.reRaises).toEqual([0, 0, 0, 0]);
    expect(agg.disputedResolutions).toEqual([0, 0, 0, 0]); // 3 synth calls + 1 APPROVE round
    expect(agg.totalAccepted).toBe(10);
    expect(agg.finalVerdict).toBe("APPROVE");

    // Verify history JSONL has 4 lines.
    const histLines = fs
      .readFileSync(path.join(tmpDir, "history.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(histLines).toHaveLength(4);

    // Verify plan file has annotations from all 3 revising rounds.
    const planText = fs.readFileSync(planPath, "utf8");
    expect(planText).toContain("<!-- gstack-plan-review-history");
    expect(planText).toContain(
      "ROUND 1 CRITICAL [Feature 1, Phase 2]: EIP-712",
    );
    expect(planText).toContain("ROUND 2 CRITICAL");
    expect(planText).toContain("ROUND 3 CRITICAL");

    // Rounds 2 and 3 raise objections at Phases 4-7, which don't exist in the
    // plan fixture (it only has Phases 1-3). The annotation writer falls back
    // to prepending those annotations above the plan heading. Verify the fallback
    // fires correctly: round-2 and round-3 annotations appear before "# Living Plan".
    expect(planText.indexOf("ROUND 2 CRITICAL")).toBeLessThan(
      planText.indexOf("# Living Plan"),
    );
    expect(planText.indexOf("ROUND 3 CRITICAL")).toBeLessThan(
      planText.indexOf("# Living Plan"),
    );
    // Round 1 objections are at Phases 1-3 which exist, so they should be
    // inserted at (or near) the matching Phase heading, not prepended.
    expect(
      planText.indexOf("ROUND 1 CRITICAL [Feature 1, Phase 2]: EIP-712"),
    ).toBeGreaterThan(planText.indexOf("# Living Plan"));
  });
});
