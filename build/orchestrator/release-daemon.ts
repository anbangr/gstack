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
  blockReleaseQueueRecordByRunId,
  defaultReleaseQueueDir,
  discoverBuildQueuedPullRequests,
  releaseQueueRecordId,
  releaseQueueRecordPath,
  readReleaseQueueRecords,
  updateReleaseQueueRecord,
  verifyPrQueued,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "./release-queue";
import { landOnly, shipOnly } from "./ship";

export const RELEASE_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
export const RELEASE_LOCK_HEARTBEAT_MS = 15 * 60 * 1000;

/**
 * Allowlist of path prefixes the daemon will fan out discovery to. The queue
 * dir is gstack-owned (writes happen via this codebase), but a planted JSON
 * file with a crafted repoPath could otherwise cause `gh`/`git` to run with
 * a cwd inside a directory containing a malicious .git/config — git executes
 * core.sshCommand / core.fsmonitor / core.editor on invocation. The
 * allowlist is the per-record gate that closes this expansion of the
 * pre-existing trust boundary.
 *
 * Prefixes:
 *   - `~/Documents/` — where checked-out product repos live
 *   - `~/.gstack/build-worktrees/` — gstack-managed worktrees
 *   - `~/code/`, `~/Development/`, `~/src/` — common alternate repo roots
 *
 * Override via `GSTACK_DAEMON_REPO_ALLOWLIST` (colon-separated absolute paths).
 * Default policy: allow only if EXACT prefix matches AND path is a real
 * directory AND contains `.git` (file or dir, to support worktrees).
 */
const DEFAULT_REPO_ALLOWLIST_PREFIXES = [
  path.join(os.homedir(), "Documents") + path.sep,
  path.join(os.homedir(), ".gstack", "build-worktrees") + path.sep,
  path.join(os.homedir(), "code") + path.sep,
  path.join(os.homedir(), "Development") + path.sep,
  path.join(os.homedir(), "src") + path.sep,
];

function getRepoAllowlistPrefixes(): string[] {
  const override = process.env.GSTACK_DAEMON_REPO_ALLOWLIST;
  if (!override) return DEFAULT_REPO_ALLOWLIST_PREFIXES;
  // Env override is ADDITIVE on top of defaults, not a replacement. A
  // replace-semantics design lets anyone who can set env on the daemon
  // (launchctl plist edit, ~/.zshenv poisoning) silently widen the
  // allowlist to / by setting GSTACK_DAEMON_REPO_ALLOWLIST=/ . With
  // additive semantics, the attacker still has to add their path
  // explicitly and the defaults stay enforced — a small mitigation but
  // it removes the "one env var = no allowlist" failure mode.
  //
  // Codex P2 (round 7) fix: reject `/` (root) and any prefix shorter
  // than 2 non-separator characters. Without this, setting
  // GSTACK_DAEMON_REPO_ALLOWLIST=/ inserts `/` (well, `/` after
  // endsWith-sep normalization stays `/`), and isAllowedRepoPath's
  // `withSep.startsWith(prefix)` check accepts every absolute path —
  // effectively disabling the allowlist. Reject root explicitly.
  // Codex P2 (round 11) fix: realpath each env entry before storing.
  // The gate uses fs.realpathSync(repoPath) to defeat symlinks; the
  // allowlist must compare against realpaths too, or symlinked
  // prefixes like macOS's /tmp (which realpaths to /private/tmp)
  // silently reject every repo in the documented location. Fall back
  // to the raw string when realpath fails — the user may want a
  // prefix that doesn't exist yet (e.g. a future mount point).
  const extra = override
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    })
    .map((p) => (p.endsWith(path.sep) ? p : p + path.sep))
    .filter((p) => {
      // Reject root (`/` on POSIX, `\` on Win32) and any prefix that
      // resolves to a single separator after trimming.
      if (p === path.sep) return false;
      // Reject any path whose pre-separator content is empty.
      const trimmed = p.slice(0, -path.sep.length);
      if (trimmed.length === 0) return false;
      return true;
    });
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const prefix of [...extra, ...DEFAULT_REPO_ALLOWLIST_PREFIXES]) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    merged.push(prefix);
  }
  return merged;
}

/**
 * Git branch names flowing into argv as part of a refspec (`git fetch
 * origin <branch>`, `git worktree add ... origin/<branch>`) can include
 * characters that git treats specially: `:` (push-side refspec separator
 * — `evil:refs/heads/main` rewrites local refs during fetch), `+` (force
 * update flag), `^{}` (deref dereferencing), `~` and `^` (ancestor
 * navigation), and leading `-` (mistaken as a flag in some git builds).
 *
 * argv-form spawnSync prevents shell injection but not git's own
 * refspec syntax. The allowlist guards the cwd; this guards branch
 * names that flow through argv.
 *
 * Accept only the safe subset of git's reference-name grammar:
 * letters, digits, `.`, `_`, `/`, `-`. Reject leading `-` to defeat
 * the flag-confusion attack. Reject empty strings.
 */
const SAFE_BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]+$/;
export function isAllowedFeatureBranch(
  branch: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!branch || typeof branch !== "string") {
    return { ok: false, reason: "featureBranch is empty or not a string" };
  }
  if (!SAFE_BRANCH_RE.test(branch)) {
    return {
      ok: false,
      reason: `featureBranch ${JSON.stringify(branch)} contains characters outside the safe subset [A-Za-z0-9._/-] (or starts with -)`,
    };
  }
  const refCheck = spawnSync("git", ["check-ref-format", "--branch", branch], {
    encoding: "utf8",
  });
  if (refCheck.status !== 0) {
    return {
      ok: false,
      reason: `featureBranch ${JSON.stringify(branch)} is not a valid git branch name`,
    };
  }
  return { ok: true };
}

/**
 * Add the realpath of `extraRoot` to the standard allowlist prefixes. Used
 * by runReleaseDaemon to always allow the explicitly-configured project
 * root, regardless of whether it sits under one of the hardcoded defaults.
 * Without this, a daemon installed from a path like /workspaces/my-repo/
 * would reject its own configured repoPath and never process queued records
 * unless the user also set GSTACK_DAEMON_REPO_ALLOWLIST. The realpath
 * resolution defeats the same symlink-bypass as the main check.
 */
export function buildAllowlistWithRoot(
  extraRoot: string | undefined,
): string[] {
  const base = getRepoAllowlistPrefixes();
  if (!extraRoot) return base;
  let resolved: string;
  try {
    resolved = fs.realpathSync(extraRoot);
  } catch {
    // Bad/missing path — don't extend the allowlist with garbage.
    return base;
  }
  const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  // Codex P2 (round 10) fix: reject root. If --project-root=/ (or
  // resolveDaemonProjectRoot defaulted to a / cwd, or extraRoot was
  // anything that realpath'd to /), prepending `/` to the allowlist
  // means every absolute path with a .git entry passes the gate.
  // The env-side rejection in getRepoAllowlistPrefixes guards the
  // GSTACK_DAEMON_REPO_ALLOWLIST=/ vector; this branch guards the
  // --project-root vector. Same defense, different entrypoint.
  if (prefix === path.sep) return base;
  if (base.includes(prefix)) return base;
  return [prefix, ...base];
}

