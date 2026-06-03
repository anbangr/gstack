import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepOrphans } from "../../cli";
import {
  writeActiveRunRecord,
  activeRunRecordPath,
  type ActiveRunRecord,
} from "../../active-runs";

/**
 * D5 — Shape Z must NOT reap a worktree whose active-run record exists on disk
 * but fails to parse (a torn/truncated write, a transient read error).
 *
 * The failure mode this protects against: orchestrator A is mid-build, its
 * active-run JSON gets caught half-written (or temporarily unreadable) at the
 * exact instant orchestrator B runs its startup `sweepOrphans`.
 * `readActiveRunRecords` silently skips the corrupt file (by design — a bad
 * record must not block unrelated builds). But that skip means nothing in the
 * registry *claims* A's worktree, so the Shape Z walk — which removes any
 * worktree under `~/.gstack/build-worktrees/` with no owning record — reaps a
 * directory that belongs to a live concurrent build.
 *
 * Note the enumeration subtlety: `sweepOrphans` only lists git worktrees for
 * repoPaths it learns from *parseable* records. So the corrupt record alone
 * would never bring `parentRepo` into scope. We add a SECOND, valid,
 * live-PID record pointing at the same `parentRepo` (a sibling concurrent
 * build). That record is skipped-live (and its own worktree is claimed), but
 * it pulls `parentRepo` into the repoPaths set, so `git worktree list` now
 * enumerates BOTH worktrees — including the corrupt-record one, which nothing
 * claims. Pre-fix, that unclaimed-but-live worktree is destroyed as Shape Z.
 *
 * Desired invariant (the fix): the worktree backing the unreadable record
 * survives the sweep. There is no safe way to prove a worktree is orphaned
 * when a registry file failed to read; the sweep must fail closed and leave it
 * alone.
 *
 * Today the torn read gets the live worktree reaped, so this is RED.
 * UNSKIP WHEN D5 IS FIXED.
 *
 * Reuses the real-`git worktree` + temp-HOME idioms from
 * `build/orchestrator/__tests__/sweep-orphans.test.ts` and
 * `sweep-orphans-restart.test.ts` (no new fakes needed; this spec exercises
 * real filesystem + real git, so the helpers.ts time/spawn fakes don't apply).
 */
describe.skip("[RED] D5 sweep-shape-z-protects-unreadable-record — UNSKIP WHEN D5 IS FIXED", () => {
  let parentRepo: string;
  let buildWorktreesRoot: string;
  let registryDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let baseCommit: string;

  function git(args: string[], cwd: string) {
    return spawnSync("git", args, { cwd, encoding: "utf8" });
  }

  beforeEach(() => {
    // realpathSync canonicalizes /var/folders/... → /private/var/folders/...
    // on macOS so paths match what `git worktree list --porcelain` reports
    // (git resolves symlinks). Mirrors sweep-orphans.test.ts.
    parentRepo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "d5-parent-")),
    );
    fakeHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "d5-home-")),
    );

    // sweepOrphans takes an explicit homeDir override, but pin HOME too so no
    // code path that consults the real home env can touch the developer's
    // ~/.gstack. Saved + restored in afterEach.
    originalHome = process.env.HOME;
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
    git(["config", "user.email", "d5-test@example.invalid"], parentRepo);
    git(["config", "user.name", "d5-test"], parentRepo);
    fs.writeFileSync(path.join(parentRepo, "README.md"), "test\n");
    git(["add", "README.md"], parentRepo);
    git(["commit", "-q", "-m", "init"], parentRepo);
    baseCommit = git(["rev-parse", "HEAD"], parentRepo).stdout.trim();
  });

  afterEach(() => {
    // Detach worktrees from the parent before deleting dirs so git's gc/prune
    // never trips. Best-effort.
    try {
      git(["worktree", "prune"], parentRepo);
    } catch {
      // ignore
    }
    fs.rmSync(parentRepo, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  function addWorktree(runId: string): string {
    const wtPath = path.join(buildWorktreesRoot, runId);
    git(["worktree", "add", "--detach", wtPath, baseCommit], parentRepo);
    return wtPath;
  }

  function makeRecord(
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
      pid: 99999999, // dead by default
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      lastUpdatedAt: new Date().toISOString(), // fresh heartbeat
      branches: [`feat/${runId}`],
      ...overrides,
    };
  }

  it("a torn/truncated active-run record must not let Shape Z reap its live worktree", () => {
    // The corrupt-record worktree — a real registered git worktree on disk
    // belonging to a build whose JSON is momentarily unreadable.
    const cwt = addWorktree("run-corrupt");

    // Write a CORRUPT (truncated JSON) record for that runId. readActiveRunRecords
    // catches the JSON.parse throw and skips it, so nothing in the parsed
    // registry claims this worktree.
    const corruptPath = activeRunRecordPath(registryDir, "run-corrupt");
    fs.writeFileSync(
      corruptPath,
      '{ "runId": "run-corrupt", "stateSlug": "build-run-corrupt", "repoP',
      { mode: 0o600 },
    );

    // A second, VALID, live-PID record for a sibling concurrent build in the
    // same parent repo. Purpose: bring `parentRepo` into sweepOrphans'
    // repoPaths set so `git worktree list` enumerates BOTH worktrees. Without
    // it, the corrupt record's repo is never even listed and the bug can't be
    // observed. This record is skipped-live; its own worktree is claimed.
    const swt = addWorktree("run-sibling");
    writeActiveRunRecord(
      registryDir,
      makeRecord("run-sibling", swt, {
        pid: process.pid, // current process — alive
        status: "running",
      }),
    );

    const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

    // The sibling build is correctly left alone.
    expect(fs.existsSync(swt)).toBe(true);

    // DESIRED INVARIANT (currently failing): the unreadable record's worktree
    // is NOT treated as an unclaimed orphan. A torn read must fail closed.
    expect(fs.existsSync(cwt)).toBe(true);
    // And the sweep must not have counted it as a Shape Z reap.
    expect(stats.shapeZ).toBe(0);
  });
});
