/**
 * C2 — shutdown-grace-escalation  [PIN]  (integration, smoke)
 *
 * Pins the kill-escalation PRIMITIVE itself, independent of the C1 two-handler
 * ordering bug. The orchestrator's shutdown path is SIGTERM-then-(grace)-then-
 * SIGKILL (`shutdownAndExit` in child-registry.ts: killAllChildren("SIGTERM")
 * → sleep(2000) → killAllChildren("SIGKILL")). C1 covers the broken ordering
 * where a competing handler pre-empts the escalation; C2 isolates the much
 * narrower claim that, given the two `killAllChildren` calls actually run, the
 * SIGKILL leg reaps a child that deliberately IGNORES SIGTERM, and the test
 * (standing in for the parent loop) never hangs.
 *
 * Setup (design doc §C2):
 *   - Spawn a real `bun -e` / `node -e` child via `child-registry.spawn`. The
 *     child installs a no-op SIGTERM handler (traps it, keeps running) so a
 *     graceful SIGTERM cannot kill it. `spawn` adds `detached: true`, so the
 *     child gets its own process group (pgid == pid) — which is exactly what
 *     `killAllChildren` relies on when it does `process.kill(-pid, signal)`.
 *   - `killAllChildren("SIGTERM")` → after a short bounded wait the child is
 *     STILL alive (it trapped the signal).
 *   - `killAllChildren("SIGKILL")` → poll process liveness in a bounded loop;
 *     the child dies (SIGKILL is uncatchable). The poll loop is bounded so a
 *     regression that fails to reach the child surfaces as a timeout-bounded
 *     assertion failure, not a hang.
 *
 * Verified against child-registry.ts: `spawn(cmd,args,opts)` sets
 * `detached:true`, registers `child.pid` in `livePids`, and auto-unregisters on
 * exit/close/error. `killAllChildren(sig)` iterates `livePids` and calls
 * `signalProcessGroup(pid,sig)` → `process.kill(-pid, sig)`. `_resetForTest()`
 * clears the registry between tests.
 *
 * `isProcessAlive` is NOT exported from stall-watchdog.ts, so per the spec
 * instruction this file uses a local `isAlive(pid)` via `process.kill(pid, 0)`
 * (same idiom as the existing child-registry.test.ts integration test).
 *
 * No real LLM, no network. The only real process is a short-lived `bun -e`
 * child that is force-reaped in-test and again in afterEach.
 *
 * See docs/designs/BUILD_ROBUSTNESS_SUITE.md §C2 and ./README.md (PIN/RED).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _liveChildPids,
  _resetForTest,
  killAllChildren,
  spawn,
} from "../../child-registry";

/** Liveness probe via signal 0 (no signal delivered). Mirrors the helper in
 *  build/orchestrator/__tests__/child-registry.test.ts. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists but we can't signal it
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred()` is true or the bounded deadline elapses. Returns the
 *  last value of `pred()`. Bounded so a regression surfaces as a failed
 *  assertion, never an unbounded hang. */
async function pollUntil(
  pred: () => boolean,
  timeoutMs: number,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

// A child that traps SIGTERM (no-op handler) and keeps running on an idle
// interval. Only SIGKILL — which userspace cannot intercept — can take it
// down. This is the SIGTERM-ignoring sub-agent the escalation must reap.
const SIGTERM_TRAPPING_CHILD = `
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdout.write("ready\\n");
  setInterval(() => {}, 60000);
`;

describe("[PIN] C2 shutdown grace escalation", () => {
  // PIDs we must hard-reap in afterEach even if an assertion throws mid-test.
  let spawnedPids: number[] = [];

  beforeEach(() => {
    _resetForTest();
    spawnedPids = [];
  });

  afterEach(async () => {
    // Force-reap anything still alive, by process group then by pid, so a
    // failed assertion never strands a real 60s-interval child.
    for (const pid of spawnedPids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Group may already be gone (ESRCH) or ungroupable; fall through.
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
    // Give the kernel a moment to tear them down before the next test.
    await sleep(50);
    _resetForTest();
    spawnedPids = [];
  });

  it("killAllChildren SIGTERM leaves a SIGTERM-trapping child alive; SIGKILL reaps it", async () => {
    if (process.platform === "win32") {
      // POSIX-only: process groups + SIGTERM/SIGKILL semantics don't apply on
      // Windows. Skip without failing (matches the existing integration test).
      return;
    }

    // Spawn the SIGTERM-trapping child through the registry so it is tracked in
    // livePids and gets detached:true (own process group). Use process.execPath
    // (bun in this harness) with `-e` so we run a real short-lived OS process.
    const child = spawn(process.execPath, ["-e", SIGTERM_TRAPPING_CHILD], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = child.pid;
    expect(typeof pid).toBe("number");
    spawnedPids.push(pid as number);

    // The registry must have tracked it before we try to signal it.
    expect(_liveChildPids()).toContain(pid);

    // Wait for the child to print "ready" so we know its SIGTERM handler is
    // installed before we signal. If we SIGTERM'd before the handler attached,
    // the default disposition would kill the child and make this PIN a
    // tautology (it would "survive" only because it never received the signal).
    let ready = false;
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (String(chunk).includes("ready")) ready = true;
      });
    }
    const becameReady = await pollUntil(() => ready, 5000);
    expect(becameReady).toBe(true);

    // It should be alive before we signal.
    expect(isAlive(pid as number)).toBe(true);

    // --- SIGTERM leg: trapped → child survives. ---
    const signaledTerm = killAllChildren("SIGTERM");
    expect(signaledTerm).toBeGreaterThanOrEqual(1);

    // Give SIGTERM ample time to (not) take effect, then confirm the child is
    // still alive: it trapped the signal. A short bounded wait is enough — if
    // SIGTERM were going to kill it, it would within tens of ms.
    await sleep(300);
    expect(isAlive(pid as number)).toBe(true);

    // --- SIGKILL leg: uncatchable → child dies within a bounded loop. ---
    const signaledKill = killAllChildren("SIGKILL");
    expect(signaledKill).toBeGreaterThanOrEqual(1);

    // Poll liveness in a bounded loop. The parent (this test) does NOT block on
    // a fixed sleep waiting for the child — it polls and returns as soon as the
    // child is gone, proving the escalation reaped it and the caller didn't
    // hang.
    const died = await pollUntil(() => !isAlive(pid as number), 5000);
    expect(died).toBe(true);
    expect(isAlive(pid as number)).toBe(false);

    // The registry auto-unregisters on the child's exit/close/error event.
    // Give that listener a tick to fire, then confirm the pid is gone from the
    // tracked set so a follow-on killAllChildren is a no-op.
    await pollUntil(() => !_liveChildPids().includes(pid as number), 2000);
    expect(_liveChildPids()).not.toContain(pid);
  });
});
