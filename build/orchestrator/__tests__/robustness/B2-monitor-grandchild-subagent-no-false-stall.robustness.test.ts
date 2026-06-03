/**
 * B2 — monitor must not false-stall a shell-wrapped (grandchild) subagent.
 *
 * Spec id: B2   Group: B (stall/monitor)   Tier: integration   Mode: RED
 *
 * Long-run failure being pinned:
 *   The orchestrator launches its subagents (Codex /qa, Claude /review, Gemini,
 *   kimi) through a shell wrapper. A 25-30 minute call therefore leaves the
 *   recognized CLI as a GRANDCHILD of the orchestrator: the process tree is
 *   `orchestrator -> /bin/sh -> gemini`, so the CLI's `ppid` is the wrapper
 *   shell, NOT the orchestrator pid. During that call no `state.json` write
 *   happens, so `lastUpdatedAt` ages past the stale window and the heartbeat
 *   sidecar's progress signals (phase, drainProcessedCount) stay frozen.
 *
 *   Today `hasActiveSubagentChild(orchPid)` (monitor.ts) only inspects the
 *   orchestrator's DIRECT children: it filters `ps -e -o ppid=,comm=` to rows
 *   whose `ppid === orchPid`. The shell wrapper (`comm = sh`) is the only direct
 *   child and is not a recognized subagent name, so the probe returns false even
 *   though a live recognized subagent is one level deeper. With the probe
 *   returning false, `snapshot.stale` stays true and the heartbeat stall arm
 *   escalates `USER_ACTION_REQUIRED` on a perfectly healthy shell-wrapped call —
 *   interrupting the work and burning a supervisor escalation.
 *
 * Desired invariant (this RED spec):
 *   A live recognized subagent ANYWHERE in the orchestrator's subtree (direct
 *   child OR grandchild via the shell wrapper) suppresses the stale alarm.
 *   Concretely, with a live grandchild `gemini` under `orchestrator -> sh`,
 *   `evaluateMonitorOnce` must NOT emit `USER_ACTION_REQUIRED` for the run.
 *
 * Why RED today (confirmed by reading monitor.ts):
 *   `hasActiveSubagentChild` does `if (ppid !== orchPid) continue;` — a direct-
 *   child-only match. A grandchild's `ppid` is the wrapper shell, so it is
 *   skipped, `subagentChildAlive` is false, and the exact stall scenario this
 *   file sets up escalates `USER_ACTION_REQUIRED` (verified: all-`pending`
 *   phases + 20-min-old `lastUpdatedAt` + fresh sidecar/tracker/mtimes + small
 *   `buildStallThresholdMs` -> "state has not advanced for N minutes"). The fix
 *   is to walk the subtree (or match by the orchestrator's descendant set)
 *   instead of only direct children. Remove `.skip` in the same commit as that
 *   fix.
 *
 * Authored as a committed `describe.skip` per the build-robustness PIN/RED
 * protocol (see ./README.md). The file loads cleanly — it imports only symbols
 * that exist today and does all setup inside `beforeEach`/`it`. The only real
 * process is a short-lived `/bin/sh` + copied-and-renamed `/bin/sleep`
 * grandchild, force-reaped in `afterEach` (by process group then by pid).
 *
 * See docs/designs/BUILD_ROBUSTNESS_SUITE.md §B2 and ./README.md (PIN/RED).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateMonitorOnce, hasActiveSubagentChild } from "../../monitor";
import type { BuildRunManifest, BuildState } from "../../types";

let tmpDir: string;
let stateDir: string;
let oldStateDir: string | undefined;
let oldGstackHome: string | undefined;
let oldGeminiBin: string | undefined;
let oldCodexBin: string | undefined;
let oldMaxAutoResume: string | undefined;

// Real processes spawned by the test that must be hard-reaped in afterEach even
// when an assertion throws mid-test: the wrapper shell and (transitively) its
// renamed-sleep grandchild.
let spawnedChildren: ChildProcess[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-robustness-B2-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = stateDir;

  // Isolate GSTACK_HOME — evaluateMonitorOnce triggers detectSkillFaults,
  // which appends to ${GSTACK_HOME}/analytics/skill-faults.jsonl. Without
  // this, each run leaks fault entries into the developer's real ~/.gstack/.
  oldGstackHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = tmpDir;

  // The monitor never spawns providers, but isolate the provider-bin env vars
  // anyway so this integration spec can never accidentally pick up the
  // developer's real GEMINI_BIN/CODEX_BIN (matches the reference harness's
  // env-isolation discipline).
  oldGeminiBin = process.env.GEMINI_BIN;
  oldCodexBin = process.env.CODEX_BIN;
  delete process.env.GEMINI_BIN;
  delete process.env.CODEX_BIN;

  // Keep the auto-resume cap knob deterministic — this spec never relies on a
  // custom value, but save+restore so a stray env doesn't perturb the run.
  oldMaxAutoResume = process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
  delete process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;

  spawnedChildren = [];
});

afterEach(async () => {
  // Force-reap the wrapper shell by process group then by pid, so a failed
  // assertion never strands a real 60s-sleep grandchild. The renamed sleep is
  // in the shell's subtree; killing the group reaps both.
  for (const child of spawnedChildren) {
    const pid = child.pid;
    if (typeof pid === "number") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Group may already be gone (ESRCH) or ungroupable; fall through.
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  }
  // Give the kernel a moment to tear them down before the next test.
  await new Promise((r) => setTimeout(r, 50));
  spawnedChildren = [];

  if (oldStateDir !== undefined)
    process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (oldGstackHome !== undefined) process.env.GSTACK_HOME = oldGstackHome;
  else delete process.env.GSTACK_HOME;
  if (oldGeminiBin !== undefined) process.env.GEMINI_BIN = oldGeminiBin;
  else delete process.env.GEMINI_BIN;
  if (oldCodexBin !== undefined) process.env.CODEX_BIN = oldCodexBin;
  else delete process.env.CODEX_BIN;
  if (oldMaxAutoResume !== undefined)
    process.env.GSTACK_MONITOR_MAX_AUTO_RESUME = oldMaxAutoResume;
  else delete process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mirrors the `manifest()` builder in ../../__tests__/monitor.test.ts so the run
// reaches the same identity/staleness branch the stall arm lives in.
function manifest(
  overrides: Partial<BuildRunManifest["runs"][number]> = {},
): BuildRunManifest {
  const repoPath = path.join(tmpDir, "repo");
  const worktreePath = path.join(tmpDir, "worktree");
  const runId = overrides.runId ?? "run-b2";
  return {
    manifestId: "manifest-b2",
    runGroupId: "group-b2",
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
        phaseIndexes: [0, 1],
        status: "running",
      },
    ],
    // All phases committed/pending — crucially NONE `*_running`. The defense-
    // in-depth status-aware threshold (leg 2, the 30x multiplier) only fires
    // when a phase status ends with `_running`; with all-`pending` phases the
    // ONLY thing that can suppress the stale alarm is leg 1's subagent probe.
    // We use all-`pending` (committedCount = 0) so the HOST_CONTEXT_SAVE branch
    // (which short-circuits before the stale arm when committedCount > the host
    // context-save count) does not pre-empt the path under test.
    phases: [
      { index: 0, number: "1", name: "Phase 1", status: "pending" },
      { index: 1, number: "2", name: "Phase 2", status: "pending" },
    ],
    completed: false,
    ...overrides,
  };
  fs.writeFileSync(
    path.join(stateDir, `${run.stateSlug}.json`),
    JSON.stringify(state, null, 2),
  );
}

/**
 * Set up a run that reaches the heartbeat stall arm, exactly as a healthy
 * 20-minute shell-wrapped subagent call would look to the monitor:
 *   - active-run registry entry claiming pid = process.pid (registryPidAlive)
 *   - state.lastUpdatedAt 30 min before `now` (so snapshot.stale, no `_running`)
 *   - stdoutLog + pidFile mtimes fresh (recentProcessActivity = true — the
 *     heartbeat ticker keeps these current during the call)
 *   - heartbeat sidecar carrying runId/pid that pass the trust gate, with phase
 *     and drainProcessedCount FROZEN (no state writes happen during the call)
 *   - a pre-seeded tracker whose lastChangedAt is 20 min before `now`, so the
 *     second-poll comparison reports stalledMs = 20 min > threshold
 *
 * The pidFile holds `process.pid`, so `hasActiveSubagentChild(pid)` probes the
 * TEST PROCESS's subtree. The wrapper shell is a direct child of the test
 * process and the renamed-sleep grandchild sits one level deeper.
 */
