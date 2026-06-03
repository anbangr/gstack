/**
 * D4 — release-scratch-worktree-reaped (RED, integration)
 *
 * Group D (release queue / locks). See ../README.md for the PIN/RED protocol
 * and docs/designs/BUILD_ROBUSTNESS_SUITE.md §D4 for the design context.
 *
 * THE GAP (confirmed by reading release-daemon.ts):
 *   When a queue record's `worktreePath` does not exist on disk,
 *   `checkoutScratchWorktree` falls back to creating a scratch worktree under
 *   `os.tmpdir()/gstack-release-daemon/<runId>-pr-<prNumber>` via
 *   `git worktree add --detach <scratch> <ref>` (release-daemon.ts:856-869).
 *   `processReleaseQueueRecord`'s `finally` block (release-daemon.ts:1209-1238)
 *   releases the lock and deregisters the record — but NEVER runs
 *   `git worktree remove` or `git worktree prune` for the scratch path. On a
 *   long-lived daemon that lands many PRs, `/tmp/gstack-release-daemon/` and
 *   the repo's `.git/worktrees/` grow unbounded.
 *
 * DESIRED INVARIANT (currently failing -> committed `describe.skip`):
 *   After a record lands through the scratch fallback, `spawnSync` is called
 *   with `git worktree remove` (or `git worktree prune`) targeting the scratch
 *   path, so the scratch worktree is reaped.
 *
 * UNSKIP when the reaper lands in `processReleaseQueueRecord` (drop `.skip`,
 * implement the cleanup, same commit).
 *
 * This is an integration spec only in the sense that it drives the real
 * `processReleaseQueueRecord` entry point; it spawns NO real process — every
 * `spawnSync` is intercepted by `spyOn(childRegistry, "spawnSync")`, and the
 * land sub-agent is a stub. No LLM, no network, no real git.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _resetReleaseDaemonForTests,
  processReleaseQueueRecord,
} from "../../release-daemon";
import {
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../../release-queue";
import { DEFAULT_ROLE_CONFIGS } from "../../role-config";
import * as childRegistry from "../../child-registry";

// The security gate inside processReleaseQueueRecord validates repoPath against
// realpath(os.tmpdir()), so the allowlist prefix must be the realpath of the
// OS tmpdir (macOS /var/folders -> /private/var/folders, etc).
const TMP_ALLOWLIST = [fs.realpathSync(os.tmpdir()) + path.sep];

// Env keys this spec touches must be saved + restored so a developer's real
// daemon-allowlist override never bleeds into (or out of) the test.
const SAVED_ENV: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]): void {
  for (const k of keys) SAVED_ENV[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A spawnSync result shaped like child_process's, with a clean exit. */
function ok(stdout = "") {
  return {
    status: 0,
    stdout,
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("[RED→FIXED] D4 release-scratch-worktree-reaped", () => {
  let queueDir: string;
  let repo: string;
  // Track scratch dirs we may need to clean if a future fix actually creates
  // them on disk. (Today the mock prevents real creation; harmless either way.)
  const scratchRoot = path.join(os.tmpdir(), "gstack-release-daemon");

  beforeEach(() => {
    saveEnv("GSTACK_DAEMON_REPO_ALLOWLIST");
    delete process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
    _resetReleaseDaemonForTests();
    queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-d4-queue-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-d4-repo-"));
    // A real .git marker so isAllowedRepoPath accepts the repo as a cwd.
    fs.mkdirSync(path.join(repo, ".git"));
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    restoreEnv();
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("reaps the scratch worktree with `git worktree remove` (or prune) after a record lands", async () => {
    const runId = "d4-scratch-run";
    const prNumber = 77;
    // Point worktreePath at a path guaranteed NOT to exist so the scratch
    // fallback in checkoutScratchWorktree fires instead of honoring an
    // existing worktree. The scratch path the daemon will compute is
    // os.tmpdir()/gstack-release-daemon/<runId>-pr-<prNumber>.
    const expectedScratch = path.join(scratchRoot, `${runId}-pr-${prNumber}`);

    const item = writeReleaseQueueRecord(queueDir, {
      runId,
      repoPath: repo,
      repoIdentity: "github.com/acme/d4",
      baseBranch: "main",
      featureBranch: "feat/d4",
      prNumber,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: path.join(os.tmpdir(), "does-not-exist-d4-worktree"),
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    } as ReleaseQueueRecord);

    // Record every spawnSync argv. Canned-success for fetch / worktree-add /
    // rev-parse (and anything else git runs); `git worktree add` does NOT
    // actually create the dir here, which is fine — we only assert on argv.
    const spawnCalls: Array<[string, string[]]> = [];
    const spawnSpy = spyOn(childRegistry, "spawnSync").mockImplementation(((
      cmd: string,
      args: readonly string[],
    ) => {
      spawnCalls.push([cmd, [...args]]);
      return ok();
    }) as typeof childRegistry.spawnSync);

    let result: ReleaseQueueRecord;
    try {
      result = await processReleaseQueueRecord(item, {
        queueDir,
        roles: DEFAULT_ROLE_CONFIGS,
        allowlistPrefixes: TMP_ALLOWLIST,
        heartbeatIntervalMs: 60_000,
        log: () => {},
        verifyQueued: () => ({ ok: true }),
        // Drive to "landed": land stub exits 0 and GitHub agrees it merged.
        verifyMerged: () => ({ merged: true }),
        acquireLock: () => ({
          acquired: true,
          handle: {
            ref: "refs/gstack/release-locks/d4/main",
            ownerId: "owner",
            commit: "c",
            repoPath: repo,
            repoIdentity: "github.com/acme/d4",
            baseBranch: "main",
          },
        }),
        refreshLock: () => ({
          ok: true,
          handle: {
            ref: "refs/gstack/release-locks/d4/main",
            ownerId: "owner",
            commit: "c",
            repoPath: repo,
            repoIdentity: "github.com/acme/d4",
            baseBranch: "main",
          },
        }),
        releaseLock: () => ({ ok: true }),
        land: async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        }),
      });
    } finally {
      spawnSpy.mockRestore();
      // Belt-and-suspenders: drop any scratch dir a real fix might create.
      fs.rmSync(expectedScratch, { recursive: true, force: true });
    }

    // The record reached "landed" through the scratch fallback path...
    expect(result.status).toBe("landed");

    // ...and the scratch worktree-add was issued targeting the scratch path,
    // confirming the fallback branch (not the existing-worktree branch) fired.
    const addCalls = spawnCalls.filter(
      ([cmd, args]) =>
        cmd === "git" &&
        args[0] === "worktree" &&
        args[1] === "add" &&
        args.includes(expectedScratch),
    );
    expect(addCalls.length).toBeGreaterThan(0);

    // DESIRED (currently failing): the daemon reaps the scratch worktree
    // after landing. Accept either an explicit `git worktree remove <scratch>`
    // or a `git worktree prune` issued in the repo after the run. Today there
    // is NO such call -> this expectation fails -> spec stays committed as
    // describe.skip until the reaper lands.
    const reapCalls = spawnCalls.filter(([cmd, args]) => {
      if (cmd !== "git" || args[0] !== "worktree") return false;
      if (args[1] === "remove" && args.includes(expectedScratch)) return true;
      if (args[1] === "prune") return true;
      return false;
    });
    expect(reapCalls.length).toBeGreaterThan(0);
  });
});
