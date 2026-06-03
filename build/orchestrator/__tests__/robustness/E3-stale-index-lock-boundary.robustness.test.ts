/**
 * E3 — stale-index-lock-boundary (build-robustness suite)
 *
 * Group E (git / quarantine / worktree), tier: smoke. Intended mode: PIN.
 *
 * WHAT THIS PINS (behavior already correct — verified by reading the production
 * code 2026-06-03, cli.ts:3444-3475 inside the exported `recoverMutableAgentCommit`):
 *
 *   Before host-side recovery stages summary-listed files, the orchestrator
 *   defuses a leftover `.git/index.lock` (a concurrent gstack-build process or a
 *   crashed git op can leave one around, after which the next `git add` fails
 *   with "Unable to create '.../.git/index.lock': File exists."). The cleanup is
 *   gated on an AGE BOUNDARY, not a liveness probe:
 *
 *       const lockPath = path.join(await resolveGitDir(opts.cwd), "index.lock");
 *       const lockStat = fs.statSync(lockPath);
 *       const ageMs = Date.now() - lockStat.mtimeMs;
 *       if (ageMs >= 10_000) { fs.unlinkSync(lockPath); ... }   // REMOVE stale
 *       // else: leave it — it belongs to an active git op       // PRESERVE fresh
 *
 *   The cutoff is exactly `>= 10_000` ms. A lock younger than 10s belongs to an
 *   active git transaction; clobbering it would corrupt that transaction, so the
 *   recovery leaves it in place and surfaces the original git error. A lock 10s
 *   or older is abandoned and is removed so recovery proceeds.
 *
 *   This file pins the AGE BOUNDARY ONLY. A PID-from-lockfile liveness probe is
 *   NOT implementable here — git's `index.lock` holds the new index binary, not
 *   an owner PID (see BUILD_ROBUSTNESS_SUITE.md §5 refutation). The single
 *   load-bearing invariant a regression could quietly break is the 10s cutoff:
 *   lower it and the orchestrator starts deleting LIVE locks, corrupting a
 *   concurrent git op; raise it and stale locks wedge recovery forever.
 *
 * DRIVEN THROUGH THE PUBLIC ENTRY POINT: the cleanup lives inside the exported
 * `recoverMutableAgentCommit`, which resolves the lock path via the exported
 * `resolveGitDir`. We exercise it exactly as `cli.test.ts:2095-2236` does:
 * a real short-lived local `git` (init + one commit, no origin), a summary that
 * lists one changed file, `fs.utimesSync` as a fake clock to age the lock past
 * / shy of the boundary, then assert the lock's survival and the recovery
 * outcome. No real LLM, no network, nothing outside the temp dir.
 *
 * Imports only symbols that exist today (`recoverMutableAgentCommit`,
 * `captureGitSnapshot` from ../../cli; `resolveGitDir` from ../../resolve-git-dir).
 * See ./README.md for the PIN/RED protocol.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { mkTmp } from "./helpers";
import { captureGitSnapshot, recoverMutableAgentCommit } from "../../cli";
import { resolveGitDir } from "../../resolve-git-dir";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

/**
 * Plant a summary that lists README.md as a changed file plus a conventional
 * commit subject, write the change to disk, and return the summary path. The
 * orchestrator's host-side recovery stages the listed file and commits it with
 * that subject — but only after defusing any stale index.lock.
 */
function plantSummaryAndChange(tmpDir: string, commitSubject: string): string {
  const summary = path.join(tmpDir, ".llm-tmp", "summary.md");
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "changed\n");
  fs.writeFileSync(
    summary,
    [
      "# Primary implementor summary",
      "",
      "## Files changed",
      "- `README.md` — update docs.",
      "",
      "## Commit",
      `- Conventional commit message: \`${commitSubject}\``,
    ].join("\n"),
  );
  return summary;
}

/** Plant an empty `.git/index.lock` and age its mtime by `ageMs` (fake clock). */
function plantLockAged(lockPath: string, ageMs: number): void {
  fs.writeFileSync(lockPath, "");
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, mtime, mtime);
}

