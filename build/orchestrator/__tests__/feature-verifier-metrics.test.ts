/**
 * feature-verifier (T12) JSONL metrics unit tests.
 *
 * Covers the write helper: path resolution (sibling analytics/ of the build
 * state dir), JSONL append, the featureReviewVerdict correlation field that
 * answers keep-vs-demote, and the best-effort error swallow.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFeatureVerifierMetrics } from "../feature-verifier-metrics";

describe("writeFeatureVerifierMetrics", () => {
  let tmpdir: string;
  const origStateDir = process.env.GSTACK_BUILD_STATE_DIR;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fv-metrics-"));
    process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpdir, "build-state");
    fs.mkdirSync(process.env.GSTACK_BUILD_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (origStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
    else process.env.GSTACK_BUILD_STATE_DIR = origStateDir;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test("writes one JSONL row to <state-dir-parent>/analytics/feature-verifier-metrics.jsonl", () => {
    writeFeatureVerifierMetrics({
      ts: "2026-06-01T00:00:00Z",
      feature: "2",
      slug: "demo",
      verdict: "GAPS",
      gapsCount: 3,
      featureReviewRan: true,
      featureReviewVerdict: "FEATURE_PASS",
      structured: true,
      strictMode: false,
      reason: null,
      wallMs: 42000,
      outputBytes: 512,
    });
    const file = path.join(
      tmpdir,
      "analytics",
      "feature-verifier-metrics.jsonl",
    );
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.feature).toBe("2");
    expect(row.verdict).toBe("GAPS");
    expect(row.gapsCount).toBe(3);
    // The correlation fields are the whole point of this metrics stream.
    expect(row.featureReviewRan).toBe(true);
    expect(row.featureReviewVerdict).toBe("FEATURE_PASS");
    expect(row.structured).toBe(true);
  });

  test("featureReviewRan disambiguates the two keep-signal populations", () => {
    const base = {
      ts: "2026-06-01T00:00:00Z",
      slug: "demo",
      gapsCount: 1,
      structured: false,
      strictMode: false,
      reason: null,
      wallMs: 0,
      outputBytes: 0,
    };
    // Case 1: T12 GAPS on a feature F3 ran AND passed.
    writeFeatureVerifierMetrics({
      ...base,
      feature: "1",
      verdict: "GAPS",
      featureReviewRan: true,
      featureReviewVerdict: "FEATURE_PASS",
    });
    // Case 2: T12 GAPS on a feature F3 SKIPPED entirely (the strongest
    // keep-signal — F3 never looked). Pre-fix this hid under a null verdict.
    writeFeatureVerifierMetrics({
      ...base,
      feature: "2",
      verdict: "GAPS",
      featureReviewRan: false,
      featureReviewVerdict: null,
    });
    const file = path.join(
      tmpdir,
      "analytics",
      "feature-verifier-metrics.jsonl",
    );
    const rows = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.length).toBe(2);
    // Keep-signal 1: GAPS where F3 ran and passed.
    const caughtAfterPass = rows.filter(
      (r) =>
        r.verdict === "GAPS" &&
        r.featureReviewRan &&
        r.featureReviewVerdict === "FEATURE_PASS",
    );
    expect(caughtAfterPass.map((r) => r.feature)).toEqual(["1"]);
    // Keep-signal 2: GAPS where F3 never ran — must be separable from null-noise.
    const caughtUnseen = rows.filter(
      (r) => r.verdict === "GAPS" && !r.featureReviewRan,
    );
    expect(caughtUnseen.map((r) => r.feature)).toEqual(["2"]);
  });

  test("featureReviewRan=false records F3-skipped features (was indistinguishable pre-fix)", () => {
    writeFeatureVerifierMetrics({
      ts: "2026-06-01T00:00:00Z",
      feature: "3",
      slug: "demo",
      verdict: "PASS",
      gapsCount: 0,
      featureReviewRan: false,
      featureReviewVerdict: null,
      structured: false,
      strictMode: false,
      reason: null,
      wallMs: 30000,
      outputBytes: 128,
    });
    const file = path.join(
      tmpdir,
      "analytics",
      "feature-verifier-metrics.jsonl",
    );
    const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(row.featureReviewRan).toBe(false);
    expect(row.featureReviewVerdict).toBeNull();
  });

  test("write failure does NOT throw", () => {
    process.env.GSTACK_BUILD_STATE_DIR = "/no/such/path/that/exists";
    expect(() =>
      writeFeatureVerifierMetrics({
        ts: "2026-06-01T00:00:00Z",
        feature: "1",
        slug: "demo",
        verdict: "UNCLEAR",
        gapsCount: 0,
        featureReviewRan: false,
        featureReviewVerdict: null,
        structured: false,
        strictMode: false,
        reason: "verifier subprocess timed out",
        wallMs: 0,
        outputBytes: 0,
      }),
    ).not.toThrow();
  });
});
