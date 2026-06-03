/**
 * E2 — dual-impl-leak-sweep  [RED]
 *
 * Group E (git / quarantine / worktree) of the `build-robustness` suite.
 * See ./README.md for the PIN/RED protocol and
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §"E2. dual-impl-leak-sweep" for the
 * full design context.
 *
 * THE GAP (confirmed by reading the production code):
 *
 *   `worktree.createWorktrees({cwd, slug, phaseNumber})` roots both dual-impl
 *   worktrees under `os.tmpdir()`:
 *       <tmpdir>/gstack-dual-<slug>-p<N>-<ts>/{primary,secondary}
 *   with tracking branches `gstack-dual-p<N>-{primary,secondary}-<ts>`.
 *   (worktree.ts:44-91 — verified signature/return below.)
 *
 *   When an applyWinner failure or a hard crash skips `teardownWorktrees`,
 *   those `/tmp` worktrees + branches leak. `sweepOrphans` (cli.ts:11861) is
 *   the only reaper, and it ONLY removes a worktree when
 *       wtPath.startsWith(path.join(homeDir, ".gstack", "build-worktrees"))
 *   (cli.ts:11960-11978). It also only enumerates worktrees for repoPaths that
 *   appear in the active-runs registry. So a `/tmp/gstack-dual-*` worktree —
 *   under `os.tmpdir()`, not `~/.gstack/build-worktrees/` — is never reaped and
 *   its branch is never deleted. Nothing reaps these today.
 *
 * THE DESIRED INVARIANT (this RED block asserts it; it currently FAILS):
 *
 *   After a crash leaves dual worktrees+branches behind, the chosen reaper
 *   (a tmpdir-aware branch in sweepOrphans, or a recorded-list teardown)
 *   removes the leaked `/tmp/gstack-dual-*` worktrees AND
 *   `git branch --list 'gstack-dual-*'` reports zero leaked branches.
 *
 * This file is committed `describe.skip`. It loads cleanly — it imports only
 * symbols that exist today (`createWorktrees` from ../../worktree, `sweepOrphans`
 * from ../../cli) and does ALL setup inside beforeEach/it. The skipped body is
 * what fails pre-fix, NOT the import. Unskip in the same commit that ships the
 * reaper fix.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkTmp } from "./helpers";
import { createWorktrees } from "../../worktree";
import { sweepOrphans } from "../../cli";

/**
 * Thin git wrapper. Every spawn is synchronous and bounded — git exits on its
 * own, there is no long-lived process to reap. We pin a 30s timeout so a hung
 * filesystem can never wedge the suite.
 */