/**
 * Returns the canonical realpath of `repoPath` (with `ok: true`) when it
 * is safe for the daemon to use as a subprocess cwd. A safe path is
 * absolute, exists, is a directory, contains `.git`, AND resolves (via
 * realpath, following symlinks) to a location inside an allowlisted
 * prefix. Failures are diagnostic strings so callers can log them.
 *
 * **Callers must use the returned `resolved` path for all subsequent
 * spawnSync `cwd` arguments**, not the input `repoPath`. Passing the
 * original `repoPath` (a possibly-symlink string) re-opens the TOCTOU:
 * the kernel re-resolves the symlink at spawn time, so an attacker who
 * can flip a symlink between gate-time and spawn-time bypasses the
 * gate. By forcing callers to substitute the resolved path, the spawn
 * target is the same physical inode the gate validated.
 *
 * The realpath check defeats symlink bypass: if the queue contains a
 * record with repoPath="/Users/me/Documents/evil-link" and that link
 * points at /tmp/attacker-repo/, the lexical path.resolve() check would
 * pass (the input is lexically inside ~/Documents/) but the subsequent
 * `git fetch` with cwd=evil-link would resolve the symlink and read
 * /tmp/attacker-repo/.git/config — running any malicious core.sshCommand
 * the attacker planted. realpathSync forces both checks to use the same
 * physical location, and returning that location to the caller forces
 * the spawn to operate on the inode the gate approved.
 */
export function isAllowedRepoPath(
  repoPath: string,
  prefixes: string[] = getRepoAllowlistPrefixes(),
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (!repoPath || typeof repoPath !== "string") {
    return { ok: false, reason: "repoPath is empty or not a string" };
  }
  if (!path.isAbsolute(repoPath)) {
    return { ok: false, reason: `repoPath is not absolute: ${repoPath}` };
  }
  // Step 1: existence + directory check on the input path (before realpath,
  // so we get a clean "does not exist" message rather than "ENOENT, realpath").
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch (err) {
    return {
      ok: false,
      reason: `repoPath ${repoPath} does not exist: ${(err as Error).message}`,
    };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `repoPath ${repoPath} is not a directory` };
  }
  // Step 2: realpath. Follows symlinks. The allowlist check below operates
  // on the realpath — this is the only correct way to defeat the symlink
  // bypass. Lexical path.resolve() would allow /Users/me/Documents/evil-link
  // (where evil-link → /tmp/attacker) to pass; the realpath does not.
  let resolved: string;
  try {
    resolved = fs.realpathSync(repoPath);
  } catch (err) {
    return {
      ok: false,
      reason: `repoPath ${repoPath} realpath failed: ${(err as Error).message}`,
    };
  }
  const withSep = resolved + path.sep;
  const allowed = prefixes.some(
    (prefix) => withSep === prefix || withSep.startsWith(prefix),
  );
  if (!allowed) {
    return {
      ok: false,
      reason: `repoPath ${repoPath} (realpath ${resolved}) is outside the daemon allowlist (set GSTACK_DAEMON_REPO_ALLOWLIST to extend)`,
    };
  }
  // Step 3: confirm there's a .git entry (dir for clones, file for linked
  // worktrees). Use the realpath to avoid a TOCTOU between Step 2 and now.
  const gitMarker = path.join(resolved, ".git");
  try {
    fs.statSync(gitMarker);
  } catch {
    return {
      ok: false,
      reason: `repoPath ${repoPath} (realpath ${resolved}) has no .git entry (not a git repo)`,
    };
  }
  return { ok: true, resolved };
}

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
 *
 * Today the daemon processes one record at a time, so this set has at most
 * one entry. When concurrent multi-repo processing lands, this needs to
 * grow into a map keyed by record runId — same shape as activeRecords below.
 */
type LockReleaseFn = () => { ok: boolean; error?: string };
const activeLockReleases = new Set<LockReleaseFn>();

/**
 * Module-level registry of in-flight records. Maps runId → {queueDir, record}
 * for every record currently being processed. The signal handler uses this
 * to rewrite each record's status back to "queued" before exiting, so a
 * SIGTERM mid-landing doesn't strand the record in "landing" — invisible to
 * `discoverQueuedRecords` (which only fans out for status==="queued") and
 * thus permanently abandoned until manual `retryReleaseQueueRecord`.
 */
interface ActiveRecordEntry {
  queueDir: string;
  record: ReleaseQueueRecord;
}
const activeRecords = new Map<string, ActiveRecordEntry>();

/**
 * Run-ids whose record was revived by reviveActiveRecordsForSignal. The
 * still-running processReleaseQueueRecord (mid-await on land/ship) checks
 * this set before every terminal status write — if the run was revived,
 * the late-returning sub-agent's result must NOT overwrite the queued
 * state the signal handler just wrote.
 *
 * Codex P2 fix: without this guard, the racing processor could land a
 * `blocked` or `landed` write AFTER the signal revived to `queued`,
 * clobbering the revival and stranding the record in the wrong state.
 * The flag is one-shot per runId — the processor on noticing it
 * abandons writes (and the lock is already released by the signal
 * handler's callback).
 */
const interruptedRunIds = new Set<string>();

let signalHandlersInstalled = false;

/**
 * Per-call timeout for synchronous release in the signal handler. macOS
 * launchctl waits ~5-10s between SIGTERM and SIGKILL; if `git push` to the
 * remote hangs (slow network, paged-out auth helper), the release stalls
 * past SIGKILL and the lock leaks anyway. We can't timeout spawnSync directly
 * in the signal handler (it's blocking), but we do measure elapsed and stop
 * after we've burned a reasonable fraction of the grace period. The total
 * budget across all in-flight records is RELEASE_BUDGET_MS.
 */
const SIGNAL_RELEASE_BUDGET_MS = 4000;

const INFLIGHT_STATES = new Set(["claiming", "landing", "drift_repairing"]);

/**
 * Revive all in-flight records back to "queued" so the next daemon
 * tick picks them up. Exported so the SIGTERM handler can call it AND
 * so tests can directly drive the same code path without sending real
 * signals to the test runner.
 *
 * **C5/C6 fix: re-reads each record from disk before deciding to
 * revive, and skips records whose on-disk status is already terminal**
 * (landed/blocked/abandoned). The in-memory `activeRecords` snapshot
 * is captured at registration time (status=queued) and never updates
 * — without the re-read, a SIGTERM arriving after the natural-path
 * `finally` block wrote `status=landed` (but before
 * `activeRecords.delete()` ran) would rewrite the disk back to
 * `queued`, erasing the version bump and CHANGELOG fields that
 * already shipped. Re-reading ensures the handler never undoes work
 * that already completed.
 */
