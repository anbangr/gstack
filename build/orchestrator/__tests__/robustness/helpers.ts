/**
 * Shared deterministic fakes for the `build-robustness` suite.
 *
 * The robustness specs simulate a *long autonomous build* (many ticks, repeated
 * stalls, multi-hour wall-clock, hard kills) in milliseconds by faking time,
 * spawn, and disk. Nothing here touches a real LLM, a real network, or a real
 * long-lived process. These fakes are lifted from the existing
 * `auth-prompt-watchdog.test.ts` / `stall-watchdog.test.ts` patterns and
 * centralized so every spec uses the same seam.
 *
 * See ./README.md for the PIN vs RED protocol.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * Fake ChildProcess for stall-watchdog specs. Same shape as the local helper
 * in auth-prompt-watchdog.test.ts. Deliberately leaves `pid` undefined so the
 * watchdog's kill branch (`typeof pid === "number"`) is skipped and no real
 * `process.kill` is ever issued — `stallKilled()`/`killReason()` still flip.
 */
export function makeFakeChild(): {
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

export interface FakeClock {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

/**
 * Deterministic clock with manual time advance. `advance(ms)` fires every
 * interval/timeout that comes due in [now, now+ms], in chronological order,
 * exactly like the helper in auth-prompt-watchdog.test.ts.
 */
export function makeFakeClock(): {
  clock: FakeClock;
  advance: (ms: number) => void;
} {
  let now = 0;
  type Timer = { fn: () => void; interval: number; nextAt: number; id: number };
  type OneShot = { fn: () => void; at: number; id: number };
  const intervals = new Map<number, Timer>();
  const timeouts = new Map<number, OneShot>();
  let nextId = 1;

  const clock: FakeClock = {
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
    for (let i = 0; i < 100_000; i++) {
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

/** Make an isolated temp dir under the OS tmpdir. Caller removes it. */
export function mkTmp(prefix = "gstack-robustness-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Write an executable shell script (mode 0755). Used by the counter-file
 * provider-binary pattern from gemini-auth-preflight.test.ts — point
 * GEMINI_BIN/CODEX_BIN at the script and drive its behavior from a counter.
 */
export function writeExecutable(filePath: string, script: string): string {
  fs.writeFileSync(filePath, script, { mode: 0o755 });
  return filePath;
}

/**
 * Counter-file harness: returns a script body that increments a counter file
 * on each invocation and runs `bodyByCall(n)` to decide per-call behavior.
 * Pattern mirrors gemini-auth-preflight.test.ts:103-118.
 */
export function counterScript(
  counterFile: string,
  perCallBash: string,
): string {
  return `#!/bin/bash\nn=$(cat "${counterFile}")\necho $((n + 1)) > "${counterFile}"\n${perCallBash}\n`;
}
