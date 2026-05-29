/**
 * Integration test: synth disputes a user-accepted objection.
 *
 * Round 1: reviewer raises 1 CRITICAL ("use bcrypt") at [F1, P1]. User accepts.
 * Synth disagrees — instead of applying the fix, it writes
 * `RESOLUTION: disputed — bcrypt conflicts with FIPS in this build`.
 * Round 2: reviewer approves (it can see the dispute and chose not to re-raise).
 *
 * Verifies:
 * - exit clean (outcome "approved")
 * - convergence aggregate's disputedResolutions[0] === 1
 * - the plan file preserves the synth's disputed reasoning text verbatim
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

describe("integration: synth disputes a user accept", () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispute-"));
    planPath = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planPath,
      `# Plan\n## Feature 1\n### Phase 1: setup\n- [ ] x\n`,
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("synth marks RESOLUTION: disputed and disputedResolutions records it", async () => {
    const verdicts: PlanReviewVerdict[] = [
      {
        verdict: "REVISE",
        objections: [
          {
            severity: "CRITICAL",
            location: "Feature 1, Phase 1",
            issue: "use bcrypt",
            suggestion: "switch from sha256 to bcrypt",
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
      const t = fs.readFileSync(planPath, "utf8");
      // Synth disputes the user accept rather than applying the fix.
      fs.writeFileSync(
        planPath,
        t.replace(
          /RESOLUTION: pending/,
          "RESOLUTION: disputed — bcrypt is correct for the spec but conflicts with FIPS requirement in this build",
        ),
        "utf8",
      );
      return { ok: true };
    };
    // Round 1: accept the single objection with rationale "ok".
    const input = readableFrom("a\nok\n");
    const out = captureWriter();
    const result = await runPlanReviewLoop({
      legacyPlanReview: true,
      planPath,
      historyPath: path.join(tmpDir, "history.jsonl"),
      aggregatePath: path.join(tmpDir, "convergence.jsonl"),
      slug: "dispute",
      branch: "feat/dispute",
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
    const agg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "convergence.jsonl"), "utf8").trim(),
    );
    expect(agg.disputedResolutions[0]).toBe(1);
    // Plan annotation should preserve the dispute reasoning verbatim.
    expect(fs.readFileSync(planPath, "utf8")).toContain(
      "ROUND 1 RESOLUTION: disputed — bcrypt is correct for the spec but conflicts with FIPS",
    );
  });
});
