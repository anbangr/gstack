/**
 * B4 — cpu-watchdog-transient-probe-flake  [PIN]  (smoke)
 *
 * Pins the CURRENT correct behavior of the cpu-mode stall watchdog's
 * null-sample handling, the long-run failure mode that the rest of the
 * watchdog tests never exercise across many flaky probe ticks:
 *
 *   - `attachStallWatchdog({ mode: "cpu", child })` with an injected
 *     `sampleCpuFn` returning a `Map<pid, cpuMs>` of increasing cputime on
 *     MOST ticks and `null` on SCATTERED ticks (ps flake on a loaded host).
 *   - Invariant 1: scattered `null` probe samples interleaved with
 *     positive-delta samples do NOT trip `stallKilled()` — because the
 *     positive samples keep resetting the activity timer and the `null`
 *     ticks are "no signal", not "no activity". A healthy, silent-by-design
 *     agent must not be false-killed by ps flakiness.
 *   - Invariant 2: a CONTINUOUS run of `null` samples past `stallMs` DOES
 *     kill — a `null` sample never resets the timer, so once probes stop
 *     showing forward CPU progress the silence accumulates and the watchdog
 *     fires (the deadlocked-group / dead-group signature).
 *
 * Verified against the cpu poll branch in stall-watchdog.ts: a `null` sample
 * is `"no signal this tick"` and falls through to the silence check; only a
 * positive per-pid CPU delta (or a fresh pid with cpuMs > 0) calls
 * `recordActivity()`. The kill fires when `silence >= effectiveStallMs`.
 *
 * `makeFakeChild()` leaves `child.pid` undefined, so the watchdog's kill
 * branch (`typeof pid === "number"`) is skipped and NO real `process.kill`
 * is ever issued — `stallKilled()` still flips. The injected `sampleCpuFn`
 * ignores the pid argument, so the undefined pid is irrelevant to sampling.
 *
 * See docs/designs/BUILD_ROBUSTNESS_SUITE.md §B4 and ./README.md (PIN/RED).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { attachStallWatchdog } from "../../stall-watchdog";
import { makeFakeClock, makeFakeChild } from "./helpers";

// Single-pid Map helper, mirroring the idiom in stall-watchdog.test.ts.
const single = (pidNum: number, cpuMs: number) =>
  new Map<number, number>([[pidNum, cpuMs]]);

const LEADER_PID = 12345;

describe("[PIN] B4 cpu-watchdog transient probe flake", () => {
  // Track live controllers so afterEach can stop the poll loop even if an
  // assertion throws mid-test. Each watchdog uses the fake clock, so this
  // only releases the in-test interval bookkeeping (no real timers/processes).
  let controllers: { stop: () => void }[] = [];

  beforeEach(() => {
    controllers = [];
  });

  afterEach(() => {
    for (const c of controllers) {
      try {
        c.stop();
      } catch {
        // Idempotent stop; nothing to clean up if it already ran.
      }
    }
    controllers = [];
  });

  it("scattered null probe samples between positive samples do NOT trip stallKilled()", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    // Leave child.pid undefined on purpose (see file header): no real kill.

    // Healthy long run: CPU climbs every tick, EXCEPT scattered ticks where
    // ps flakes and returns null. The null ticks are interleaved between
    // positive-delta ticks, so the silence timer never accumulates past
    // stallMs. Flake every 3rd poll — well inside the stall window.
    let cpuMs = 100; // fresh pid starts non-zero so first sighting = activity
    let polls = 0;
    let nullSamples = 0;
    const sampleCpuFn = () => {
      polls += 1;
      // Scattered flake: every 3rd probe returns null (loaded-host ps flake).
      if (polls % 3 === 0) {
        nullSamples += 1;
        return null;
      }
      cpuMs += 50;
      return single(LEADER_PID, cpuMs);
    };

    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "kimi",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        // Disable Phase A so the legacy stallMs window is the only gate; the
        // first positive sample would exit Phase A anyway, but pinning it off
        // keeps this test about the null-flake invariant, not startup.
        startupHangMs: 0,
        clock,
        sampleCpuFn,
      },
    );
    controllers.push(ctrl);

    // Run for a long simulated stretch (3s of fake time = 30 polls), with
    // ~10 scattered null samples sprinkled between positive-delta samples.
    advance(3000);

    // The positive-delta samples on the non-flaky ticks keep resetting the
    // activity timer; the scattered nulls are "no signal", never long enough
    // in a row to exhaust stallMs.
    expect(ctrl.stallKilled()).toBe(false);
    expect(ctrl.killReason()).toBeUndefined();
    // Sanity: we actually exercised the null branch (otherwise this would be
    // a tautology that proves nothing about flake handling).
    expect(nullSamples).toBeGreaterThan(1);
  });

  it("a continuous run of null past stallMs DOES kill", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    // child.pid undefined: kill branch is a no-op, stallKilled() still flips.

    let killSilence: number | null = null;
    // First few probes show forward CPU progress (healthy), then ps starts
    // returning null on every call — the dead/deadlocked-group signature.
    // A continuous null run never resets the timer, so silence accumulates
    // from the last positive sample and the kill fires once it crosses
    // stallMs.
    let cpuMs = 100;
    let polls = 0;
    const sampleCpuFn = () => {
      polls += 1;
      if (polls <= 3) {
        cpuMs += 50;
        return single(LEADER_PID, cpuMs);
      }
      // Continuous flake from poll 4 onward.
      return null;
    };

    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "kimi",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        startupHangMs: 0,
        clock,
        sampleCpuFn,
        onStallKill: (s) => {
          killSilence = s;
        },
      },
    );
    controllers.push(ctrl);

    // Polls 1-3 (t=100,200,300) record activity; from poll 4 (t=400) on, every
    // probe is null. Advancing well past the last positive sample + stallMs
    // lets the silence window trip.
    advance(1000);

    expect(ctrl.stallKilled()).toBe(true);
    // Legacy silence kill (no parseProgress, not in Phase A) → "stall".
    expect(ctrl.killReason()).toBe("stall");
    expect(killSilence).not.toBeNull();
    expect(killSilence!).toBeGreaterThanOrEqual(300);
  });
});
