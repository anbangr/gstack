import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendHistoryEntry,
  readHistoryEntries,
  deriveRoundNumber,
  type HistoryEntry,
} from "../plan-review-loop";

let tmpDir: string;
let histPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
  histPath = path.join(tmpDir, "plan-review-history.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendHistoryEntry", () => {
  it("creates the file when absent and writes one line", () => {
    const entry: HistoryEntry = {
      round: 1,
      ts: "2026-05-19T12:00:00Z",
      reviewedBy: "codex",
      verdict: "REVISE",
      objectionCountRaw: 5,
      critical: 5,
      important: 0,
      suggestion: 0,
      triage: { accepted: [0, 2, 4], rejected: [1, 3], deferred: [] },
      convergence: { delta: null, noForwardProgress: false, reRaises: 0, newObjections: 5 },
    };
    appendHistoryEntry(histPath, entry);
    const lines = fs.readFileSync(histPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it("appends without rewriting existing lines", () => {
    appendHistoryEntry(histPath, {
      round: 1, ts: "t1", reviewedBy: "codex", verdict: "REVISE",
      objectionCountRaw: 5, critical: 5, important: 0, suggestion: 0,
      triage: { accepted: [0], rejected: [], deferred: [] },
      convergence: { delta: null, noForwardProgress: false, reRaises: 0, newObjections: 5 },
    });
    appendHistoryEntry(histPath, {
      round: 2, ts: "t2", reviewedBy: "codex", verdict: "APPROVE",
      objectionCountRaw: 0, critical: 0, important: 0, suggestion: 0,
      triage: null,
      convergence: { delta: -1, noForwardProgress: false, reRaises: 0, newObjections: 0 },
    });
    const lines = fs.readFileSync(histPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).round).toBe(2);
  });
});

describe("readHistoryEntries", () => {
  it("returns empty array for missing file", () => {
    expect(readHistoryEntries(histPath)).toEqual([]);
  });

  it("skips corrupt lines and logs a warning", () => {
    fs.writeFileSync(
      histPath,
      `${JSON.stringify({ round: 1, ts: "t1", reviewedBy: "c", verdict: "REVISE", objectionCountRaw: 1, critical: 1, important: 0, suggestion: 0, triage: null, convergence: { delta: null, noForwardProgress: false, reRaises: 0, newObjections: 1 } })}\n` +
        `{not valid json\n` +
        `${JSON.stringify({ round: 2, ts: "t2", reviewedBy: "c", verdict: "APPROVE", objectionCountRaw: 0, critical: 0, important: 0, suggestion: 0, triage: null, convergence: { delta: -1, noForwardProgress: false, reRaises: 0, newObjections: 0 } })}\n`,
    );
    const entries = readHistoryEntries(histPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].round).toBe(1);
    expect(entries[1].round).toBe(2);
  });
});

describe("deriveRoundNumber", () => {
  it("returns 1 for empty history", () => {
    expect(deriveRoundNumber([])).toBe(1);
  });

  it("returns max(round)+1 for non-empty history", () => {
    expect(
      deriveRoundNumber([
        { round: 1 } as HistoryEntry,
        { round: 2 } as HistoryEntry,
      ]),
    ).toBe(3);
  });
});