export function reviveActiveRecordsForSignal(
  signal: NodeJS.Signals | "TEST",
  log: (msg: string) => void = () => {},
): { revived: number; skipped: number; failed: number } {
  let revived = 0;
  let skipped = 0;
  let failed = 0;
  for (const [runId, entry] of activeRecords) {
    try {
      const onDiskPath = releaseQueueRecordPath(entry.queueDir, entry.record);
      let onDisk: ReleaseQueueRecord;
      try {
        onDisk = JSON.parse(
          fs.readFileSync(onDiskPath, "utf8"),
        ) as ReleaseQueueRecord;
      } catch {
        // Disk file missing or corrupt — fall back to the in-memory
        // snapshot (status=queued). Better to mark queued than to leak.
        onDisk = entry.record;
      }
      if (!INFLIGHT_STATES.has(onDisk.status)) {
        // Terminal state already on disk (landed/blocked) — don't touch.
        skipped++;
        log(
          `signal ${signal}: skipping revive of ${runId}: already terminal (${onDisk.status})`,
        );
        continue;
      }
      // Codex P2 (round 6) fix: if the interrupt happened mid-
      // drift_repairing, the in-progress repair didn't complete. Clear
      // `retries` so the next daemon pass gets a fresh attempt at drift
      // repair. Without this, the revived record carries retries=1
      // through queued→claiming→landing, and the next drift failure
      // immediately blocks the PR without ever finishing /ship —
      // permanently stuck until manual retryReleaseQueueRecord.
      const revivalPatch: Partial<ReleaseQueueRecord> = {
        status: "queued",
        lastError: `interrupted by signal ${signal} mid-landing`,
      };
      if (onDisk.status === "drift_repairing") {
        revivalPatch.retries = 0;
      }
      updateReleaseQueueRecord(entry.queueDir, onDisk, revivalPatch);
      // Mark the run interrupted so the still-running processor (if
      // any) sees it and abandons further status writes. Without this,
      // a late-returning land/ship result could overwrite the queued
      // status the signal just wrote.
      interruptedRunIds.add(runId);
      revived++;
    } catch (err) {
      failed++;
      log(
        `signal ${signal}: failed to revive record ${runId}: ${(err as Error).message}`,
      );
    }
  }
  activeRecords.clear();
  if (revived + skipped + failed > 0) {
    log(
      `signal ${signal}: revived ${revived} record(s) to queued, ${skipped} skipped (terminal on disk), ${failed} failed`,
    );
  }
  return { revived, skipped, failed };
}

function installReleaseDaemonSignalHandlers(log: (msg: string) => void): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const handler = (signal: NodeJS.Signals) => {
    // Step 1: revive in-flight records BEFORE attempting lock release. If
    // the process is killed before we get to lock release, the records
    // are at least back to "queued" status and the next daemon will retry.
    reviveActiveRecordsForSignal(signal, log);
    // Step 2: release locks within a bounded budget. Once budget is gone,
    // log the rest as deferred and exit — better to leak a lock for 2h than
    // get SIGKILLed mid-git-push, which can be worse if it corrupts state.
    let released = 0;
    let failed = 0;
    let deferred = 0;
    const start = Date.now();
    for (const release of activeLockReleases) {
      const elapsed = Date.now() - start;
      if (elapsed >= SIGNAL_RELEASE_BUDGET_MS) {
        deferred++;
        continue;
      }
      try {
        const r = release();
        if (r.ok) released++;
        else {
          failed++;
          log(`signal ${signal}: lock release failed: ${r.error ?? "unknown"}`);
        }
      } catch (err) {
        failed++;
        log(`signal ${signal}: lock release threw: ${(err as Error).message}`);
      }
    }
    activeLockReleases.clear();
    log(
      `signal ${signal}: released ${released} lock(s), ${failed} failed, ${deferred} deferred (budget exhausted)`,
    );
    // Intentionally do NOT call process.exit here. child-registry installs
    // its own SIGTERM/SIGINT/SIGHUP handler that runs `killAllChildren("SIGTERM")`,
    // waits 2s for graceful shutdown, then `killAllChildren("SIGKILL")` for
    // survivors before exiting. If we exit here, we abort that 2s fallback
    // and any child process that ignores SIGTERM gets reparented to init
    // (orphaned, exactly the failure child-registry exists to prevent).
    // Both handlers fire on the same signal; node runs them in registration
    // order. Our work is sync (record revival + bounded lock release), so it
    // completes before child-registry's async sleep + kill + exit sequence.
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  process.on("SIGHUP", handler);
}

/**
 * Test-only: reset module-level state. Tests that exercise the signal
 * handler or watch loop should call this in afterEach so the handler
 * doesn't accumulate listeners or stale registry entries.
 */
export function _resetReleaseDaemonForTests(): void {
  activeLockReleases.clear();
  activeRecords.clear();
  interruptedRunIds.clear();
  signalHandlersInstalled = false;
  // Note: we can't `process.removeAllListeners('SIGTERM')` because that
  // would also remove any test-runner handlers. Tests that need a clean
  // signal surface should run in a child process.
}

/**
 * Test-only: register a synthetic in-flight record so tests can drive
 * `reviveActiveRecordsForSignal` directly without going through the
 * full processReleaseQueueRecord flow. Used to exercise the C5/C6
 * race: write a record to disk, set its on-disk status to something
 * (landed / landing / etc.), register it as "in-flight" with a stale
 * snapshot, then invoke revive — assert what happens.
 */
export function _registerActiveRecordForTests(
  queueDir: string,
  record: ReleaseQueueRecord,
): void {
  activeRecords.set(record.runId, { queueDir, record });
}

