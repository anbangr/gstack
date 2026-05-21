import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import * as watchdog from "../stall-watchdog";
import type { ChildProcess } from "node:child_process";

/**
 * T12 + T13 + T16: Auth-prompt detection inside the stall watchdog.
 *
 * When a provider binary emits an interactive auth prompt (e.g. "Opening
 * authentication page in your browser..."), the watchdog must kill the
 * process immediately with killReason: "auth_required" instead of waiting
 * for the stall window to expire.
 */

// Fake ChildProcess — same helper pattern as stall-watchdog.test.ts.
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

// Fake clock — deterministic time control.
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

describe("AUTH_PROMPT_RE module-level constant", () => {
  test("T13: AUTH_PROMPT_RE is exported and compiled once at module load", () => {
    if (typeof (watchdog as any).AUTH_PROMPT_RE === "undefined") {
      expect(false).toBe(true);
      return;
    }
    const re1 = (watchdog as any).AUTH_PROMPT_RE;
    const re2 = (watchdog as any).AUTH_PROMPT_RE;
    expect(re1).toBe(re2); // same object reference
    expect(re1 instanceof RegExp).toBe(true);
  });
});

describe("attachStallWatchdog auth prompt detection", () => {
  test("T12: auth prompt stdout chunk triggers immediate kill with auth_required reason", () => {
    if (typeof (watchdog as any).AUTH_PROMPT_RE === "undefined") {
      expect(false).toBe(true);
      return;
    }

    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 99999;

    const originalKill = process.kill;
    const signals: Array<{ signal: NodeJS.Signals; reason?: string }> = [];
    (process as unknown as { kill: typeof process.kill }).kill = ((
      _pid: number,
      sig?: NodeJS.Signals | number,
    ) => {
      if (typeof sig === "string") {
        signals.push({ signal: sig });
      }
      return true;
    }) as typeof process.kill;

    try {
      const ctrl = watchdog.attachStallWatchdog(
        { mode: "stream", child },
        {
          stallMs: 10_000, // long stall window — auth kill must fire BEFORE this
          provider: "gemini",
          pollIntervalMs: 50,
          gracePeriodMs: 100,
          clock,
        },
      );

      // Emit an auth prompt. The watchdog must kill immediately, not wait 10s.
      emitStdout("Opening authentication page in your browser...\n");

      // Advance just one poll tick — enough for the detection loop to run.
      advance(100);

      expect(ctrl.stallKilled()).toBe(true);

      // The controller must expose the kill reason.
      const killReason =
        typeof (ctrl as any).killReason === "function"
          ? (ctrl as any).killReason()
          : undefined;
      expect(killReason).toBe("auth_required");

      ctrl.stop();
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  test("T16: GSTACK_DISABLE_AUTH_PROMPT_DETECTOR=1 disables regex testing", () => {
    if (typeof (watchdog as any).AUTH_PROMPT_RE === "undefined") {
      expect(false).toBe(true);
      return;
    }

    const prevEnv = process.env.GSTACK_DISABLE_AUTH_PROMPT_DETECTOR;
    process.env.GSTACK_DISABLE_AUTH_PROMPT_DETECTOR = "1";

    try {
      const { clock, advance } = makeFakeClock();
      const { child, emitStdout } = makeFakeChild();
      (child as unknown as { pid: number }).pid = 99999;

      const originalKill = process.kill;
      let killCalled = false;
      (process as unknown as { kill: typeof process.kill }).kill = (() => {
        killCalled = true;
        return true;
      }) as typeof process.kill;

      try {
        const ctrl = watchdog.attachStallWatchdog(
          { mode: "stream", child },
          {
            stallMs: 200,
            provider: "gemini",
            pollIntervalMs: 50,
            gracePeriodMs: 100,
            clock,
          },
        );

        // Emit auth prompt text. With the detector disabled, this should NOT
        // trigger an immediate auth kill.
        emitStdout("Please authenticate to continue\n");
        advance(100);

        // Must NOT have killed for auth reasons.
        // stallKilled may still be false because we haven't reached stallMs.
        expect(ctrl.stallKilled()).toBe(false);
        expect(killCalled).toBe(false);

        ctrl.stop();
      } finally {
        (process as unknown as { kill: typeof process.kill }).kill =
          originalKill;
      }
    } finally {
      if (prevEnv === undefined) delete process.env.GSTACK_DISABLE_AUTH_PROMPT_DETECTOR;
      else process.env.GSTACK_DISABLE_AUTH_PROMPT_DETECTOR = prevEnv;
    }
  });

  test("auth prompt on stderr also triggers kill", () => {
    if (typeof (watchdog as any).AUTH_PROMPT_RE === "undefined") {
      expect(false).toBe(true);
      return;
    }

    const { clock, advance } = makeFakeClock();
    const { child, emitStderr } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 99999;

    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = (() =>
      true) as typeof process.kill;

    try {
      const ctrl = watchdog.attachStallWatchdog(
        { mode: "stream", child },
        {
          stallMs: 10_000,
          provider: "gemini",
          pollIntervalMs: 50,
          gracePeriodMs: 100,
          clock,
        },
      );

      emitStderr("Token expired. Sign in with Google to continue.\n");
      advance(100);

      expect(ctrl.stallKilled()).toBe(true);
      ctrl.stop();
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });
});
