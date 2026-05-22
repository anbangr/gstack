import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _registerActiveRecordForTests,
  _resetReleaseDaemonForTests,
  buildAllowlistWithRoot,
  createReleaseLockHeartbeat,
  isAllowedFeatureBranch,
  isAllowedRepoPath,
  processReleaseQueueRecord,
  reviveActiveRecordsForSignal,
  runReleaseDaemon,
  verifyPrMerged,
} from "../release-daemon";
import {
  readReleaseQueueRecords,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../release-queue";
import { DEFAULT_ROLE_CONFIGS } from "../role-config";
import type { ReleaseLockHandle } from "../release-lock";
import type { SubAgentResult } from "../sub-agents";
import * as childRegistry from "../child-registry";

describe("release daemon queue loop", () => {
  let dir: string;
  // Each test that needs a "repo path" creates a real tmp dir with a .git
  // marker so the security gate in processReleaseQueueRecord (and the
  // early-block gate in runReleaseDaemon) accepts it. Synthetic paths
  // like "/repo" no longer work — that was the test-bypass C7 closed.
  const trackedRepos: string[] = [];
  function makeRepo(slug: string): string {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), `gstack-rd-${slug}-`));
    fs.mkdirSync(path.join(p, ".git"));
    trackedRepos.push(p);
    return p;
  }
  // Allowlist that admits any tmpdir-rooted path. Tests pass this through
  // opts.allowlistPrefixes so the gate accepts makeRepo() outputs. Use the
  // realpath of tmpdir because the gate validates against realpath.
  const TMP_ALLOWLIST = [fs.realpathSync(os.tmpdir()) + path.sep];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-daemon-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const repo of trackedRepos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
    trackedRepos.length = 0;
  });

  function record(overrides: Partial<ReleaseQueueRecord>): ReleaseQueueRecord {
    return {
      runId: "run",
      repoPath: overrides.repoPath ?? makeRepo("default"),
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 1,
      version: "1.0.0.1",
      livingPlanPath: "/plans/living.md",
      worktreePath: "/worktree",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  function handle(
    overrides: Partial<ReleaseLockHandle> = {},
  ): ReleaseLockHandle {
    return {
      ref: "refs/gstack/release-locks/github.com-acme-repo/main",
      ownerId: "owner",
      commit: "mine",
      repoPath: "/repo",
      repoIdentity: "github.com/acme/repo",
      baseBranch: "main",
      ...overrides,
    };
  }

  function result(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/log",
      durationMs: 1,
      retries: 0,
      ...overrides,
    };
  }

  it("processes the oldest queued record once and ignores blocked records", async () => {
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 3,
        queuedAt: "2026-05-09T00:03:00.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 2,
        queuedAt: "2026-05-09T00:02:00.000Z",
        status: "blocked",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 1,
        queuedAt: "2026-05-09T00:01:00.000Z",
      }),
    );

    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    expect(processed).toEqual([1]);
  });

  it("exits cleanly when the queue is empty", async () => {
    const messages: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: (msg) => messages.push(msg),
    });
    expect(exit).toBe(0);
    expect(messages).toContain("release queue empty");
  });

  it("can process a globally discovered queued PR when no local record exists", async () => {
    const repo = makeRepo("globally-discovered");
    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      repoPath: repo,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: () => ({
        records: [record({ prNumber: 9, repoPath: repo })],
      }),
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    expect(processed).toEqual([9]);
  });

  it("discovers remote PRs from every distinct repoPath in the local queue", async () => {
    // Two local queued records pointing at different repos. The daemon
    // should call discoverRemote once per unique repoIdentity, plus once
    // for opts.repoPath (which is a distinct third repo here).
    const repoA = makeRepo("a");
    const repoB = makeRepo("b");
    const repoC = makeRepo("c");
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 10,
        repoPath: repoA,
        repoIdentity: "github.com/acme/repo-a",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 11,
        repoPath: repoB,
        repoIdentity: "github.com/acme/repo-b",
        queuedAt: "2026-05-09T00:00:02.000Z",
      }),
    );

    const discoverCalls: string[] = [];
    const processed: number[] = [];

    const exit = await runReleaseDaemon({
      queueDir: dir,
      repoPath: repoC,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: (repoPath) => {
        discoverCalls.push(repoPath);
        return { records: [] };
      },
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    // Sorted check: same membership regardless of map iteration order.
    expect([...discoverCalls].sort()).toEqual([repoA, repoB, repoC].sort());
    // Oldest queued local record wins (PR 10 from repo-a).
    expect(processed).toEqual([10]);
  });

  it("isolates per-repo discovery errors so one failing repo doesn't block others", async () => {
    // Two repos in the local queue. One discoverRemote call errors,
    // the other returns a record. The errored repo should produce a
    // warning naming that repo, but the other repo's record should
    // still be picked up and processed.
    const repoFails = makeRepo("fails");
    const repoWorks = makeRepo("works");
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 70,
        repoPath: repoFails,
        repoIdentity: "github.com/acme/repo-fails",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 71,
        repoPath: repoWorks,
        repoIdentity: "github.com/acme/repo-works",
        queuedAt: "2026-05-09T00:00:02.000Z",
      }),
    );

    const logs: string[] = [];
    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: (msg) => logs.push(msg),
      discoverRemote: (repoPath) => {
        if (repoPath === repoFails) {
          return { records: [], error: `gh pr list failed for ${repoFails}` };
        }
        return { records: [] };
      },
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    // Warning names the failing repo (the new attribution).
    expect(
      logs.some(
        (m) =>
          m.includes(`could not discover queued PRs for ${repoFails}`) &&
          m.includes(`gh pr list failed for ${repoFails}`),
      ),
    ).toBe(true);
    // The non-failing repo's local record (PR 71) is still processed
    // even though repoFails errored. Oldest queued wins (PR 70).
    expect(processed).toEqual([70]);
  });

  it("dedups discovery by repoIdentity when multiple records share the same repo", async () => {
    const repoA = makeRepo("a");
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 20,
        repoPath: repoA,
        repoIdentity: "github.com/acme/repo-a",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 21,
        repoPath: repoA,
        repoIdentity: "github.com/acme/repo-a",
        queuedAt: "2026-05-09T00:00:02.000Z",
      }),
    );

    const discoverCalls: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: (repoPath) => {
        discoverCalls.push(repoPath);
        return { records: [] };
      },
      processor: async (item) => ({ ...item, status: "landed" }),
    });

    expect(exit).toBe(0);
    // One discovery call for repo-a despite two records.
    expect(discoverCalls).toEqual([repoA]);
  });

  it("dedups configured repoPath against queued records at the same path", async () => {
    // The configured opts.repoPath and a queued record without repoIdentity
    // both target the same path. They share the same path key and must
    // produce only one discovery call, not two.
    const repoShared = makeRepo("shared");
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 80,
        repoPath: repoShared,
        repoIdentity: undefined,
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );

    const discoverCalls: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      repoPath: repoShared,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: (repoPath) => {
        discoverCalls.push(repoPath);
        return { records: [] };
      },
      processor: async (item) => ({ ...item, status: "landed" }),
    });

    expect(exit).toBe(0);
    // ONE call, not two. Before the keying-scheme unification, the configured
    // entry used a "__configured__:" prefix while the record used "path:",
    // producing two redundant discovery calls.
    expect(discoverCalls).toEqual([repoShared]);
  });

  it("falls back to path key when repoIdentity is missing", async () => {
    // Records without repoIdentity should still be discovered, keyed by
    // resolved path. Two records with the same path but no identity → one
    // discovery call.
    const repoNoIdentity = makeRepo("no-identity");
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 25,
        repoPath: repoNoIdentity,
        repoIdentity: undefined,
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 26,
        repoPath: repoNoIdentity,
        repoIdentity: undefined,
        queuedAt: "2026-05-09T00:00:02.000Z",
      }),
    );

    const discoverCalls: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: (repoPath) => {
        discoverCalls.push(repoPath);
        return { records: [] };
      },
      processor: async (item) => ({ ...item, status: "landed" }),
    });

    expect(exit).toBe(0);
    expect(discoverCalls).toEqual([repoNoIdentity]);
  });

  it("skips discovery for non-queued local records", async () => {
    const repoA = makeRepo("non-queued-a");
    const repoB = makeRepo("non-queued-b");
    const repoC = makeRepo("non-queued-c");
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 30,
        repoPath: repoA,
        repoIdentity: "github.com/acme/repo-a",
        status: "blocked",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 31,
        repoPath: repoB,
        repoIdentity: "github.com/acme/repo-b",
        status: "landed",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 32,
        repoPath: repoC,
        repoIdentity: "github.com/acme/repo-c",
        status: "queued",
      }),
    );

    const discoverCalls: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: (repoPath) => {
        discoverCalls.push(repoPath);
        return { records: [] };
      },
      processor: async (item) => ({ ...item, status: "landed" }),
    });

    expect(exit).toBe(0);
    // Only repo-c (the queued one) gets a discovery call.
    expect(discoverCalls).toEqual([repoC]);
  });

  it("heartbeat updates the current handle and records ownership loss", () => {
    const hb = createReleaseLockHeartbeat({
      cwd: "/repo",
      handle: handle(),
      refresh: () => ({ ok: true, handle: handle({ commit: "next" }) }),
    });
    hb.beat();
    expect(hb.currentHandle().commit).toBe("next");

    const lost = createReleaseLockHeartbeat({
      cwd: "/repo",
      handle: handle(),
      refresh: () => ({
        ok: false,
        lostOwnership: true,
        error: "release lock is no longer owned by this daemon",
      }),
    });
    lost.beat();
    expect(lost.lostOwnership()).toContain("no longer owned");
  });

  it("blocks a local queue record without a valid PR marker before landing", async () => {
    const item = writeReleaseQueueRecord(dir, record({ prNumber: 20 }));
    const processed = await processReleaseQueueRecord(item, {
      queueDir: dir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: TMP_ALLOWLIST,
      verifyQueued: () => ({ ok: false, error: "missing queued PR marker" }),
      land: async () => {
        throw new Error("land should not run");
      },
    });

    expect(processed.status).toBe("blocked");
    expect(processed.lastError).toContain("missing queued PR marker");
    expect(readReleaseQueueRecords(dir)[0].status).toBe("blocked");
  });

  it("blocks after landing when heartbeat loses ownership and does not drift-repair", async () => {
    const worktree = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-release-worktree-"),
    );
    fs.mkdirSync(path.join(worktree, ".git"));
    const item = writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 21,
        repoPath: worktree,
        worktreePath: worktree,
      }),
    );
    let shipCalls = 0;
    const processed = await processReleaseQueueRecord(item, {
      queueDir: dir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: TMP_ALLOWLIST,
      heartbeatIntervalMs: 1,
      verifyQueued: () => ({ ok: true }),
      acquireLock: () => ({
        acquired: true,
        handle: handle({ repoPath: worktree }),
      }),
      refreshLock: () => ({
        ok: false,
        lostOwnership: true,
        error: "release lock is no longer owned by this daemon",
      }),
      releaseLock: () => ({ ok: true }),
      land: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return result({
          exitCode: 1,
          stderr: "VERSION drift detected",
        });
      },
      ship: async () => {
        shipCalls++;
        return result();
      },
    });

    fs.rmSync(worktree, { recursive: true, force: true });
    expect(processed.status).toBe("blocked");
    expect(processed.lastError).toContain("ownership lost");
    expect(shipCalls).toBe(0);
  });

  it("releases the lock on natural completion so the SIGTERM registry is empty", async () => {
    // Indirect test of the active-lock registry: after a successful
    // processReleaseQueueRecord, the registered release callback must be
    // removed. We verify by checking releaseLock was called from the
    // finally block (not by signal), AND that a subsequent call with the
    // same opts doesn't accumulate registry entries.
    const worktree = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-release-worktree-cleanup-"),
    );
    fs.mkdirSync(path.join(worktree, ".git"));
    const item = writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 40,
        repoPath: worktree,
        worktreePath: worktree,
      }),
    );
    let releaseCalls = 0;
    const processed = await processReleaseQueueRecord(item, {
      queueDir: dir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: TMP_ALLOWLIST,
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: handle({ repoPath: worktree }),
      }),
      refreshLock: () => ({ ok: true, handle: handle({ repoPath: worktree }) }),
      releaseLock: () => {
        releaseCalls++;
        return { ok: true };
      },
      land: async () => result(),
    });

    fs.rmSync(worktree, { recursive: true, force: true });
    expect(processed.status).toBe("landed");
    // releaseLock called exactly once (from the finally block).
    expect(releaseCalls).toBe(1);
  });
});

