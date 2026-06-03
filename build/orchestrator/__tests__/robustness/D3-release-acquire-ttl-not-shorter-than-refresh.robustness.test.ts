/**
 * D3 — release-acquire-ttl-not-shorter-than-refresh.robustness.test.ts
 *      [PIN]+[RED]  (smoke)
 *
 * Group D (release queue / locks). See docs/designs/BUILD_ROBUSTNESS_SUITE.md
 * §"D3. release-acquire-ttl-not-shorter-than-refresh" and the ranked
 * failure-mode row `verifymerged-default-ttl-asymmetry`:
 *
 *   "acquire default TTL (1h) < refresh TTL (2h); lock stealable before first refresh"
 *
 * The long-run failure this guards: a daemon ACQUIRES the remote release lock
 * with the acquire default TTL (1h), then its heartbeat (refresh) is delayed
 * past the first hour by a sustained transient push failure. Because the
 * INITIAL lock the daemon stamped expires after only 1h while the refresh path
 * stamps 2h, a second daemon sees an expired lock and steals it before the
 * first heartbeat ever lands — two daemons then race to land the same release.
 *
 *   [PIN] The two TTL defaults are EXACTLY what release-lock.ts encodes today
 *         (acquire = 60*60*1000 ms = 1h at release-lock.ts:151, refresh =
 *         2*60*60*1000 ms = 2h at release-lock.ts:243), and both code paths
 *         stamp a finite, future, ISO-8601 `expiresAt` into the pushed lock
 *         commit. These are current correct, load-bearing facts: the encode
 *         pipeline must keep producing a parseable future expiry. A regression
 *         that drops `expiresAt`, makes it non-finite, or silently changes a
 *         default magnitude would reopen a different lock-lifetime bug, so they
 *         are pinned.
 *
 *   [RED] The acquire window must be NO SHORTER than the refresh window:
 *         (acquire expiresAt - now) >= (refresh expiresAt - now). Today acquire
 *         defaults to 1h and refresh to 2h, so the initial lock expires an hour
 *         before a once-delayed heartbeat would have, leaving a 1h window where
 *         the lock is stealable before the first refresh. The desired fix is a
 *         single shared TTL (e.g. an exported RELEASE_LOCK_TTL_MS both paths
 *         use) so acquire >= refresh. UNSKIP WHEN D3 IS FIXED (the acquire
 *         default TTL is raised to at least the refresh default — ideally both
 *         read one shared constant).
 *
 * No real LLM, no network, no long-lived process. Both functions take an
 * injectable `GitRunner`; the fake below captures the `commit-tree` stdin
 * (the encoded lock payload) so the pushed `expiresAt` can be parsed without
 * touching git. We import only symbols that exist today (release-lock.ts does
 * NOT export RELEASE_LOCK_TTL_MS yet — that is part of the desired fix — so it
 * is intentionally NOT imported here).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  acquireRemoteReleaseLock,
  refreshRemoteReleaseLock,
  parseReleaseLockPayload,
  type GitRunner,
  type ReleaseLockHandle,
} from "../../release-lock";

/**
 * A deterministic git runner that lets the acquire path push-create a fresh
 * lock and the refresh path force-with-lease its heartbeat, while capturing
 * the payload each path stamps. The payload is passed to `git commit-tree` on
 * stdin (release-lock.ts:93-98), so we record `opts.input` keyed by the
 * commit-tree invocation order. Both paths only create ONE commit per call, so
 * the most-recent captured payload is the one being pushed.
 */
function fakeGit(): {
  run: GitRunner;
  lastCommitTreeInput: () => string | undefined;
} {
  let lastInput: string | undefined;
  const run: GitRunner = (_cmd, args, opts) => {
    const ok = (stdout: string) =>
      ({
        status: 0,
        stdout,
        stderr: "",
        signal: null,
        output: [],
      }) as ReturnType<GitRunner>;
    if (args[0] === "remote") {
      // No origin remote configured -> canonicalRepoIdentity falls back to path.
      return {
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        output: [],
      } as ReturnType<GitRunner>;
    }
    if (args[0] === "mktree") return ok("tree\n");
    if (args[0] === "commit-tree") {
      lastInput = opts?.input;
      return ok("commit-new\n");
    }
    if (args[0] === "ls-remote") {
      // acquire: ref missing -> push-create branch.
      // refresh: ref present and == handle.commit ("mine") -> heartbeat branch.
      const refArg = args[2] ?? "";
      if (refArg.includes("release-locks")) {
        // Distinguish acquire (no prior lock) from refresh (handle commit "mine").
        // Refresh always queries its own handle.ref; return "mine" so ownership holds.
        return ok("mine\t" + refArg + "\n");
      }
      return ok("");
    }
    if (args[0] === "push") return ok("");
    return {
      status: 1,
      stdout: "",
      stderr: args.join(" "),
      signal: null,
      output: [],
    } as ReturnType<GitRunner>;
  };
  return { run, lastCommitTreeInput: () => lastInput };
}

