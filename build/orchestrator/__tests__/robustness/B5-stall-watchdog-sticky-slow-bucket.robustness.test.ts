/**
 * B5 — stall-watchdog sticky slow-bucket: a genuinely-hung slow tool kept
 * alive indefinitely by repeated classifiable TOOL_START lines.
 *
 * Failure mode (from BUILD_ROBUSTNESS_SUITE.md §B5): a sub-agent emits a
 * `slow`-bucket TOOL_START marker every 4 minutes and NEVER a TOOL_END. The
 * 4-minute cadence sits under BOTH gates that could fire:
 *   - progressGapMs (5 min): each marker refreshes lastClassifiedActivityAt,
 *     so the gap arm never reaches its threshold.
 *   - the slow tool-stall window (10 min): currentToolBucket stays "slow"
 *     (no TOOL_END to clear it), and each marker resets lastActivityAt, so
 *     the silence window never closes.
 * There is no ABSOLUTE cap on a single tool invocation, so the watchdog keeps
 * the process alive forever even though one tool call has been "running" for
 * 40+ minutes with no completion.
 *
 * DESIRED invariant (this spec): the watchdog eventually kills a single tool
 * invocation that never completes, within a bounded wall-clock window. Today
 * no such cap exists, so this block is committed as `describe.skip` — UNSKIP
 * WHEN B5 IS FIXED (the fix adds an absolute single-tool-invocation cap and
 * the [RED] block goes green).
 *
 * A second [PIN] block pins the behavior that is already correct and is the
 * reason the gap is subtle: the sticky-slow-bucket survival path the watchdog
 * implements TODAY. We pin it so a regression that broke slow-bucket survival
 * (e.g. dropping currentToolBucket persistence) is caught — that path is a
 * deliberate feature, not the bug. The bug is the MISSING upper bound on top
 * of it.
 *
 * See ./README.md for the PIN/RED protocol and ./helpers.ts for the fakes.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { attachStallWatchdog } from "../../stall-watchdog";
import type { ProgressEvent } from "../../subagent-progress-parser";
import type { StallWatchdogController } from "../../stall-watchdog";
import { makeFakeClock, makeFakeChild } from "./helpers";

// Fixture cadence/windows shared by both blocks. Mirrors the design's numbers.
const MARKER_INTERVAL_MS = 4 * 60_000; // 4 min — < progressGapMs and < slow window
const PROGRESS_GAP_MS = 5 * 60_000; // 5 min
const SLOW_WINDOW_MS = 10 * 60_000; // 10 min
const FAST_WINDOW_MS = 90_000; // 90 s
const LEGACY_STALL_MS = 60_000; // legacy fallback (irrelevant while bucket is set)
const TOTAL_FAKE_MS = 40 * 60_000; // 40 min of fake time

// A slow-bucket TOOL_START marker line. The parser maps exactly this line to
// a TOOL_START with bucket "slow" and never emits a TOOL_END (matching the
// stuck-tool fixture: the tool started but never completed).
const SLOW_MARKER = "TOOL_START_SLOW";
function slowToolStart(now: number): ProgressEvent {
  return { event: "TOOL_START", tool: "WebFetch", bucket: "slow", ts: now };
}
function parseSlowMarker(line: string, now: number): ProgressEvent | null {
  return line === SLOW_MARKER ? slowToolStart(now) : null;
}

// ---------------------------------------------------------------------------
// [PIN] The sticky-slow-bucket survival path the watchdog implements TODAY.
// This is correct, intended behavior (a slow tool legitimately running and
// re-announcing itself under both windows must NOT be killed). We pin it so a
// regression in slow-bucket persistence is caught. It is also the substrate
// the B5 gap rides on: the missing absolute cap, not this survival.
// ---------------------------------------------------------------------------
describe("[PIN] B5 sticky-slow-bucket survival is intentional", () => {
  let controller: StallWatchdogController | null = null;

  afterEach(() => {
    // Always tear down the watchdog so its (faked) poll interval is cleared.
    controller?.stop();
    controller = null;
  });

  it("repeated slow-bucket TOOL_START under both gates does NOT kill (today's behavior)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killCount = 0;

    controller = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: LEGACY_STALL_MS,
        provider: "shell",
        clock,
        onStallKill: () => {
          killCount += 1;
        },
        parseProgress: parseSlowMarker,
        toolStallMs: { fast: FAST_WINDOW_MS, slow: SLOW_WINDOW_MS },
        progressGapMs: PROGRESS_GAP_MS,
        // Phase A off — we want to exercise the Phase B tool-aware path, and
        // the first marker fires immediately (firstActivityAt set on tick 0).
        startupHangMs: 0,
      },
    );

    // First marker establishes the slow bucket and arms the gap detector.
    emitStdout(`${SLOW_MARKER}\n`);

    // Re-announce the slow tool every 4 minutes for the full 40-minute run.
    // 4min < progressGapMs (5min) AND 4min < slow window (10min), so under
    // current semantics neither the silence arm nor the gap arm ever fires.
    for (
      let elapsed = 0;
      elapsed < TOTAL_FAKE_MS;
      elapsed += MARKER_INTERVAL_MS
    ) {
      advance(MARKER_INTERVAL_MS);
      emitStdout(`${SLOW_MARKER}\n`);
    }

    // Today: survives the whole run. (This is the substrate the B5 gap lives
    // on — there is no absolute cap to ever stop a never-ending slow tool.)
    expect(controller.stallKilled()).toBe(false);
    expect(controller.killReason()).toBeUndefined();
    expect(killCount).toBe(0);
    // The sticky bucket is preserved as "slow" the entire time.
    expect(controller.lastBucket()).toBe("slow");
  });

  it("a true silence past the slow window still kills (silence arm intact)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();

    controller = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: LEGACY_STALL_MS,
        provider: "shell",
        clock,
        onStallKill: () => {},
        parseProgress: parseSlowMarker,
        toolStallMs: { fast: FAST_WINDOW_MS, slow: SLOW_WINDOW_MS },
        // Push the gap arm past the silence window so this test isolates the
        // tool-aware SILENCE kill (not progress_gap).
        progressGapMs: 30 * 60_000,
        startupHangMs: 0,
      },
    );

    // One slow marker, then go fully silent. With the bucket sticky at "slow",
    // the effective window is the 10-min slow window. Advancing past it must
    // trip the silence kill — proving the slow window is a real upper bound on
    // SILENCE (it just isn't an upper bound on a re-announcing tool).
    emitStdout(`${SLOW_MARKER}\n`);
    advance(SLOW_WINDOW_MS + 60_000); // 11 min of pure silence

    expect(controller.stallKilled()).toBe(true);
    expect(controller.killReason()).toBe("silence");
  });
});

// ---------------------------------------------------------------------------
// [RED] The desired invariant the watchdog does NOT satisfy today: an
// absolute cap on a single tool invocation. A slow tool that re-announces
// itself every 4 minutes for 40 minutes without ever emitting TOOL_END must
// eventually be killed. UNSKIP WHEN B5 IS FIXED.
// ---------------------------------------------------------------------------
describe("[RED→FIXED] B5 absolute single-tool-invocation cap", () => {
  let controller: StallWatchdogController | null = null;

  afterEach(() => {
    controller?.stop();
    controller = null;
  });

  it("kills a never-completing slow tool re-announcing under both gates within ~40min", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killCount = 0;
    let killSilenceMs: number | null = null;

    controller = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: LEGACY_STALL_MS,
        provider: "shell",
        clock,
        onStallKill: (s) => {
          killCount += 1;
          if (killSilenceMs === null) killSilenceMs = s;
        },
        parseProgress: parseSlowMarker,
        toolStallMs: { fast: FAST_WINDOW_MS, slow: SLOW_WINDOW_MS },
        progressGapMs: PROGRESS_GAP_MS,
        startupHangMs: 0,
        // The B5 fix: an opt-in absolute cap on a single uninterrupted tool
        // invocation. 30 min < the 40-min re-announce run, so the never-ending
        // slow tool is killed (killReason "tool_timeout") even though it keeps
        // the silence + progress-gap arms refreshed.
        maxToolInvocationMs: 30 * 60_000,
      },
    );

    // First marker: slow tool "starts" but will never end.
    emitStdout(`${SLOW_MARKER}\n`);

    // Re-announce every 4 minutes for 40 minutes. Under today's semantics this
    // keeps the watchdog alive forever (each marker refreshes both timers).
    // The DESIRED behavior is an absolute cap on a single tool invocation that
    // never sees TOOL_END — so by 40 minutes the watchdog MUST have killed.
    for (
      let elapsed = 0;
      elapsed < TOTAL_FAKE_MS;
      elapsed += MARKER_INTERVAL_MS
    ) {
      advance(MARKER_INTERVAL_MS);
      // Stop feeding markers once the (future) cap has fired, so the assertion
      // reads cleanly. Pre-fix this branch is never taken.
      if (!controller.stallKilled()) {
        emitStdout(`${SLOW_MARKER}\n`);
      }
    }

    // Desired: a single tool invocation cannot run unbounded. Pre-fix this
    // FAILS (the watchdog never kills) — which is exactly why the block is
    // committed as describe.skip until B5 is fixed.
    expect(controller.stallKilled()).toBe(true);
    expect(killCount).toBeGreaterThanOrEqual(1);
    expect(killSilenceMs).not.toBeNull();
  });
});
