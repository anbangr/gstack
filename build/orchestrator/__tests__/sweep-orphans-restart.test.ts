import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepOrphans } from "../cli";
import {
  readActiveRunRecords,
  writeActiveRunRecord,
  type ActiveRunRecord,
} from "../active-runs";

/**
 * Integration test for the supervised-restart bug: orchestrator A writes the
 * active-run record, exits between phases (dead PID), supervisor relaunches
 * as orchestrator B, B's startup sweep must NOT destroy A's worktree, and B
 * can then claim it by rewriting the record with its own PID.
 *
 * Pre-fix: sweep deleted the worktree on every restart. The two assertions
 * here (worktree survives sweep, second orchestrator can claim it) both fail
 * pre-fix.
 */
describe("supervised restart preserves worktree", () => {
  let parentRepo: string;
  let buildWorktreesRoot: string;
  let registryDir: string;
  let fakeHome: string;
  let originalHome: string;
  let baseCommit: string;

  function git(args: string[], cwd: string) {
    return spawnSync("git", args, { cwd, encoding: "utf8" });
  }

  beforeEach(() => {
    parentRepo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "restart-parent-")),
    );
    fakeHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "restart-home-")),
    );
    originalHome = process.env.HOME || "";
    process.env.HOME = fakeHome;
    buildWorktreesRoot = path.join(
      fakeHome,
      ".gstack",
      "build-worktrees",
      "test-repo",
    );
    fs.mkdirSync(buildWorktreesRoot, { recursive: true });
    registryDir = path.join(fakeHome, ".gstack", "build-state", "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });

    git(["init", "-b", "main", "-q"], parentRepo);
    git(["config", "user.email", "restart-test@example.invalid"], parentRepo);
    git(["config", "user.name", "restart-test"], parentRepo);
    fs.writeFileSync(path.join(parentRepo, "README.md"), "test\n");
    git(["add", "README.md"], parentRepo);
    git(["commit", "-q", "-m", "init"], parentRepo);
    baseCommit = git(["rev-parse", "HEAD"], parentRepo).stdout.trim();
  });

  afterEach(() => {
    try {
      git(["worktree", "prune"], parentRepo);
    } catch {
      // ignore
    }
    fs.rmSync(parentRepo, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  function addWorktree(runId: string): string {
    const wtPath = path.join(buildWorktreesRoot, runId);
    git(["worktree", "add", "--detach", wtPath, baseCommit], parentRepo);
    return wtPath;
  }

  function record(
    runId: string,
    wtPath: string,
    overrides: Partial<ActiveRunRecord> = {},
  ): ActiveRunRecord {
    return {
      runId,
      stateSlug: `build-${runId}`,
      repoPath: parentRepo,
      worktreePath: wtPath,
      planFile: "/plans/plan.md",
      pid: 99999999, // dead — typical for an exited orchestrator
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      branches: [`feat/${runId}`],
      ...overrides,
    };
  }

  it("modern record (with worktreePath): orchestrator B sweep preserves orch A's worktree, then claims it", () => {
    const runId = "run-supervised-modern";
    const wt = addWorktree(runId);

    // Step 1: Orchestrator A wrote its record with worktreePath populated,
    // then exited (PID 99999999 is dead). Heartbeat is fresh.
    writeActiveRunRecord(registryDir, record(runId, wt));

    // Step 2: Orchestrator B starts up. Its first action is sweepOrphans.
    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // Sweep must protect, not reap.
    expect(stats.protectedOnDisk).toBe(1);
    expect(stats.shapeX).toBe(0);
    expect(stats.shapeY).toBe(0);
    expect(stats.shapeZ).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);

    // Step 3: Orchestrator B writes its own provisional record (same runId,
    // its own PID, refreshed heartbeat). The previous JSON gets overwritten.
    const orchBPid = process.pid;
    writeActiveRunRecord(
      registryDir,
      record(runId, wt, { pid: orchBPid, lastUpdatedAt: new Date().toISOString() }),
    );

    // Step 4: Verify the registry now reflects orch B's ownership.
    const after = readActiveRunRecords(registryDir);
    expect(after).toHaveLength(1);
    expect(after[0].runId).toBe(runId);
    expect(after[0].pid).toBe(orchBPid);
    expect(after[0].worktreePath).toBe(wt);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("legacy record (no worktreePath): orchestrator B sweep migrates + preserves, then claims", () => {
    const runId = "run-supervised-legacy";
    const wt = addWorktree(runId);

    // Step 1: Orchestrator A's record was written by a pre-v1.40 orchestrator
    // that didn't know about worktreePath. The basename runId matches the
    // worktree on disk so the migration path can discover it.
    const legacy = record(runId, wt);
    delete (legacy as Partial<ActiveRunRecord>).worktreePath;
    writeActiveRunRecord(registryDir, legacy);

    // Step 2: Orchestrator B's startup sweep.
    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // Migration discovers + rewrites; protect-on-disk on the same pass.
    expect(stats.migrated).toBe(1);
    expect(stats.protectedOnDisk).toBe(1);
    expect(stats.shapeX).toBe(0);
    expect(stats.shapeY).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);

    const migrated = readActiveRunRecords(registryDir);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].worktreePath).toBe(wt);

    // Step 3: Orchestrator B can now claim normally.
    const orchBPid = process.pid;
    writeActiveRunRecord(
      registryDir,
      record(runId, wt, { pid: orchBPid, lastUpdatedAt: new Date().toISOString() }),
    );

    // Step 4: A subsequent sweep should be a clean no-op (live PID skip).
    const stats2 = sweepOrphans(registryDir, { homeDir: fakeHome });
    expect(stats2.skippedLive).toBe(1);
    expect(stats2.migrated).toBe(0);
    expect(stats2.shapeX).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
  });
});