describe("[PIN] E3 stale-index-lock-boundary", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Real temp git repo: git init + one commit. No origin remote is needed —
    // recoverMutableAgentCommit only touches the local repo. The lock path it
    // cleans is resolved via resolveGitDir(cwd), so this repo's `.git` dir is
    // exactly the boundary's playground.
    tmpDir = mkTmp("gstack-robustness-e3-");
    git(["init", "--initial-branch=main"], tmpDir);
    git(["config", "user.email", "t@t.com"], tmpDir);
    git(["config", "user.name", "Test"], tmpDir);
    fs.writeFileSync(path.join(tmpDir, "README.md"), "init\n");
    git(["add", "."], tmpDir);
    git(["commit", "-m", "init"], tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves the lock under the gitdir reported by resolveGitDir", async () => {
    // Sanity-pin: the lock the boundary acts on lives at
    // `${resolveGitDir(cwd)}/index.lock`. If a refactor moved the lookup off
    // resolveGitDir, the boundary would silently act on the wrong path.
    const gitDir = await resolveGitDir(tmpDir);
    expect(fs.existsSync(gitDir)).toBe(true);
    expect(path.basename(path.join(gitDir, "index.lock"))).toBe("index.lock");
  });

  it("PRESERVES a fresh (<10s old) index.lock and surfaces a clear error", async () => {
    // A lock younger than the 10_000ms cutoff belongs to an active git op.
    // The boundary must NOT clean it — removing it would corrupt that op's
    // transaction. Recovery instead fails and surfaces the git error so the
    // operator knows to retry.
    const before = captureGitSnapshot(tmpDir);
    const summary = plantSummaryAndChange(tmpDir, "feat: fresh-lock-preserved");

    const lockPath = path.join(await resolveGitDir(tmpDir), "index.lock");
    // 1s old: comfortably under the boundary.
    plantLockAged(lockPath, 1_000);

    const recovery = await recoverMutableAgentCommit({
      cwd: tmpDir,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    // Fresh lock survives — we did not clobber a concurrent op's transaction.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(recovery.recovered).toBe(false);
    expect(recovery.errors.join("\n")).toMatch(/index\.lock|File exists/);
  });

  it("PRESERVES a lock just under the 10s boundary (9.5s old)", async () => {
    // Boundary precision (upper side): the cutoff is `ageMs >= 10_000`, so a
    // lock at 9.5s is still "fresh" and must be preserved. This is the assertion
    // a cutoff-lowering regression (e.g. 5_000) would break first.
    const before = captureGitSnapshot(tmpDir);
    const summary = plantSummaryAndChange(
      tmpDir,
      "feat: near-boundary-preserved",
    );

    const lockPath = path.join(await resolveGitDir(tmpDir), "index.lock");
    plantLockAged(lockPath, 9_500);

    const recovery = await recoverMutableAgentCommit({
      cwd: tmpDir,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(recovery.recovered).toBe(false);
    expect(recovery.errors.join("\n")).toMatch(/index\.lock|File exists/);
  });

  it("REMOVES a stale (>=10s old) index.lock and lets recovery proceed", async () => {
    // A lock 10s or older is abandoned. The boundary removes it so the
    // host-side recovery's `git add` + commit can proceed. We age it well past
    // the cutoff (60s) — the classic crashed-op leftover.
    const before = captureGitSnapshot(tmpDir);
    const summary = plantSummaryAndChange(tmpDir, "feat: stale-lock-removed");

    const lockPath = path.join(await resolveGitDir(tmpDir), "index.lock");
    plantLockAged(lockPath, 60_000);

    const recovery = await recoverMutableAgentCommit({
      cwd: tmpDir,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    // Stale lock removed; recovery committed the summary-listed file.
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(recovery.recovered).toBe(true);
    expect(recovery.errors).toEqual([]);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir)).toBe(
      "feat: stale-lock-removed",
    );
  });

  it("REMOVES a lock exactly at the 10s boundary (10s old)", async () => {
    // Boundary precision (lower side): the cutoff is INCLUSIVE (`ageMs >=
    // 10_000`), so a lock aged exactly 10s is stale and removed. fs.utimesSync
    // sets a whole-second mtime, so `Date.now() - mtimeMs` lands a hair over
    // 10_000ms — squarely on the "remove" side and immune to sub-ms jitter.
    const before = captureGitSnapshot(tmpDir);
    const summary = plantSummaryAndChange(tmpDir, "feat: at-boundary-removed");

    const lockPath = path.join(await resolveGitDir(tmpDir), "index.lock");
    plantLockAged(lockPath, 10_000);

    const recovery = await recoverMutableAgentCommit({
      cwd: tmpDir,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(recovery.recovered).toBe(true);
    expect(recovery.errors).toEqual([]);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir)).toBe(
      "feat: at-boundary-removed",
    );
  });
});
