import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadHaltEventByFaultId,
  pickMostRecentActiveRun,
  resolveInvestigationContext,
} from "../investigate-context";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-ctx-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeHaltEvent(
  subdir: "pending-investigations" | "processed",
  runId: string,
  faultId: string,
): void {
  const dir = path.join(faultsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const event = {
    faultId, runId, stateSlug: "slug", kind: "PHASE_FAILED",
    severity: "HIGH", timestamp: "2026-05-22T10:00:00.000Z",
    message: "test",
    pointers: {
      stateFile: "/tmp/state.json", stdoutLog: "/tmp/stdout.log",
      livingPlan: "/tmp/plan.md", worktreePath: "/tmp/wt",
    },
    snapshot: { stdoutTail: "" },
  };
  fs.writeFileSync(
    path.join(dir, `${runId}-${faultId}.json`),
    JSON.stringify(event),
  );
}

function writeActiveRun(runId: string, lastUpdatedAt: string): void {
  const record = {
    runId, stateSlug: "slug", repoPath: "/tmp/repo",
    worktreePath: "/tmp/wt", planFile: "/tmp/plan.md",
    pid: process.pid, status: "running",
    startedAt: lastUpdatedAt, lastUpdatedAt,
    branches: ["feat/x"],
  };
  fs.writeFileSync(
    path.join(activeRunsDir, `${runId}.json`),
    JSON.stringify(record),
  );
}

describe("loadHaltEventByFaultId", () => {
  test("finds event in pending-investigations", () => {
    writeHaltEvent("pending-investigations", "run-A", "CAT:p0:abc");
    const found = loadHaltEventByFaultId({ faultId: "CAT:p0:abc", faultsDir });
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("run-A");
  });

  test("finds event in processed/ if not in pending", () => {
    writeHaltEvent("processed", "run-B", "CAT:p1:def");
    const found = loadHaltEventByFaultId({ faultId: "CAT:p1:def", faultsDir });
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("run-B");
  });

  test("returns null when fault id not found anywhere", () => {
    const found = loadHaltEventByFaultId({ faultId: "MISSING:p0:xxx", faultsDir });
    expect(found).toBeNull();
  });
});

describe("pickMostRecentActiveRun", () => {
  test("returns the run with the latest lastUpdatedAt", () => {
    writeActiveRun("run-old", "2026-05-22T08:00:00.000Z");
    writeActiveRun("run-new", "2026-05-22T10:00:00.000Z");
    const picked = pickMostRecentActiveRun({ registryDir: activeRunsDir });
    expect(picked).not.toBeNull();
    expect(picked!.runId).toBe("run-new");
  });

  test("returns null when no records exist", () => {
    expect(pickMostRecentActiveRun({ registryDir: activeRunsDir })).toBeNull();
  });
});

describe("resolveInvestigationContext", () => {
  test("explicit --state flag wins over auto-detect", async () => {
    writeActiveRun("run-detected", "2026-05-22T10:00:00.000Z");
    const stateFile = path.join(tmpRoot, "explicit-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      runId: "run-explicit", stateSlug: "slug", recentErrors: [],
    }));
    const ctx = await resolveInvestigationContext({
      statePath: stateFile,
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    });
    expect(ctx).not.toBeNull();
    expect(ctx!.runId).toBe("run-explicit");
    expect(ctx!.source).toBe("explicit-state");
  });

  test("positional faultId resolves the stored halt event", async () => {
    writeHaltEvent("pending-investigations", "run-FF", "CAT:p2:fff");
    const ctx = await resolveInvestigationContext({
      faultId: "CAT:p2:fff",
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    });
    expect(ctx).not.toBeNull();
    expect(ctx!.runId).toBe("run-FF");
    expect(ctx!.faultId).toBe("CAT:p2:fff");
    expect(ctx!.source).toBe("explicit-fault-id");
  });

  test("symptoms-only synthesizes a manual fault id", async () => {
    const ctx = await resolveInvestigationContext({
      symptoms: "build halts on phase 3 codex review every time",
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    });
    expect(ctx).not.toBeNull();
    expect(ctx!.runId).toMatch(/^manual-/);
    expect(ctx!.faultId).toMatch(/^MANUAL_INVESTIGATION:0:/);
    expect(ctx!.severity).toBe("MEDIUM");
    expect(ctx!.source).toBe("symptoms");
  });

  test("auto-detect picks most recent active run when no flags given", async () => {
    writeActiveRun("run-auto", "2026-05-22T10:00:00.000Z");
    writeHaltEvent("pending-investigations", "run-auto", "CAT:p0:aaa");
    const ctx = await resolveInvestigationContext({
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    });
    expect(ctx).not.toBeNull();
    expect(ctx!.runId).toBe("run-auto");
    expect(ctx!.faultId).toBe("CAT:p0:aaa");
    expect(ctx!.source).toBe("auto-detect");
  });

  test("returns null context when nothing found and non-TTY", async () => {
    const ctx = await resolveInvestigationContext({
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    });
    expect(ctx).toBeNull();
  });
});
