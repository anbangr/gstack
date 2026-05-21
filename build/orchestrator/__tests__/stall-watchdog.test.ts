import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  attachStallWatchdog,
  classifyClaudeLine,
  classifyGeminiLine,
  classifyCodexLine,
  classifyKimiLine,
  parseCpuTime,
  sampleProcessTreeCpuMs,
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

describe("parseCpuTime", () => {
  it("parses MM:SS to ms", () => {
    expect(parseCpuTime("00:00")).toBe(0);
    expect(parseCpuTime("00:01")).toBe(1000);
    expect(parseCpuTime("01:30")).toBe(90_000);
  });

  it("parses HH:MM:SS to ms", () => {
    expect(parseCpuTime("01:00:00")).toBe(3_600_000);
    expect(parseCpuTime("00:02:30")).toBe(150_000);
  });

  it("parses fractional seconds", () => {
    expect(parseCpuTime("00:00.50")).toBe(500);
    expect(parseCpuTime("01:30.25")).toBe(90_250);
  });

  it("returns 0 on garbage input rather than throwing", () => {
    expect(parseCpuTime("")).toBe(0);
    expect(parseCpuTime("not a time")).toBe(0);
    expect(parseCpuTime("01")).toBe(0);
    expect(parseCpuTime("01:02:03:04")).toBe(0);
    expect(parseCpuTime("aa:bb")).toBe(0);
  });

  it("trims surrounding whitespace from ps output cells", () => {
    expect(parseCpuTime("    00:42   ")).toBe(42_000);
  });

  it("parses Linux procps DD-HH:MM:SS format (≥1 day of CPU)", () => {
    // procps emits `1-02:30:45` once a process accumulates ≥24h of cputime.
    // Pre-fix this produced NaN and a silent 0-ms reading — a long-lived
    // pair-agent shell would look frozen forever to the cpu-mode watchdog.
    expect(parseCpuTime("1-00:00:00")).toBe(86_400_000); // exactly 1 day
    expect(parseCpuTime("1-02:30:45")).toBe(
      (86_400 + 2 * 3600 + 30 * 60 + 45) * 1000,
    );
    expect(parseCpuTime("7-12:34:56")).toBe(
      (7 * 86_400 + 12 * 3600 + 34 * 60 + 56) * 1000,
    );
  });

  it("rejects malformed DD- prefix without throwing", () => {
    expect(parseCpuTime("-01:00")).toBe(0); // empty days
    expect(parseCpuTime("abc-01:00:00")).toBe(0); // non-numeric days
    expect(parseCpuTime("-1-00:00:00")).toBe(0); // negative days
  });
});

describe("sampleProcessTreeCpuMs", () => {
  it("returns null for invalid pid inputs without throwing", () => {
    expect(sampleProcessTreeCpuMs(undefined)).toBeNull();
    expect(sampleProcessTreeCpuMs(0)).toBeNull();
    expect(sampleProcessTreeCpuMs(-1)).toBeNull();
    expect(sampleProcessTreeCpuMs(1.5)).toBeNull();
  });

  it("returns null when the process group has no live members", () => {
    // pid 2**22 - 1 is well above any realistic live pid; ps will return
    // either an empty body or "ESRCH"-like error. Either way we want null,
    // not a fake empty map that would count as "no activity" forever.
    const result = sampleProcessTreeCpuMs(4_194_303);
    expect(result).toBeNull();
  });

  it("returns a Map<pid, cpuMs> for the current process group", () => {
    // `process.pid` is alive and accumulating CPU; sampling its group
    // should yield a Map containing at least one entry (or null on
    // platforms where `ps -g` isn't available — we accept either, but
    // the call must not throw).
    const result = sampleProcessTreeCpuMs(process.pid);
    if (result !== null) {
      expect(result instanceof Map).toBe(true);
      expect(result.size).toBeGreaterThanOrEqual(1);
      for (const [pidNum, cpuMs] of result) {
        expect(Number.isInteger(pidNum)).toBe(true);
        expect(pidNum).toBeGreaterThan(0);
        expect(cpuMs).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(cpuMs)).toBe(true);
      }
    }
  });
});

