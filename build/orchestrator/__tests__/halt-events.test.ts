import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeFaultId,
  emitHaltEvent,
  loadPendingInvestigations,
  markInvestigated,
  type HaltEvent,
} from "../halt-events";

describe("computeFaultId", () => {
  test("deterministic for identical inputs", () => {
    const a = computeFaultId({
      kind: "PHASE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "phase 2 spec-flip failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { stdoutTail: "" },
    });
    const b = computeFaultId({
      kind: "PHASE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "phase 2 spec-flip failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { stdoutTail: "" },
    });
    expect(a).toBe(b);
  });

  test("differs across phase indices", () => {
    const base = {
      kind: "PHASE_FAILED" as const,
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL" as const,
      message: "same",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
    };
    const a = computeFaultId({
      ...base,
      snapshot: { phase: { index: 0, status: "failed" } as any, stdoutTail: "" },
    });
    const b = computeFaultId({
      ...base,
      snapshot: { phase: { index: 1, status: "failed" } as any, stdoutTail: "" },
    });
    expect(a).not.toBe(b);
  });

  test("uses f<number> for feature-scoped events", () => {
    const id = computeFaultId({
      kind: "FEATURE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "ship failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { feature: { number: "3", status: "failed" } as any, stdoutTail: "" },
    });
    expect(id.startsWith("FEATURE_FAILED:f3:")).toBe(true);
  });
});

describe("emitHaltEvent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-events-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes <runId>-<faultId>.json atomically", () => {
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "run-abc",
        stateSlug: "slug-1",
        severity: "CRITICAL",
        message: "phase 0 failed",
        pointers: {
          stateFile: "/x/state.json",
          stdoutLog: "/x/stdout.log",
          livingPlan: "/x/plan.md",
          worktreePath: "/x/wt",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    const file = path.join(
      tmpDir, "pending-investigations", `run-abc-${faultId}.json`,
    );
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.faultId).toBe(faultId);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("no temp file is left behind on success", () => {
    emitHaltEvent(
      {
        kind: "SOFT_HALT_WARN",
        runId: "r1",
        stateSlug: "s1",
        severity: "LOW",
        message: "test",
        pointers: {
          stateFile: "/x/state.json",
          stdoutLog: "/x/stdout.log",
          livingPlan: "/x/plan.md",
          worktreePath: "/x/wt",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    const tmpFiles = fs
      .readdirSync(path.join(tmpDir, "pending-investigations"))
      .filter((f) => f.includes(".tmp."));
    expect(tmpFiles.length).toBe(0);
  });
});

describe("loadPendingInvestigations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-events-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when dir missing", () => {
    expect(loadPendingInvestigations({ queueDir: tmpDir })).toEqual([]);
  });

  test("loads multiple events, ignores .tmp files", () => {
    const a = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "a",
        pointers: {
          stateFile: "/x", stdoutLog: "/x", livingPlan: "/x", worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    const b = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "b",
        pointers: {
          stateFile: "/x", stdoutLog: "/x", livingPlan: "/x", worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    // Plant a stray .tmp file
    fs.writeFileSync(
      path.join(tmpDir, "pending-investigations", "stray.tmp.99999"),
      "{}",
    );
    const loaded = loadPendingInvestigations({ queueDir: tmpDir });
    expect(loaded.map((e) => e.faultId).sort()).toEqual([a, b].sort());
  });

  test("skips malformed JSON files without throwing", () => {
    const good = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "good event",
        pointers: {
          stateFile: "/x", stdoutLog: "/x", livingPlan: "/x", worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    // Plant a malformed JSON file alongside the good one
    fs.writeFileSync(
      path.join(tmpDir, "pending-investigations", "r1-broken.json"),
      "{not valid json",
    );
    const loaded = loadPendingInvestigations({ queueDir: tmpDir });
    expect(loaded.map((e) => e.faultId)).toEqual([good]);
  });
});

describe("markInvestigated", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-events-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("moves file to processed/", () => {
    const faultId = emitHaltEvent(
      {
        kind: "FEATURE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "x",
        pointers: {
          stateFile: "/x", stdoutLog: "/x", livingPlan: "/x", worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    markInvestigated("r1", faultId, "investigated", { queueDir: tmpDir });
    const pending = path.join(
      tmpDir, "pending-investigations", `r1-${faultId}.json`,
    );
    const processed = path.join(
      tmpDir, "processed", `r1-${faultId}.json`,
    );
    expect(fs.existsSync(pending)).toBe(false);
    expect(fs.existsSync(processed)).toBe(true);
  });
});
