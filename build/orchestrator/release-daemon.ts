import { spawnSync } from "./child-registry";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RoleConfigs } from "./role-config";
import {
  acquireRemoteReleaseLock,
  refreshRemoteReleaseLock,
  releaseRemoteReleaseLock,
  type ReleaseLockHandle,
} from "./release-lock";
import {
  defaultReleaseQueueDir,
  discoverBuildQueuedPullRequests,
  releaseQueueRecordId,
  readReleaseQueueRecords,
  updateReleaseQueueRecord,
  verifyPrQueued,
  type ReleaseQueueRecord,
} from "./release-queue";
import { landOnly, shipOnly } from "./ship";

export const RELEASE_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
export const RELEASE_LOCK_HEARTBEAT_MS = 15 * 60 * 1000;

/**
 * Module-level registry of active release-lock release functions. When the
 * daemon receives SIGTERM (e.g. from launchctl bootkick/unload), the signal
 * handler runs every registered release synchronously so the lock ref is
 * deleted on the remote before the process exits. Without this, the lock
 * lingers for the full TTL (2 hours) blocking any other landing attempt.
 *
 * Each entry returns the release-lock result so the handler can log
 * unreleased locks for forensics. The registry is process-global because
 * the signal handler can't reach into a closure.
 */
type LockReleaseFn = () => { ok: boolean; error?: string };
const activeLockReleases = new Set<LockReleaseFn>();

let signalHandlersInstalled = false;

function installReleaseDaemonSignalHandlers(
  log: (msg: string) => void,
): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const handler = (signal: NodeJS.Signals) => {
    let released = 0;
    let failed = 0;
    for (const release of activeLockReleases) {
      try {
        const r = release();
        if (r.ok) released++;
        else {
          failed++;
          log(`signal ${signal}: lock release failed: ${r.error ?? "unknown"}`);
        }
      } catch (err) {
        failed++;
        log(
          `signal ${signal}: lock release threw: ${(err as Error).message}`,
        );
      }
    }
    activeLockReleases.clear();
    log(
      `signal ${signal}: released ${released} lock(s), ${failed} failed; exiting`,
    );
    // Conventional exit code: 128 + signal number for SIGTERM(15)/SIGINT(2)/SIGHUP(1).
    const code =
      signal === "SIGTERM"
        ? 143
        : signal === "SIGINT"
          ? 130
          : signal === "SIGHUP"
            ? 129
            : 1;
    process.exit(code);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  process.on("SIGHUP", handler);
}

export interface ReleaseDaemonOptions {
  queueDir?: string;
  once?: boolean;
  watch?: boolean;
  pollMs?: number;
  repoPath?: string;
  discoverRemote?: (repoPath: string) => {
    records: ReleaseQueueRecord[];
    error?: string;
  };
  roles: RoleConfigs;
  now?: () => Date;
  log?: (msg: string) => void;
  heartbeatIntervalMs?: number;
  verifyQueued?: typeof verifyPrQueued;
  acquireLock?: typeof acquireRemoteReleaseLock;
  releaseLock?: typeof releaseRemoteReleaseLock;
  refreshLock?: typeof refreshRemoteReleaseLock;
  land?: typeof landOnly;
  ship?: typeof shipOnly;
  processor?: (
    record: ReleaseQueueRecord,
    opts: ReleaseDaemonOptions,
  ) => Promise<ReleaseQueueRecord>;
}

export function createReleaseLockHeartbeat(args: {
  cwd: string;
  handle: ReleaseLockHandle;
  ttlMs?: number;
  intervalMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  refresh?: typeof refreshRemoteReleaseLock;
}): {
  start: () => void;
  stop: () => void;
  beat: () => void;
  currentHandle: () => ReleaseLockHandle;
  lostOwnership: () => string | null;
} {
  const refresh = args.refresh ?? refreshRemoteReleaseLock;
  const log = args.log ?? (() => {});
  let handle = args.handle;
  let lostOwnership: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const beat = () => {
    if (lostOwnership) return;
    const result = refresh({
      cwd: args.cwd,
      handle,
      ttlMs: args.ttlMs ?? RELEASE_LOCK_TTL_MS,
      now: args.now?.(),
    });
    if (result.ok) {
      handle = result.handle;
      return;
    }
    log(`release lock heartbeat failed: ${result.error}`);
    if (result.lostOwnership) lostOwnership = result.error;
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(beat, args.intervalMs ?? RELEASE_LOCK_HEARTBEAT_MS);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    beat,
    currentHandle: () => handle,
    lostOwnership: () => lostOwnership,
  };
}

