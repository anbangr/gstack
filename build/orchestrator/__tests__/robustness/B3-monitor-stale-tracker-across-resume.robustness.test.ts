/**
 * B3 — monitor stale-tracker survives across a resume.
 *
 * Spec id: B3   Group: B (stall/monitor)   Tier: smoke   Mode: RED
 *
 * Long-run failure being pinned:
 *   When a build is auto-resumed, the dead process leaves a
 *   `<slug>.heartbeat-track.json` tracker on disk whose `lastChangedAt` is
 *   however old the run had been frozen (or simply stamped) before the
 *   resume. The fresh resumed process re-writes the per-run heartbeat sidecar
 *   replaying the SAME progress signals it loaded from saved state
 *   (`phase = N`, `drainProcessedCount = K`). On the resumed process's FIRST
 *   monitor poll, `evaluateHeartbeatStall` sees the sidecar's signals equal to
 *   the stale tracker's `lastSeen*` values → `moved = false` → it reports
 *   `stalledMs = now - tracker.lastChangedAt` (the INHERITED clock). With a
 *   tracker that was last "changed" 20 min ago and a 15 min threshold, the
 *   monitor escalates USER_ACTION_REQUIRED on the resumed process's very first
 *   poll — killing a healthy resume because the stall clock belonged to the
 *   dead process.
 *
 * Desired invariant (this RED spec):
 *   A resumed process gets a grace window — the stall clock is NOT inherited
 *   from the dead process. The first post-resume poll re-seeds `lastChangedAt`
 *   (or otherwise grants a grace window) so the monitor does NOT immediately
 *   escalate. Concretely: the terminal event is `MONITOR_REENTER` (the run's
 *   per-run event being `RUN_RUNNING`), NOT `USER_ACTION_REQUIRED`.
 *
 * Authored as a committed `describe.skip` per the build-robustness PIN/RED
 * protocol (see ./README.md). The file loads cleanly — it imports only
 * symbols that exist today and does all setup inside `beforeEach`/`it`. Remove
 * `.skip` in the same commit that lands the production fix.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateMonitorOnce } from "../../monitor";
import type { BuildRunManifest, BuildState } from "../../types";

let tmpDir: string;
let stateDir: string;
let oldStateDir: string | undefined;
let oldGstackHome: string | undefined;
let oldMaxAutoResume: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-robustness-B3-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = stateDir;

  // Isolate GSTACK_HOME — evaluateMonitorOnce triggers detectSkillFaults,
  // which appends to ${GSTACK_HOME}/analytics/skill-faults.jsonl. Without
  // this, each run leaks fault entries into the developer's real ~/.gstack/.
  oldGstackHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = tmpDir;

  // Keep the auto-resume cap env knob deterministic — this spec never relies
  // on a custom value, but save+restore so a stray env doesn't perturb it.
  oldMaxAutoResume = process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
  delete process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
});

afterEach(() => {
  if (oldStateDir !== undefined)
    process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (oldGstackHome !== undefined) process.env.GSTACK_HOME = oldGstackHome;
  else delete process.env.GSTACK_HOME;
  if (oldMaxAutoResume !== undefined)
    process.env.GSTACK_MONITOR_MAX_AUTO_RESUME = oldMaxAutoResume;
  else delete process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mirrors the `manifest()` builder in ../../__tests__/monitor.test.ts so the
// run reaches the same identity/staleness branch the stall arm lives in.
function manifest(
  overrides: Partial<BuildRunManifest["runs"][number]> = {},
): BuildRunManifest {
  const repoPath = path.join(tmpDir, "repo");
  const worktreePath = path.join(tmpDir, "worktree");
  const runId = overrides.runId ?? "run-b3";
  return {
    manifestId: "manifest-b3",
    runGroupId: "group-b3",
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
): void {
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
}

/**
 * Build a run that reaches the heartbeat stall arm:
 *   - active-run registry entry claiming pid = process.pid (registryPidAlive)
 *   - state.lastUpdatedAt stale beyond the staleWindow (so snapshot.stale)
 *   - stdoutLog + pidFile mtimes fresh (so recentProcessActivity = true)
 *   - heartbeat sidecar carrying runId/pid that pass the trust gate, replaying
 *     the post-resume progress signals (phase=N, drainProcessedCount=K)
 *
 * The phaseN / drainK args are what the resumed process replays from saved
 * state. The PRE-EXISTING tracker (written separately by the test) carries the
 * SAME lastSeen values plus a stale lastChangedAt — that's the inherited clock.
 */