export interface ReleaseDaemonOptions {
  queueDir?: string;
  once?: boolean;
  watch?: boolean;
  pollMs?: number;
  repoPath?: string;
  /**
   * Test-only allowlist override. Production callers should leave this
   * undefined and rely on `buildAllowlistWithRoot(opts.repoPath)`. Tests
   * that exercise the processor against synthetic paths set this to the
   * fixture's parent dir so isAllowedRepoPath accepts the fixture. This
   * is NOT a security-bypass — every value passes through the same
   * `isAllowedRepoPath` realpath+`.git` checks; it only controls which
   * prefixes are accepted, identical in shape to GSTACK_DAEMON_REPO_ALLOWLIST.
   */
  allowlistPrefixes?: string[];
  discoverRemote?: (repoPath: string) => {
    records: ReleaseQueueRecord[];
    error?: string;
  };
  roles: RoleConfigs;
  now?: () => Date;
  log?: (msg: string) => void;
  heartbeatIntervalMs?: number;
  verifyQueued?: typeof verifyPrQueued;
  /**
   * Verify the PR actually merged on GitHub after the land sub-agent
   * returns exit 0. Defaults to {@link verifyPrMerged}. Tests inject a
   * stub to control the response.
   */
  verifyMerged?: typeof verifyPrMerged;
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

/**
 * Result of verifying whether a PR is actually merged on GitHub.
 * The daemon uses this AFTER the land sub-agent returns exit 0 to
 * confirm the merge actually happened (the sub-agent may have
 * gracefully declined and still exited 0 — see verifyPrMerged below).
 */
export interface PrMergeStatus {
  merged: boolean;
  state?: string;
  /** Free-text for the queue record's lastError when not merged. */
  reason?: string;
}

/**
 * Ask GitHub whether a PR is actually merged. The release-daemon
 * runs this after the /land-and-deploy sub-agent returns exit 0,
 * because exit code alone is not authoritative: the sub-agent (Kimi,
 * Claude, or Codex running /land-and-deploy) gracefully declines to
 * merge in real scenarios — failing CI, no PR found, pre-merge
 * readiness gate fails — and still exits 0. The verdict in those
 * cases lives in prose inside the output file. Trusting exit code
 * alone produced a 50% false-positive landed rate in production
 * (PRs #120 and #129 on mitosis-control-plane, observed 2026-05-19),
 * silently stranding queue records as "landed" while the PR was
 * still OPEN on GitHub. This check makes GitHub the ground truth.
 *
 * Uses `gh pr view <pr> --repo <repo> --json state` via spawnSync.
 * `gh` is already a hard dependency of the daemon for other paths
 * (verifyPrQueued, discoverBuildQueuedPullRequests). The repo arg
 * is the OWNER/NAME form parsed from repoIdentity ("github.com/X/Y"
 * → "X/Y") so we don't depend on cwd or remote URL.
 *
 * Network/auth failures are reported as `merged: false, reason:
 * "could not verify"` rather than thrown, so the daemon blocks the
 * record instead of crashing. A blocked record can be retried; a
 * crashed daemon leaks the lock.
 */
export function verifyPrMerged(
  prNumber: number,
  repoIdentity: string | undefined,
  cwd: string,
): PrMergeStatus {
  // Derive OWNER/NAME from repoIdentity ("github.com/owner/repo" →
  // "owner/repo"). When repoIdentity is missing, omit --repo and
  // rely on cwd's remote — last-resort fallback for legacy records.
  let repoArg: string[] = [];
  if (repoIdentity) {
    const match = repoIdentity.match(/^github\.com\/([^/]+\/[^/]+)$/);
    if (!match) {
      return {
        merged: false,
        reason: `could not parse repoIdentity ${JSON.stringify(repoIdentity)} as github.com/owner/repo`,
      };
    }
    repoArg = ["--repo", match[1]];
  }
  const result = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      ...repoArg,
      "--json",
      "state",
      "-q",
      ".state",
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    return {
      merged: false,
      reason: `gh pr view exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 200)}`,
    };
  }
  const state = (result.stdout || "").trim();
  if (state === "MERGED") return { merged: true, state };
  return {
    merged: false,
    state: state || "unknown",
    reason: `PR #${prNumber} state is ${state || "unknown"} on GitHub (sub-agent reported success but PR was not merged)`,
  };
}

const MERGED_RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000;

