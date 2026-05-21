import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateMonitorOnce } from "../monitor";
import type { BuildRunManifest, BuildState } from "../types";

/**
 * End-to-end integration: a real bun child process writes a heartbeat
 * sidecar with a frozen state timestamp. The monitor (in this same
 * process) polls the on-disk state, reads the sidecar, and escalates
 * once the configured threshold is exceeded.
 *
 * Unlike the unit tests in monitor.test.ts which feed synthetic snapshots,
 * this test exercises the heartbeat.ts → sidecar file → monitor.ts read
 * path with no mocks. If any wire in the stall-detection chain is broken
 * (sidecar path mismatch, runId-pid trust gate, tracker semantics), this
 * test catches it.
 *
 * Runs in ~1 second using a 500ms threshold override — no real money,
 * no LLM, deterministic. Lives in __tests__/ so `bun test` picks it up.
 */

let tmpDir: string;
let stateDir: string;
let oldStateDir: string | undefined;
let oldGstackHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-hb-int-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = stateDir;
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

describe("monitor-heartbeat integration", () => {
  it("real bun child writes sidecar; monitor escalates after threshold", async () => {
    const runId = "integration-run-1";
    const stateSlug = `build-${runId}`;
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktree");
    const stdoutLog = path.join(tmpDir, runId, "agent-stdout.log");
    const pidFile = path.join(tmpDir, runId, "gstack-build.pid");
    fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });

    // Seed state.json. stateMatchesRun checks state.planFile === run.livingPlanPath
    // AND state.launch.runId === run.runId AND projectRoot/baseProjectRoot match —
    // the monitor's identity check fires USER_ACTION_REQUIRED otherwise, masking
    // the stall arm we actually want to test.
    const initialStateTs = "2026-05-21T00:00:00.000Z";
    const livingPlanPath = path.join(tmpDir, "living.md");
    const registryDirPath = path.join(tmpDir, "active-runs");
    const state: BuildState = {
      planFile: livingPlanPath,
      planBasename: "living",
      slug: stateSlug,
      branch: "test",
      startedAt: initialStateTs,
      lastUpdatedAt: initialStateTs,
      launch: {
        argv: ["/bin/echo", "resume"],
        projectRoot: worktreePath,
        baseProjectRoot: repoPath,
        runId,
        branchPrefix: `repo-${runId}`,
        activeRunRegistry: registryDirPath,
        stateSlug,
        originPlan: path.join(tmpDir, "plan.md"),
        dryRun: false,
        skipShip: false,
        skipFeatureReview: false,
        launchedAt: initialStateTs,
      },
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "P", status: "running" }],
      completed: false,
    };
    fs.writeFileSync(
      path.join(stateDir, `${stateSlug}.json`),
      JSON.stringify(state),
    );

    // Spawn a real bun child that imports the production heartbeat.ts
    // and ticks every 100ms with a FROZEN state snapshot (we want to
    // simulate the orchestrator wedged at a particular state timestamp).
    const shimSource = `
      import { startHeartbeat } from "${path.resolve("build/orchestrator/heartbeat.ts").replace(/\\/g, "\\\\")}";
      const ctrl = startHeartbeat({
        runId: ${JSON.stringify(runId)},
        pid: process.pid,
        stateSlug: ${JSON.stringify(stateSlug)},
        intervalMs: 100,
        heartbeatFilePath: ${JSON.stringify(path.join(stateDir, `${stateSlug}.heartbeat.json`))},
        getStateSnapshot: () => ({
          lastUpdatedAt: ${JSON.stringify(initialStateTs)},
          currentPhaseIndex: 0,
          drainProcessedCount: 0,
        }),
        write: () => {
          // Suppress stdout — the test doesn't need RUN_HEARTBEAT lines.
        },
      });
      // Keep alive long enough for the monitor to observe two polls.
      setTimeout(() => {
        ctrl.stop();
        process.exit(0);
      }, 3000);
    `;
    const shimPath = path.join(tmpDir, "heartbeat-shim.ts");
    fs.writeFileSync(shimPath, shimSource);

    const child = spawn("bun", ["run", shimPath], {
      env: { ...process.env, GSTACK_BUILD_STATE_DIR: stateDir },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const childPid = child.pid!;
    expect(typeof childPid).toBe("number");

    // Wait for the child to write its first heartbeat (intervalMs=100,
    // so within 200ms the sidecar exists).
    const sidecarPath = path.join(
      stateDir,
      `${stateSlug}.heartbeat.json`,
    );
    const start = Date.now();
    while (Date.now() - start < 1500) {
      if (fs.existsSync(sidecarPath)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    expect(sidecar.runId).toBe(runId);
    expect(sidecar.pid).toBe(childPid);
    expect(sidecar.stateLastUpdatedAt).toBe(initialStateTs);

    // Build a manifest pointing at this run.
    const manifest: BuildRunManifest = {
      manifestId: "m",
      runGroupId: "g",
      tmpDir,
      workspaceRoot: tmpDir,
      gstackRepo: tmpDir,
      runs: [
        {
          runId,
          repoPath,
          repoSlug: "repo",
          sourcePlanPath: path.join(tmpDir, "plan.md"),
          livingPlanPath: path.join(tmpDir, "living.md"),
          originPlanPath: path.join(tmpDir, "plan.md"),
          worktreePath,
          stateSlug,
          branchPrefix: `repo-${runId}`,
          pidFile,
          stdoutLog,
          launchCommand: [
            "/bin/echo",
            "resume",
            "--active-run-registry",
            registryDirPath,
          ],
          launchEnv: {},
        },
      ],
    };
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    // Write the active-run registry record (child is our orchestrator
    // proxy — the monitor reads its pid from here).
    fs.mkdirSync(registryDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(registryDirPath, `${runId}.json`),
      JSON.stringify({
        runId,
        stateSlug,
        repoPath: worktreePath,
        baseProjectRoot: repoPath,
        planFile: path.join(tmpDir, "living.md"),
        pid: childPid,
        status: "running",
        startedAt: initialStateTs,
        lastUpdatedAt: initialStateTs,
        branches: [],
      }),
    );

    // Touch stdoutLog + pidFile so recentProcessActivity is true.
    fs.writeFileSync(stdoutLog, "x\n");
    fs.writeFileSync(pidFile, `${childPid}\n`);

    // First monitor poll: seeds the tracker. Should NOT escalate.
    const first = evaluateMonitorOnce({
      manifestPath,
      now: new Date(),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 500, // tiny threshold for fast test
    });
    expect(first.terminalEvent.event).toBe("MONITOR_REENTER");

    // Wait > threshold ms. The child keeps emitting the SAME frozen
    // state snapshot, so neither stateLastUpdatedAt nor drainProcessedCount
    // changes. The tracker's lastChangedAt stays put.
    await new Promise((r) => setTimeout(r, 700));

    // Refresh stdoutLog mtime so recentProcessActivity is still true on
    // the second poll. In a real run the child's stdout ticker would
    // refresh it; here we suppress stdout so we have to touch manually.
    const stale = new Date();
    fs.utimesSync(stdoutLog, stale, stale);
    fs.utimesSync(pidFile, stale, stale);

    const second = evaluateMonitorOnce({
      manifestPath,
      now: new Date(),
      pollMs: 60_000,
      spawnResume: false,
      buildStallThresholdMs: 500,
    });

    // After >threshold ms of frozen state, the stall arm fires.
    expect(second.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(second.terminalEvent.message).toContain("state has not advanced");

    // Cleanup: kill the shim if it's still running.
    try {
      child.kill("SIGTERM");
    } catch {
      // best-effort
    }
    await new Promise((r) => {
      child.on("exit", () => r(undefined));
      // Don't wait forever — the SIGTERM should land in <100ms.
      setTimeout(() => r(undefined), 2000);
    });
  });
});