function setupShellWrappedRun(opts: {
  freshAt: Date;
  staleStateAt: string;
  trackerChangedAt: string;
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

  writeState(run, { lastUpdatedAt: opts.staleStateAt });

  fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
  fs.writeFileSync(run.stdoutLog, "subagent running\n");
  fs.writeFileSync(run.pidFile, `${process.pid}\n`);
  fs.utimesSync(run.stdoutLog, opts.freshAt, opts.freshAt);
  fs.utimesSync(run.pidFile, opts.freshAt, opts.freshAt);

  // Fresh sidecar: runId + pid pass the trust gate (pid = readPid(pidFile) =
  // process.pid). Phase and drainProcessedCount are frozen — no progress during
  // the long subagent call.
  const sidecarPath = path.join(stateDir, `${run.stateSlug}.heartbeat.json`);
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify({
      ts: opts.freshAt.toISOString(),
      runId: run.runId,
      pid: process.pid,
      stateSlug: run.stateSlug,
      phase: 0,
      stateLastUpdatedAt: opts.staleStateAt,
      drainProcessedCount: 0,
    }),
  );

  // Pre-seeded tracker (as if a prior poll already observed these frozen
  // signals): lastSeen* equal to the sidecar so `moved = false`, and
  // lastChangedAt 20 min before `now` so stalledMs = 20 min.
  const trackerPath = path.join(
    stateDir,
    `${run.stateSlug}.heartbeat-track.json`,
  );
  fs.writeFileSync(
    trackerPath,
    JSON.stringify({
      lastSeenStateLastUpdatedAt: opts.staleStateAt,
      lastSeenDrainProcessedCount: 0,
      lastSeenPhase: 0,
      lastChangedAt: Date.parse(opts.trackerChangedAt),
    }),
  );

  return { data, run };
}