function shouldReconcileBlockedRecord(
  record: ReleaseQueueRecord,
  now: Date,
): boolean {
  if (record.status !== "blocked") return false;
  if (!record.lastGithubCheckedAt) return true;
  const last = Date.parse(record.lastGithubCheckedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= MERGED_RECONCILE_MIN_INTERVAL_MS;
}

export function reconcileBlockedRecordWithGithub(
  record: ReleaseQueueRecord,
  opts: Pick<
    ReleaseDaemonOptions,
    "allowlistPrefixes" | "now" | "repoPath" | "verifyMerged" | "log"
  > & { queueDir?: string },
): ReleaseQueueRecord {
  const now = opts.now?.() ?? new Date();
  if (!shouldReconcileBlockedRecord(record, now)) return record;
  const prefixes =
    opts.allowlistPrefixes ?? buildAllowlistWithRoot(opts.repoPath);
  const gate = isAllowedRepoPath(record.repoPath, prefixes);
  if (!gate.ok) {
    opts.log?.(
      `warning: skipping blocked PR #${record.prNumber} reconciliation: ${gate.reason}`,
    );
    return record;
  }
  const verifyMerged = opts.verifyMerged ?? verifyPrMerged;
  const mergeStatus = verifyMerged(
    record.prNumber,
    record.repoIdentity,
    gate.resolved,
  );
  const checkedAt = now.toISOString();
  if (mergeStatus.merged) {
    return writeReleaseQueueRecord(opts.queueDir ?? defaultReleaseQueueDir(), {
      ...record,
      status: "landed",
      lastError: undefined,
      lastGithubCheckedAt: checkedAt,
      lastGithubState: mergeStatus.state ?? "MERGED",
      reconciledAt: checkedAt,
    });
  }
  return updateReleaseQueueRecord(
    opts.queueDir ?? defaultReleaseQueueDir(),
    record,
    {
      lastGithubCheckedAt: checkedAt,
      lastGithubState: mergeStatus.state ?? "unknown",
    },
  );
}

function scratchWorktreePath(record: ReleaseQueueRecord): string {
  return path.join(
    os.tmpdir(),
    "gstack-release-daemon",
    `${record.runId}-pr-${record.prNumber}`,
  );
}

function checkoutScratchWorktree(
  record: ReleaseQueueRecord,
  resolvedRepoPath: string,
  allowlistPrefixes: string[],
): string {
  const remoteTrackingRef = `refs/remotes/origin/${record.featureBranch}`;
  const fetchRemoteBranch = (cwd: string): void => {
    const fetched = spawnSync(
      "git",
      [
        "fetch",
        "origin",
        `+refs/heads/${record.featureBranch}:${remoteTrackingRef}`,
      ],
      { cwd, encoding: "utf8" },
    );
    if (fetched.status !== 0) {
      throw new Error(fetched.stderr || fetched.stdout || "git fetch failed");
    }
  };
  const resetWorktree = (cwd: string): void => {
    const reset = spawnSync("git", ["reset", "--hard", remoteTrackingRef], {
      cwd,
      encoding: "utf8",
    });
    if (reset.status !== 0) {
      throw new Error(reset.stderr || reset.stdout || "git reset failed");
    }
  };

  // Codex P2 (round 9) fix: gate record.worktreePath too. A planted
  // queue record can have an allowed repoPath but a worktreePath
  // pointing anywhere on disk (an attacker checkout, /tmp, etc). The
  // returned cwd flows straight into /land-and-deploy's spawnSync,
  // bypassing the repoPath gate. Validate worktreePath with the same
  // allowlist + .git marker checks, and only honor it if it passes;
  // otherwise fall through to creating a fresh scratch worktree from
  // the gate-validated resolvedRepoPath.
  if (fs.existsSync(record.worktreePath)) {
    const worktreeGate = isAllowedRepoPath(
      record.worktreePath,
      allowlistPrefixes,
    );
    if (worktreeGate.ok) {
      // Use the realpath-resolved worktree path, not the raw record
      // value — same TOCTOU mitigation as the repoPath gate.
      const resolvedWorktree = worktreeGate.resolved;
      const branchCheck = spawnSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: resolvedWorktree, encoding: "utf8" },
      );
      if (branchCheck.status !== 0) {
        // Existing fixtures and unusual worktree-like directories can pass
        // the .git marker gate without being real repos. Keep the legacy
        // fallback for those, but reset every real worktree below.
        return resolvedWorktree;
      }
      fetchRemoteBranch(resolvedWorktree);
      resetWorktree(resolvedWorktree);
      return resolvedWorktree;
    }
    // worktreePath exists but is disallowed — ignore it and create a
    // fresh scratch worktree from the validated repo instead.
  }
  const scratch = scratchWorktreePath(record);
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  if (!fs.existsSync(scratch)) {
    fetchRemoteBranch(resolvedRepoPath);
    const added = spawnSync(
      "git",
      [
        "worktree",
        "add",
        "--detach",
        scratch,
        remoteTrackingRef,
      ],
      { cwd: resolvedRepoPath, encoding: "utf8" },
    );
    if (added.status !== 0) {
      throw new Error(
        added.stderr || added.stdout || "git worktree add failed",
      );
    }
  } else {
    const branchCheck = spawnSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: scratch, encoding: "utf8" },
    );
    if (branchCheck.status === 0) {
      fetchRemoteBranch(scratch);
      resetWorktree(scratch);
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
  // Allowlist + branch-name gate at the entry of the processor itself.
  // This is the only choke point that EVERY code path must pass through
  // (CLI, test injection with opts.processor, direct callers from other
  // modules). The discovery-time and watch-loop gates above are
  // redundant defenses; the gate here is the load-bearing one. The gate
  // returns the realpath-resolved repo path, which we substitute into
  // every spawnSync cwd argument below — passing the original (possibly
  // symlink) `record.repoPath` re-opens the TOCTOU the gate exists to
  // close, because the kernel re-resolves the symlink at spawn time.
  //
  // Tests that drive processReleaseQueueRecord directly with synthetic
  // paths can set GSTACK_DAEMON_REPO_ALLOWLIST or pass opts.allowlist to
  // include their fixture root. The gate has no test-bypass flag — if
  // tests get to bypass it, future production wrappers that copy a
  // similar shape will too, which is exactly the C7 bypass.
  const prefixes =
    opts.allowlistPrefixes ?? buildAllowlistWithRoot(opts.repoPath);
  const gate = isAllowedRepoPath(record.repoPath, prefixes);
  if (!gate.ok) {
    // Codex P1 (round 12) fix: use runId-based block to avoid `git
    // remote get-url` in the rejected repo. Falls back to
    // updateReleaseQueueRecord (which is safe when repoIdentity is
    // set — the canonicalRepoIdentity git fallback only fires when
    // repoIdentity is missing).
    const blocked = blockReleaseQueueRecordByRunId(
      queueDir,
      record,
      `repoPath rejected by daemon allowlist: ${gate.reason}`,
    );
    if (blocked) return blocked;
    return updateReleaseQueueRecord(queueDir, record, {
      status: "blocked",
      lastError: `repoPath rejected by daemon allowlist: ${gate.reason}`,
    });
  }
  const resolvedRepoPath = gate.resolved;
  const branchGate = isAllowedFeatureBranch(record.featureBranch);
  if (!branchGate.ok) {
    const blocked = blockReleaseQueueRecordByRunId(
      queueDir,
      record,
      `featureBranch rejected: ${branchGate.reason}`,
    );
    if (blocked) return blocked;
    return updateReleaseQueueRecord(queueDir, record, {
      status: "blocked",
      lastError: `featureBranch rejected: ${branchGate.reason}`,
    });
  }
  const ownedBy = `${ownerId()}-pr-${record.prNumber}`;
  let current = updateReleaseQueueRecord(queueDir, record, {
    status: "claiming",
    lastError: undefined,
  });
  // Codex P2 (round 7) fix: register the record in activeRecords
  // IMMEDIATELY after the claiming-write, before the blocking
  // verifyQueued + acquireLock calls. Without this, SIGTERM arriving
  // during verifyPrQueued (which can spawn `gh`) or
  // acquireRemoteReleaseLock (spawns `git push` to claim the ref)
  // leaves the disk record stuck in `claiming` — discovery only
  // refans `queued` records, so the PR is abandoned until manual
  // retryReleaseQueueRecord. The signal handler can now see this
  // claiming record (claiming is in INFLIGHT_STATES) and revive it
  // back to queued. We deregister in the finally block as before.
  activeRecords.set(record.runId, { queueDir, record });
  // Helper to deregister early-return paths. The full try/finally
  // registers the lock-release callback too — those paths use the
  // finally cleanup. These pre-lock returns deregister manually.
  const deregisterPreLock = () => {
    activeRecords.delete(record.runId);
    interruptedRunIds.delete(record.runId);
  };
  // Short-circuit if SIGTERM already fired since the claiming write.
  if (interruptedRunIds.has(record.runId)) {
    deregisterPreLock();
    try {
      return JSON.parse(
        fs.readFileSync(releaseQueueRecordPath(queueDir, current), "utf8"),
      ) as ReleaseQueueRecord;
    } catch {
      return current;
    }
  }
  const marker = (opts.verifyQueued ?? verifyPrQueued)(
    resolvedRepoPath,
    record,
  );
  // Codex P2 (round 8) fix: check interruption BEFORE honoring a
  // !marker.ok result. If shutdown revival fired during verifyQueued
  // (which spawns `gh pr view` — a likely victim of SIGTERM-driven
  // child cleanup), the marker failure could be just "the gh subprocess
  // got killed mid-shutdown," not a real "PR not queued" verdict.
  // Writing blocked here would convert a retryable shutdown into a
  // manual-retry hang. Bail out on interruption first.
  if (interruptedRunIds.has(record.runId)) {
    deregisterPreLock();
    try {
      return JSON.parse(
        fs.readFileSync(releaseQueueRecordPath(queueDir, current), "utf8"),
      ) as ReleaseQueueRecord;
    } catch {
      return current;
    }
  }
  if (!marker.ok) {
    deregisterPreLock();
    return updateReleaseQueueRecord(queueDir, current, {
      status: "blocked",
      lastError: `queued PR marker verification failed: ${marker.error}`,
    });
  }
  const lock = (opts.acquireLock ?? acquireRemoteReleaseLock)({
    cwd: resolvedRepoPath,
    repoPath: resolvedRepoPath,
    baseBranch: record.baseBranch,
    ownerId: ownedBy,
    ttlMs: RELEASE_LOCK_TTL_MS,
    now: opts.now?.(),
  });
  // Codex P2 (round 8) fix: if interruption happened during acquireLock
  // AND the lock was actually acquired, we MUST release it before
  // returning — the heartbeat+finally cleanup hasn't been wired up yet,
  // so a plain early-return leaks the ref for the 2h TTL. Same defense
  // for !lock.acquired (no leak there; just deregister).
  if (interruptedRunIds.has(record.runId)) {
    deregisterPreLock();
    if (lock.acquired) {
      try {
        (opts.releaseLock ?? releaseRemoteReleaseLock)({
          cwd: resolvedRepoPath,
          handle: lock.handle,
        });
      } catch (err) {
        log(
          `warning: failed to release lock during pre-heartbeat interrupt: ${(err as Error).message}`,
        );
      }
    }
    try {
      return JSON.parse(
        fs.readFileSync(releaseQueueRecordPath(queueDir, current), "utf8"),
      ) as ReleaseQueueRecord;
    } catch {
      return current;
    }
  }
  if (!lock.acquired) {
    deregisterPreLock();
    log(`release lock unavailable for ${record.baseBranch}: ${lock.reason}`);
    return updateReleaseQueueRecord(queueDir, current, { status: "queued" });
  }

  const heartbeat = createReleaseLockHeartbeat({
    cwd: resolvedRepoPath,
    handle: lock.handle,
    ttlMs: RELEASE_LOCK_TTL_MS,
    intervalMs: opts.heartbeatIntervalMs,
    now: opts.now,
    log,
    refresh: opts.refreshLock,
  });
  heartbeat.start();
  // Register a synchronous lock-release callback. SIGTERM handler runs it
  // if the daemon is killed mid-landing so the ref is freed on the remote
  // instead of waiting for the 2h TTL. The callback ALSO stops the
  // heartbeat before releasing — without that, an in-flight heartbeat
  // tick (or one fired between release and process exit) re-pushes the
  // ref using its captured handle, resurrecting the lock the handler
  // just released. The macOS launchctl SIGTERM→SIGKILL grace window is
  // long enough (~5-10s) that one re-push round trip easily fits inside
  // it, and the heartbeat timer is `unref`'d but not cleared, so the
  // event loop can keep it alive while the handler is processing other
  // records.
  const releaseFn = opts.releaseLock ?? releaseRemoteReleaseLock;
  const signalReleaseCallback: LockReleaseFn = () => {
    heartbeat.stop();
    return releaseFn({
      cwd: resolvedRepoPath,
      handle: heartbeat.currentHandle(),
    });
  };
  activeLockReleases.add(signalReleaseCallback);
  // activeRecords.set already happened above immediately after the
  // claiming-write — registering here would be a no-op (same runId).
  // Codex P2 fix: every status write after registration goes through this
  // wrapper. If reviveActiveRecordsForSignal already revived this runId,
  // the wrapper short-circuits and returns the pre-write snapshot —
  // preventing a late-returning land/ship result from overwriting the
  // signal handler's queued revival with a blocked or landed write.
  // Reads disk to return the actual current state when interrupted (the
  // revival wrote queued; we want callers to see that, not the stale
  // pre-revival current).
  const isInterrupted = () => interruptedRunIds.has(record.runId);
  const readCurrentFromDisk = (
    snapshot: ReleaseQueueRecord,
  ): ReleaseQueueRecord => {
    try {
      return JSON.parse(
        fs.readFileSync(releaseQueueRecordPath(queueDir, snapshot), "utf8"),
      ) as ReleaseQueueRecord;
    } catch {
      return { ...snapshot, status: "queued" };
    }
  };
  const safeUpdate = (
    snapshot: ReleaseQueueRecord,
    patch: Partial<ReleaseQueueRecord>,
  ): ReleaseQueueRecord => {
    if (isInterrupted()) return readCurrentFromDisk(snapshot);
    return updateReleaseQueueRecord(queueDir, snapshot, patch);
  };
  const blockIfLockLost = () => {
    const lost = heartbeat.lostOwnership();
    if (!lost) return null;
    return safeUpdate(current, {
      status: "blocked",
      lastError: `release lock ownership lost during landing: ${lost}`,
    });
  };

  try {
    // Codex P1 fix: bail out before any expensive work if the signal
    // handler already interrupted us. Without this, a SIGTERM that
    // arrives mid-checkoutScratchWorktree (or any of the blocking git
    // calls below) revives the record but the processor keeps going,
    // launching sub-agents AFTER the lock was released and the record
    // marked queued for retry. Two processes (the old, dying one and
    // the next daemon's pickup) could then race on the same PR.
    if (isInterrupted()) return readCurrentFromDisk(current);
    const cwd = checkoutScratchWorktree(record, resolvedRepoPath, prefixes);
    if (isInterrupted()) return readCurrentFromDisk(current);
    current = safeUpdate(current, {
      status: "landing",
    });
    if (isInterrupted()) return readCurrentFromDisk(current);
    const land = opts.land ?? landOnly;
    const ship = opts.ship ?? shipOnly;
    let landResult = await land({
      cwd,
      slug: `release-daemon-pr-${record.prNumber}`,
      landRole: opts.roles.land,
      prNumber: record.prNumber,
      featureBranch: record.featureBranch,
    });
    if (isInterrupted()) return readCurrentFromDisk(current);
    const lockLost = blockIfLockLost();
    if (lockLost) return lockLost;
    const landOutput = `${landResult.stdout}\n${landResult.stderr}`;
    if (
      (landResult.exitCode !== 0 || landResult.timedOut) &&
      isDriftFailure(landOutput) &&
      (current.retries ?? 0) < 1
    ) {
      current = safeUpdate(current, {
        status: "drift_repairing",
        retries: (current.retries ?? 0) + 1,
      });
      if (isInterrupted()) return readCurrentFromDisk(current);
      const shipResult = await ship({
        cwd,
        slug: `release-daemon-pr-${record.prNumber}-drift`,
        shipRole: opts.roles.ship,
      });
      if (isInterrupted()) return readCurrentFromDisk(current);
      const lockLostAfterShip = blockIfLockLost();
      if (lockLostAfterShip) return lockLostAfterShip;
      if (shipResult.exitCode !== 0 || shipResult.timedOut) {
        return safeUpdate(current, {
          status: "blocked",
          lastError: `drift repair /ship failed (exit ${shipResult.exitCode}, timed_out=${shipResult.timedOut})`,
        });
      }
      current = safeUpdate(current, {
        status: "landing",
      });
      if (isInterrupted()) return readCurrentFromDisk(current);
      landResult = await land({
        cwd,
        slug: `release-daemon-pr-${record.prNumber}-retry`,
        landRole: opts.roles.land,
        prNumber: record.prNumber,
        featureBranch: record.featureBranch,
      });
      if (isInterrupted()) return readCurrentFromDisk(current);
      const lockLostAfterRetry = blockIfLockLost();
      if (lockLostAfterRetry) return lockLostAfterRetry;
    }
    if (landResult.exitCode !== 0 || landResult.timedOut) {
      return safeUpdate(current, {
        status: "blocked",
        lastError: `land-and-deploy failed (exit ${landResult.exitCode}, timed_out=${landResult.timedOut}); see ${landResult.logPath}`,
      });
    }
    // GitHub ground-truth check. The land sub-agent (Kimi / Claude /
    // Codex running /land-and-deploy) gracefully declines to merge in
    // real scenarios — failing CI, no PR found, pre-merge readiness
    // gate fails — and still exits 0. Trusting exit code alone
    // produced a 50% false-positive landed rate in production (PRs
    // #120, #129 on mitosis-control-plane, 2026-05-19), silently
    // stranding records as "landed" while the PR was still OPEN on
    // GitHub. Ask GitHub for the truth before we commit to "landed".
    const verifyMerged = opts.verifyMerged ?? verifyPrMerged;
    const mergeStatus = verifyMerged(
      record.prNumber,
      record.repoIdentity,
      resolvedRepoPath,
    );
    if (!mergeStatus.merged) {
      return safeUpdate(current, {
        status: "blocked",
        lastError: `land-and-deploy reported success but GitHub disagrees: ${mergeStatus.reason}; see ${landResult.logPath}`,
      });
    }
    return safeUpdate(current, { status: "landed" });
  } catch (err) {
    return safeUpdate(current, {
      status: "blocked",
      lastError: (err as Error).message,
    });
  } finally {
    // Order matters: release the lock FIRST, then deregister the
    // SIGTERM-callback. The reverse order opens a one-statement window
    // where SIGTERM between delete() and releaseFn() runs neither path
    // and the lock leaks for the full 2h TTL — the exact failure mode
    // this code exists to prevent. If SIGTERM lands after releaseFn but
    // before delete, the handler may re-release; releaseRemoteReleaseLock
    // is idempotent (returns ok:true when the ref is already gone), so
    // double-release is cheap. Missed release is not.
    heartbeat.stop();
    // Use the already-resolved releaseFn so the natural-completion path
    // and the SIGTERM-callback path go through one callable. Use the
    // gate-resolved path for cwd, not the original record.repoPath —
    // same TOCTOU mitigation as the spawnSync calls above.
    const released = releaseFn({
      cwd: resolvedRepoPath,
      handle: heartbeat.currentHandle(),
    });
    activeLockReleases.delete(signalReleaseCallback);
    activeRecords.delete(record.runId);
    // Clear the interrupt flag — this run is done. The natural-path
    // cleanup may have completed concurrently with revival; either way,
    // the flag served its purpose (blocking late terminal writes) and
    // should not leak across daemon ticks where a new run could reuse
    // the same runId.
    interruptedRunIds.delete(record.runId);
    if (!released.ok) {
      log(`warning: could not release ${lock.handle.ref}: ${released.error}`);
    }
  }
}

