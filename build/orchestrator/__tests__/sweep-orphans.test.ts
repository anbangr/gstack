import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepOrphans } from "../cli";
import {
  writeActiveRunRecord,
  readActiveRunRecords,
  type ActiveRunRecord,
} from "../active-runs";

/**
 * sweepOrphans tests use real `git worktree` invocations to avoid the
 * impossible-to-trust-mock trap. Each test sets up:
 *
 *   1. A temp parent repo (initialized with one commit so worktree-add works)
 *   2. A temp build-worktrees root that mimics ~/.gstack/build-worktrees/<slug>/
 *   3. A temp active-runs registry
 *
 * Then we run sweepOrphans against the registry and assert filesystem state.
 *
 * Important: tests pin GSTACK_BUILD_STATE_DIR to point at a temp dir so the
 * sweep's "where do I write WORKTREE_LEAK.resolved" marker write goes to a
 * temp location, NOT the user's real ~/.gstack/skill-faults/. Set on process
 * env in beforeEach, restored in afterEach.
 */
describe("sweepOrphans", () => {
  let parentRepo: string;
  let buildWorktreesRoot: string;
  let registryDir: string;
  let fakeHome: string;
  let originalHome: string;
  let baseCommit: string;

  function git(
    args: string[],
    cwd: string,
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return {
      status: r.status ?? -1,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
    };
  }

  beforeEach(() => {
    // realpathSync canonicalizes /var/folders/... → /private/var/folders/...
    // on macOS so it matches what `git worktree list --porcelain` reports (git
    // resolves symlinks). Without this, the sweep's Shape Z `startsWith` check
    // never matches the worktree paths git returns.
    parentRepo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sweep-parent-")),
    );
    fakeHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sweep-home-")),
    );
    // The sweep walks `os.homedir() + /.gstack/build-worktrees/...` for Shape Z.
    // Pin HOME so the build-worktrees root lands under our temp dir.
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

    // Initialize parent repo with one commit so `git worktree add` has something
    // to create a worktree from.
    git(["init", "-b", "main", "-q"], parentRepo);
    git(["config", "user.email", "sweep-test@example.invalid"], parentRepo);
    git(["config", "user.name", "sweep-test"], parentRepo);
    fs.writeFileSync(path.join(parentRepo, "README.md"), "test\n");
    git(["add", "README.md"], parentRepo);
    git(["commit", "-q", "-m", "init"], parentRepo);
    const head = git(["rev-parse", "HEAD"], parentRepo);
    baseCommit = head.stdout.trim();
  });

  afterEach(() => {
    // Remove worktrees registered against parent before deleting dirs so git
    // doesn't complain. Best-effort.
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

  // Default lastUpdatedAt is deliberately stale (>24h in the past) so that
  // legacy Shape X tests classify as reap. Tests exercising the protect-on-disk
  // path (supervised restart / fresh heartbeat) pass a recent `lastUpdatedAt`
  // explicitly via overrides.
  function staleTimestamp(): string {
    const d = new Date(Date.now() - 48 * 3600 * 1000); // 48h ago
    return d.toISOString();
  }
  function freshTimestamp(): string {
    return new Date().toISOString();
  }

  function makeRecord(
    overrides: Partial<ActiveRunRecord> = {},
  ): ActiveRunRecord {
    return {
      runId: "run-x",
      stateSlug: "build-run-x",
      repoPath: parentRepo,
      planFile: "/plans/plan.md",
      pid: 99999999, // dead PID by default
      status: "running",
      startedAt: "2026-05-16T00:00:00.000Z",
      lastUpdatedAt: staleTimestamp(),
      branches: ["feat/run-x"],
      ...overrides,
    };
  }

  function addWorktree(runId: string): string {
    const wtPath = path.join(buildWorktreesRoot, runId);
    git(["worktree", "add", "--detach", wtPath, baseCommit], parentRepo);
    return wtPath;
  }

  it("Shape X — worktree + JSON + dead PID + stale heartbeat — both cleaned", () => {
    const wt = addWorktree("run-x");
    writeActiveRunRecord(
      registryDir,
      makeRecord({ runId: "run-x", worktreePath: wt }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeX).toBe(1);
    expect(fs.existsSync(wt)).toBe(false);
    expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([]);
  });

  it("Shape Y — dir gone, JSON exists — JSON deleted", () => {
    // Create worktree then remove it manually (simulating user rm -rf)
    const wt = addWorktree("run-y");
    fs.rmSync(wt, { recursive: true, force: true });
    writeActiveRunRecord(
      registryDir,
      makeRecord({ runId: "run-y", worktreePath: wt }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeY).toBe(1);
    expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([]);
  });

  it("Shape Z — dir on disk, no JSON — dir removed", () => {
    // Worktree exists but no active-run JSON. Need at least one record in the
    // registry so the sweep visits parentRepo via the repoPaths set. Use a
    // separate record pointing at parentRepo so the sweep enumerates its
    // worktrees.
    const wtZ = addWorktree("run-z-orphan");
    // A separate record for a different runId, completed-and-cleaned scenario.
    // worktreePath points at a nonexistent path so the record classifies as
    // reap-shape-y, not protect.
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "different-run",
        pid: 88888888, // also dead
        status: "completed",
        worktreePath: path.join(buildWorktreesRoot, "different-run"),
      }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeZ).toBe(1);
    expect(fs.existsSync(wtZ)).toBe(false);
    // The "different-run" record had no worktree on disk → Shape Y for it.
    expect(stats.shapeY).toBe(1);
  });

  it("skips live-PID records", () => {
    const wt = addWorktree("run-live");
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-live",
        worktreePath: wt,
        pid: process.pid, // current process is alive
        status: "running",
      }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.skippedLive).toBe(1);
    expect(stats.shapeX).toBe(0);
    expect(fs.existsSync(wt)).toBe(true); // untouched
    expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([
      "run-live",
    ]);
  });

  it("empty registry — no-op silently, no marker written", () => {
    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeX).toBe(0);
    expect(stats.shapeY).toBe(0);
    expect(stats.shapeZ).toBe(0);
    expect(stats.errors).toBe(0);
    const markerPath = path.join(
      fakeHome,
      ".gstack",
      "skill-faults",
      "WORKTREE_LEAK.resolved",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("handles malformed JSON — logs warning, continues, doesn't crash", () => {
    // Write a malformed JSON file into the registry dir.
    fs.writeFileSync(
      path.join(registryDir, "bogus.json"),
      "{ this is not json",
      { mode: 0o600 },
    );
    // Add a valid record alongside to verify the sweep keeps going.
    const wt = addWorktree("run-valid");
    writeActiveRunRecord(
      registryDir,
      makeRecord({ runId: "run-valid", worktreePath: wt }),
    );

    // Should not throw. readActiveRunRecords gracefully skips malformed files.
    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // The valid record gets cleaned as Shape X.
    expect(stats.shapeX).toBe(1);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("handles git worktree remove failure — logs warning, still cleans JSON", () => {
    const wt = addWorktree("run-locked");
    writeActiveRunRecord(
      registryDir,
      makeRecord({ runId: "run-locked", worktreePath: wt }),
    );
    // Make the worktree read-only at the parent level to (try to) fail removal.
    // git worktree remove --force is robust to most things, so we simulate by
    // pointing the record at a non-existent repoPath, which fails listing but
    // also fails removal cleanly.
    // Alternative: write a lock file in the worktree's .git that git refuses to
    // remove. The cleanest sim: corrupt the worktree's .git pointer.
    const dotGitPath = path.join(wt, ".git");
    try {
      fs.unlinkSync(dotGitPath);
    } catch {
      // ignore
    }
    fs.writeFileSync(dotGitPath, "gitdir: /nonexistent/path\n");

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // git worktree remove will fail (broken gitdir), but the JSON should still
    // be cleaned because the record is stale either way.
    expect(stats.shapeX + stats.errors).toBeGreaterThanOrEqual(1);
    expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([]);
  });

  it("is idempotent — second call on cleaned state is a no-op", () => {
    const wt = addWorktree("run-idem");
    writeActiveRunRecord(
      registryDir,
      makeRecord({ runId: "run-idem", worktreePath: wt }),
    );

    const stats1 = sweepOrphans(registryDir, { homeDir: fakeHome });
    expect(stats1.shapeX).toBe(1);

    const stats2 = sweepOrphans(registryDir, { homeDir: fakeHome });
    expect(stats2.shapeX).toBe(0);
    expect(stats2.shapeY).toBe(0);
    expect(stats2.shapeZ).toBe(0);
    expect(stats2.skippedLive).toBe(0);
    expect(stats2.errors).toBe(0);
  });

  it("writes WORKTREE_LEAK.resolved marker after first non-empty run", () => {
    const wt = addWorktree("run-marker");
    writeActiveRunRecord(
      registryDir,
      makeRecord({ runId: "run-marker", worktreePath: wt }),
    );
    const markerPath = path.join(
      fakeHome,
      ".gstack",
      "skill-faults",
      "WORKTREE_LEAK.resolved",
    );
    expect(fs.existsSync(markerPath)).toBe(false);

    sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(fs.existsSync(markerPath)).toBe(true);
    const content = fs.readFileSync(markerPath, "utf8");
    expect(content).toMatch(/status:shipped-in-code/);
    expect(content).toMatch(/commit:/);
    expect(content).toMatch(/ts:/);

    // Second sweep with nothing to clean must NOT overwrite the marker.
    const mtimeBefore = fs.statSync(markerPath).mtimeMs;
    sweepOrphans(registryDir, { homeDir: fakeHome });
    const mtimeAfter = fs.statSync(markerPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  // -- protect-on-disk (the central regression for v1.40.0.0) --

  it("REGRESSION: dead PID + worktree on disk + fresh heartbeat — does NOT reap (supervised restart)", () => {
    // This is the exact bug from the original investigation: orchestrator
    // exited between phases, supervisor relaunched, new sweep saw stale PID
    // and destroyed the still-active worktree. With the fix, the worktree
    // must survive untouched until the heartbeat goes stale.
    const wt = addWorktree("run-restart");
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-restart",
        worktreePath: wt,
        pid: 99999999, // dead — typical between-phase orchestrator
        status: "running",
        lastUpdatedAt: freshTimestamp(),
      }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeX).toBe(0);
    expect(stats.shapeY).toBe(0);
    expect(stats.shapeZ).toBe(0);
    expect(stats.protectedOnDisk).toBe(1);
    expect(fs.existsSync(wt)).toBe(true);
    expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([
      "run-restart",
    ]);
    // No marker write — a pure-protect run is not a "leak resolved" event.
    const markerPath = path.join(
      fakeHome,
      ".gstack",
      "skill-faults",
      "WORKTREE_LEAK.resolved",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("clock skew clamp: lastUpdatedAt in the future — treats as protect, not reap", () => {
    // Cross-machine sync (e.g., gbrain artifacts sync) can land records whose
    // lastUpdatedAt is ahead of this machine's clock. The reaper must not
    // misclassify these as stale-with-bogus-negative-age.
    const wt = addWorktree("run-future");
    const futureTimestamp = new Date(Date.now() + 3600 * 1000).toISOString();
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-future",
        worktreePath: wt,
        lastUpdatedAt: futureTimestamp,
      }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeX).toBe(0);
    expect(stats.protectedOnDisk).toBe(1);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("GSTACK_SWEEP_STALE_HOURS env override — record aged past override reaps", () => {
    // With override=0.1h (=360s), a record aged 600s is past threshold and reaps.
    const wt = addWorktree("run-env");
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-env",
        worktreePath: wt,
        lastUpdatedAt: new Date(Date.now() - 600 * 1000).toISOString(),
      }),
    );

    const originalEnv = process.env.GSTACK_SWEEP_STALE_HOURS;
    process.env.GSTACK_SWEEP_STALE_HOURS = "0.1";
    try {
      const stats = sweepOrphans(registryDir, { homeDir: fakeHome });
      expect(stats.shapeX).toBe(1);
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GSTACK_SWEEP_STALE_HOURS;
      } else {
        process.env.GSTACK_SWEEP_STALE_HOURS = originalEnv;
      }
    }
  });

  it("sub-60s freshness clamp: record updated 5s ago — always protected", () => {
    // Even with a tiny GSTACK_SWEEP_STALE_HOURS override, very fresh records
    // are protected. Prevents racing the heartbeat-writer.
    const wt = addWorktree("run-fresh");
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-fresh",
        worktreePath: wt,
        lastUpdatedAt: new Date(Date.now() - 5 * 1000).toISOString(),
      }),
    );

    const originalEnv = process.env.GSTACK_SWEEP_STALE_HOURS;
    process.env.GSTACK_SWEEP_STALE_HOURS = "0.001"; // 3.6s
    try {
      const stats = sweepOrphans(registryDir, { homeDir: fakeHome });
      expect(stats.protectedOnDisk).toBe(1);
      expect(stats.shapeX).toBe(0);
      expect(fs.existsSync(wt)).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GSTACK_SWEEP_STALE_HOURS;
      } else {
        process.env.GSTACK_SWEEP_STALE_HOURS = originalEnv;
      }
    }
  });

  // -- migration on read (legacy records without worktreePath) --

  it("migrates legacy record (no worktreePath) when basename matches and dir exists", () => {
    const wt = addWorktree("run-legacy");
    const legacy = makeRecord({
      runId: "run-legacy",
      lastUpdatedAt: freshTimestamp(),
    });
    // Strip worktreePath to simulate a pre-v1.40 record.
    delete (legacy as Partial<ActiveRunRecord>).worktreePath;
    writeActiveRunRecord(registryDir, legacy);

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // Migration discovers the worktree, rewrites the record, then the second
    // classify in the same pass treats it as protect-on-disk (fresh heartbeat).
    expect(stats.migrated).toBe(1);
    expect(stats.protectedOnDisk).toBe(1);
    expect(stats.shapeX).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);

    const records = readActiveRunRecords(registryDir);
    expect(records).toHaveLength(1);
    expect(records[0].worktreePath).toBe(wt);

    // Second sweep: record now has worktreePath, no migration needed.
    const stats2 = sweepOrphans(registryDir, { homeDir: fakeHome });
    expect(stats2.migrated).toBe(0);
    expect(stats2.protectedOnDisk).toBe(1);
  });

  it("legacy record with no matching worktree on disk anywhere — Shape Y", () => {
    // Legacy record exists, but no worktree dir matches the runId by basename
    // anywhere in the registry's repoPaths. Sweep treats as genuine Shape Y.
    const legacy = makeRecord({ runId: "run-orphan-legacy" });
    delete (legacy as Partial<ActiveRunRecord>).worktreePath;
    writeActiveRunRecord(registryDir, legacy);

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    expect(stats.shapeY).toBe(1);
    expect(stats.migrated).toBe(0);
    expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([]);
  });

  // -- repoPath normalization --

  it("repoPath dedup: trailing slash form collapses to single git worktree list call", () => {
    // Two records pointing at the same repo via slightly different path forms
    // (with and without trailing slash). Sweep must normalize both to the
    // same canonical form and not produce ghost classifications.
    const wt1 = addWorktree("run-norm-a");
    const wt2 = addWorktree("run-norm-b");
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-norm-a",
        repoPath: parentRepo, // canonical
        worktreePath: wt1,
        lastUpdatedAt: freshTimestamp(),
      }),
    );
    writeActiveRunRecord(
      registryDir,
      makeRecord({
        runId: "run-norm-b",
        repoPath: parentRepo + "/", // same repo, trailing slash
        worktreePath: wt2,
        lastUpdatedAt: freshTimestamp(),
      }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // Both records protected; no spurious Shape Y from trailing-slash mismatch.
    expect(stats.protectedOnDisk).toBe(2);
    expect(stats.shapeY).toBe(0);
    expect(fs.existsSync(wt1)).toBe(true);
    expect(fs.existsSync(wt2)).toBe(true);
  });
});