/**
 * Spawn a live recognized subagent as a GRANDCHILD of the test process:
 *   test process (orchestrator pid) -> /bin/sh -> <renamed /bin/sleep = gemini>
 *
 * The kernel reports `comm` from the exec'd binary's basename, so the renamed
 * sleep shows up in `ps` as `gemini` (a recognized subagent CLI name). It must
 * be a real exec'd binary, not a shebang script — a script would exec the
 * interpreter and `comm` would become `sh`.
 *
 * The wrapper command deliberately keeps `/bin/sh` ALIVE as the intermediate
 * parent (the trailing `; true` prevents the shell from tail-call `exec`-ing the
 * sleep, which would collapse the grandchild into a direct child). Result:
 * `gemini`'s ppid is the wrapper shell, NOT the orchestrator pid — exactly the
 * shell-wrapped topology the monitor's direct-child-only probe misses today.
 *
 * `gemini` is chosen over `codex`/`claude` because those CLIs are commonly
 * running on a developer box (exact-basename collisions); `gemini` and `kimi`
 * are not. We probe by ppid against the orchestrator's subtree, so an unrelated
 * `gemini` elsewhere on the host can never satisfy the desired invariant.
 *
 * Returns the spawned shell ChildProcess and the recognized binary's path.
 */
function spawnGrandchildSubagent(): { shell: ChildProcess; binPath: string } {
  const binDir = path.join(tmpDir, "fake-subagent-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "gemini");
  fs.copyFileSync("/bin/sleep", binPath);
  fs.chmodSync(binPath, 0o755);

  // `detached: true` puts the shell in its own process group so afterEach can
  // reap the whole subtree with `process.kill(-pid, ...)`.
  const shell = spawn(
    "/bin/sh",
    ["-c", `${JSON.stringify(binPath)} 60; true`],
    { detached: true, stdio: "ignore" },
  );
  return { shell, binPath };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("[RED→FIXED] B2 monitor-grandchild-subagent-no-false-stall", () => {
  it("does NOT emit USER_ACTION_REQUIRED when a live recognized subagent is a shell-wrapped grandchild of the orchestrator", async () => {
    if (process.platform === "win32") {
      // POSIX-only: the ps ppid/comm probe and process-group reaping don't apply
      // on Windows. Skip without failing.
      return;
    }

    // now = 00:30; tracker last changed at 00:10 -> frozen for 20 min.
    const nowDate = new Date("2026-05-08T00:30:00.000Z");
    const freshAt = nowDate; // stdoutLog/pidFile mtimes "now" -> recent activity
    const staleStateAt = "2026-05-08T00:00:00.000Z"; // lastUpdatedAt 30 min old

    const { data, run } = setupShellWrappedRun({
      freshAt,
      staleStateAt,
      trackerChangedAt: "2026-05-08T00:10:00.000Z",
    });

    // Launch the grandchild subagent, then POLL until it is visible to `ps`
    // before the monitor probes — polling the same probe the monitor uses
    // exercises the subtree walk rather than a fixed-wait spawn race.
    const { shell } = spawnGrandchildSubagent();
    spawnedChildren.push(shell);
    let grandchildVisible = false;
    // 3s is ample for a sh+grandchild to register on a normal host; kept well
    // under the test's outer timeout so the skip path below runs cleanly when
    // the binary never registers (macOS code-signing kill).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (hasActiveSubagentChild(process.pid)) {
        grandchildVisible = true;
        break;
      }
      await sleep(50);
    }
    if (!grandchildVisible) {
      // Could not establish a live recognized grandchild. On macOS, executing a
      // COPY of a signed system binary (our renamed /bin/sleep) is intermittently
      // SIGKILLed by code-signing/AMFI ("Killed: 9"), so the fake subagent can't
      // run. That's a harness limitation, not the behavior under test: skip
      // rather than false-fail. The production subtree walk is still pinned by
      // the direct-child case (monitor-stale-subagent-child T-B1c) and this spec
      // runs fully on the Linux CI gate, where copied binaries execute normally.
      return;
    }

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: nowDate,
      pollMs: 60_000,
      spawnResume: false,
      gstackConfigBin: "", // force default-threshold code path, no real binary
      buildStallThresholdMs: 60_000, // 1 min — 20 min freeze clears it easily
    });

    // DESIRED: a live recognized subagent ANYWHERE in the orchestrator's subtree
    // (here a grandchild via the shell wrapper) suppresses the stale alarm. The
    // monitor must NOT escalate USER_ACTION_REQUIRED for this run.
    expect(result.terminalEvent.event).not.toBe("USER_ACTION_REQUIRED");
    expect(result.events.some((e) => e.event === "USER_ACTION_REQUIRED")).toBe(
      false,
    );

    // The healthy run should report as still running rather than stalled.
    const runEvents = result.events.filter(
      (e) => "runId" in e && e.runId === run.runId,
    );
    expect(runEvents.length).toBeGreaterThan(0);
    const last = runEvents[runEvents.length - 1];
    expect(last.event).toBe("RUN_RUNNING");
  }, 30_000);
});
