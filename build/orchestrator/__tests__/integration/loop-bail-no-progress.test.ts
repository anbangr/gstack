/**
 * Integration test: adaptive cap fires on re-raises-only stall.
 *
 * Round 1: reviewer raises 2 CRITICAL at [F1,P1] and [F1,P2]. User accepts
 * both. Synth pretends to resolve (rewrites RESOLUTION: pending to a real
 * value), but the reviewer in round 2 ignores the resolutions and re-raises
 * the SAME two objections with no new ones.
 *
 * Adaptive cap detects: reRaises=2, newObjections=0 → bail-out gate fires.
 * User picks [m]anual mode → exit code 3, outcome "user_manual".
 *
 * Verifies the convergence.jsonl exit_reason is "user_manual" and that
 * the loop exits without invoking synth a second time.
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
      write(c, _e, cb) { buf += c.toString(); cb(); },
    }),
    read: () => buf,
  };
}

describe("integration: adaptive bail on re-raises-only", () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bail-"));
    planPath = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planPath,
      `# Plan\n\n## Feature 1: x\n\n### Phase 1: setup\n- [ ] task\n\n### Phase 2: impl\n- [ ] task\n`,
    );
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("fires adaptive bail at round 2 when all are re-raises", async () => {
    const objs = [
      { severity: "CRITICAL" as const, location: "Feature 1, Phase 1", issue: "x", suggestion: "y" },
      { severity: "CRITICAL" as const, location: "Feature 1, Phase 2", issue: "x", suggestion: "y" },
    ];
    const verdicts: PlanReviewVerdict[] = [
      { verdict: "REVISE", objections: objs, assessment: "", reviewedBy: "stub", round: 1 },
      { verdict: "REVISE", objections: objs, assessment: "", reviewedBy: "stub", round: 2 },
    ];
    let rIdx = 0;
    const reviewerFn = async () => verdicts[rIdx++];
    // Synth pretends to apply the fix so the annotation marks resolution non-pending.
    // This is what makes the round-2 re-raise count as a real re-raise per
    // isPriorAcceptedResolutionAttempt (resolution !== "pending").
    let synthInvocations = 0;
    const synthFn = async () => {
      synthInvocations += 1;
      const t = fs.readFileSync(planPath, "utf8");
      fs.writeFileSync(
        planPath,
        t.replace(/RESOLUTION: pending/g, "RESOLUTION: synth applied"),
        "utf8",
      );
      return { ok: true };
    };
    // Round 1: accept both objections with rationale "ok".
    // Round 2: accept both again with rationale "ok" — the loop detects them
    // as re-raises and fires the bail-out gate.
    // At the bail-out gate: pick [m]anual mode.
    const input = readableFrom("a\nok\na\nok\na\nok\na\nok\nm\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "bail-test", branch: "feat/bail",
      reviewerFn, synthFn,
      maxRounds: 5, adaptiveEnabled: true,
      nonInteractiveMode: "auto-accept", isTTY: true,
      input, output: out.stream,
      reviewerName: "stub", synthesizerName: "stub-synth",
    });

    expect(result.outcome).toBe("user_manual");
    expect(result.exitCode).toBe(3);
    expect(result.rounds).toBe(2);
    expect(synthInvocations).toBe(1); // only round 1 invoked synth; round 2 bailed before synth

    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    expect(agg.exitReason).toBe("user_manual");
    expect(agg.reRaises).toEqual([0, 2]);
  });
});