function git(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

describe.skip("[RED] E2 dual-impl-leak-sweep — UNSKIP WHEN E2 IS FIXED", () => {
  // realpathSync canonicalizes /var/folders/... → /private/var/folders/... on
  // macOS so paths match what `git worktree list --porcelain` reports (git
  // resolves symlinks). Mirrors the sweep-orphans.test.ts beforeEach.
  let repoPath: string;
  let fakeHome: string;
  let registryDir: string;
  // Leaked artifacts we must clean up in afterEach even though the test
  // *simulates a crash* by skipping teardownWorktrees.
  const leakedWorktreePaths: string[] = [];
  const leakedBranches: string[] = [];
  const tmpRoots: string[] = [];

  let savedStaleHours: string | undefined;

  beforeEach(() => {
    // Save+restore the only env var sweepOrphans reads. We do not set it; this
    // is purely defensive so a value leaking in from the outer env can't change
    // the reaper's staleness threshold under us.
    savedStaleHours = process.env.GSTACK_SWEEP_STALE_HOURS;

    const repoRoot = fs.realpathSync(mkTmp("e2-dual-repo-"));
    tmpRoots.push(repoRoot);
    repoPath = path.join(repoRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });

    git(["init", "--initial-branch=main", "-q"], repoPath);
    git(["config", "user.email", "e2-test@example.invalid"], repoPath);
    git(["config", "user.name", "e2-test"], repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# e2 test repo\n");
    git(["add", "README.md"], repoPath);
    git(["commit", "-q", "-m", "initial"], repoPath);

    // Isolated fake HOME for the reaper so it never touches the developer's
    // real ~/.gstack and its WORKTREE_LEAK.resolved marker write lands here.
    fakeHome = fs.realpathSync(mkTmp("e2-dual-home-"));
    tmpRoots.push(fakeHome);
    registryDir = path.join(fakeHome, ".gstack", "build-state", "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });

    leakedWorktreePaths.length = 0;
    leakedBranches.length = 0;
  });

  afterEach(() => {
    // Force-clean the leaked dual worktrees + branches the simulated crash left
    // behind, so this spec never strands /tmp worktrees for the next run.
    for (const wt of leakedWorktreePaths) {
      git(["worktree", "remove", "--force", wt], repoPath);
    }
    for (const b of leakedBranches) {
      git(["branch", "-D", b], repoPath);
    }
    git(["worktree", "prune"], repoPath);
    for (const root of tmpRoots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpRoots.length = 0;

    if (savedStaleHours === undefined) {
      delete process.env.GSTACK_SWEEP_STALE_HOURS;
    } else {
      process.env.GSTACK_SWEEP_STALE_HOURS = savedStaleHours;
    }
  });

  it("crash leaks two phases of /tmp dual worktrees+branches; a reaper removes them and no gstack-dual-* branch survives", () => {
    // --- Two phases, each creating a dual worktree pair under os.tmpdir(). ---
    const phase1 = createWorktrees({
      cwd: repoPath,
      slug: "e2feat",
      phaseNumber: "1",
    });
    const phase2 = createWorktrees({
      cwd: repoPath,
      slug: "e2feat",
      phaseNumber: "2",
    });

    // Record everything for afterEach cleanup BEFORE asserting anything.
    for (const pair of [phase1, phase2]) {
      leakedWorktreePaths.push(
        pair.candidates.primary.worktreePath,
        pair.candidates.secondary.worktreePath,
      );
      leakedBranches.push(
        pair.candidates.primary.branch,
        pair.candidates.secondary.branch,
      );
    }

    // Sanity: confirm the leak actually exists on disk and in `git branch`,
    // and that the worktrees really do live under os.tmpdir() (the un-reaped
    // location), NOT under ~/.gstack/build-worktrees/.
    const tmpdir = fs.realpathSync(os.tmpdir());
    for (const wt of leakedWorktreePaths) {
      expect(fs.existsSync(wt)).toBe(true);
      expect(fs.realpathSync(wt).startsWith(tmpdir)).toBe(true);
    }
    const branchesBefore = git(["branch", "--list", "gstack-dual-*"], repoPath);
    expect(branchesBefore.status).toBe(0);
    // 4 leaked branches: p1 primary/secondary + p2 primary/secondary.
    expect(
      branchesBefore.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ).toHaveLength(4);

    // --- Simulate the crash: teardownWorktrees is NEVER called. ---
    // Run the only reaper that exists today against an isolated registry +
    // fake HOME. (Registry is empty because the crashed run never wrote an
    // active-run record for these /tmp worktrees — that's the realistic shape.)
    sweepOrphans(registryDir, { homeDir: fakeHome });

    // --- DESIRED invariant (currently FAILS — nothing reaps os.tmpdir()). ---
    // Every leaked dual worktree directory is gone...
    for (const wt of leakedWorktreePaths) {
      expect(fs.existsSync(wt)).toBe(false);
    }
    // ...and no gstack-dual-* tracking branch survives.
    const branchesAfter = git(["branch", "--list", "gstack-dual-*"], repoPath);
    expect(branchesAfter.status).toBe(0);
    expect(branchesAfter.stdout.trim()).toBe("");
  });
});