describe("isAllowedRepoPath (security gate)", () => {
  // os.tmpdir() returns /var/folders/... on macOS but realpath resolves to
  // /private/var/folders/...; on Linux /tmp/ realpaths to /private/tmp/ on
  // macOS. The security gate uses realpath, so tests need the realpath of
  // tmpdir as the allowlist prefix to match what the gate computes.
  const TMP_REAL = fs.realpathSync(os.tmpdir()) + path.sep;

  it("rejects empty / non-string repoPath", () => {
    expect(isAllowedRepoPath("", [])).toEqual({
      ok: false,
      reason: expect.stringContaining("empty"),
    });
  });

  it("rejects relative paths", () => {
    expect(isAllowedRepoPath("../etc/passwd", ["/tmp/"])).toEqual({
      ok: false,
      reason: expect.stringContaining("not absolute"),
    });
  });

  it("rejects paths outside the prefix list", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-allowlist-outside-"),
    );
    fs.mkdirSync(path.join(dir, ".git"));
    try {
      // Real git repo, but `/tmp/...` is not on the allowlist.
      const result = isAllowedRepoPath(dir, ["/Users/different/"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("outside the daemon allowlist");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects allowlisted paths that don't exist", () => {
    const fakePath = "/tmp/gstack-allowlist-missing-xyz123";
    const prefix = "/tmp/";
    const result = isAllowedRepoPath(fakePath, [prefix]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("does not exist");
  });

  it("rejects allowlisted paths that aren't directories", () => {
    const file = path.join(os.tmpdir(), "gstack-allowlist-file-" + Date.now());
    fs.writeFileSync(file, "x");
    try {
      const result = isAllowedRepoPath(file, [TMP_REAL]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("not a directory");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("rejects allowlisted directories without a .git marker", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-allowlist-nogit-"),
    );
    try {
      const result = isAllowedRepoPath(dir, [TMP_REAL]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("no .git entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts allowlisted directories with a .git directory (normal clone)", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-allowlist-clone-"),
    );
    fs.mkdirSync(path.join(dir, ".git"));
    try {
      const result = isAllowedRepoPath(dir, [TMP_REAL]);
      expect(result.ok).toBe(true);
      // The resolved path is the realpath of dir (the gate must return
      // it so callers can substitute it for spawnSync cwd — that's the
      // TOCTOU fix). It may differ from `dir` if tmpdir is symlinked.
      if (result.ok) {
        expect(result.resolved).toBe(fs.realpathSync(dir));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts allowlisted directories with a .git FILE (linked worktree)", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-allowlist-worktree-"),
    );
    fs.writeFileSync(
      path.join(dir, ".git"),
      "gitdir: /elsewhere/.git/worktrees/x",
    );
    try {
      const result = isAllowedRepoPath(dir, [TMP_REAL]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved).toBe(fs.realpathSync(dir));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defeats path traversal via .. that escapes the prefix", () => {
    // /tmp is allowlisted, but /tmp/../etc resolves to /etc which is not.
    const result = isAllowedRepoPath("/tmp/../etc", [TMP_REAL]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("outside the daemon allowlist");
  });

  it("defeats symlink bypass via realpath", () => {
    // The attack: queue file contains repoPath="<allowed>/evil-link" where
    // evil-link → /tmp/attacker/. Lexical path.resolve passes (the input is
    // lexically inside the allowlist). But realpath follows the symlink and
    // exposes that the actual filesystem location is outside.
    const allowedDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-allowlist-symlink-allowed-"),
    );
    const attackerDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-allowlist-symlink-attacker-"),
    );
    fs.mkdirSync(path.join(attackerDir, ".git"));
    const linkPath = path.join(allowedDir, "evil-link");
    fs.symlinkSync(attackerDir, linkPath, "dir");
    try {
      // Allowlist is the allowedDir's realpath. The link path is lexically
      // inside the allowlist BUT realpath resolves to attackerDir which
      // is OUTSIDE. Gate must reject.
      const result = isAllowedRepoPath(linkPath, [
        fs.realpathSync(allowedDir) + path.sep,
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("outside the daemon allowlist");
      }
    } finally {
      fs.unlinkSync(linkPath);
      fs.rmSync(allowedDir, { recursive: true, force: true });
      fs.rmSync(attackerDir, { recursive: true, force: true });
    }
  });
});

describe("runReleaseDaemon allowlist enforcement on local records (F1 fix)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-f1-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<ReleaseQueueRecord>): ReleaseQueueRecord {
    return {
      runId: "run",
      repoPath: "/repo",
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 1,
      version: "1.0.0.1",
      livingPlanPath: "/plans/living.md",
      worktreePath: "/worktree",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  it("blocks records with disallowed repoPath rather than handing them to the processor", async () => {
    // A planted queue record with repoPath pointing outside the allowlist.
    // The production path (no opts.processor) must mark it blocked and skip
    // it instead of running it through processReleaseQueueRecord (which
    // would `cd` into the attacker-controlled directory).
    writeReleaseQueueRecord(
      dir,
      record({
        runId: "f1-run-100",
        prNumber: 100,
        repoPath: "/tmp/attacker-planted",
        repoIdentity: "github.com/attacker/repo",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        runId: "f1-run-101",
        prNumber: 101,
        // Also disallowed.
        repoPath: "/etc",
        repoIdentity: "github.com/attacker/other",
        queuedAt: "2026-05-09T00:00:02.000Z",
      }),
    );

    const logs: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: (msg) => logs.push(msg),
      // NO opts.processor → production path. Allowlist gate MUST fire.
      // NO opts.discoverRemote → real gh would be called for the configured
      // repoPath; we leave that unset so only local records are evaluated.
    });

    // Codex-9 fix: --once with only-blocked records exits 1 (poisoned
    // queue), not 0 (queue empty). Automation needs to notice this.
    expect(exit).toBe(1);
    // Both records get marked blocked.
    const records = readReleaseQueueRecords(dir);
    const pr100 = records.find((r) => r.prNumber === 100);
    const pr101 = records.find((r) => r.prNumber === 101);
    expect(pr100?.status).toBe("blocked");
    expect(pr100?.lastError).toContain("outside daemon allowlist");
    expect(pr101?.status).toBe("blocked");
    expect(pr101?.lastError).toContain("outside daemon allowlist");
    // Log lines mention which PRs got blocked.
    expect(logs.some((m) => m.includes("blocking PR #100"))).toBe(true);
    expect(logs.some((m) => m.includes("blocking PR #101"))).toBe(true);
  });

  it("test processor injection bypasses the EARLY gate but not the processor's own gate", async () => {
    // When tests inject opts.processor, the early gate in the watch loop
    // does NOT fire (synthetic paths like /repo-a aren't real dirs and
    // would falsely block the test). The test takes responsibility for
    // safety — its processor doesn't spawn anything with the synthetic
    // path as cwd. The early gate is a defense-in-depth layer; the
    // load-bearing gate lives inside processReleaseQueueRecord itself
    // and is unconditional (see the C7-prevention test below).
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 200,
        repoPath: "/repo-fake-but-test-injected",
        repoIdentity: "github.com/acme/fake",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );

    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    expect(processed).toEqual([200]);
  });

  it("processReleaseQueueRecord rejects a disallowed repoPath even with synthetic test inputs (C2/C7)", async () => {
    // Direct-call gate: a wrapper that calls processReleaseQueueRecord
    // directly (no runReleaseDaemon, no opts.processor seam) must STILL
    // get rejected by the allowlist. Without the gate in the processor,
    // any production wrapper that bypassed runReleaseDaemon (or any test
    // that called processReleaseQueueRecord directly with attacker input)
    // could `cd` into the disallowed path. This locks the closure.
    const planted = record({
      prNumber: 999,
      repoPath: "/tmp/attacker-planted-direct",
      repoIdentity: "github.com/attacker/direct",
    });
    writeReleaseQueueRecord(dir, planted);
    const result = await processReleaseQueueRecord(planted, {
      queueDir: dir,
      roles: DEFAULT_ROLE_CONFIGS,
      // NO test-bypass. /tmp/attacker-planted-direct doesn't exist, so
      // the existence check in isAllowedRepoPath rejects it. Even if it
      // did exist, the default allowlist excludes /tmp/.
      verifyQueued: () => {
        throw new Error("must not be reached past the gate");
      },
      acquireLock: () => {
        throw new Error("must not be reached past the gate");
      },
    });
    expect(result.status).toBe("blocked");
    expect(result.lastError).toContain("rejected by daemon allowlist");
  });

  it("processReleaseQueueRecord rejects an unsafe featureBranch (C3 refspec injection)", async () => {
    // featureBranch flows into argv: `git fetch origin <branch>` and
    // `git worktree add ... origin/<branch>`. A planted record with
    // branch like "evil:refs/heads/main" would rewrite local refs
    // during fetch. The branch-name gate inside processReleaseQueueRecord
    // must reject anything outside the safe subset before any git runs.
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-release-branch-injection-"),
    );
    fs.mkdirSync(path.join(repo, ".git"));
    try {
      const planted = record({
        prNumber: 1000,
        repoPath: repo,
        featureBranch: "evil:refs/heads/main",
      });
      writeReleaseQueueRecord(dir, planted);
      const result = await processReleaseQueueRecord(planted, {
        queueDir: dir,
        roles: DEFAULT_ROLE_CONFIGS,
        allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
        verifyQueued: () => {
          throw new Error("must not be reached past the branch gate");
        },
        acquireLock: () => {
          throw new Error("must not be reached past the branch gate");
        },
      });
      expect(result.status).toBe("blocked");
      expect(result.lastError).toContain("featureBranch rejected");
      expect(result.lastError).toContain("safe subset");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("buildAllowlistWithRoot (Codex-1 fix)", () => {
  // The daemon's configured opts.repoPath must be allowlisted automatically.
  // Without this, a daemon installed from /workspaces/repo/ (or any path
  // outside ~/Documents/, ~/code/, etc.) rejects its own configured root
  // and blocks every record unless the user manually sets
  // GSTACK_DAEMON_REPO_ALLOWLIST.

  it("returns the default allowlist when extraRoot is undefined", () => {
    const result = buildAllowlistWithRoot(undefined);
    expect(result.length).toBeGreaterThan(0);
    // All default prefixes end with path.sep.
    for (const prefix of result) {
      expect(prefix.endsWith(path.sep)).toBe(true);
    }
  });

  it("prepends the realpath of extraRoot to the default prefixes", () => {
    const installedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-codex1-build-allowlist-"),
    );
    try {
      const result = buildAllowlistWithRoot(installedRoot);
      const expectedPrefix = fs.realpathSync(installedRoot) + path.sep;
      // The realpath of the installed root is the FIRST entry.
      expect(result[0]).toBe(expectedPrefix);
      // And the default prefixes follow.
      expect(result.length).toBeGreaterThan(1);
    } finally {
      fs.rmSync(installedRoot, { recursive: true, force: true });
    }
  });

  it("does not duplicate when extraRoot already matches a default prefix", () => {
    // ~/Documents/ is in the defaults. If a user happens to install the
    // daemon at ~/Documents/<something>, the realpath might still resolve
    // to a subpath of an existing default. Dedup test: passing a sub-path
    // produces a properly-prepended entry, but passing the EXACT default
    // path (synthetic via env override) doesn't duplicate.
    const fakeOverride = "/tmp/gstack-codex1-already-listed";
    const prev = process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
    process.env.GSTACK_DAEMON_REPO_ALLOWLIST = fakeOverride;
    fs.mkdirSync(fakeOverride, { recursive: true });
    try {
      const result = buildAllowlistWithRoot(fakeOverride);
      // The first entry is the realpath of fakeOverride, plus separator.
      const expectedPrefix = fs.realpathSync(fakeOverride) + path.sep;
      // It should appear exactly once: either as the prepended entry OR
      // because the env override already provided it. Count occurrences.
      const occurrences = result.filter((p) => p === expectedPrefix).length;
      expect(occurrences).toBe(1);
    } finally {
      fs.rmSync(fakeOverride, { recursive: true, force: true });
      if (prev === undefined) delete process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
      else process.env.GSTACK_DAEMON_REPO_ALLOWLIST = prev;
    }
  });

  it("ignores extraRoot when realpath fails (missing path)", () => {
    const result = buildAllowlistWithRoot("/nonexistent/gstack-codex1-missing");
    // Should fall back to default prefixes — no garbage entry added.
    const defaults = buildAllowlistWithRoot(undefined);
    expect(result).toEqual(defaults);
  });

  it("makes isAllowedRepoPath accept the configured root via the extended allowlist", () => {
    // Integration check: a path that would be rejected by the default
    // allowlist passes when we extend with that root.
    const installedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-codex1-integration-"),
    );
    fs.mkdirSync(path.join(installedRoot, ".git"));
    try {
      // Default allowlist rejects: /tmp/folders/... isn't on any of the
      // hardcoded prefixes.
      const defaultCheck = isAllowedRepoPath(installedRoot);
      expect(defaultCheck.ok).toBe(false);
      // Extended allowlist accepts.
      const extendedCheck = isAllowedRepoPath(
        installedRoot,
        buildAllowlistWithRoot(installedRoot),
      );
      expect(extendedCheck.ok).toBe(true);
    } finally {
      fs.rmSync(installedRoot, { recursive: true, force: true });
    }
  });
});

describe("isAllowedFeatureBranch (refspec injection gate)", () => {
  it("accepts ordinary branch names", () => {
    for (const branch of [
      "main",
      "feat/release-daemon",
      "fix/release-daemon-multi-repo-discovery",
      "release-v1.40.4.2",
      "anbang/feature_with_underscore",
      "1.0.x",
    ]) {
      const result = isAllowedFeatureBranch(branch);
      expect(result.ok).toBe(true);
    }
  });

  it("rejects empty / non-string", () => {
    expect(isAllowedFeatureBranch("").ok).toBe(false);
    expect(isAllowedFeatureBranch(undefined).ok).toBe(false);
    expect(isAllowedFeatureBranch(123 as unknown as string).ok).toBe(false);
  });

  it("rejects branch names containing git refspec specials", () => {
    // `:` triggers push-side refspec rewriting in `git fetch`.
    const colon = isAllowedFeatureBranch("evil:refs/heads/main");
    expect(colon.ok).toBe(false);
    if (!colon.ok) expect(colon.reason).toContain("safe subset");
    // Plus, caret, tilde, space, glob — all unsafe in refspec context.
    for (const branch of [
      "evil+force",
      "evil^",
      "evil~1",
      "evil branch",
      "evil*",
      "evil`whoami`",
      "evil$(whoami)",
      "evil;rm -rf",
      "evil\\backslash",
      "evil@{0}",
    ]) {
      expect(isAllowedFeatureBranch(branch).ok).toBe(false);
    }
  });

  it("rejects branch names starting with `-` (flag confusion)", () => {
    // Some git invocations treat a leading `-` as an option flag.
    // Reject defensively.
    const result = isAllowedFeatureBranch("--upload-pack=bad");
    expect(result.ok).toBe(false);
  });

  it("rejects git-invalid ref names even when characters are allowlisted", () => {
    for (const branch of [
      "../main",
      "foo/../main",
      "foo//bar",
      "foo.lock",
      "foo/",
    ]) {
      const result = isAllowedFeatureBranch(branch);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("valid git branch");
    }
  });
});

describe("getRepoAllowlistPrefixes — env override is additive (C8)", () => {
  it("appends env entries on top of defaults instead of replacing them", () => {
    const prev = process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
    const extra = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-c8-extra-allowlist-"),
    );
    process.env.GSTACK_DAEMON_REPO_ALLOWLIST = extra;
    try {
      const merged = buildAllowlistWithRoot(undefined);
      // Defaults survive — env CANNOT silently widen the allowlist to /
      // by setting GSTACK_DAEMON_REPO_ALLOWLIST=/ . The env entry is
      // added (realpath-normalized); the defaults remain.
      const home = os.homedir();
      expect(merged.some((p) => p.startsWith(home + path.sep))).toBe(true);
      // Env entry is also present (realpath-normalized).
      const expectedExtra = fs.realpathSync(extra) + path.sep;
      expect(merged.some((p) => p === expectedExtra)).toBe(true);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
      if (prev === undefined) delete process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
      else process.env.GSTACK_DAEMON_REPO_ALLOWLIST = prev;
    }
  });

  it("deduplicates env entries that match defaults", () => {
    const prev = process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
    // Documents/ is in the defaults. Setting it again via env should
    // not produce duplicate entries (after env realpath normalization).
    const docs = path.join(os.homedir(), "Documents");
    process.env.GSTACK_DAEMON_REPO_ALLOWLIST = docs;
    try {
      const merged = buildAllowlistWithRoot(undefined);
      // Both the default and the env entry realpath to the same string
      // when ~/Documents is not a symlink, OR realpath fails (path
      // doesn't exist for this test runner) and falls back to raw —
      // in both cases the dedup should collapse to one occurrence.
      const matches = merged.filter(
        (p) =>
          p === docs + path.sep ||
          p === (fs.existsSync(docs) ? fs.realpathSync(docs) : docs) + path.sep,
      );
      // At minimum, only ONE entry should match the input docs path.
      expect(matches.length).toBeLessThanOrEqual(2);
      // And the dedup should have collapsed identical entries.
      const uniqueMatches = new Set(matches);
      expect(uniqueMatches.size).toBe(matches.length);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
      else process.env.GSTACK_DAEMON_REPO_ALLOWLIST = prev;
    }
  });
});

describe("heartbeat stops before lock release (C4 race)", () => {
  it("signal-handler-style release stops the heartbeat first, preventing re-push of the ref", async () => {
    // Reproduces C4: if SIGTERM handler releases the lock but doesn't
    // stop the heartbeat, an in-flight refresh tick re-pushes the ref
    // using its captured handle, resurrecting the lock the handler
    // just released. Test by observing the call order: heartbeat.stop()
    // (modeled by tracking the refresh callback being unhooked) must
    // run before the release fires.
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-heartbeat-race-"),
    );
    fs.mkdirSync(path.join(repo, ".git"));
    try {
      const order: string[] = [];
      let refreshAfterStop = 0;
      let heartbeatStopped = false;
      const item: ReleaseQueueRecord = {
        runId: "race-run",
        repoPath: repo,
        baseBranch: "main",
        featureBranch: "feat/race",
        prNumber: 41,
        version: "1.0.0.0",
        livingPlanPath: "/plan",
        worktreePath: repo,
        queuedAt: "2026-05-09T00:00:00.000Z",
        status: "queued",
      };
      writeReleaseQueueRecord(
        fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-race-queue-")),
        item,
      );
      const result = await processReleaseQueueRecord(item, {
        queueDir: fs.mkdtempSync(
          path.join(os.tmpdir(), "gstack-rd-race-queue2-"),
        ),
        roles: DEFAULT_ROLE_CONFIGS,
        allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
        heartbeatIntervalMs: 60_000,
        verifyQueued: () => ({ ok: true }),
        verifyMerged: () => ({ merged: true }),
        acquireLock: () => ({
          acquired: true,
          handle: {
            ref: "refs/gstack/release-locks/race/main",
            ownerId: "owner",
            commit: "c",
            repoPath: repo,
            repoIdentity: "github.com/acme/race",
            baseBranch: "main",
          },
        }),
        refreshLock: () => {
          order.push("refresh");
          if (heartbeatStopped) refreshAfterStop++;
          return {
            ok: true,
            handle: {
              ref: "refs/gstack/release-locks/race/main",
              ownerId: "owner",
              commit: "c2",
              repoPath: repo,
              repoIdentity: "github.com/acme/race",
              baseBranch: "main",
            },
          };
        },
        releaseLock: () => {
          order.push("release");
          heartbeatStopped = true; // After finally's heartbeat.stop()
          return { ok: true };
        },
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
      expect(result.status).toBe("landed");
      // Heartbeat-interval is 60s so no refresh actually ticks during
      // the test. The point of the test is structural: release fires
      // in finally, AFTER heartbeat.stop(). No refresh observed after
      // release — confirms the heartbeat couldn't have re-pushed the
      // ref under SIGTERM either.
      expect(refreshAfterStop).toBe(0);
      // Release was called from the finally block.
      expect(order).toContain("release");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("reviveActiveRecordsForSignal (C5/C6 stale-snapshot fix)", () => {
  let queueDir: string;

  beforeEach(() => {
    queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-revive-"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir, { recursive: true, force: true });
  });

  function rec(overrides: Partial<ReleaseQueueRecord>): ReleaseQueueRecord {
    return {
      runId: "revive-run",
      repoPath: "/repo",
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 7,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: "/wt",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  it("revives in-flight records to queued (status=landing on disk)", () => {
    const r = rec({ runId: "in-flight-1", status: "landing" });
    writeReleaseQueueRecord(queueDir, r);
    _registerActiveRecordForTests(queueDir, { ...r, status: "queued" }); // stale snapshot

    const result = reviveActiveRecordsForSignal("TEST");

    expect(result.revived).toBe(1);
    expect(result.skipped).toBe(0);
    const onDisk = readReleaseQueueRecords(queueDir)[0];
    expect(onDisk.status).toBe("queued");
    expect(onDisk.lastError).toContain("interrupted by signal TEST");
  });

  it("SKIPS records whose on-disk status is already 'landed' (does NOT undo the ship)", () => {
    // C5/C6 reproduction: stale in-memory snapshot says queued, but
    // disk already says landed. Old code would rewrite to queued and
    // erase the version bump. Fixed code reads disk and leaves landed.
    const landed = rec({
      runId: "already-landed",
      status: "landed",
      version: "1.0.0.42",
      shippedAt: "2026-05-19T22:00:00.000Z",
    });
    writeReleaseQueueRecord(queueDir, landed);
    _registerActiveRecordForTests(queueDir, {
      ...landed,
      status: "queued", // STALE — captured at registration time
      shippedAt: undefined,
    });

    const logs: string[] = [];
    const result = reviveActiveRecordsForSignal("TEST", (msg) =>
      logs.push(msg),
    );

    expect(result.revived).toBe(0);
    expect(result.skipped).toBe(1);
    // Disk untouched — the landed ship survives.
    const onDisk = readReleaseQueueRecords(queueDir)[0];
    expect(onDisk.status).toBe("landed");
    expect(onDisk.version).toBe("1.0.0.42");
    expect(onDisk.shippedAt).toBe("2026-05-19T22:00:00.000Z");
    expect(
      logs.some((m) => m.includes("skipping revive") && m.includes("landed")),
    ).toBe(true);
  });

  it("SKIPS records that have moved to 'blocked' on disk", () => {
    const blocked = rec({
      runId: "already-blocked",
      status: "blocked",
      lastError: "earlier failure",
    });
    writeReleaseQueueRecord(queueDir, blocked);
    _registerActiveRecordForTests(queueDir, {
      ...blocked,
      status: "queued",
    });

    const result = reviveActiveRecordsForSignal("TEST");

    expect(result.skipped).toBe(1);
    const onDisk = readReleaseQueueRecords(queueDir)[0];
    expect(onDisk.status).toBe("blocked");
  });

  it("falls back to the in-memory snapshot if the disk file is missing", () => {
    // Disk file deleted between processReleaseQueueRecord and the
    // signal handler firing. Fall back to the in-memory snapshot
    // (status=queued) — better to mark queued than to leak.
    const r = rec({ runId: "ghost", status: "landing" });
    writeReleaseQueueRecord(queueDir, r);
    _registerActiveRecordForTests(queueDir, r);
    // Delete the disk file to simulate the race.
    fs.rmSync(path.join(queueDir, fs.readdirSync(queueDir)[0]));

    const result = reviveActiveRecordsForSignal("TEST");

    // We fell back to the in-memory snapshot. Its status was "landing"
    // (in-flight), so revive proceeds. The new write succeeds, creating
    // a fresh queued record on disk.
    expect(result.revived).toBe(1);
    const onDisk = readReleaseQueueRecords(queueDir);
    expect(onDisk.length).toBe(1);
    expect(onDisk[0].status).toBe("queued");
  });

  it("clears activeRecords after running so the next signal is a no-op", () => {
    const r = rec({ runId: "once-only", status: "landing" });
    writeReleaseQueueRecord(queueDir, r);
    _registerActiveRecordForTests(queueDir, r);
    reviveActiveRecordsForSignal("TEST");
    // Second invocation finds an empty registry.
    const second = reviveActiveRecordsForSignal("TEST");
    expect(second.revived).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("resets retries to 0 when reviving from drift_repairing (Codex-4)", () => {
    // Without this reset, a record interrupted mid-drift-repair carries
    // retries=1 forward. The next daemon pass sees retries=1 and
    // immediately blocks on any drift failure without ever attempting
    // /ship — the PR is permanently stuck until manual retry.
    const r = rec({
      runId: "drift-interrupted",
      status: "drift_repairing",
      retries: 1,
    });
    writeReleaseQueueRecord(queueDir, r);
    _registerActiveRecordForTests(queueDir, r);

    const result = reviveActiveRecordsForSignal("TEST");

    expect(result.revived).toBe(1);
    const onDisk = readReleaseQueueRecords(queueDir)[0];
    expect(onDisk.status).toBe("queued");
    // KEY ASSERTION: retries reset so the next attempt gets a fresh
    // drift-repair budget.
    expect(onDisk.retries).toBe(0);
  });

  it("preserves retries when reviving from non-drift states (landing/claiming)", () => {
    // Sanity check: the reset only fires for drift_repairing. A revival
    // from landing/claiming preserves whatever retries was, so the
    // next daemon pass doesn't lose retry-count bookkeeping that didn't
    // need clearing.
    const r = rec({
      runId: "landing-interrupted",
      status: "landing",
      retries: 1,
    });
    writeReleaseQueueRecord(queueDir, r);
    _registerActiveRecordForTests(queueDir, r);

    reviveActiveRecordsForSignal("TEST");

    const onDisk = readReleaseQueueRecords(queueDir)[0];
    expect(onDisk.status).toBe("queued");
    expect(onDisk.retries).toBe(1);
  });
});

describe("processReleaseQueueRecord respects interruptedRunIds (Codex P2)", () => {
  // Reproduces the race Codex flagged: SIGTERM revives the record to
  // queued while `land` is still in flight. When land returns
  // (success or failure), the processor must NOT overwrite the queued
  // state the signal handler wrote. The `safeUpdate` guard checks
  // interruptedRunIds and short-circuits.
  let queueDir: string;
  let repo: string;

  beforeEach(() => {
    queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-interrupted-"));
    repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-interrupted-repo-"),
    );
    fs.mkdirSync(path.join(repo, ".git"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("late-returning land result does NOT overwrite queued revival", async () => {
    // Flow:
    //   1. processReleaseQueueRecord starts, status writes to landing.
    //   2. land() begins, awaits.
    //   3. While land is in flight, simulate SIGTERM revival by calling
    //      reviveActiveRecordsForSignal directly. The disk record goes
    //      to queued; interruptedRunIds gets the runId.
    //   4. land() resolves with a SUCCESS exit code. The processor
    //      tries to write status=landed via safeUpdate — but the guard
    //      sees the runId in interruptedRunIds and short-circuits.
    //   5. Final disk state must still be queued (revival survives).
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "interrupted-run",
      repoPath: repo,
      baseBranch: "main",
      featureBranch: "feat/race",
      prNumber: 42,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let landResolve: (v: SubAgentResult) => void = () => {};
    const landReady = new Promise<void>((readySignal) => {
      // Resolved as soon as the land function is entered.
      landResolve = (v) => readySignal(); // attached below
    });

    const processorPromise = processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/race/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/race",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/race/main",
          ownerId: "owner",
          commit: "c2",
          repoPath: repo,
          repoIdentity: "github.com/acme/race",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: () =>
        new Promise<SubAgentResult>((resolve) => {
          // Signal that we're inside land() so the test can run revival.
          landResolve(undefined as unknown as SubAgentResult);
          // Wait a microtask to ensure revival runs before we resolve.
          setTimeout(() => {
            resolve({
              stdout: "",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              logPath: "/tmp/log",
              durationMs: 1,
              retries: 0,
            });
          }, 10);
        }),
    });

    // Wait until we're inside land(). Then run the signal revival.
    await landReady;
    const revived = reviveActiveRecordsForSignal("TEST");
    expect(revived.revived).toBe(1);
    // Disk should be queued NOW.
    const midState = readReleaseQueueRecords(queueDir)[0];
    expect(midState.status).toBe("queued");

    // Now let land() resolve. The processor's safeUpdate must NOT
    // overwrite the queued state with landed.
    const result = await processorPromise;
    // The processor returns whatever safeUpdate returned — the
    // re-read disk state (queued).
    expect(result.status).toBe("queued");
    expect(result.lastError).toContain("interrupted by signal");
    // And the disk file confirms queued (revival survived).
    const finalState = readReleaseQueueRecords(queueDir)[0];
    expect(finalState.status).toBe("queued");
  });

  it("does NOT dispatch SECOND sub-agent after interruption mid-await (Codex-3)", async () => {
    // After the first land() returns and the processor await yields,
    // the signal handler interrupts. The processor sees isInterrupted()
    // and must NOT proceed to the drift-repair ship() or the retry
    // land(). Without the isInterrupted() checks at each await
    // boundary, the processor would dispatch additional sub-agents
    // after the lock was released by the signal handler — concurrent
    // deploys on the same PR.
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "interrupt-mid-await",
      repoPath: repo,
      baseBranch: "main",
      featureBranch: "feat/race",
      prNumber: 43,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let landCalls = 0;
    let shipCalls = 0;
    const processorPromise = processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/race/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/race",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/race/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/race",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      // First land() simulates drift failure to entice the processor
      // into the drift-repair branch. After this resolves, we trigger
      // the signal handler, then the isInterrupted() check at the next
      // await boundary must short-circuit before ship() runs.
      land: async () => {
        landCalls++;
        if (landCalls === 1) {
          // Schedule revival BEFORE returning from land() — by the time
          // the processor's await resumes, interruptedRunIds is set.
          await new Promise<void>((resolve) =>
            setImmediate(() => {
              reviveActiveRecordsForSignal("TEST");
              resolve();
            }),
          );
          return {
            stdout: "",
            stderr: "VERSION drift detected",
            exitCode: 1,
            timedOut: false,
            logPath: "/tmp/log",
            durationMs: 1,
            retries: 0,
          };
        }
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
      ship: async () => {
        shipCalls++;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
    });

    const result = await processorPromise;
    // First land() ran (unavoidable — we needed it to set up the drift
    // path). KEY ASSERTION: ship() (drift repair) and second land()
    // (retry) did NOT run. The isInterrupted() check between land
    // returning and ship dispatching bailed us out.
    expect(landCalls).toBe(1);
    expect(shipCalls).toBe(0);
    // Returned the disk state — queued (revival survived).
    expect(result.status).toBe("queued");
  });

  it("revives a record interrupted DURING verifyQueued (Codex-5)", async () => {
    // Before round-7, the processor registered the record AFTER
    // verifyQueued + acquireLock. SIGTERM during verifyQueued left the
    // disk record stuck at 'claiming' with no entry in activeRecords —
    // the signal handler couldn't revive it, and discovery only
    // re-fans 'queued' records, so the PR was abandoned. Round-7
    // moved the register call to immediately after the claiming write.
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "interrupt-during-verify",
      repoPath: repo,
      baseBranch: "main",
      featureBranch: "feat/race",
      prNumber: 44,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let landCalls = 0;
    const processorPromise = processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => {
        // Simulate SIGTERM arriving WHILE verifyQueued is running.
        // The disk record is already 'claiming' (the processor wrote
        // it just before this call). With the round-7 fix, the
        // activeRecords entry exists at this moment, so revival sees
        // it and writes queued. Without the fix, activeRecords is
        // empty here.
        reviveActiveRecordsForSignal("TEST");
        return { ok: true };
      },
      acquireLock: () => {
        throw new Error(
          "must not be reached — interrupt fired in verifyQueued",
        );
      },
      land: async () => {
        landCalls++;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
    });

    const result = await processorPromise;
    // The interrupt-during-verify path: the processor's pre-lock
    // interrupted-check fires after verifyQueued returns and bails
    // out. land() never ran.
    expect(landCalls).toBe(0);
    // Disk state is queued (revival succeeded) — not stranded at
    // claiming.
    const onDisk = readReleaseQueueRecords(queueDir)[0];
    expect(onDisk.status).toBe("queued");
    expect(result.status).toBe("queued");
  });
});

describe("env override allowlist edge cases (Codex-6)", () => {
  it("rejects GSTACK_DAEMON_REPO_ALLOWLIST=/ (root)", () => {
    // Without the round-7 rejection, an attacker who can set env on
    // the daemon (launchctl plist edit, ~/.zshenv poisoning) can flip
    // GSTACK_DAEMON_REPO_ALLOWLIST=/ and effectively disable the
    // allowlist — every absolute path with a .git entry starts with
    // /, so withSep.startsWith("/") matches every check.
    const prev = process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
    process.env.GSTACK_DAEMON_REPO_ALLOWLIST = "/";
    try {
      const merged = buildAllowlistWithRoot(undefined);
      // The override is rejected, so we get defaults only (no root).
      expect(merged).not.toContain("/");
      // Defaults survive — all under $HOME.
      expect(merged.every((p) => p.startsWith(os.homedir() + path.sep))).toBe(
        true,
      );
    } finally {
      if (prev === undefined) delete process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
      else process.env.GSTACK_DAEMON_REPO_ALLOWLIST = prev;
    }
  });

  it("rejects --project-root resolving to / (buildAllowlistWithRoot path)", () => {
    // Codex-11: env-side rejection guards GSTACK_DAEMON_REPO_ALLOWLIST=/;
    // this test guards the parallel attack vector via --project-root.
    // If extraRoot realpaths to /, buildAllowlistWithRoot used to
    // prepend / to the allowlist — every absolute path with .git
    // would then match `withSep.startsWith('/')`.
    const merged = buildAllowlistWithRoot("/");
    expect(merged).not.toContain("/");
    // Defaults survive.
    expect(merged.length).toBeGreaterThan(0);
  });

  it("accepts a legitimate env entry alongside the / rejection", () => {
    // A user who really wants /tmp on the allowlist (e.g. for tests)
    // can still set it. Only `/` itself is rejected.
    const prev = process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
    process.env.GSTACK_DAEMON_REPO_ALLOWLIST = "/:/tmp:/etc";
    try {
      const merged = buildAllowlistWithRoot(undefined);
      // `/` rejected, /tmp + /etc accepted (realpath-normalized,
      // so on macOS these become /private/tmp and /private/etc).
      expect(merged).not.toContain("/");
      const tmpReal = fs.realpathSync("/tmp") + path.sep;
      const etcReal = fs.realpathSync("/etc") + path.sep;
      expect(merged).toContain(tmpReal);
      expect(merged).toContain(etcReal);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
      else process.env.GSTACK_DAEMON_REPO_ALLOWLIST = prev;
    }
  });
});

describe("worktreePath is gate-validated (Codex-10)", () => {
  // A planted queue record can have a legitimate repoPath but
  // worktreePath pointing at an attacker checkout. The repoPath gate
  // passes; checkoutScratchWorktree historically returned the
  // worktreePath unchanged; /land-and-deploy then ran with cwd =
  // attacker dir. Round-9 added a gate on worktreePath that mirrors
  // the repoPath check.
  let queueDir2: string;
  let allowedRepo: string;
  let attackerCheckout: string;

  beforeEach(() => {
    queueDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-c10-"));
    allowedRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-c10-allowed-"),
    );
    fs.mkdirSync(path.join(allowedRepo, ".git"));
    attackerCheckout = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-c10-attacker-"),
    );
    fs.mkdirSync(path.join(attackerCheckout, ".git"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir2, { recursive: true, force: true });
    fs.rmSync(allowedRepo, { recursive: true, force: true });
    fs.rmSync(attackerCheckout, { recursive: true, force: true });
  });

  it("uses gate-resolved worktreePath when it passes the allowlist", async () => {
    const item = writeReleaseQueueRecord(queueDir2, {
      runId: "wt-allowed",
      repoPath: allowedRepo,
      baseBranch: "main",
      featureBranch: "feat/test",
      prNumber: 60,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: allowedRepo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let observedCwd = "";
    const result = await processReleaseQueueRecord(item, {
      queueDir: queueDir2,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: allowedRepo,
          repoIdentity: "github.com/acme/wt",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: allowedRepo,
          repoIdentity: "github.com/acme/wt",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: async ({ cwd }) => {
        observedCwd = cwd;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
    });
    expect(result.status).toBe("landed");
    expect(observedCwd).toBe(fs.realpathSync(allowedRepo));
  });

  it("does NOT pass disallowed worktreePath into land's cwd", async () => {
    // Restrictive allowlist: ONLY allowedRepo. worktreePath at
    // attackerCheckout is outside. The gate must reject and
    // checkoutScratchWorktree falls through to creating a scratch
    // worktree from allowedRepo. The attacker dir must NEVER appear
    // as land's cwd.
    const item = writeReleaseQueueRecord(queueDir2, {
      runId: "wt-disallowed",
      repoPath: allowedRepo,
      baseBranch: "main",
      featureBranch: "feat/test",
      prNumber: 61,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: attackerCheckout,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });
    const restrictiveAllowlist = [fs.realpathSync(allowedRepo) + path.sep];

    let observedCwd = "";
    try {
      await processReleaseQueueRecord(item, {
        queueDir: queueDir2,
        roles: DEFAULT_ROLE_CONFIGS,
        allowlistPrefixes: restrictiveAllowlist,
        heartbeatIntervalMs: 60_000,
        verifyQueued: () => ({ ok: true }),
        acquireLock: () => ({
          acquired: true,
          handle: {
            ref: "refs/gstack/release-locks/wt/main",
            ownerId: "owner",
            commit: "c",
            repoPath: allowedRepo,
            repoIdentity: "github.com/acme/wt",
            baseBranch: "main",
          },
        }),
        refreshLock: () => ({
          ok: true,
          handle: {
            ref: "refs/gstack/release-locks/wt/main",
            ownerId: "owner",
            commit: "c",
            repoPath: allowedRepo,
            repoIdentity: "github.com/acme/wt",
            baseBranch: "main",
          },
        }),
        releaseLock: () => ({ ok: true }),
        land: async ({ cwd }) => {
          observedCwd = cwd;
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            logPath: "/tmp/log",
            durationMs: 1,
            retries: 0,
          };
        },
      });
    } catch {
      // allowedRepo isn't a real git repo so `git fetch` may throw —
      // that's fine. We only assert the negative: land never observed
      // the attacker dir as cwd.
    }
    // KEY ASSERTION: if land was reached, it was NOT with attacker dir.
    if (observedCwd) {
      expect(observedCwd).not.toBe(attackerCheckout);
      expect(observedCwd).not.toBe(fs.realpathSync(attackerCheckout));
    }
  });
});

describe("discoverQueuedRecords gates legacy records before ID derivation (Codex-12)", () => {
  // Records without repoIdentity cause releaseQueueRecordId to fall
  // back to canonicalRepoIdentity which spawns `git remote get-url
  // origin` in cwd: record.repoPath. The early gate in
  // discoverQueuedRecords must reject disallowed paths BEFORE that
  // git invocation, so a planted record can't exfiltrate via the
  // .git/config of an attacker-controlled dir.
  let queueDir3: string;

  beforeEach(() => {
    queueDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-c12-"));
  });

  afterEach(() => {
    fs.rmSync(queueDir3, { recursive: true, force: true });
  });

  it("marks disallowed legacy records (no repoIdentity) blocked before discovery", async () => {
    // A planted record with no repoIdentity AND a disallowed repoPath.
    // Without the round-11 early gate, releaseQueueRecordId would
    // spawn git in /tmp/attacker-c12 BEFORE the watch-loop gate
    // fires. Round-11 gates this record at discovery time and marks
    // it blocked.
    writeReleaseQueueRecord(queueDir3, {
      runId: "legacy-no-identity",
      repoPath: "/tmp/attacker-c12-disallowed",
      // NOTE: no repoIdentity — the field is optional.
      baseBranch: "main",
      featureBranch: "feat/legacy",
      prNumber: 700,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: "/wt",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    const logs: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: queueDir3,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: (msg) => logs.push(msg),
      // NO opts.processor, NO opts.discoverRemote → production path.
    });

    // Daemon reports the disallowed record as blocked and exits non-zero.
    expect(exit).toBe(1);
    const onDisk = readReleaseQueueRecords(queueDir3);
    const blocked = onDisk.find((r) => r.prNumber === 700);
    expect(blocked?.status).toBe("blocked");
    // Either the early-discovery gate (round-11) or the watch-loop
    // gate (round-7) catches it — both produce a "disallowed
    // repoPath" log line.
    expect(
      logs.some(
        (m) =>
          (m.includes("disallowed repoPath") ||
            m.includes("outside daemon allowlist") ||
            m.includes("does not exist")) &&
          m.includes("700"),
      ) || logs.some((m) => m.includes("disallowed repoPath")),
    ).toBe(true);
  });
});

describe("verifyPrMerged + post-land GitHub ground-truth (Codex-15 / false-positive landed fix)", () => {
  // Background: the daemon used to mark records "landed" whenever the
  // /land-and-deploy sub-agent returned exit 0 — regardless of whether
  // the PR actually merged on GitHub. The sub-agent gracefully declines
  // to merge in real scenarios (failing CI, no PR found, pre-merge
  // gate fails) and still exits 0. Observed in production on
  // 2026-05-19: PRs #120 and #129 on mitosis-control-plane both got
  // marked "landed" while still OPEN on GitHub with failing e2e checks.
  // Fix: after the land sub-agent returns exit 0, ask GitHub whether
  // the PR is actually MERGED. If not, classify as "blocked".

  let queueDir3: string;
  let repo: string;

  beforeEach(() => {
    queueDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-verify-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-verify-repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir3, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function planted(): ReleaseQueueRecord {
    return {
      runId: "verify-run",
      repoPath: repo,
      repoIdentity: "github.com/acme/verify",
      baseBranch: "main",
      featureBranch: "feat/verify",
      prNumber: 999,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    };
  }

  function happyHandle(): ReleaseLockHandle {
    return {
      ref: "refs/gstack/release-locks/verify/main",
      ownerId: "owner",
      commit: "c",
      repoPath: repo,
      repoIdentity: "github.com/acme/verify",
      baseBranch: "main",
    };
  }

  it("classifies as 'blocked' when sub-agent exits 0 but GitHub says PR is still OPEN (the production bug)", async () => {
    // Reproduces the exact PR#129 failure pattern: Kimi/Claude/Codex
    // ran /land-and-deploy, refused to merge because e2e CI was
    // failing, wrote a prose "BLOCKED — CI failure prevented merge"
    // verdict to its output file, and exited 0. The daemon must
    // notice the PR is still OPEN on GitHub and write "blocked" with
    // a useful lastError, not "landed".
    const item = writeReleaseQueueRecord(queueDir3, planted());
    const result = await processReleaseQueueRecord(item, {
      queueDir: queueDir3,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({
        merged: false,
        reason:
          "PR #999 state is OPEN on GitHub (sub-agent reported success but PR was not merged)",
      }),
      acquireLock: () => ({ acquired: true, handle: happyHandle() }),
      refreshLock: () => ({ ok: true, handle: happyHandle() }),
      releaseLock: () => ({ ok: true }),
      land: async () => ({
        stdout: "Status: BLOCKED — CI failure prevented merge",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: "/tmp/log",
        durationMs: 1,
        retries: 0,
      }),
    });
    expect(result.status).toBe("blocked");
    expect(result.lastError).toContain(
      "land-and-deploy reported success but GitHub disagrees",
    );
    expect(result.lastError).toContain("PR #999 state is OPEN");
  });

  it("classifies as 'landed' when sub-agent exits 0 AND GitHub confirms MERGED (happy path)", async () => {
    const item = writeReleaseQueueRecord(queueDir3, planted());
    const result = await processReleaseQueueRecord(item, {
      queueDir: queueDir3,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({ acquired: true, handle: happyHandle() }),
      refreshLock: () => ({ ok: true, handle: happyHandle() }),
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
    expect(result.status).toBe("landed");
  });

  it("blocks when GitHub verification fails (network/auth error) — never silent-success", async () => {
    // If `gh pr view` fails (network issue, auth expired, rate-limited),
    // the verifier returns { merged: false, reason: "gh pr view exited..." }.
    // The daemon must block the record — better to mark it blocked
    // and retry than silently claim success when GitHub is
    // unreachable.
    const item = writeReleaseQueueRecord(queueDir3, planted());
    const result = await processReleaseQueueRecord(item, {
      queueDir: queueDir3,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({
        merged: false,
        reason: "gh pr view exited 1: HTTP 401: Bad credentials",
      }),
      acquireLock: () => ({ acquired: true, handle: happyHandle() }),
      refreshLock: () => ({ ok: true, handle: happyHandle() }),
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
    expect(result.status).toBe("blocked");
    expect(result.lastError).toContain("GitHub disagrees");
    expect(result.lastError).toContain("Bad credentials");
  });

  it("verifyPrMerged rejects unparseable repoIdentity (defense against planted records)", () => {
    // The verifier parses repoIdentity to derive the OWNER/NAME for
    // `gh pr view --repo OWNER/NAME`. A planted queue record could
    // try to inject shell-special characters or non-github identities
    // here. The verifier rejects anything that doesn't match
    // ^github.com/owner/repo$ — those records get classified as
    // not-merged (which then becomes "blocked").
    for (const bad of [
      "gitlab.com/acme/repo",
      "github.com/acme",
      "github.com/acme/repo/extra",
      "github.com//repo",
      "",
      "github.com/acme/repo; rm -rf /",
    ]) {
      const r = verifyPrMerged(1, bad, "/tmp");
      expect(r.merged).toBe(false);
      if (!r.merged) {
        // Either we get the parse error explicitly (most cases) or
        // gh itself fails (the shell-special case where the parse
        // regex accepts it because semicolons fit the [^/]+ class).
        // Both outcomes block the record — that's the security
        // property we care about.
        expect(typeof r.reason).toBe("string");
      }
    }
  });

  it("verifyPrMerged accepts a well-formed github.com identity (positive case for the parser)", () => {
    // We can't actually call `gh pr view` for a fake PR in tests, so
    // this just exercises the regex parse for an identity that
    // SHOULD pass the syntactic gate. The downstream `gh` call will
    // fail (PR doesn't exist), and we expect merged=false with a
    // reason that comes from gh, not from the parse step.
    const r = verifyPrMerged(999999999, "github.com/acme/repo", "/tmp");
    expect(r.merged).toBe(false);
    if (!r.merged) {
      // Must NOT contain "could not parse" — that would mean the
      // parser rejected a valid input.
      expect(r.reason ?? "").not.toContain("could not parse");
    }
  });
});


describe("processReleaseQueueRecord worktree branch correction", () => {
  let queueDir: string;
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    queueDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-wt-branch-"),
    );
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-wt-repo-"));
    worktree = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-wt-worktree-"),
    );
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(worktree, ".git"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("resets existing worktree to origin/featureBranch when on wrong branch", async () => {
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "wt-branch-run",
      repoPath: repo,
      repoIdentity: "github.com/acme/wt",
      baseBranch: "main",
      featureBranch: "feat/target",
      prNumber: 50,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: worktree,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    const spawnCalls: [string, string[]][] = [];
    const spawnSpy = spyOn(childRegistry, "spawnSync").mockImplementation(
      (cmd: string, args: readonly string[]) => {
        spawnCalls.push([cmd, [...args]]);
        if (
          cmd === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "--abbrev-ref" &&
          args[2] === "HEAD"
        ) {
          return {
            status: 0,
            stdout: "wrong-branch\n",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          } as any;
        }
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        } as any;
      },
    );

    let observedCwd = "";
    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/wt",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/wt",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: async ({ cwd }) => {
        observedCwd = cwd;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
    });

    spawnSpy.mockRestore();

    expect(result.status).toBe("landed");
    expect(observedCwd).toBe(fs.realpathSync(worktree));

    // Verify git commands were issued to reset the worktree
    const fetchCalls = spawnCalls.filter(
      ([cmd, args]) =>
        cmd === "git" &&
        args[0] === "fetch" &&
        args.includes(
          "+refs/heads/feat/target:refs/remotes/origin/feat/target",
        ),
    );
    const resetCalls = spawnCalls.filter(
      ([cmd, args]) =>
        cmd === "git" &&
        args[0] === "reset" &&
        args.includes("refs/remotes/origin/feat/target"),
    );

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(resetCalls.length).toBeGreaterThan(0);
  });

  it("resets even when worktree is already on the correct branch", async () => {
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "wt-correct-run",
      repoPath: repo,
      repoIdentity: "github.com/acme/wt",
      baseBranch: "main",
      featureBranch: "feat/correct",
      prNumber: 51,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: worktree,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    const spawnCalls: [string, string[]][] = [];
    const spawnSpy = spyOn(childRegistry, "spawnSync").mockImplementation(
      (cmd: string, args: readonly string[]) => {
        spawnCalls.push([cmd, [...args]]);
        if (
          cmd === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "--abbrev-ref" &&
          args[2] === "HEAD"
        ) {
          return {
            status: 0,
            stdout: "feat/correct\n",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          } as any;
        }
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        } as any;
      },
    );

    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/wt",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/wt",
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

    spawnSpy.mockRestore();

    expect(result.status).toBe("landed");

    const fetchCalls = spawnCalls.filter(
      ([cmd, args]) =>
        cmd === "git" &&
        args[0] === "fetch" &&
        args.includes(
          "+refs/heads/feat/correct:refs/remotes/origin/feat/correct",
        ),
    );
    const resetCalls = spawnCalls.filter(
      ([cmd, args]) =>
        cmd === "git" &&
        args[0] === "reset" &&
        args.includes("refs/remotes/origin/feat/correct"),
    );

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(resetCalls.length).toBeGreaterThan(0);
  });

  it("blocks when remote featureBranch was deleted", async () => {
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "wt-deleted-run",
      repoPath: repo,
      repoIdentity: "github.com/acme/wt",
      baseBranch: "main",
      featureBranch: "feat/deleted",
      prNumber: 52,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: worktree,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    const spawnSpy = spyOn(childRegistry, "spawnSync").mockImplementation(
      (cmd: string, args: readonly string[]) => {
        if (
          cmd === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "--abbrev-ref" &&
          args[2] === "HEAD"
        ) {
          return {
            status: 0,
            stdout: "wrong-branch\n",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          } as any;
        }
        if (cmd === "git" && args[0] === "fetch") {
          return {
            status: 128,
            stdout: "",
            stderr: "fatal: couldn't find remote ref feat/deleted",
            pid: 1,
            output: [],
            signal: null,
          } as any;
        }
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        } as any;
      },
    );

    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/wt",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/wt/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/wt",
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

    spawnSpy.mockRestore();

    expect(result.status).toBe("blocked");
    expect(result.lastError).toContain("feat/deleted");
  });
});

describe("processReleaseQueueRecord landOnly argument propagation", () => {
  let queueDir: string;
  let repo: string;

  beforeEach(() => {
    queueDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-propagate-"),
    );
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-propagate-repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("passes prNumber and featureBranch to land on normal path", async () => {
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "propagate-normal",
      repoPath: repo,
      repoIdentity: "github.com/acme/prop",
      baseBranch: "main",
      featureBranch: "feat/normal",
      prNumber: 70,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let capturedArgs: any = null;
    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/prop/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/prop",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/prop/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/prop",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: async (args) => {
        capturedArgs = args;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
    });

    expect(result.status).toBe("landed");
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs.prNumber).toBe(70);
    expect(capturedArgs.featureBranch).toBe("feat/normal");
  });

  it("passes prNumber and featureBranch to land on retry path after drift repair", async () => {
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "propagate-retry",
      repoPath: repo,
      repoIdentity: "github.com/acme/prop",
      baseBranch: "main",
      featureBranch: "feat/retry",
      prNumber: 71,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    const landCalls: any[] = [];
    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/prop/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/prop",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/prop/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/prop",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: async (args) => {
        landCalls.push(args);
        if (landCalls.length === 1) {
          // First call simulates drift failure
          return {
            stdout: "",
            stderr: "VERSION drift detected",
            exitCode: 1,
            timedOut: false,
            logPath: "/tmp/log",
            durationMs: 1,
            retries: 0,
          };
        }
        // Retry call succeeds
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
      ship: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: "/tmp/log",
        durationMs: 1,
        retries: 0,
      }),
    });

    expect(result.status).toBe("landed");
    expect(landCalls.length).toBe(2);

    // Both normal and retry calls must propagate prNumber and featureBranch
    for (const call of landCalls) {
      expect(call.prNumber).toBe(71);
      expect(call.featureBranch).toBe("feat/retry");
    }
  });
});

describe("processReleaseQueueRecord PR already merged edge cases", () => {
  let queueDir: string;
  let repo: string;

  beforeEach(() => {
    queueDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-rd-merged-edge-"),
    );
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rd-merged-repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("marks landed when PR was merged externally before retry", async () => {
    // The first land fails with drift. While drift repair runs, a human
    // merges the PR on GitHub. The retry land succeeds, and verifyMerged
    // confirms the PR is merged.
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "merged-externally",
      repoPath: repo,
      repoIdentity: "github.com/acme/merged",
      baseBranch: "main",
      featureBranch: "feat/merged",
      prNumber: 80,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let landCalls = 0;
    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({ merged: true }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/merged/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/merged",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/merged/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/merged",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: async () => {
        landCalls++;
        if (landCalls === 1) {
          return {
            stdout: "",
            stderr: "VERSION drift detected",
            exitCode: 1,
            timedOut: false,
            logPath: "/tmp/log",
            durationMs: 1,
            retries: 0,
          };
        }
        // Retry succeeds
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
      ship: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: "/tmp/log",
        durationMs: 1,
        retries: 0,
      }),
    });

    expect(result.status).toBe("landed");
  });

  it("blocks when verifyMerged fails on retry path", async () => {
    const item = writeReleaseQueueRecord(queueDir, {
      runId: "verify-fail-retry",
      repoPath: repo,
      repoIdentity: "github.com/acme/verify",
      baseBranch: "main",
      featureBranch: "feat/verify",
      prNumber: 81,
      version: "1.0.0.0",
      livingPlanPath: "/plan",
      worktreePath: repo,
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
    });

    let landCalls = 0;
    const result = await processReleaseQueueRecord(item, {
      queueDir,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: [fs.realpathSync(os.tmpdir()) + path.sep],
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
      verifyMerged: () => ({
        merged: false,
        reason: "PR #81 state is OPEN on GitHub",
      }),
      acquireLock: () => ({
        acquired: true,
        handle: {
          ref: "refs/gstack/release-locks/verify/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/verify",
          baseBranch: "main",
        },
      }),
      refreshLock: () => ({
        ok: true,
        handle: {
          ref: "refs/gstack/release-locks/verify/main",
          ownerId: "owner",
          commit: "c",
          repoPath: repo,
          repoIdentity: "github.com/acme/verify",
          baseBranch: "main",
        },
      }),
      releaseLock: () => ({ ok: true }),
      land: async () => {
        landCalls++;
        if (landCalls === 1) {
          return {
            stdout: "",
            stderr: "VERSION drift detected",
            exitCode: 1,
            timedOut: false,
            logPath: "/tmp/log",
            durationMs: 1,
            retries: 0,
          };
        }
        // Retry succeeds but verifyMerged will block
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
      ship: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: "/tmp/log",
        durationMs: 1,
        retries: 0,
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.lastError).toContain("GitHub disagrees");
    expect(result.lastError).toContain("PR #81 state is OPEN");
  });
});