describe("attachStallWatchdog (cpu mode)", () => {
  // Helper: build a single-pid Map for the most common test shape.
  const single = (pidNum: number, cpuMs: number) =>
    new Map<number, number>([[pidNum, cpuMs]]);

  it("does not kill while the leader pid's CPU keeps increasing", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    let cpuMs = 0;
    const sampleCpuFn = () => {
      // Healthy long run burning CPU continuously, like a Kimi review
      // thinking through a hard problem with no stdout output.
      cpuMs += 50;
      return single(12345, cpuMs);
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 500,
        provider: "kimi",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    advance(2500);
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("kills when leader CPU is flat and no stdout activity", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    let killSilence: number | null = null;
    // CPU stays at same value forever — process alive (ps finds it) but
    // doing nothing. This is the deadlocked-MCP-call signature.
    const sampleCpuFn = () => single(12345, 12_345);
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "kimi",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
        onStallKill: (s) => {
          killSilence = s;
        },
      },
    );
    advance(400);
    expect(ctrl.stallKilled()).toBe(true);
    expect(killSilence).not.toBeNull();
    expect(killSilence!).toBeGreaterThanOrEqual(300);
    ctrl.stop();
  });

  it("stdout activity still resets the timer in cpu mode (safety net)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    // CPU flat — would normally trip — but stdout emits periodically.
    // Models a sub-agent blocked on a slow syscall (low CPU) that still
    // streams a status line every so often.
    const sampleCpuFn = () => single(12345, 100);
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "claude",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    for (let i = 0; i < 5; i++) {
      advance(150);
      emitStdout(`progress ${i}\n`);
    }
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("treats null sampleCpuFn results as no-activity (no false reset)", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    // ps fails every call (platform quirk, group already gone, etc).
    // Null must NOT count as activity — otherwise a dead group would
    // mask itself forever.
    const sampleCpuFn = () => null;
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    advance(400);
    expect(ctrl.stallKilled()).toBe(true);
    ctrl.stop();
  });

  it("does not double-count the first sample as a delta (same value → kill)", () => {
    // Identical per-pid readings across all polls must NOT count as
    // activity. First sighting with non-zero cputime IS recorded as
    // activity (a process that's already accumulated CPU was clearly
    // working at some point), but the second identical sample is not.
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    const sampleCpuFn = () => single(12345, 500); // same value every time
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    // First poll at t=100 records activity (fresh pid with cpuMs>0).
    // Subsequent polls at 200/300 are identical → no activity. silence
    // accumulates from t=100. Kill expected somewhere between t=400-500.
    advance(600);
    expect(ctrl.stallKilled()).toBe(true);
    ctrl.stop();
  });

  it("auto-stops on child exit (no kill, no further sampling)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, triggerExit } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    let sampleCalls = 0;
    const sampleCpuFn = () => {
      sampleCalls += 1;
      return null; // would otherwise trip the stall
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    advance(150);
    triggerExit();
    const callsAtExit = sampleCalls;
    advance(1000); // way past stallMs

    expect(ctrl.stallKilled()).toBe(false);
    expect(sampleCalls).toBe(callsAtExit);
    ctrl.stop();
  });

  it("group shrink does NOT trip kill (helper exits, leader keeps working)", () => {
    // Regression: a kimi entry shell forks a short-lived helper, then
    // settles into the long-running LLM call. Helper exits and its
    // cputime disappears from the group, which previously dropped the
    // sum and tripped stallMs against the healthy surviving leader.
    // New per-pid design: ignore disappearing pids, count any positive
    // delta on any surviving pid as activity.
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    let leaderCpu = 200;
    let polls = 0;
    const sampleCpuFn = () => {
      polls += 1;
      const map = new Map<number, number>();
      map.set(12345, leaderCpu); // leader
      if (polls <= 2) {
        // Helper is alive for the first two polls with high cputime.
        map.set(12346, 9800);
      }
      // Leader keeps climbing slowly even after helper exits.
      leaderCpu += 30;
      return map;
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "kimi",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    // Run 6x stallMs. At t=300, helper exits — sum drops from
    // (10000) to (290). Old code would kill here. New code sees
    // leader still climbing → no kill.
    advance(1800);
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("null sample then valid sample resets the activity timer", () => {
    // Coverage gap from the prior review: tests covered constant-null
    // and constant-valid, but not the null → valid transition. The
    // first non-null sample with positive cputime must count as
    // activity to avoid spurious kills during ps warm-up.
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    let cpuMs = 100;
    let n = 0;
    const sampleCpuFn = () => {
      const tick = n++;
      if (tick === 0) return null; // first poll: ps wasn't ready
      cpuMs += 50;
      return single(12345, cpuMs);
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "kimi",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    advance(800);
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("concurrent CPU + stdout activity both keep the timer alive", () => {
    // Defense-in-depth: cpu-mode keeps the stream listener as a
    // safety net. With both signals firing, the watchdog must
    // tolerate them without double-counting or crashing.
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    let cpuMs = 0;
    const sampleCpuFn = () => {
      cpuMs += 20;
      return single(12345, cpuMs);
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "claude",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    for (let i = 0; i < 10; i++) {
      advance(150);
      emitStdout(`x ${i}\n`);
    }
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("fresh pid with zero cputime is NOT activity (avoids cheap-fork false reset)", () => {
    // Edge case: a process that just spawned and hasn't been
    // scheduled yet shows up with cputime=0. Appearing alone is
    // not proof of work; only a positive cputime counts. This
    // prevents a fork-storm of zero-cputime helpers from
    // continuously resetting the watchdog timer on a deadlocked
    // parent.
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    // Leader is deadlocked at cputime=100. Each poll, a new
    // zero-cputime helper appears with a different pid. None of
    // them advance any cputime.
    let helperPidCounter = 20000;
    const sampleCpuFn = () => {
      const map = new Map<number, number>();
      map.set(12345, 100);
      map.set(helperPidCounter++, 0);
      return map;
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 300,
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
      },
    );
    advance(400);
    expect(ctrl.stallKilled()).toBe(true);
    ctrl.stop();
  });
});
