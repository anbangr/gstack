import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluateMonitorOnce,
  loadMonitorManifest,
  monitorExitCode,
} from "../monitor";
import {
  buildMonitorAgentEscalation,
  buildMonitorAgentPrompt,
  parseMonitorAgentJson,
  shouldInvokeMonitorAgent,
} from "../monitor-supervisor";
import { lockPath } from "../state";
import type { BuildRunManifest, BuildState } from "../types";

let tmpDir: string;
let stateDir: string;
let oldStateDir: string | undefined;
let oldGstackHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = stateDir;
  // Isolate GSTACK_HOME — evaluateMonitorOnce triggers detectSkillFaults,
  // which appends to ${GSTACK_HOME}/analytics/skill-faults.jsonl. Without
  // this, each test run leaks fault entries into the developer's real ~/.gstack/.
  oldGstackHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = tmpDir;
});

afterEach(() => {
  if (oldStateDir) process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (oldGstackHome !== undefined) process.env.GSTACK_HOME = oldGstackHome;
  else delete process.env.GSTACK_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function manifest(
  overrides: Partial<BuildRunManifest["runs"][number]> = {},
): BuildRunManifest {
  const repoPath = path.join(tmpDir, "repo");
  const worktreePath = path.join(tmpDir, "worktree");
  const runId = overrides.runId ?? "run-a";
  return {
    manifestId: "manifest-a",
    runGroupId: "group-a",
    tmpDir,
    workspaceRoot: tmpDir,
    gstackRepo: path.join(tmpDir, "demo-gstack"),
    runs: [
      {
        runId,
        repoPath,
        repoSlug: "repo",
        sourcePlanPath: path.join(tmpDir, "demo-gstack", "inbox", "plan.md"),
        livingPlanPath: path.join(tmpDir, "living.md"),
        originPlanPath: path.join(tmpDir, "demo-gstack", "inbox", "plan.md"),
        worktreePath,
        stateSlug: `build-${runId}`,
        branchPrefix: `repo-${runId}`,
        pidFile: path.join(tmpDir, runId, "gstack-build.pid"),
        stdoutLog: path.join(tmpDir, runId, "agent-stdout.log"),
        launchCommand: [
          "/bin/echo",
          "resume",
          "--active-run-registry",
          path.join(tmpDir, "active-runs"),
        ],
        launchEnv: {},
        ...overrides,
      },
    ],
  };
}

function writeManifest(data: BuildRunManifest): string {
  const filePath = path.join(tmpDir, "manifest.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function writeState(
  run: BuildRunManifest["runs"][number],
  overrides: Partial<BuildState> = {},
): BuildState {
  const now = new Date("2026-05-08T00:00:00.000Z").toISOString();
  const state: BuildState = {
    planFile: run.livingPlanPath,
    planBasename: "living",
    slug: run.stateSlug,
    branch: "feat/test",
    startedAt: now,
    lastUpdatedAt: now,
    launch: {
      argv: run.launchCommand,
      projectRoot: run.worktreePath,
      baseProjectRoot: run.repoPath,
      runId: run.runId,
      branchPrefix: run.branchPrefix,
      activeRunRegistry: path.join(tmpDir, "active-runs"),
      stateSlug: run.stateSlug,
      originPlan: run.originPlanPath,
      dryRun: false,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: now,
    },
    currentPhaseIndex: 0,
    currentFeatureIndex: 0,
    features: [
      {
        index: 0,
        number: "1",
        name: "Feature",
        phaseIndexes: [0],
        status: "running",
      },
    ],
    phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
    completed: false,
    ...overrides,
  };
  fs.writeFileSync(
    path.join(stateDir, `${run.stateSlug}.json`),
    JSON.stringify(state, null, 2),
  );
  return state;
}

function writeContextCount(
  run: BuildRunManifest["runs"][number],
  count: number,
): void {
  const dir = path.join(stateDir, run.stateSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".host-context-save-count"), `${count}\n`);
}

describe("loadMonitorManifest", () => {
  it("accepts manifest v2 runs with launchCommand", () => {
    const filePath = writeManifest(manifest());
    const loaded = loadMonitorManifest(filePath);
    expect(loaded.runs[0].launchCommand[0]).toBe("/bin/echo");
  });

  it("fails closed when launchCommand is missing", () => {
    const data = manifest();
    delete (data.runs[0] as any).launchCommand;
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("MONITOR_ERROR");
    expect(result.terminalEvent.message).toContain("launchCommand");
  });

  it("fails closed when required top-level manifest fields are missing", () => {
    const data = manifest();
    delete (data as any).manifestId;
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("MONITOR_ERROR");
    expect(result.terminalEvent.message).toContain("manifestId");
  });
});

describe("evaluateMonitorOnce", () => {
  it("emits HOST_CONTEXT_SAVE_REQUIRED when committed count advances", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
    });
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("HOST_CONTEXT_SAVE_REQUIRED");
    expect(result.terminalEvent.committed).toBe(1);
    expect(monitorExitCode(result.terminalEvent.event)).toBe(10);
  });

  it("returns ALL_RUNS_COMPLETE only after host context-save count is current", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
      completed: true,
    });
    writeContextCount(run, 1);
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("ALL_RUNS_COMPLETE");
    expect(monitorExitCode(result.terminalEvent.event)).toBe(0);
  });

  it("emits RUN_FAILED for failed state and preserves worktree ownership", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "tests failed",
      phases: [{ index: 0, number: "1", name: "Phase", status: "failed" }],
    });
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("RUN_FAILED");
    expect(result.terminalEvent.stdoutLog).toBe(run.stdoutLog);
    expect(monitorExitCode(result.terminalEvent.event)).toBe(20);
  });

  it("auto-resumes stale dead runs only when identity matches", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });
    expect(result.terminalEvent.event).toBe("RUN_RESUMED");
    expect(result.terminalEvent.resumeAttempted).toBe(true);
  });

  it("removes a dead state lock before auto-resuming a stale run", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const staleLock = lockPath(run.stateSlug);
    fs.writeFileSync(staleLock, "99999999\n2026-05-08T00:01:00.000Z\n");

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("RUN_RESUMED");
    expect(fs.existsSync(staleLock)).toBe(false);
  });

  it("does not remove a live state lock for a stale run", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const liveLock = lockPath(run.stateSlug);
    fs.writeFileSync(liveLock, `${process.pid}\n2026-05-08T00:01:00.000Z\n`);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain(
      "lock is still held by a live process",
    );
    expect(fs.existsSync(liveLock)).toBe(true);
  });

  it("requires user action when a stale run has an invalid state lock", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const invalidLock = lockPath(run.stateSlug);
    fs.writeFileSync(invalidLock, "not-a-pid\n2026-05-08T00:01:00.000Z\n");

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("cannot be safely verified");
    expect(fs.existsSync(invalidLock)).toBe(true);
  });

  it("requires user action when stale run identity is ambiguous", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      launch: {
        argv: run.launchCommand,
        projectRoot: path.join(tmpDir, "wrong-worktree"),
        baseProjectRoot: run.repoPath,
        runId: run.runId,
        branchPrefix: run.branchPrefix,
        activeRunRegistry: path.join(tmpDir, "active-runs"),
        stateSlug: run.stateSlug,
        dryRun: false,
        skipShip: false,
        skipFeatureReview: false,
        launchedAt: "2026-05-08T00:00:00.000Z",
      },
    });
    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });
    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("ambiguous");
  });

  it("requires user action when the active-run registry points at another repo", () => {
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: path.join(tmpDir, "another-repo"),
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("ambiguous");
  });

  it("requires user action when a stale run still has a live active-run owner", () => {
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: run.worktreePath,
        baseProjectRoot: run.repoPath,
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("active-run registry owner");
  });

  it("emits RUN_RUNNING when state is stale but stdoutLog mtime is fresh (heartbeat keep-alive)", () => {
    // Pins Fix 1 (heartbeat). The gstack-build CLI emits a periodic
    // RUN_HEARTBEAT line to stdout while a long sub-agent call is in
    // flight; the outer `tee "$stdoutLog"` keeps stdoutLog mtime
    // current. recentProcessActivity should pick that up and the
    // monitor should NOT escalate.
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: run.worktreePath,
        baseProjectRoot: run.repoPath,
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    // Fresh stdoutLog: written "now-1s" relative to the monitor's
    // synthetic now-time below.
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, "anything\n");
    const fresh = new Date("2026-05-08T00:03:59.000Z");
    fs.utimesSync(run.stdoutLog, fresh, fresh);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    // Per-run terminal events live in result.events. The watch-loop's
    // outer terminal is MONITOR_REENTER (or ALL_RUNS_COMPLETE) when no
    // run-level escalation fired.
    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    const runEvents = result.events.filter(
      (e) => "runId" in e && e.runId === data.runs[0].runId,
    );
    expect(runEvents.length).toBeGreaterThan(0);
    const last = runEvents[runEvents.length - 1];
    expect(last.event).toBe("RUN_RUNNING");
    expect(last.message).toContain("waiting for state update");
    // Crucially, no USER_ACTION_REQUIRED in the event stream — the
    // false-positive escalation is gone.
    expect(result.events.some((e) => e.event === "USER_ACTION_REQUIRED")).toBe(
      false,
    );
  });

  it("REGRESSION: still escalates USER_ACTION_REQUIRED when state, pidFile, AND stdoutLog are ALL stale (true-stuck detection preserved)", () => {
    // Mandatory regression test: Fix 1 must remove the false-positive
    // escalation without removing the true-positive ("orchestrator
    // truly hung") escalation. If this test ever fails, the staleness
    // path has been silently broken by a future refactor.
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: run.worktreePath,
        baseProjectRoot: run.repoPath,
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    // Write a stdoutLog and pidFile but stamp their mtimes well outside
    // the 180s staleness window. recentProcessActivity must be false.
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, "anything\n");
    fs.writeFileSync(run.pidFile, `${process.pid}\n`);
    const stale = new Date("2026-05-07T23:55:00.000Z");
    fs.utimesSync(run.stdoutLog, stale, stale);
    fs.utimesSync(run.pidFile, stale, stale);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("active-run registry owner");
  });

  /**
   * Helpers for the new stall-arm tests. Sets up a run with:
   *   - active-run registry entry claiming pid = process.pid
   *   - state at the given lastUpdatedAt
   *   - stdoutLog mtime fresh (so recentProcessActivity = true)
   *   - heartbeat sidecar pre-populated with the given snapshot + runId/pid
   * Returns the manifest path the test passes to evaluateMonitorOnce.
   */
  const setupRunWithSidecar = (
    sidecarPayload: Partial<{
      stateLastUpdatedAt: string;
      drainProcessedCount: number;
      runId: string;
      pid: number;
    }>,
    opts: {
      freshStdoutAt: Date;
      stateAt: string;
      writeSidecar?: boolean;
      omitTracker?: boolean;
    },
  ) => {
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: run.worktreePath,
        baseProjectRoot: run.repoPath,
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, { lastUpdatedAt: opts.stateAt });
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, "anything\n");
    fs.writeFileSync(run.pidFile, `${process.pid}\n`);
    fs.utimesSync(run.stdoutLog, opts.freshStdoutAt, opts.freshStdoutAt);
    fs.utimesSync(run.pidFile, opts.freshStdoutAt, opts.freshStdoutAt);

    if (opts.writeSidecar !== false) {
      const sidecarPath = path.join(
        stateDir,
        `${run.stateSlug}.heartbeat.json`,
      );
      fs.writeFileSync(
        sidecarPath,
        JSON.stringify({
          ts: opts.freshStdoutAt.toISOString(),
          runId: sidecarPayload.runId ?? run.runId,
          pid: sidecarPayload.pid ?? process.pid,
          stateSlug: run.stateSlug,
          phase: 0,
          stateLastUpdatedAt: sidecarPayload.stateLastUpdatedAt,
          drainProcessedCount: sidecarPayload.drainProcessedCount,
        }),
      );
    }
    return { data, run };
  };

  it("STALL ARM: escalates USER_ACTION_REQUIRED when heartbeat shows state frozen beyond threshold", () => {
    // Regression test for the 47-min auto-drain hang. State + drain counter
    // both unchanged across two polls separated by >threshold ms. Process
    // pid is alive, stdoutLog mtime is fresh (the heartbeat ticker keeps
    // writing) — under the OLD logic this would stay at RUN_RUNNING forever.
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data, run } = setupRunWithSidecar(
      { stateLastUpdatedAt: stateAt, drainProcessedCount: 0 },
      {
        freshStdoutAt: new Date("2026-05-08T00:30:00.000Z"),
        stateAt,
      },
    );

    // Pre-seed a tracker so the SECOND poll observes "frozen since" exceeds
    // the threshold. This mirrors what would happen across two real monitor
    // ticks (sidecar unchanged → tracker.lastChangedAt sticks → time grows).
    const trackerPath = path.join(
      stateDir,
      `${run.stateSlug}.heartbeat-track.json`,
    );
    fs.writeFileSync(
      trackerPath,
      JSON.stringify({
        lastSeenStateLastUpdatedAt: stateAt,
        lastSeenDrainProcessedCount: 0,
        // Frozen for 20 minutes when "now" hits 00:30; threshold = 15min.
        lastChangedAt: Date.parse("2026-05-08T00:10:00.000Z"),
      }),
    );

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:30:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 15 * 60 * 1000,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain(
      "state has not advanced",
    );
    void run;
  });

  it("STALL ARM: does NOT escalate when state moves between polls", () => {
    // Counter-test: if either signal is moving, the monitor must NOT
    // escalate even when stdoutLog is fresh. Pins the "legit long work"
    // case (a healthy drain processing entries one by one).
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data, run } = setupRunWithSidecar(
      { stateLastUpdatedAt: stateAt, drainProcessedCount: 5 },
      {
        freshStdoutAt: new Date("2026-05-08T00:30:00.000Z"),
        stateAt,
      },
    );

    // Tracker recorded a DIFFERENT drainProcessedCount last poll. The
    // current sidecar's count differs → evaluateHeartbeatStall sees movement,
    // bumps lastChangedAt to now, stalledMs = 0. No escalation.
    const trackerPath = path.join(
      stateDir,
      `${run.stateSlug}.heartbeat-track.json`,
    );
    fs.writeFileSync(
      trackerPath,
      JSON.stringify({
        lastSeenStateLastUpdatedAt: stateAt,
        lastSeenDrainProcessedCount: 3,
        lastChangedAt: Date.parse("2026-05-08T00:10:00.000Z"),
      }),
    );

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:30:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 15 * 60 * 1000,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    const runEvents = result.events.filter(
      (e) => "runId" in e && e.runId === run.runId,
    );
    const last = runEvents[runEvents.length - 1];
    expect(last.event).toBe("RUN_RUNNING");
    // Tracker MUST be updated with the new counter — otherwise the next
    // poll would still see "5" as stale.
    const updated = JSON.parse(fs.readFileSync(trackerPath, "utf-8"));
    expect(updated.lastSeenDrainProcessedCount).toBe(5);
  });

  it("STALL ARM: ignores sidecar with mismatched runId (defense against cross-run files)", () => {
    // Codex finding #3. If a sidecar file lingers from a crashed prior run
    // on the same stateSlug, its runId won't match the current run's
    // active-run registry. Trust gate must null the sidecar.
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data } = setupRunWithSidecar(
      {
        stateLastUpdatedAt: stateAt,
        drainProcessedCount: 0,
        runId: "DIFFERENT-RUN-ID",
        pid: process.pid,
      },
      {
        freshStdoutAt: new Date("2026-05-08T00:30:00.000Z"),
        stateAt,
      },
    );

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:30:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 1, // Tiny threshold — would fire if sidecar trusted.
    });

    // Sidecar nulled → no stall arm. Falls through to existing
    // "waiting for state update" branch.
    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    const runEvents = result.events.filter(
      (e) => "runId" in e && e.runId === data.runs[0].runId,
    );
    const last = runEvents[runEvents.length - 1];
    expect(last.event).toBe("RUN_RUNNING");
  });

  it("STALL ARM: ignores sidecar with mismatched pid (PID-reuse defense)", () => {
    // Codex finding #3 part 2. Same runId, wrong pid → trust gate rejects.
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data } = setupRunWithSidecar(
      {
        stateLastUpdatedAt: stateAt,
        drainProcessedCount: 0,
        pid: 99999, // A pid the test process can't be.
      },
      {
        freshStdoutAt: new Date("2026-05-08T00:30:00.000Z"),
        stateAt,
      },
    );

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:30:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 1,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
  });

  it("STALL ARM: missing sidecar → falls back to existing decision tree", () => {
    // Sidecar file just doesn't exist. The new arm must NOT fire; the
    // existing recentProcessActivity branch (RUN_RUNNING) takes over.
    // This is the "no new silent failure mode" guarantee.
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data } = setupRunWithSidecar(
      { stateLastUpdatedAt: stateAt },
      {
        freshStdoutAt: new Date("2026-05-08T00:30:00.000Z"),
        stateAt,
        writeSidecar: false,
      },
    );

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:30:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 1,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    const runEvents = result.events.filter(
      (e) => "runId" in e && e.runId === data.runs[0].runId,
    );
    const last = runEvents[runEvents.length - 1];
    expect(last.event).toBe("RUN_RUNNING");
  });

  it("STALL ARM: tracker persists across monitor restarts (first poll seeds, second poll evaluates)", () => {
    // The monitor is stateless: each evaluateMonitorOnce() reads + writes
    // the tracker file on disk. This test simulates two monitor processes
    // running sequentially against the same on-disk state.
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data, run } = setupRunWithSidecar(
      { stateLastUpdatedAt: stateAt, drainProcessedCount: 0 },
      {
        freshStdoutAt: new Date("2026-05-08T00:14:00.000Z"),
        stateAt,
      },
    );

    // First monitor process: no tracker on disk yet. Should seed one.
    const trackerPath = path.join(
      stateDir,
      `${run.stateSlug}.heartbeat-track.json`,
    );
    expect(fs.existsSync(trackerPath)).toBe(false);

    const first = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:14:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 15 * 60 * 1000,
    });
    expect(first.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(fs.existsSync(trackerPath)).toBe(true);

    // Between polls: stdoutLog mtime is refreshed (the heartbeat ticker
    // would have written more lines). Without this, recentProcessActivity
    // goes false and the OTHER existing USER_ACTION_REQUIRED branch fires
    // first — testing the wrong arm. We want the new stall arm specifically.
    const between = new Date("2026-05-08T00:29:59.000Z");
    fs.utimesSync(data.runs[0].stdoutLog, between, between);
    fs.utimesSync(data.runs[0].pidFile, between, between);

    // Second monitor process: same on-disk state, >threshold ms later.
    const second = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:30:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 15 * 60 * 1000,
    });
    expect(second.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(second.terminalEvent.message).toContain("state has not advanced");
    void run;
  });

  it("STALL ARM: threshold defaults to 15 minutes when no override provided", () => {
    // Hardcoded fallback when no gstack-config knob is wired. 14 minutes of
    // freeze must NOT escalate; 16 minutes must.
    const stateAt = "2026-05-08T00:00:00.000Z";
    const { data, run } = setupRunWithSidecar(
      { stateLastUpdatedAt: stateAt, drainProcessedCount: 0 },
      {
        freshStdoutAt: new Date("2026-05-08T00:14:00.000Z"),
        stateAt,
      },
    );

    const trackerPath = path.join(
      stateDir,
      `${run.stateSlug}.heartbeat-track.json`,
    );
    // Seed tracker as if it was first observed 14 minutes ago (under
    // default threshold of 15min). buildStallThresholdMs omitted → uses
    // default.
    fs.writeFileSync(
      trackerPath,
      JSON.stringify({
        lastSeenStateLastUpdatedAt: stateAt,
        lastSeenDrainProcessedCount: 0,
        lastChangedAt: Date.parse("2026-05-08T00:00:00.000Z"),
      }),
    );
    const under = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:14:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      gstackConfigBin: "",
      // No buildStallThresholdMs override → default 15min applies.
    });
    expect(under.terminalEvent.event).toBe("MONITOR_REENTER");
    void run;

    // 16 minutes since change → over default → escalate.
    fs.writeFileSync(
      trackerPath,
      JSON.stringify({
        lastSeenStateLastUpdatedAt: stateAt,
        lastSeenDrainProcessedCount: 0,
        lastChangedAt: Date.parse("2026-05-08T00:00:00.000Z"),
      }),
    );
    const over = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:16:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
      gstackConfigBin: "",
    });
    expect(over.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
  });

  it("emits MONITOR_ERROR instead of crashing when the resume executable is missing", () => {
    const data = manifest({
      launchCommand: [path.join(tmpDir, "missing-gstack-build")],
    });
    const run = data.runs[0];
    fs.mkdirSync(run.worktreePath, { recursive: true });
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_ERROR");
    expect(result.terminalEvent.message).toContain(
      "resume executable not found",
    );
  });
});