interface DiscoveryResult {
  records: ReleaseQueueRecord[];
  preBlocked: number;
}

function discoverQueuedRecords(
  queueDir: string,
  opts: ReleaseDaemonOptions,
): DiscoveryResult {
  const local = readReleaseQueueRecords(queueDir).map((record) =>
    reconcileBlockedRecordWithGithub(record, { ...opts, queueDir }),
  );
  const byId = new Map<string, ReleaseQueueRecord>();
  let preBlocked = 0;
  // Codex P1 (round 11) fix: when no test seam bypasses the
  // production path, gate each local record's repoPath BEFORE
  // calling releaseQueueRecordId. Without `repoIdentity`,
  // releaseQueueRecordId falls back to `canonicalRepoIdentity`,
  // which spawns `git remote get-url origin` in `cwd: record.repoPath`.
  // A planted disallowed record could trigger that git subprocess
  // (running .git/config in an attacker dir) before any allowlist
  // check fires. The early gate here keeps the trust boundary
  // intact: legacy records without repoIdentity must pass the
  // allowlist before any git/gh invocation touches their repoPath.
  // Tests that inject opts.discoverRemote OR opts.processor bypass
  // this — same seam as the watch-loop early gate, since those
  // injections take responsibility for not running git against
  // synthetic paths.
  const earlyGateEnabled = !opts.discoverRemote && !opts.processor;
  const earlyAllowlist =
    opts.allowlistPrefixes ?? buildAllowlistWithRoot(opts.repoPath);
  for (const record of local) {
    if (
      earlyGateEnabled &&
      !record.repoIdentity &&
      record.status === "queued"
    ) {
      const check = isAllowedRepoPath(record.repoPath, earlyAllowlist);
      if (!check.ok) {
        opts.log?.(
          `warning: blocking PR #${record.prNumber}: disallowed repoPath: ${check.reason}`,
        );
        // Codex P1 (round 12) fix: use the runId-based blocking path
        // instead of updateReleaseQueueRecord. The latter would compute
        // releaseQueueRecordPath → releaseQueueRecordId →
        // canonicalRepoIdentity → `git remote get-url` IN THE REJECTED
        // REPO, defeating the gate. The runId-based path writes the
        // existing on-disk file directly without touching the
        // disallowed repo.
        try {
          const blocked = blockReleaseQueueRecordByRunId(
            queueDir,
            record,
            `repoPath rejected by daemon allowlist (pre-id derivation): ${check.reason}`,
          );
          if (blocked) preBlocked++;
        } catch {
          // Transition validator may reject if record is already
          // terminal. Either way, skip it.
        }
        continue;
      }
    }
    byId.set(releaseQueueRecordId(record), record);
  }
  // Build set of repos to discover remote PRs from. Always include
  // opts.repoPath if set (the explicitly-configured one). Then add every
  // unique repoPath we see in the local queue, since the build orchestrator
  // queues PRs across repos into a shared queue dir. Dedup by repoIdentity
  // when present, otherwise by resolved path. Use one keying scheme for
  // both sources so a configured path and a queued record at the same path
  // (with no repoIdentity) collapse to one discovery call.
  const reposToDiscover = new Map<string, string>();
  const repoKey = (identity: string | undefined, repoPath: string): string =>
    identity ? `id:${identity}` : `path:${repoPath}`;
  if (opts.repoPath) {
    reposToDiscover.set(repoKey(undefined, opts.repoPath), opts.repoPath);
  }
  for (const record of local) {
    if (record.status !== "queued") continue;
    const repoPath = record.repoPath;
    if (!repoPath) continue;
    const key = repoKey(record.repoIdentity, repoPath);
    if (!reposToDiscover.has(key)) {
      reposToDiscover.set(key, repoPath);
    }
  }
  // Build the effective allowlist once per discovery pass. Always extend with
  // opts.repoPath (the configured daemon root) so daemons installed outside
  // the hardcoded defaults work without manual GSTACK_DAEMON_REPO_ALLOWLIST.
  const allowlistPrefixes =
    opts.allowlistPrefixes ?? buildAllowlistWithRoot(opts.repoPath);
  for (const [, repoPath] of reposToDiscover) {
    // Allowlist gate + path-resolution: only applies when we'd hit the
    // filesystem-touching default. Tests that inject `opts.discoverRemote`
    // opt out of the gate and take responsibility for whatever paths they
    // pass through.
    //
    // Codex-2 fix: pass the GATE-RESOLVED realpath to
    // discoverBuildQueuedPullRequests, not the original (possibly-symlink)
    // path. Same TOCTOU concern as the processor's spawnSync chain — if
    // we validate /Users/me/Documents/evil-link (which realpaths to
    // /tmp/attacker) and then run `gh pr list` against the original
    // symlink string, the kernel re-resolves the link at spawn time and
    // the gh subprocess runs against /tmp/attacker. Substituting the
    // resolved path forces the spawn to operate on the inode the gate
    // approved.
    let cwdForDiscovery = repoPath;
    if (!opts.discoverRemote) {
      const check = isAllowedRepoPath(repoPath, allowlistPrefixes);
      if (!check.ok) {
        opts.log?.(
          `warning: skipping discovery for disallowed repoPath: ${check.reason}`,
        );
        continue;
      }
      cwdForDiscovery = check.resolved;
    }
    const remote = opts.discoverRemote
      ? opts.discoverRemote(repoPath)
      : discoverBuildQueuedPullRequests(cwdForDiscovery);
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
  const records = [...byId.values()].sort((a, b) => {
    const byQueued = a.queuedAt.localeCompare(b.queuedAt);
    return byQueued !== 0 ? byQueued : a.prNumber - b.prNumber;
  });
  return { records, preBlocked };
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
  // Effective allowlist for this daemon — always includes the configured
  // opts.repoPath so daemons installed outside the hardcoded defaults work.
  // Tests can override via opts.allowlistPrefixes (same shape, used to
  // accept synthetic fixture paths). The same `allowlist` value is
  // threaded through to processReleaseQueueRecord below so the gate
  // inside the processor uses identical prefixes — there must be exactly
  // one allowlist for a given daemon invocation, otherwise the early
  // block here and the processor's gate can disagree and a record could
  // pass one but not the other.
  const candidateAllowlist =
    opts.allowlistPrefixes ?? buildAllowlistWithRoot(opts.repoPath);
  while (true) {
    const discovery = discoverQueuedRecords(queueDir, {
      ...opts,
      allowlistPrefixes: candidateAllowlist,
      log,
    });
    const candidates = discovery.records.filter(
      (record) => record.status === "queued",
    );
    // Early-block disallowed candidates so they're marked "blocked" in
    // the queue before any processor work happens. This is redundant
    // with the gate inside processReleaseQueueRecord (which is the
    // load-bearing one — every code path passes through it), but the
    // early block here lets the daemon skip past bad records on the
    // same tick and emits a clearer log message naming the PR.
    //
    // Tests that inject opts.processor opt out of THIS early gate: their
    // synthetic paths (/repo-a, etc.) don't exist on disk, so the gate
    // would reject them and the test couldn't exercise the watch loop.
    // The processor injection is the test seam — when present, the test
    // takes responsibility for path safety (its processor doesn't run
    // any subprocesses with the synthetic path as cwd). The gate inside
    // processReleaseQueueRecord remains unconditional: any production
    // wrapper that uses the real processor still gets gated.
    const earlyGateEnabled = !opts.processor;
    let next: ReleaseQueueRecord | undefined;
    // Combine discovery-time pre-blocks (Codex-12 / round-11 gate) with
    // watch-loop early blocks (round-7). Either signals a poisoned
    // queue and bumps --once's exit code to 1.
    let earlyBlockedCount = discovery.preBlocked;
    for (const candidate of candidates) {
      if (earlyGateEnabled) {
        const check = isAllowedRepoPath(candidate.repoPath, candidateAllowlist);
        if (!check.ok) {
          log(
            `blocking PR #${candidate.prNumber}: disallowed repoPath: ${check.reason}`,
          );
          // Codex P1 (round 12) fix: if the candidate lacks
          // repoIdentity, use the runId-based block path to avoid
          // invoking git in the rejected repo. For candidates that DO
          // have repoIdentity, updateReleaseQueueRecord is safe (no
          // git fallback). Use the runId path always for consistency
          // since both work and runId-based avoids any future
          // regression where someone removes repoIdentity.
          const blocked = blockReleaseQueueRecordByRunId(
            queueDir,
            candidate,
            `repoPath outside daemon allowlist: ${check.reason}`,
          );
          if (blocked) {
            earlyBlockedCount++;
          } else {
            // Fallback: no on-disk file matched (record came from
            // remote discovery, never written to local queue). Fall
            // back to updateReleaseQueueRecord, which is safe here
            // because remote-discovered records always have
            // repoIdentity (gh pr list provides it).
            try {
              updateReleaseQueueRecord(queueDir, candidate, {
                status: "blocked",
                lastError: `repoPath outside daemon allowlist: ${check.reason}`,
              });
              earlyBlockedCount++;
            } catch {
              // Best-effort. Skip.
            }
          }
          continue;
        }
      }
      next = candidate;
      break;
    }
    if (next) {
      const processor = opts.processor ?? processReleaseQueueRecord;
      const result = await processor(next, { ...opts, queueDir, log });
      log(`PR #${result.prNumber}: ${result.status}`);
      if (opts.once) return result.status === "blocked" ? 1 : 0;
    } else if (opts.once) {
      // Codex P2 (round 8) fix: if --once only saw disallowed records
      // and early-blocked them, return 1 so automation notices the
      // poisoned queue. The original code path returned 0 ("queue
      // empty") because next was unset — that masked the broken state
      // and disagreed with the processor's behavior, which returns 1
      // for a blocked result.
      if (earlyBlockedCount > 0) {
        log(
          `release queue: blocked ${earlyBlockedCount} record(s) for disallowed repoPath; no eligible records to process`,
        );
        return 1;
      }
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
