/**
 * B1 — `monitor-resume-count-resets-on-progress` `[RED]` (smoke).
 *
 * Failure mode (from BUILD_ROBUSTNESS_SUITE.md §B1): the per-run auto-resume
 * cap counts *lifetime* resumes per `stateSlug` with no reset-on-progress. Three
 * fully-recovered transient stalls spread over hours exhaust the cap, so a
 * healthy long run that simply hiccuped three times eventually gets
 * `RUN_HALTED_RESTART_CAP` instead of being resumed again.
 *
 * Desired invariant: the cap counts *consecutive failed* resumes. A resume
 * that is followed by genuine phase progress (the orchestrator advanced a
 * phase / committed work and freshened `state.lastUpdatedAt`) resets the
 * counter, so a later re-stale starts a fresh budget at attempt 1.
 *
 * Today the only write to the counter is `writeResumeCount(counterPath,
 * priorCount + 1)` (monitor.ts:1400) and the only read is the raw file value
 * (monitor.ts:1377). There is no production code that compares the resume to
 * subsequent phase progress and rewinds the counter — so the re-stale after
 * progress reports `resumeCount: 3` (priorCount 2 + 1), not the desired 1.
 *
 * RED protocol: this block is `describe.skip`. It loads cleanly (imports only
 * symbols that exist today, all setup inside `beforeEach`/`it`), drives the
 * behavior through `evaluateMonitorOnce` (NO reset helper is imported — none
 * exists), and asserts the DESIRED count. The fix PR removes `.skip`.
 *
 * Harness (env + tmp isolation, manifest()/writeManifest()/writeState()) is
 * lifted verbatim from `../monitor.test.ts` so this spec exercises the same
 * seam as the existing resume-count tests (monitor.test.ts:278-385).
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
let oldMaxResume: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-robustness-b1-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = stateDir;
  // Isolate GSTACK_HOME — evaluateMonitorOnce triggers detectSkillFaults,
  // which appends to ${GSTACK_HOME}/analytics/skill-faults.jsonl. Without
  // this, each run leaks fault entries into the developer's real ~/.gstack/.
  oldGstackHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = tmpDir;
  // Pin the cap to its documented default so a developer's local override
  // can't perturb the assertion. Saved + restored in afterEach.
  oldMaxResume = process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
  delete process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
});

afterEach(() => {
  if (oldStateDir) process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (oldGstackHome !== undefined) process.env.GSTACK_HOME = oldGstackHome;
  else delete process.env.GSTACK_HOME;
  if (oldMaxResume !== undefined)
    process.env.GSTACK_MONITOR_MAX_AUTO_RESUME = oldMaxResume;
  else delete process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
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
        phaseIndexes: [0, 1],
        status: "running",
      },
    ],
    // Two phases so we can model genuine progress: phase 0 -> committed,
    // currentPhaseIndex advances 0 -> 1. Neither status ends in `_running`,
    // so the status-aware stale-window multiplier (monitor.ts:748) stays off
    // and the 3x base window (180s at pollMs=60_000) governs staleness.
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
  return state;
}

describe("[RED→FIXED] B1 monitor-resume-count-resets-on-progress", () => {
  it("rewinds the auto-resume counter to attempt 1 after genuine phase progress, instead of climbing to the cap", () => {
    const data = manifest();
    const run = data.runs[0];

    // ---- Stage 1: a stale, dead-pid run that has already been auto-resumed
    // twice. Pre-stage the counter to 2 (mirrors monitor.test.ts:366). No pid
    // file is written, so `pidAlive` is false; `lastUpdatedAt` is 4 minutes
    // behind `now` (>= the 180s stale window), so the run is stale.
    writeState(run, { lastUpdatedAt: "2026-05-08T00:00:00.000Z" });
    const counterPath = path.join(stateDir, `${run.stateSlug}.resume-count`);
    fs.writeFileSync(counterPath, "2");

    const beforeProgress = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });
    // Sanity: at counter 2 with a default cap of 3, the stale run still
    // resumes (this is the resume that we will then "recover" from).
    expect(beforeProgress.terminalEvent.event).toBe("RUN_RESUMED");
    expect(beforeProgress.terminalEvent.resumeCount).toBe(3);

    // ---- Stage 2: GENUINE phase progress since that resume. The resumed
    // orchestrator advanced past phase 0 (mark it committed), bumped
    // `currentPhaseIndex` to 1, and freshened `lastUpdatedAt` to a time that
    // is well inside the stale window — i.e. the run made real forward
    // progress, not just another stall. (spawnResume:false here so dry-run
    // doesn't itself touch the counter file; we model the progress directly.)
    //
    // Acknowledge the commit's context-save: the host already ran
    // /context-save for the newly-committed phase, so the
    // `committedCount > priorContextSaveCount` guard (monitor.ts:1193) does
    // NOT short-circuit into HOST_CONTEXT_SAVE_REQUIRED. That file lives at
    // <stateDir>/<stateSlug>/.host-context-save-count.
    const contextSaveCountFile = path.join(
      stateDir,
      run.stateSlug,
      ".host-context-save-count",
    );
    fs.mkdirSync(path.dirname(contextSaveCountFile), { recursive: true });
    fs.writeFileSync(contextSaveCountFile, "1");
    writeState(run, {
      currentPhaseIndex: 1,
      currentFeatureIndex: 0,
      phases: [
        { index: 0, number: "1", name: "Phase 1", status: "committed" },
        { index: 1, number: "2", name: "Phase 2", status: "pending" },
      ],
      lastUpdatedAt: "2026-05-08T01:00:00.000Z",
    });
    const progressing = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T01:00:30.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });
    // 30s since lastUpdatedAt with a 180s window and a live phase => not
    // stale, the run is healthy. The monitor should NOT treat this as a
    // failed resume.
    expect(progressing.terminalEvent.event).not.toBe("RUN_HALTED_RESTART_CAP");
    expect(progressing.terminalEvent.event).not.toBe("RUN_RESUMED");

    // ---- Stage 3: a fresh stall AFTER the progress. State keeps the
    // progressed phase shape but `lastUpdatedAt` ages out again and the pid is
    // still dead. Because the intervening resume actually recovered (phase 0
    // committed, currentPhaseIndex advanced), the consecutive-failed-resume
    // budget should have reset.
    writeState(run, {
      currentPhaseIndex: 1,
      currentFeatureIndex: 0,
      phases: [
        { index: 0, number: "1", name: "Phase 1", status: "committed" },
        { index: 1, number: "2", name: "Phase 2", status: "pending" },
      ],
      lastUpdatedAt: "2026-05-08T01:00:00.000Z",
    });
    const afterProgress = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T01:10:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    // DESIRED invariant: the re-stale resumes with a fresh budget — attempt 1,
    // not attempt 3. Today the counter is lifetime-monotonic and never resets
    // on progress, so this reports resumeCount 3 (priorCount 2 + 1) and the
    // assertion fails. Unskip when B1's reset-on-progress logic lands.
    expect(afterProgress.terminalEvent.event).toBe("RUN_RESUMED");
    expect(afterProgress.terminalEvent.resumeCount).toBe(1);
  });
});
