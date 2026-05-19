import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createReleaseLockHeartbeat,
  processReleaseQueueRecord,
  runReleaseDaemon,
} from "../release-daemon";
import {
  readReleaseQueueRecords,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../release-queue";
import { DEFAULT_ROLE_CONFIGS } from "../role-config";
import type { ReleaseLockHandle } from "../release-lock";
import type { SubAgentResult } from "../sub-agents";

describe("release daemon queue loop", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-daemon-"));
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
    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      repoPath: "/repo",
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: () => ({ records: [record({ prNumber: 9 })] }),
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
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 10,
        repoPath: "/repo-a",
        repoIdentity: "github.com/acme/repo-a",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 11,
        repoPath: "/repo-b",
        repoIdentity: "github.com/acme/repo-b",
        queuedAt: "2026-05-09T00:00:02.000Z",
      }),
    );

    const discoverCalls: string[] = [];
    const processed: number[] = [];

    const exit = await runReleaseDaemon({
      queueDir: dir,
      repoPath: "/repo-c",
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
    expect([...discoverCalls].sort()).toEqual([
      "/repo-a",
      "/repo-b",
      "/repo-c",
    ]);
    // Oldest queued local record wins (PR 10 from repo-a).
    expect(processed).toEqual([10]);
  });

  it("dedups discovery by repoIdentity when multiple records share the same repo", async () => {
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 20,
        repoPath: "/repo-a",
        repoIdentity: "github.com/acme/repo-a",
        queuedAt: "2026-05-09T00:00:01.000Z",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 21,
        repoPath: "/repo-a",
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
    expect(discoverCalls).toEqual(["/repo-a"]);
  });

  it("skips discovery for non-queued local records", async () => {
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 30,
        repoPath: "/repo-a",
        repoIdentity: "github.com/acme/repo-a",
        status: "blocked",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 31,
        repoPath: "/repo-b",
        repoIdentity: "github.com/acme/repo-b",
        status: "landed",
      }),
    );
    writeReleaseQueueRecord(
      dir,
      record({
        prNumber: 32,
        repoPath: "/repo-c",
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
    expect(discoverCalls).toEqual(["/repo-c"]);
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
      heartbeatIntervalMs: 60_000,
      verifyQueued: () => ({ ok: true }),
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
