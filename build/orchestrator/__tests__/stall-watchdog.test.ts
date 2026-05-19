import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  attachStallWatchdog,
  classifyClaudeLine,
  classifyGeminiLine,
  classifyCodexLine,
  classifyKimiLine,
} from "../stall-watchdog";
import type { ChildProcess } from "node:child_process";

// Fake clock + scheduler. Tests step time forward manually via `advance(ms)`.
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
  (child as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
  (child as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr = stderr;
  return {
    child,
    emitStdout: (s: string) => stdout.emit("data", s),
    emitStderr: (s: string) => stderr.emit("data", s),
    triggerExit: () => child.emit("exit"),
  };
}

describe("attachStallWatchdog (stream mode)", () => {
  it("does not kill when stdout emits lines faster than stallMs", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killSilence: number | null = null;
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 50,
        clock,
        onStallKill: (s) => {
          killSilence = s;
        },
      },
    );

    // Emit a line every 100ms for 1s. 100ms < 200ms stallMs → never killed.
    for (let i = 0; i < 10; i++) {
      advance(100);
      emitStdout(`tick ${i}\n`);
    }
    advance(50); // one more poll
    expect(ctrl.stallKilled()).toBe(false);
    expect(killSilence).toBeNull();
    ctrl.stop();
  });

  it("kills after stallMs of silence", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    let killSilence: number | null = null;
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
        onStallKill: (s) => {
          killSilence = s;
        },
      },
    );

    // No stdout activity. Advance 300ms — past stallMs.
    advance(300);
    expect(ctrl.stallKilled()).toBe(true);
    expect(killSilence).not.toBeNull();
    expect(killSilence!).toBeGreaterThanOrEqual(200);
    ctrl.stop();
  });

  it("escalates to SIGKILL after gracePeriodMs when child ignores SIGTERM", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 99999;

    const originalKill = process.kill;
    const signals: NodeJS.Signals[] = [];
    (process as unknown as { kill: typeof process.kill }).kill = ((
      _pid: number,
      sig?: NodeJS.Signals | number,
    ) => {
      if (typeof sig === "string") signals.push(sig);
      return true;
    }) as typeof process.kill;

    try {
      attachStallWatchdog(
        { mode: "stream", child },
        {
          stallMs: 200,
          provider: "shell",
          pollIntervalMs: 50,
          gracePeriodMs: 150,
          clock,
        },
      );

      advance(250); // past stallMs → SIGTERM fires
      expect(signals.filter((s) => s === "SIGTERM").length).toBeGreaterThan(0);
      expect(signals.filter((s) => s === "SIGKILL").length).toBe(0);

      advance(200); // past gracePeriodMs (150) → SIGKILL fires
      expect(signals.filter((s) => s === "SIGKILL").length).toBeGreaterThan(0);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("cancels SIGKILL escalation when child exits within grace period", () => {
    const { clock, advance } = makeFakeClock();
    const { child, triggerExit } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 99999;

    const originalKill = process.kill;
    const signals: NodeJS.Signals[] = [];
    (process as unknown as { kill: typeof process.kill }).kill = ((
      _pid: number,
      sig?: NodeJS.Signals | number,
    ) => {
      if (typeof sig === "string") signals.push(sig);
      return true;
    }) as typeof process.kill;

    try {
      attachStallWatchdog(
        { mode: "stream", child },
        {
          stallMs: 200,
          provider: "shell",
          pollIntervalMs: 50,
          gracePeriodMs: 5000,
          clock,
        },
      );

      advance(250); // SIGTERM fires
      expect(signals.filter((s) => s === "SIGTERM").length).toBeGreaterThan(0);

      triggerExit(); // child responds to SIGTERM and exits — should cancel SIGKILL
      advance(10_000); // way past gracePeriodMs
      expect(signals.filter((s) => s === "SIGKILL").length).toBe(0);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("never signals non-positive pids", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = -1;

    const originalKill = process.kill;
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    try {
      const ctrl = attachStallWatchdog(
        { mode: "stream", child },
        {
          stallMs: 200,
          provider: "shell",
          pollIntervalMs: 50,
          gracePeriodMs: 100,
          clock,
        },
      );

      advance(300);
      expect(ctrl.stallKilled()).toBe(true);
      expect(calls).toEqual([]);
      ctrl.stop();
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("empty/whitespace-only lines do NOT reset the timer", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
      },
    );

    // Emit only whitespace lines. Should still get killed.
    for (let i = 0; i < 4; i++) {
      advance(80);
      emitStdout("\n   \n  \t \n");
    }
    advance(50);
    expect(ctrl.stallKilled()).toBe(true);
    ctrl.stop();
  });

  it("stderr activity also resets the timer", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStderr } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
      },
    );

    for (let i = 0; i < 5; i++) {
      advance(100);
      emitStderr(`err line ${i}\n`);
    }
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("stop() halts polling and is idempotent", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
      },
    );

    ctrl.stop();
    expect(() => {
      ctrl.stop();
      ctrl.stop();
    }).not.toThrow();

    // After stop, advancing past stallMs must not flip stallKilled.
    advance(500);
    expect(ctrl.stallKilled()).toBe(false);
  });

  it("child exit triggers stop automatically", () => {
    const { clock, advance } = makeFakeClock();
    const { child, triggerExit } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
      },
    );

    triggerExit();
    advance(500); // would have killed if not stopped
    expect(ctrl.stallKilled()).toBe(false);
  });

  it("silenceMs() reflects elapsed time since last activity", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 10_000,
        provider: "shell",
        pollIntervalMs: 1000,
        gracePeriodMs: 100,
        clock,
      },
    );

    emitStdout("hello\n");
    advance(750);
    expect(ctrl.silenceMs()).toBe(750);
    emitStdout("again\n");
    expect(ctrl.silenceMs()).toBe(0);
    ctrl.stop();
  });
});

