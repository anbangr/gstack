/**
 * T1: feature-review JSONL metrics unit tests.
 *
 * Covers the write helper (path resolution, JSONL append, error swallow)
 * and the watchFirstWrite poller (null when never written, positive ms
 * when file becomes non-empty, idempotent stop, ENOENT tolerance).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeFeatureReviewMetrics,
  watchFirstWrite,
} from "../feature-review-metrics";

describe("writeFeatureReviewMetrics", () => {
  let tmpdir: string;
  const origStateDir = process.env.GSTACK_BUILD_STATE_DIR;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fr-metrics-"));
    process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpdir, "build-state");
    fs.mkdirSync(process.env.GSTACK_BUILD_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (origStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
    else process.env.GSTACK_BUILD_STATE_DIR = origStateDir;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test("writes one JSONL row to <state-dir-parent>/analytics/feature-review-metrics.jsonl", () => {
    writeFeatureReviewMetrics({
      ts: "2026-05-21T00:00:00Z",
      feature: "1",
      cycle: 1,
      reasoning: "high",
      verdict: "FEATURE_PASS",
      promptBytes: 100,
      outputBytes: 50,
      wallMs: 1000,
      spawnToFirstWriteMs: 300,
      firstWriteToCompletionMs: 700,
      endedBy: "exit0",
      passEvidenceTimeout: false,
    });
    const file = path.join(tmpdir, "analytics", "feature-review-metrics.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.feature).toBe("1");
    expect(row.cycle).toBe(1);
    expect(row.verdict).toBe("FEATURE_PASS");
    expect(row.spawnToFirstWriteMs).toBe(300);
    expect(row.firstWriteToCompletionMs).toBe(700);
    expect(row.endedBy).toBe("exit0");
  });

  test("write failure does NOT throw", () => {
    // Point at an un-writable dir (root-owned / nonexistent parent we can't create)
    process.env.GSTACK_BUILD_STATE_DIR = "/no/such/path/that/exists";
    expect(() =>
      writeFeatureReviewMetrics({
        ts: "2026-05-21T00:00:00Z",
        feature: "1",
        cycle: 1,
        reasoning: "high",
        verdict: "FEATURE_PASS",
        promptBytes: 0,
        outputBytes: 0,
        wallMs: 0,
        spawnToFirstWriteMs: null,
        firstWriteToCompletionMs: null,
        endedBy: "exit0",
        passEvidenceTimeout: false,
      }),
    ).not.toThrow();
  });
});

describe("watchFirstWrite", () => {
  let tmpdir: string;
  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-watch-"));
  });
  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test("returns null when file stays empty", async () => {
    const filePath = path.join(tmpdir, "out.md");
    fs.writeFileSync(filePath, "");
    const start = Date.now();
    const w = watchFirstWrite(filePath, start, 50);
    await new Promise((r) => setTimeout(r, 200));
    w.stop();
    expect(w.firstWriteAt()).toBeNull();
  });

  test("returns positive ms when file becomes non-empty", async () => {
    const filePath = path.join(tmpdir, "out.md");
    fs.writeFileSync(filePath, "");
    const start = Date.now();
    const w = watchFirstWrite(filePath, start, 50);
    setTimeout(() => fs.writeFileSync(filePath, "hello"), 150);
    await new Promise((r) => setTimeout(r, 500));
    w.stop();
    const at = w.firstWriteAt();
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(100);
    expect(at!).toBeLessThan(2000);
  });

  test("stop() is idempotent", () => {
    const filePath = path.join(tmpdir, "out.md");
    const w = watchFirstWrite(filePath, Date.now(), 50);
    expect(() => {
      w.stop();
      w.stop();
    }).not.toThrow();
  });

  test("handles ENOENT silently — detects file when it appears", async () => {
    const filePath = path.join(tmpdir, "later.md");
    // file does NOT exist yet
    const start = Date.now();
    const w = watchFirstWrite(filePath, start, 50);
    setTimeout(() => fs.writeFileSync(filePath, "appeared"), 150);
    await new Promise((r) => setTimeout(r, 500));
    w.stop();
    const at = w.firstWriteAt();
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(100);
  });
});
