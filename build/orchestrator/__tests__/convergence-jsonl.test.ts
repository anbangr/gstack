import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeConvergenceAggregate,
  type ConvergenceAggregate,
} from "../plan-review-loop";

let tmpDir: string;
let aggPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-test-"));
  aggPath = path.join(tmpDir, "analytics", "convergence.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeConvergenceAggregate", () => {
  it("creates analytics dir and writes one line for bundle-1 trajectory", () => {
    const agg: ConvergenceAggregate = {
      ts: "2026-05-19T12:19:55Z",
      slug: "test-slug",
      branch: "feat/bundle-1",
      rounds: 4,
      finalVerdict: "APPROVE",
      exitReason: "approved",
      trajectoryRaw: [5, 3, 3, 0],
      trajectoryAccepted: [3, 3, 2, 0],
      reRaises: [0, 0, 1, 0],
      reRejected: [0, 0, 1, 0],
      disputedResolutions: [0, 0, 0, 0],
      totalAccepted: 8,
      totalRejected: 4,
      totalDeferred: 0,
      reviewer: "codex/gpt-5.5/high",
      synthesizer: "codex/gpt-5.5/medium",
      wallTimeS: 1102,
      reviewerWallTimeS: 487,
      synthWallTimeS: 542,
      planFileSizeBytes: [4821, 5103, 5410, 5398],
      interrupted: false,
      annotationParseErrors: 0,
    };
    writeConvergenceAggregate(aggPath, agg);
    const lines = fs.readFileSync(aggPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(agg);
  });

  it("appends additional builds to the same file", () => {
    const base: ConvergenceAggregate = {
      ts: "t", slug: "s", branch: "b", rounds: 1, finalVerdict: "APPROVE",
      exitReason: "approved", trajectoryRaw: [0], trajectoryAccepted: [0],
      reRaises: [0], reRejected: [0], disputedResolutions: [0],
      totalAccepted: 0, totalRejected: 0, totalDeferred: 0,
      reviewer: "x", synthesizer: "y", wallTimeS: 1,
      reviewerWallTimeS: 1, synthWallTimeS: 0,
      planFileSizeBytes: [100], interrupted: false, annotationParseErrors: 0,
    };
    writeConvergenceAggregate(aggPath, { ...base, slug: "build-1" });
    writeConvergenceAggregate(aggPath, { ...base, slug: "build-2" });
    const lines = fs.readFileSync(aggPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).slug).toBe("build-1");
    expect(JSON.parse(lines[1]).slug).toBe("build-2");
  });

  it("does not throw if file write fails (logs to console.warn)", () => {
    // Pass a path that can't be created (parent is a file, not dir).
    const filePath = path.join(tmpDir, "blocked-file");
    fs.writeFileSync(filePath, "x", "utf8");
    const bad = path.join(filePath, "convergence.jsonl");
    const agg: ConvergenceAggregate = {
      ts: "t", slug: "s", branch: "b", rounds: 1, finalVerdict: "APPROVE",
      exitReason: "approved", trajectoryRaw: [0], trajectoryAccepted: [0],
      reRaises: [0], reRejected: [0], disputedResolutions: [0],
      totalAccepted: 0, totalRejected: 0, totalDeferred: 0,
      reviewer: "x", synthesizer: "y", wallTimeS: 1,
      reviewerWallTimeS: 1, synthWallTimeS: 0,
      planFileSizeBytes: [100], interrupted: false, annotationParseErrors: 0,
    };
    expect(() => writeConvergenceAggregate(bad, agg)).not.toThrow();
  });
});