function ownerId(): string {
  return `${os.hostname()}-${process.pid}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDriftFailure(text: string): boolean {
  return /VERSION drift detected|queue moved since last \/ship/i.test(text);
}

function scratchWorktreePath(record: ReleaseQueueRecord): string {
  return path.join(
    os.tmpdir(),
    "gstack-release-daemon",
    `${record.runId}-pr-${record.prNumber}`,
  );
}

function checkoutScratchWorktree(record: ReleaseQueueRecord): string {
  if (fs.existsSync(record.worktreePath)) return record.worktreePath;
  const scratch = scratchWorktreePath(record);
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  if (!fs.existsSync(scratch)) {
    const fetched = spawnSync(
      "git",
      ["fetch", "origin", record.featureBranch],
      {
        cwd: record.repoPath,
        encoding: "utf8",
      },
    );
    if (fetched.status !== 0) {
      throw new Error(fetched.stderr || fetched.stdout || "git fetch failed");
    }
    const added = spawnSync(
      "git",
      [
        "worktree",
        "add",
        "--detach",
        scratch,
        `origin/${record.featureBranch}`,
      ],
      { cwd: record.repoPath, encoding: "utf8" },
    );
    if (added.status !== 0) {
      throw new Error(
        added.stderr || added.stdout || "git worktree add failed",
      );
    }
  }
  return scratch;
}

export async function processReleaseQueueRecord(
  record: ReleaseQueueRecord,
  opts: ReleaseDaemonOptions,
): Promise<ReleaseQueueRecord> {
  const queueDir = opts.queueDir ?? defaultReleaseQueueDir();
  const log = opts.log ?? (() => {});
  const ownedBy = `${ownerId()}-pr-${record.prNumber}`;
  let current = updateReleaseQueueRecord(queueDir, record, {
    status: "claiming",
    lastError: undefined,
  });
  const marker = (opts.verifyQueued ?? verifyPrQueued)(record.repoPath, record);
  if (!marker.ok) {
    return updateReleaseQueueRecord(queueDir, current, {
      status: "blocked",
      lastError: `queued PR marker verification failed: ${marker.error}`,
    });
  }
  const lock = (opts.acquireLock ?? acquireRemoteReleaseLock)({
    cwd: record.repoPath,
    repoPath: record.repoPath,
    baseBranch: record.baseBranch,
    ownerId: ownedBy,
    ttlMs: RELEASE_LOCK_TTL_MS,
    now: opts.now?.(),
  });
  if (!lock.acquired) {
    log(`release lock unavailable for ${record.baseBranch}: ${lock.reason}`);
    return updateReleaseQueueRecord(queueDir, current, { status: "queued" });
  }

  const heartbeat = createReleaseLockHeartbeat({
    cwd: record.repoPath,
    handle: lock.handle,
    ttlMs: RELEASE_LOCK_TTL_MS,
    intervalMs: opts.heartbeatIntervalMs,
    now: opts.now,
    log,
    refresh: opts.refreshLock,
  });
  heartbeat.start();
  // Register a synchronous lock-release callback. SIGTERM handler runs it if
  // the daemon is killed mid-landing so the ref is freed on the remote
  // instead of waiting for the 2h TTL.
  const releaseFn = opts.releaseLock ?? releaseRemoteReleaseLock;
  const signalReleaseCallback: LockReleaseFn = () =>
    releaseFn({
      cwd: record.repoPath,
      handle: heartbeat.currentHandle(),
    });
  activeLockReleases.add(signalReleaseCallback);
  const blockIfLockLost = () => {
    const lost = heartbeat.lostOwnership();
    if (!lost) return null;
    return updateReleaseQueueRecord(queueDir, current, {
      status: "blocked",
      lastError: `release lock ownership lost during landing: ${lost}`,
    });
  };

  try {
    const cwd = checkoutScratchWorktree(record);
    current = updateReleaseQueueRecord(queueDir, current, {
      status: "landing",
    });
    const land = opts.land ?? landOnly;
    const ship = opts.ship ?? shipOnly;
    let landResult = await land({
      cwd,
      slug: `release-daemon-pr-${record.prNumber}`,
      landRole: opts.roles.land,
    });
    const lockLost = blockIfLockLost();
    if (lockLost) return lockLost;
    const landOutput = `${landResult.stdout}\n${landResult.stderr}`;
    if (
      (landResult.exitCode !== 0 || landResult.timedOut) &&
      isDriftFailure(landOutput) &&
      (current.retries ?? 0) < 1
    ) {
      current = updateReleaseQueueRecord(queueDir, current, {
        status: "drift_repairing",
        retries: (current.retries ?? 0) + 1,
      });
      const shipResult = await ship({
        cwd,
        slug: `release-daemon-pr-${record.prNumber}-drift`,
        shipRole: opts.roles.ship,
      });
      const lockLostAfterShip = blockIfLockLost();
      if (lockLostAfterShip) return lockLostAfterShip;
      if (shipResult.exitCode !== 0 || shipResult.timedOut) {
        return updateReleaseQueueRecord(queueDir, current, {
          status: "blocked",
          lastError: `drift repair /ship failed (exit ${shipResult.exitCode}, timed_out=${shipResult.timedOut})`,
        });
      }
      current = updateReleaseQueueRecord(queueDir, current, {
        status: "landing",
      });
      landResult = await land({
        cwd,
        slug: `release-daemon-pr-${record.prNumber}-retry`,
        landRole: opts.roles.land,
      });
      const lockLostAfterRetry = blockIfLockLost();
      if (lockLostAfterRetry) return lockLostAfterRetry;
    }
    if (landResult.exitCode !== 0 || landResult.timedOut) {
      return updateReleaseQueueRecord(queueDir, current, {
        status: "blocked",
        lastError: `land-and-deploy failed (exit ${landResult.exitCode}, timed_out=${landResult.timedOut}); see ${landResult.logPath}`,
      });
    }
    return updateReleaseQueueRecord(queueDir, current, { status: "landed" });
  } catch (err) {
    return updateReleaseQueueRecord(queueDir, current, {
      status: "blocked",
      lastError: (err as Error).message,
    });
  } finally {
    heartbeat.stop();
    activeLockReleases.delete(signalReleaseCallback);
    const released = (opts.releaseLock ?? releaseRemoteReleaseLock)({
      cwd: record.repoPath,
      handle: heartbeat.currentHandle(),
    });
    if (!released.ok) {
      log(`warning: could not release ${lock.handle.ref}: ${released.error}`);
    }
  }
}

function discoverQueuedRecords(
  queueDir: string,
  opts: ReleaseDaemonOptions,
): ReleaseQueueRecord[] {
  const local = readReleaseQueueRecords(queueDir);
  const byId = new Map<string, ReleaseQueueRecord>();
  for (const record of local) {
    byId.set(releaseQueueRecordId(record), record);
  }
  // Build set of repos to discover remote PRs from. Always include
  // opts.repoPath if set (the explicitly-configured one). Then add every
  // unique repoPath we see in the local queue, since the build orchestrator
  // queues PRs across repos into a shared queue dir. Dedup by repoIdentity
  // when present, otherwise by resolved path.
  const reposToDiscover = new Map<string, string>(); // identity → path
  if (opts.repoPath) {
    reposToDiscover.set(`__configured__:${opts.repoPath}`, opts.repoPath);
  }
  for (const record of local) {
    if (record.status !== "queued") continue;
    const repoPath = record.repoPath;
    if (!repoPath) continue;
    const key = record.repoIdentity || `path:${repoPath}`;
    if (!reposToDiscover.has(key)) {
      reposToDiscover.set(key, repoPath);
    }
  }
  for (const [, repoPath] of reposToDiscover) {
    const remote = opts.discoverRemote
      ? opts.discoverRemote(repoPath)
      : discoverBuildQueuedPullRequests(repoPath);
    if (remote.error) {
      opts.log?.(
        `warning: could not discover queued PRs for ${repoPath}: ${remote.error}`,
      );
    }
    for (const record of remote.records) {
      const id = releaseQueueRecordId(record);
      if (!byId.has(id)) byId.set(id, record);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const byQueued = a.queuedAt.localeCompare(b.queuedAt);
    return byQueued !== 0 ? byQueued : a.prNumber - b.prNumber;
  });
}

export async function runReleaseDaemon(
  opts: ReleaseDaemonOptions,
): Promise<number> {
  const queueDir = opts.queueDir ?? defaultReleaseQueueDir();
  const pollMs = opts.pollMs ?? 30_000;
  const log = opts.log ?? console.log;
  // Only install signal handlers for long-running mode. one-shot tests
  // call runReleaseDaemon many times; installing handlers there leaks
  // listeners and triggers MaxListenersExceededWarning.
  if (opts.watch) {
    installReleaseDaemonSignalHandlers(log);
  }
  while (true) {
    const next = discoverQueuedRecords(queueDir, { ...opts, log }).find(
      (record) => record.status === "queued",
    );
    if (next) {
      const processor = opts.processor ?? processReleaseQueueRecord;
      const result = await processor(next, { ...opts, queueDir, log });
      log(`PR #${result.prNumber}: ${result.status}`);
      if (opts.once) return result.status === "blocked" ? 1 : 0;
    } else if (opts.once) {
      log("release queue empty");
      return 0;
    }
    if (!opts.watch) return 0;
    await sleepMs(pollMs);
  }
}

export function retryReleaseQueueRecord(
  prNumber: number,
  queueDir = defaultReleaseQueueDir(),
): ReleaseQueueRecord | null {
  const record = readReleaseQueueRecords(queueDir).find(
    (item) => item.prNumber === prNumber,
  );
  if (!record) return null;
  if (record.status !== "blocked") return record;
  return updateReleaseQueueRecord(queueDir, record, {
    status: "queued",
    lastError: undefined,
  });
}