describe("attachStallWatchdog (mtime mode)", () => {
  it("does not kill when file mtime advances within stallMs", () => {
    const { clock, advance } = makeFakeClock();
    let curMtime = 1000;
    const statFn = () => ({ mtimeMs: curMtime });

    const ctrl = attachStallWatchdog(
      { mode: "mtime", filePath: "/fake/path" },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
        statFn,
      },
    );

    for (let i = 0; i < 10; i++) {
      advance(80);
      curMtime += 10; // file is being written
    }
    advance(50);
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("kills when file mtime stops advancing for stallMs", () => {
    const { clock, advance } = makeFakeClock();
    const curMtime = 1000;
    const statFn = () => ({ mtimeMs: curMtime }); // never advances

    let killSilence: number | null = null;
    const ctrl = attachStallWatchdog(
      { mode: "mtime", filePath: "/fake/path" },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
        statFn,
        onStallKill: (s) => {
          killSilence = s;
        },
      },
    );

    advance(500);
    expect(ctrl.stallKilled()).toBe(true);
    expect(killSilence!).toBeGreaterThanOrEqual(200);
    ctrl.stop();
  });

  it("missing file at start is fine — first appearance counts as activity", () => {
    const { clock, advance } = makeFakeClock();
    let exists = false;
    let mtime = 0;
    const statFn = () => {
      if (!exists) throw new Error("ENOENT");
      return { mtimeMs: mtime };
    };

    const ctrl = attachStallWatchdog(
      { mode: "mtime", filePath: "/fake/path" },
      {
        stallMs: 200,
        provider: "shell",
        pollIntervalMs: 50,
        gracePeriodMs: 100,
        clock,
        statFn,
      },
    );

    advance(100); // file still missing — silence accumulating
    exists = true;
    mtime = 1000;
    advance(60); // first poll after file appears → activity
    advance(100);
    mtime = 1500;
    advance(60);
    // We accumulated some silence before file existed, but after appearance
    // it gets reset. Total elapsed: 320ms, but no 200ms continuous silence.
    // EDIT: actually the silence WOULD be > 200 between t=0 (start) and
    // t=160 (file appears) was only 160ms < 200. So no kill.
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });
});

describe("provider classifiers", () => {
  it("classifyClaudeLine: tool_use content block → true", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    expect(classifyClaudeLine(line)).toBe(true);
  });

  it("classifyClaudeLine: text-only assistant block → false", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(classifyClaudeLine(line)).toBe(false);
  });

  it("classifyClaudeLine: non-JSON → false", () => {
    expect(classifyClaudeLine("plain text")).toBe(false);
    expect(classifyClaudeLine("")).toBe(false);
    expect(classifyClaudeLine("   ")).toBe(false);
  });

  it("classifyGeminiLine: tool_name field → true", () => {
    expect(classifyGeminiLine(JSON.stringify({ tool_name: "shell" }))).toBe(
      true,
    );
    expect(classifyGeminiLine(JSON.stringify({ type: "tool_use" }))).toBe(true);
  });

  it("classifyCodexLine: function_call type → true", () => {
    expect(classifyCodexLine(JSON.stringify({ type: "function_call" }))).toBe(
      true,
    );
    expect(classifyCodexLine(JSON.stringify({ type: "tool_call" }))).toBe(true);
    expect(classifyCodexLine(JSON.stringify({ type: "message" }))).toBe(false);
  });

  it("classifyKimiLine: tools/call method → true", () => {
    expect(classifyKimiLine(JSON.stringify({ method: "tools/call" }))).toBe(
      true,
    );
    expect(classifyKimiLine(JSON.stringify({ type: "tool_use" }))).toBe(true);
  });
});
