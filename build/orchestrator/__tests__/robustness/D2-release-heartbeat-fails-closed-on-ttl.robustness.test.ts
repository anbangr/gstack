/**
 * D2 — release-heartbeat-fails-closed-on-ttl  [RED]
 *
 * Group D (release queue / locks / daemon), smoke tier.
 *
 * Confirmed gap from docs/designs/BUILD_ROBUSTNESS_SUITE.md §"Group D":
 *
 *   "Sustained transient push failures let the 2h lock TTL lapse; a second
 *    daemon steals and double-lands."
 *
 * `createReleaseLockHeartbeat` (build/orchestrator/release-daemon.ts) drives a
 * `refresh` on every `beat()`. When `refresh` reports `{ok:false,
 * lostOwnership:false}` — a *transient* push failure where the remote ref still
 * points at our commit — the heartbeat only logs the error. It never tracks how
 * long it has been since the last *successful* refresh, so `lostOwnership()`
 * stays `null` forever even after the lock's `ttlMs` has elapsed in wall-clock
 * time. Meanwhile the on-disk lock's `expiresAt` lapses, a second daemon steals
 * it, and both land the same PR.
 *
 * DESIRED (this spec): once elapsed-since-last-success exceeds `ttlMs`, the
 * heartbeat fails closed — `lostOwnership()` returns a non-null reason — so the
 * landing daemon stops trusting a lock the rest of the fleet can already steal.
 *
 * Today the code has no notion of "time since last success", so this block is
 * committed as `describe.skip`. The fix PR (track lastSuccessAt against the
 * fake `now`, flip lostOwnership once `now - lastSuccessAt > ttlMs`) removes the
 * `.skip` and the spec goes green. See README.md "Unskip checklist".
 *
 * Pure in-memory: no real LLM, network, spawn, disk writes, or env mutation.
 * The injected `refresh` stub and fake `now` are the only seams; `cwd` is a
 * throwaway temp dir the stub never reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import {
  createReleaseLockHeartbeat,
  RELEASE_LOCK_TTL_MS,
} from "../../release-daemon";
import type { ReleaseLockHandle } from "../../release-lock";
import { mkTmp } from "./helpers";

// Mirror the handle builder from release-daemon.test.ts so we exercise the
// exact ReleaseLockHandle shape the production code expects.
function handle(overrides: Partial<ReleaseLockHandle> = {}): ReleaseLockHandle {
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

// A refresh stub that always reports a *transient* push failure: the remote ref
// is unchanged (so `lostOwnership` from refresh's own perspective is false) but
// our force-with-lease push didn't land. This is the "transient forever" input.
function transientRefreshStub(): () => {
  ok: false;
  lostOwnership: false;
  error: string;
} {
  return () => ({
    ok: false,
    lostOwnership: false,
    error:
      "release lock heartbeat failed: could not push to origin (transient)",
  });
}

describe("[RED→FIXED] D2 release-heartbeat-fails-closed-on-ttl", () => {
  let cwd: string;
  // A manually-advanced wall-clock the heartbeat reads via `now: () => Date`.
  let fakeNowMs: number;

  beforeEach(() => {
    cwd = mkTmp("gstack-robustness-d2-");
    fakeNowMs = 0;
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("fails closed once elapsed-since-last-success exceeds ttlMs", () => {
    const ttlMs = RELEASE_LOCK_TTL_MS; // 2h
    const hb = createReleaseLockHeartbeat({
      cwd,
      handle: handle(),
      ttlMs,
      now: () => new Date(fakeNowMs),
      refresh: transientRefreshStub(),
      log: () => {},
    });

    // First beat at t=0: transient failure. We've never had a success since
    // construction, and no time has elapsed yet, so it's still tentatively OK.
    hb.beat();
    expect(hb.lostOwnership()).toBeNull();

    // Beat repeatedly while advancing the clock toward (but not past) the TTL.
    // Every refresh is a transient failure. The lock has NOT lapsed yet, so
    // the heartbeat must keep treating it as transient (still null).
    for (let elapsed = 0; elapsed < ttlMs; elapsed += ttlMs / 4) {
      fakeNowMs = elapsed;
      hb.beat();
    }
    // Just shy of the TTL boundary: still transient.
    fakeNowMs = ttlMs - 1;
    hb.beat();
    expect(hb.lostOwnership()).toBeNull();

    // Now cross the TTL: more than `ttlMs` has elapsed since the last
    // successful refresh (there was never one — construction counts as the
    // anchor). The heartbeat MUST fail closed.
    fakeNowMs = ttlMs + 1;
    hb.beat();
    const reason = hb.lostOwnership();
    expect(reason).not.toBeNull();
    expect(typeof reason).toBe("string");
    expect((reason ?? "").length).toBeGreaterThan(0);

    // Once failed closed, it stays failed closed (beat() short-circuits on a
    // set lostOwnership), even if the clock advances further.
    fakeNowMs = ttlMs * 2;
    hb.beat();
    expect(hb.lostOwnership()).not.toBeNull();
  });

  it("a single successful refresh resets the TTL window", () => {
    const ttlMs = 60 * 60 * 1000; // 1h, explicit to decouple from the default
    let mode: "ok" | "transient" = "ok";
    const hb = createReleaseLockHeartbeat({
      cwd,
      handle: handle(),
      ttlMs,
      now: () => new Date(fakeNowMs),
      refresh: () =>
        mode === "ok"
          ? { ok: true, handle: handle({ commit: "renewed" }) }
          : {
              ok: false,
              lostOwnership: false,
              error: "transient push failure",
            },
      log: () => {},
    });

    // Successful refresh near the end of the first window resets the anchor.
    fakeNowMs = ttlMs - 1;
    hb.beat();
    expect(hb.lostOwnership()).toBeNull();
    expect(hb.currentHandle().commit).toBe("renewed");

    // Switch to transient failures. Advance just past the ORIGINAL ttl, but
    // not yet past ttl-since-the-successful-refresh. Must still be transient.
    mode = "transient";
    fakeNowMs = ttlMs + (ttlMs - 1); // (ttlMs - 1) since last success
    hb.beat();
    expect(hb.lostOwnership()).toBeNull();

    // Now cross ttl since the successful refresh: fail closed.
    fakeNowMs = ttlMs - 1 + ttlMs + 1;
    hb.beat();
    expect(hb.lostOwnership()).not.toBeNull();
  });
});