describe("monitor agent supervisor", () => {
  const monitorAgent = {
    provider: "kimi" as const,
    model: "kimi-code/kimi-for-coding",
    reasoning: "high" as const,
  };

  it("does not invoke the agent for normal monitor re-entry", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run);
    const evaluation = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:00:30.000Z"),
      pollMs: 60_000,
    });
    expect(evaluation.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(shouldInvokeMonitorAgent(evaluation.terminalEvent)).toBe(false);

    let invoked = false;
    const escalation = await buildMonitorAgentEscalation({
      manifestPath: writeManifest(data),
      evaluation,
      role: monitorAgent,
      runner: async () => {
        invoked = true;
        throw new Error("should not run");
      },
    });
    expect(escalation).toBeNull();
    expect(invoked).toBe(false);
  });

  it("skips monitorAgent for host-owned context-save events", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
    });
    const evaluation = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
    });
    expect(evaluation.terminalEvent.event).toBe("HOST_CONTEXT_SAVE_REQUIRED");
    expect(shouldInvokeMonitorAgent(evaluation.terminalEvent)).toBe(false);

    const escalation = await buildMonitorAgentEscalation({
      manifestPath: writeManifest(data),
      evaluation,
      role: monitorAgent,
      runner: async () => {
        throw new Error("should not run");
      },
    });
    expect(escalation).toBeNull();
  });

  it("invokes fake monitorAgent for RUN_FAILED and emits MONITOR_AGENT_ESCALATION", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "tests failed",
      phases: [{ index: 0, number: "1", name: "Phase", status: "failed" }],
    });
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, "test output\nAssertionError\n");
    const manifestPath = writeManifest(data);
    const evaluation = evaluateMonitorOnce({ manifestPath });
    expect(shouldInvokeMonitorAgent(evaluation.terminalEvent)).toBe(true);
    let agentCwd = "";

    const escalation = await buildMonitorAgentEscalation({
      manifestPath,
      evaluation,
      role: monitorAgent,
      now: new Date("2026-05-08T01:00:00.000Z"),
      runner: async ({ outputFilePath, cwd }) => {
        agentCwd = cwd;
        const body = {
          verdict: "host_action_required",
          summary: "tests failed after implementation",
          attempted: ["read monitor event", "read log tail"],
          recommendedHostAction: "inspect failing test and relaunch monitor",
          suggestedCommands: [
            `gstack-build monitor --manifest ${manifestPath} --watch --supervise`,
          ],
          userChoices: [],
        };
        fs.writeFileSync(outputFilePath, JSON.stringify(body));
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: path.join(tmpDir, "agent.log"),
          durationMs: 1,
          retries: 0,
        };
      },
    });

    expect(escalation?.event).toBe("MONITOR_AGENT_ESCALATION");
    expect(escalation?.sourceEvent).toBe("RUN_FAILED");
    expect(escalation?.verdict).toBe("host_action_required");
    expect(escalation?.recommendedHostAction).toContain("inspect");
    expect(agentCwd).toContain("monitor-");
    expect(agentCwd).not.toBe(run.worktreePath);
    expect(monitorExitCode(escalation!.event)).toBe(11);
  });

  it("invokes fake monitorAgent for USER_ACTION_REQUIRED and MONITOR_ERROR", async () => {
    for (const eventName of [
      "USER_ACTION_REQUIRED",
      "MONITOR_ERROR",
    ] as const) {
      const evaluation = {
        events: [
          {
            event: eventName,
            timestamp: "2026-05-08T00:00:00.000Z",
            message: "blocked",
          },
        ],
        terminalEvent: {
          event: eventName,
          timestamp: "2026-05-08T00:00:00.000Z",
          message: "blocked",
        },
      };
      const escalation = await buildMonitorAgentEscalation({
        manifestPath: path.join(tmpDir, "manifest.json"),
        evaluation,
        role: monitorAgent,
        runner: async ({ outputFilePath }) => {
          fs.writeFileSync(
            outputFilePath,
            JSON.stringify({
              verdict: "user_action_required",
              summary: `${eventName} diagnosis`,
              attempted: [],
              recommendedHostAction: "ask user",
              suggestedCommands: [],
              userChoices: ["continue", "stop"],
            }),
          );
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            logPath: path.join(tmpDir, "agent.log"),
            durationMs: 1,
            retries: 0,
          };
        },
      });
      expect(escalation?.event).toBe("MONITOR_AGENT_ESCALATION");
      expect(escalation?.sourceEvent).toBe(eventName);
      expect(escalation?.verdict).toBe("user_action_required");
    }
  });

  it("fails closed when monitorAgent returns malformed or empty JSON", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "failed",
      phases: [{ index: 0, number: "1", name: "Phase", status: "failed" }],
    });
    const manifestPath = writeManifest(data);
    const evaluation = evaluateMonitorOnce({ manifestPath });
    const escalation = await buildMonitorAgentEscalation({
      manifestPath,
      evaluation,
      role: monitorAgent,
      runner: async () => ({
        stdout: "not json",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: path.join(tmpDir, "agent.log"),
        durationMs: 1,
        retries: 0,
      }),
    });
    expect(escalation?.event).toBe("MONITOR_AGENT_ESCALATION");
    expect(escalation?.verdict).toBe("host_action_required");
    expect(escalation?.summary).toContain("invalid JSON");
  });

  it("builds bounded prompts with truncated stdout log tails and safety rules", () => {
    const data = manifest();
    const run = data.runs[0];
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, `${"x".repeat(200)}TAIL`);
    const event = {
      event: "RUN_FAILED" as const,
      timestamp: "2026-05-08T00:00:00.000Z",
      runId: run.runId,
      message: "failed",
      stdoutLog: run.stdoutLog,
    };
    const prompt = buildMonitorAgentPrompt({
      manifestPath: writeManifest(data),
      manifest: data,
      event,
      role: monitorAgent,
      logTailChars: 12,
    });
    expect(prompt).toContain("Do not edit files, run shell commands");
    expect(prompt).toContain("Do not tell the host to do those things either");
    expect(prompt).toContain("exactly one JSON object");
    expect(prompt).toContain("[...truncated");
    expect(prompt).toContain("xxxxxxxxTAIL");
    expect(prompt).not.toContain("x".repeat(50));
  });

  it("parses fenced strict JSON output", () => {
    const parsed = parseMonitorAgentJson(`\`\`\`json
{"verdict":"no_action","summary":"ok","attempted":[],"recommendedHostAction":"none","suggestedCommands":[],"userChoices":[]}
\`\`\``);
    expect(parsed?.verdict).toBe("no_action");
    expect(parseMonitorAgentJson("{}")).toBeNull();
    expect(parseMonitorAgentJson('{"verdict":"no_action"}')).toBeNull();
  });
});