function setupResumedRun(opts: {
  freshAt: Date;
  staleStateAt: string;
  phaseN: number;
  drainK: number;
}) {
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
      startedAt: opts.staleStateAt,
      lastUpdatedAt: opts.staleStateAt,
      branches: [],
    }),
  );

  // Stale state: lastUpdatedAt well outside the staleWindow. Phase index
  // matches the sidecar's replayed phase.
  writeState(run, {
    lastUpdatedAt: opts.staleStateAt,
    currentPhaseIndex: opts.phaseN,
  });

  // Fresh stdoutLog + pidFile so recentProcessActivity = true (the resumed
  // process's heartbeat ticker keeps these current).
  fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
  fs.writeFileSync(run.stdoutLog, "resumed\n");
  fs.writeFileSync(run.pidFile, `${process.pid}\n`);
  fs.utimesSync(run.stdoutLog, opts.freshAt, opts.freshAt);
  fs.utimesSync(run.pidFile, opts.freshAt, opts.freshAt);

  // Fresh sidecar from the resumed process. runId + pid pass the trust gate
  // (pid = readPid(pidFile) = process.pid). It replays the loaded progress
  // signals: the SAME phase and drainProcessedCount the dead process had.
  const sidecarPath = path.join(stateDir, `${run.stateSlug}.heartbeat.json`);
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify({
      ts: opts.freshAt.toISOString(),
      runId: run.runId,
      pid: process.pid,
      stateSlug: run.stateSlug,
      phase: opts.phaseN,
      stateLastUpdatedAt: opts.staleStateAt,
      drainProcessedCount: opts.drainK,
    }),
  );

  return { data, run };
}

describe.skip("[RED] B3 monitor-stale-tracker-across-resume — UNSKIP WHEN B3 IS FIXED", () => {
  it("does NOT escalate on the resumed process's first poll when the tracker's stall clock was inherited from the dead process", () => {
    const N = 1; // lastSeenPhase replayed by the resumed process
    const K = 4; // lastSeenDrainProcessedCount replayed by the resumed process
    // now = 00:30; tracker last changed at 00:10 → inherited stall = 20 min.
    const nowDate = new Date("2026-05-08T00:30:00.000Z");
    const freshAt = nowDate; // stdoutLog/pidFile mtimes "now" → recent activity
    // State stale enough to be flagged: pollMs default staleWindow is
    // 3*60_000 = 180_000ms (no *_running phase). 30 min old clears it.
    const staleStateAt = "2026-05-08T00:00:00.000Z";

    const { data, run } = setupResumedRun({
      freshAt,
      staleStateAt,
      phaseN: N,
      drainK: K,
    });

    // PRE-EXISTING tracker left by the dead process: lastChangedAt 20 min ago,
    // and lastSeen* equal to what the resumed sidecar replays. Under today's
    // code this makes `moved = false`, so stalledMs = now - lastChangedAt =
    // 20 min, which exceeds the 15 min threshold → immediate escalation.
    const trackerPath = path.join(
      stateDir,
      `${run.stateSlug}.heartbeat-track.json`,
    );
    fs.writeFileSync(
      trackerPath,
      JSON.stringify({
        lastSeenStateLastUpdatedAt: staleStateAt,
        lastSeenDrainProcessedCount: K,
        lastSeenPhase: N,
        lastChangedAt: Date.parse("2026-05-08T00:10:00.000Z"),
      }),
    );

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: nowDate,
      pollMs: 60_000,
      spawnResume: false,
      gstackConfigBin: "", // force default-threshold code path, no real binary
      buildStallThresholdMs: 15 * 60 * 1000,
    });

    // DESIRED: the resumed process is granted a grace window — the stall clock
    // is re-seeded on the first post-resume poll instead of being inherited.
    // The monitor must NOT escalate on this poll.
    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(result.terminalEvent.event).not.toBe("USER_ACTION_REQUIRED");

    const runEvents = result.events.filter(
      (e) => "runId" in e && e.runId === run.runId,
    );
    expect(runEvents.length).toBeGreaterThan(0);
    const last = runEvents[runEvents.length - 1];
    expect(last.event).toBe("RUN_RUNNING");

    // And no escalation anywhere in the event stream for this poll.
    expect(result.events.some((e) => e.event === "USER_ACTION_REQUIRED")).toBe(
      false,
    );
  });
});