// Fixed reference instant for every encode in this file.
const NOW = new Date("2026-05-09T00:00:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Drive `acquireRemoteReleaseLock` with no `ttlMs` and a fresh remote (no prior
 * lock) so it push-creates, then parse the `expiresAt` it stamped into the
 * pushed lock commit. Returns the window (expiresAt - now) in ms.
 */
function acquireWindowMs(): number {
  const git = fakeGit();
  // ls-remote for acquire must report NO existing ref so it push-creates.
  // The fake above returns "mine" for any release-locks ref, so for acquire we
  // use a runner whose ls-remote reports empty for the create check.
  const acquireRun: GitRunner = (cmd, args, opts) => {
    if (args[0] === "ls-remote") {
      return {
        status: 0,
        stdout: "",
        stderr: "",
        signal: null,
        output: [],
      } as ReturnType<GitRunner>;
    }
    return git.run(cmd, args, opts);
  };
  const res = acquireRemoteReleaseLock({
    cwd: "/repo",
    repoPath: "/repo",
    baseBranch: "main",
    ownerId: "owner-a",
    now: NOW,
    run: acquireRun,
  });
  if (!res.acquired)
    throw new Error(`acquire unexpectedly failed: ${res.reason}`);
  const payload = parseReleaseLockPayload(git.lastCommitTreeInput() ?? "");
  if (!payload) throw new Error("could not parse acquire lock payload");
  return Date.parse(payload.expiresAt) - NOW.getTime();
}

/**
 * Drive `refreshRemoteReleaseLock` with no `ttlMs` against a held lock and parse
 * the `expiresAt` it stamped. Returns the window (expiresAt - now) in ms.
 */
function refreshWindowMs(): number {
  const git = fakeGit();
  const handle: ReleaseLockHandle = {
    ref: "refs/gstack/release-locks/path-repo/main",
    ownerId: "owner-a",
    commit: "mine",
    repoPath: "/repo",
    repoIdentity: "/repo",
    baseBranch: "main",
  };
  const res = refreshRemoteReleaseLock({
    cwd: "/repo",
    handle,
    now: NOW,
    run: git.run,
  });
  if (!res.ok) throw new Error(`refresh unexpectedly failed: ${res.error}`);
  const payload = parseReleaseLockPayload(git.lastCommitTreeInput() ?? "");
  if (!payload) throw new Error("could not parse refresh lock payload");
  return Date.parse(payload.expiresAt) - NOW.getTime();
}

describe("[PIN] D3 release-acquire-ttl-not-shorter-than-refresh — default TTLs are encoded as a finite future expiry", () => {
  it("acquire stamps a finite, future ISO expiresAt parseable from the pushed commit", () => {
    const win = acquireWindowMs();
    expect(Number.isFinite(win)).toBe(true);
    expect(win).toBeGreaterThan(0);
  });

  it("refresh stamps a finite, future ISO expiresAt parseable from the pushed commit", () => {
    const win = refreshWindowMs();
    expect(Number.isFinite(win)).toBe(true);
    expect(win).toBeGreaterThan(0);
  });

  it("acquire default TTL window is exactly 2h (aligned to RELEASE_LOCK_DEFAULT_TTL_MS)", () => {
    // Was 1h before the D3 fix; acquire now shares the refresh default so the
    // initial lock cannot expire before a once-delayed first heartbeat.
    expect(acquireWindowMs()).toBe(TWO_HOURS_MS);
  });

  it("refresh default TTL window is exactly 2h (release-lock.ts)", () => {
    expect(refreshWindowMs()).toBe(TWO_HOURS_MS);
  });
});

describe("[RED→FIXED] D3 release-acquire-ttl-not-shorter-than-refresh — acquire window must be >= refresh window", () => {
  let acquireWin: number;
  let refreshWin: number;

  beforeEach(() => {
    acquireWin = acquireWindowMs();
    refreshWin = refreshWindowMs();
  });

  afterEach(() => {
    // Nothing to tear down: both helpers use injected fake git runners with no
    // disk, no env, and no spawned process. Reset locals so a future failing
    // iteration cannot leak a value across tests.
    acquireWin = NaN;
    refreshWin = NaN;
  });

  it("the initial acquire lock does not expire before a once-delayed first heartbeat would have", () => {
    // DESIRED INVARIANT (does not hold today): the lock a daemon stamps at
    // acquire time must live at least as long as the window the refresh path
    // stamps, so a delayed first heartbeat cannot let a second daemon steal the
    // lock. Today acquire=1h < refresh=2h, so this fails by exactly 1h.
    expect(acquireWin).toBeGreaterThanOrEqual(refreshWin);
  });
});
