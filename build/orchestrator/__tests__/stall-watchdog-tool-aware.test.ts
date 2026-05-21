import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { attachStallWatchdog } from "../stall-watchdog";
import type { ProgressEvent } from "../subagent-progress-parser";
import type { ChildProcess } from "node:child_process";

// COPIED VERBATIM from stall-watchdog.test.ts (lines 14-114). These
// helpers are not exported from the test module; copying is the
// established pattern for this test suite.
function makeFakeClock() {
  let now = 0;
  type Timer = { fn: () => void; interval: number; nextAt: number; id: number };
  type OneShot = { fn: () => void; at: number; id: number };
  const intervals = new Map<number, Timer>();
  const timeouts = new Map<number, OneShot>();
  let nextId = 1;

  const clock = {
    now: () => now,
    setInterval: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      intervals.set(id, { fn, interval: ms, nextAt: now + ms, id });
      return id;
    },
    clearInterval: (h: unknown) => {
      intervals.delete(h as number);
    },
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timeouts.set(id, { fn, at: now + ms, id });
      return id;
    },
    clearTimeout: (h: unknown) => {
      timeouts.delete(h as number);
    },
  };

  const advance = (ms: number) => {
    const target = now + ms;
    // Drain all timers (interval + oneshot) in chronological order.
    // Iterate until no due timer remains within [now, target].
    // Cap at 10k iterations as a safety against runaway re-arming.
    for (let i = 0; i < 10_000; i++) {
      let dueIntervalId: number | null = null;
      let dueIntervalAt = Infinity;
      for (const t of intervals.values()) {
        if (t.nextAt <= target && t.nextAt < dueIntervalAt) {
          dueIntervalAt = t.nextAt;
          dueIntervalId = t.id;
        }
      }
      let dueOneShotId: number | null = null;
      let dueOneShotAt = Infinity;
      for (const t of timeouts.values()) {
        if (t.at <= target && t.at < dueOneShotAt) {
          dueOneShotAt = t.at;
          dueOneShotId = t.id;
        }
      }
      if (dueIntervalId === null && dueOneShotId === null) break;
      if (
        dueOneShotId !== null &&
        (dueIntervalId === null || dueOneShotAt < dueIntervalAt)
      ) {
        const t = timeouts.get(dueOneShotId)!;
        now = t.at;
        timeouts.delete(dueOneShotId);
        t.fn();
      } else if (dueIntervalId !== null) {
        const t = intervals.get(dueIntervalId)!;
        now = t.nextAt;
        t.nextAt += t.interval;
        t.fn();
      }
    }
    now = target;
  };

  return { clock, advance };
}

// Fake ChildProcess: an EventEmitter with stdout/stderr emitters and no real pid.
// We don't actually kill anything; we just verify the watchdog signaled.
function makeFakeChild(): {
  child: ChildProcess;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  triggerExit: () => void;
} {
  const stdout = new EventEmitter() as EventEmitter & {
    on(event: "data", listener: (chunk: Buffer | string) => void): EventEmitter;
    off(
      event: "data",
      listener: (chunk: Buffer | string) => void,
    ): EventEmitter;
  };
  const stderr = new EventEmitter() as typeof stdout;
  const child = new EventEmitter() as ChildProcess;
  (child as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout =
    stdout;
  (child as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr =
    stderr;
  return {
    child,
    emitStdout: (s: string) => stdout.emit("data", s),
    emitStderr: (s: string) => stderr.emit("data", s),
    triggerExit: () => child.emit("exit"),
  };
}

function slowToolStart(now: number): ProgressEvent {
  return { event: "TOOL_START", tool: "WebFetch", bucket: "slow", ts: now };
}
function fastToolStart(now: number): ProgressEvent {
  return { event: "TOOL_START", tool: "Edit", bucket: "fast", ts: now };
}

describe("attachStallWatchdog tool-aware", () => {
  it("slow bucket survives 8min of silence (slow window is 10min)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killed = false;

    const w = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 60_000, // legacy 60s — irrelevant once slow bucket is active
        provider: "shell",
        clock,
        onStallKill: () => {
          killed = true;
        },
        parseProgress: (line) =>
          line === "TOOL_START_SLOW" ? slowToolStart(clock.now()) : null,
        toolStallMs: { fast: 90_000, slow: 600_000 },
        // progressGapMs must exceed the 8-min test window so the gap arm
        // doesn't fire before the slow silence window (10min) does.
        progressGapMs: 900_000, // 15 min
      },
    );

    emitStdout("TOOL_START_SLOW\n");
    advance(8 * 60_000); // 8 minutes
    expect(killed).toBe(false);
    expect(w.stallKilled()).toBe(false);

    w.stop();
  });

  it("fast bucket kills at 90s with killReason=silence", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killedSilenceMs: number | null = null;

    const w = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 60_000,
        provider: "shell",
        clock,
        onStallKill: (s) => {
          killedSilenceMs = s;
        },
        parseProgress: (line) =>
          line === "TOOL_START_FAST" ? fastToolStart(clock.now()) : null,
        toolStallMs: { fast: 90_000, slow: 600_000 },
        progressGapMs: 300_000,
      },
    );

    emitStdout("TOOL_START_FAST\n");
    advance(120_000); // 120s — past the 90s fast window

    expect(w.stallKilled()).toBe(true);
    expect(killedSilenceMs).not.toBeNull();
    expect(killedSilenceMs! >= 90_000).toBe(true);
    expect(w.killReason()).toBe("silence");

    w.stop();
  });

  it("kills with killReason=progress_gap when noisy stdout has no parsed events", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killedSilenceMs: number | null = null;

    const w = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 60_000,
        provider: "shell",
        clock,
        onStallKill: (s) => {
          killedSilenceMs = s;
        },
        parseProgress: (line) =>
          line === "TOOL_START_FAST" ? fastToolStart(clock.now()) : null,
        toolStallMs: { fast: 90_000, slow: 600_000 },
        progressGapMs: 300_000, // 5 min
      },
    );

    // Seed a classified event so the gap detector is "armed".
    emitStdout("TOOL_START_FAST\n");
    // Now emit noisy non-classified lines every 30s for 6 minutes. The
    // stdout chunks keep lastActivityAt fresh (so legacy stallMs never
    // trips), but parseProgress returns null for "noise" so
    // lastClassifiedActivityAt is frozen. After progressGapMs (5min)
    // the gap arm MUST fire even though stdout is healthy.
    //
    // Note: currentToolBucket stays "fast" the whole time (no TOOL_END
    // event in this fixture). Fast window is 90s, but noisy stdout
    // resets lastActivityAt every chunk, so the fast window never
    // closes. That's the bug we're testing — the gap detector must
    // still fire even with bucket="fast" and fresh lastActivityAt.

    for (let i = 0; i < 12; i++) {
      advance(30_000); // 30s
      emitStdout("noise\n");
    }
    // 12 * 30s = 360s = 6 min. Gap threshold is 5 min, so the watchdog
    // should have fired between minute 5 and minute 6.

    expect(w.stallKilled()).toBe(true);
    expect(w.killReason()).toBe("progress_gap");
    expect(killedSilenceMs).not.toBeNull();

    w.stop();
  });
});
