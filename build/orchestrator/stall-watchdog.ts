/**
 * Liveness-based stall detection for orchestrator sub-agents.
 *
 * Why this exists: replacing the old `execFile({ timeout })` model. The old
 * model killed a sub-agent after N total milliseconds regardless of whether
 * it was actively working. Long-running phases (Kimi at 25min, ship at 30min)
 * got killed mid-flight, then the same-budget retry killed again. Under
 * liveness semantics, we only kill processes that have gone silent for the
 * stall window. A sub-agent producing tool-use events or any stdout activity
 * runs as long as it needs.
 *
 * Two modes:
 *   - `stream`: subscribes to a ChildProcess's stdout/stderr line streams.
 *     Any non-empty line resets the activity timer. Used for the standard
 *     execFile/spawn call sites where the orchestrator owns the streams.
 *   - `mtime`: polls a file's mtime at 1s intervals. Used for call sites
 *     that pipe the child's stdout to a file descriptor directly (no Node
 *     stream available), like drain-faults.ts:545's `stdio: ['ignore', out, out]`
 *     pattern. Matches monitor.ts:344-347's existing recentProcessActivity
 *     mechanism.
 *
 * Provider classifiers (`classifyClaudeLine` etc.) are stubbed in as pure
 * helpers. v1 of the watchdog uses the any-non-empty-line fallback for all
 * providers because current Claude/Gemini/Codex/Kimi invocations don't run
 * with `--output-format stream-json`. When that flips later, the classifiers
 * become the strict signal and the fallback degrades gracefully.
 */

import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";

export type Provider = "claude" | "gemini" | "codex" | "kimi" | "shell";

export type StallWatchdogMode =
  | { mode: "stream"; child: ChildProcess }
  | { mode: "mtime"; filePath: string };

export interface StallWatchdogOptions {
  /** Max milliseconds of silence before SIGTERM. */
  stallMs: number;
  /** Provider for tool-use classification. Currently informational; future use. */
  provider: Provider;
  /**
   * After SIGTERM is sent, wait this many ms before escalating to SIGKILL.
   * Default 5000.
   */
  gracePeriodMs?: number;
  /** Poll interval. Default 1000. */
  pollIntervalMs?: number;
  /**
   * Optional callback fired exactly once when the watchdog kills the process.
   * Receives the elapsed silence in ms at kill time.
   */
  onStallKill?: (silenceMs: number) => void;
  /**
   * Test hook: override now() and setInterval/clearInterval. Allows
   * deterministic time control in unit tests.
   */
  clock?: {
    now: () => number;
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /**
   * Test hook: file-stat function for mtime mode. Defaults to fs.statSync.
   * Tests can swap in a fake clock-driven stat.
   */
  statFn?: (filePath: string) => { mtimeMs: number };
}

export interface StallWatchdogController {
  /** True if the watchdog fired SIGTERM. */
  stallKilled: () => boolean;
  /** ms elapsed since the most recent activity reset. */
  silenceMs: () => number;
  /** Cancel the watchdog without killing the child. Idempotent. */
  stop: () => void;
}

/**
 * Trim then check non-empty. A line of only whitespace is NOT activity —
 * a stalled child whose buffer happens to flush blank lines shouldn't
 * keep itself alive forever.
 */
function isActivityLine(line: string): boolean {
  return line.trim().length > 0;
}

/**
 * Signal both the child (positive pid) AND its process group (negative pid).
 *
 * Why both: Bun's child_process module accepts `detached: true` but its
 * execFile shim sometimes doesn't actually setpgrp the child, so the group
 * signal returns ESRCH. spawn() works correctly. We send both signals and
 * swallow ESRCH/EPERM either way — at least one of the two will reach the
 * process tree.
 *
 * The group signal is important because most sub-agent binaries are shell
 * scripts that exec `sleep`/long-running children. A SIGTERM to the shell
 * alone doesn't propagate to its children — but a group signal does.
 */
function killProcessAndGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH (no such pgrp) or EPERM — fall through to positive-pid kill.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (already exited) or EPERM — the watchdog never throws.
  }
}

/**
 * Classify a Claude `--output-format stream-json` line. Returns true if the
 * line represents a tool_use content block or any structured event we'd
 * count as forward progress. Returns false for the empty/keepalive shapes.
 *
 * v1: not wired into the watchdog (Claude isn't invoked with stream-json
 * today). Kept here so the flip is a one-line change in the watchdog later.
 */
export function classifyClaudeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  try {
    const obj = JSON.parse(t);
    if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
      return obj.message.content.some(
        (c: { type?: string }) => c?.type === "tool_use",
      );
    }
    return obj?.type === "tool_use" || obj?.type === "result";
  } catch {
    return false;
  }
}

/** Gemini tool-use line shape. Reserved for future stream-json flip. */
export function classifyGeminiLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  try {
    const obj = JSON.parse(t);
    return obj?.type === "tool_use" || typeof obj?.tool_name === "string";
  } catch {
    return false;
  }
}

/** Codex tool-call line shape. Reserved for future stream-json flip. */
export function classifyCodexLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  try {
    const obj = JSON.parse(t);
    return obj?.type === "function_call" || obj?.type === "tool_call";
  } catch {
    return false;
  }
}

/** Kimi MCP line shape. Reserved for future stream-json flip. */
export function classifyKimiLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  try {
    const obj = JSON.parse(t);
    return obj?.method === "tools/call" || obj?.type === "tool_use";
  } catch {
    return false;
  }
}

/**
 * Attach a stall watchdog to a child process or a file's mtime.
 *
 * Returns a controller exposing stallKilled(), silenceMs(), stop().
 *
 * Internal contract: the watchdog NEVER throws. Any I/O failure inside the
 * polling loop is swallowed (the assumption being that if stat() fails on
 * the log file, the orchestrator has bigger problems — and the watchdog
 * shouldn't be the thing that crashes the parent).
 */
export function attachStallWatchdog(
  source: StallWatchdogMode,
  opts: StallWatchdogOptions,
): StallWatchdogController {
  const stallMs = opts.stallMs;
  const gracePeriodMs = opts.gracePeriodMs ?? 5000;
  // Default poll interval is 1s, but never more than half the stall window —
  // a 100ms stallMs with a 1s poll interval would miss the stall by 10x.
  // Floor at 10ms to avoid degenerate near-zero polling.
  const pollIntervalMs =
    opts.pollIntervalMs ?? Math.max(10, Math.min(1000, Math.floor(stallMs / 2)));
  const clock = opts.clock ?? {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown,
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  };
  const stat = opts.statFn ?? ((p: string) => fs.statSync(p));

  let lastActivityAt = clock.now();
  let stopped = false;
  let killed = false;
  let pollHandle: unknown = null;
  let killTimerHandle: unknown = null;

  // Track baseline mtime for mtime-mode so a pre-existing file's old mtime
  // doesn't immediately count as a stall.
  let lastSeenMtime: number | null = null;
  if (source.mode === "mtime") {
    try {
      lastSeenMtime = stat(source.filePath).mtimeMs;
    } catch {
      // File may not exist yet; that's fine — first poll will discover it.
      lastSeenMtime = null;
    }
  }

  const recordActivity = () => {
    lastActivityAt = clock.now();
  };

  const onLine = (chunk: Buffer | string) => {
    if (stopped) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Split on any newline; check each line for activity. A multi-line burst
    // resets the timer once (good — it's a single event in human terms).
    for (const line of text.split(/\r?\n/)) {
      if (isActivityLine(line)) {
        recordActivity();
        return;
      }
    }
  };

  if (source.mode === "stream") {
    source.child.stdout?.on("data", onLine);
    source.child.stderr?.on("data", onLine);
  }

  const poll = () => {
    if (stopped || killed) return;

    if (source.mode === "mtime") {
      try {
        const cur = stat(source.filePath).mtimeMs;
        if (lastSeenMtime === null || cur > lastSeenMtime) {
          lastSeenMtime = cur;
          recordActivity();
        }
      } catch {
        // File missing or unreadable; treat as no-update. Next poll retries.
      }
    }

    const silence = clock.now() - lastActivityAt;
    if (silence >= stallMs) {
      killed = true;
      try {
        opts.onStallKill?.(silence);
      } catch {
        // Callback errors are swallowed — caller's logging concern, not ours.
      }
      if (source.mode === "stream") {
        const pid = source.child.pid;
        if (typeof pid === "number") {
          killProcessAndGroup(pid, "SIGTERM");
          killTimerHandle = clock.setTimeout(() => {
            killProcessAndGroup(pid, "SIGKILL");
          }, gracePeriodMs);
        }
      }
      // In mtime mode the caller (drain-faults) owns the child handle and
      // does its own kill. We just signal via onStallKill and stop polling.
      stop();
    }
  };

  pollHandle = clock.setInterval(poll, pollIntervalMs);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pollHandle !== null) {
      clock.clearInterval(pollHandle);
      pollHandle = null;
    }
    if (killTimerHandle !== null) {
      clock.clearTimeout(killTimerHandle);
      killTimerHandle = null;
    }
    if (source.mode === "stream") {
      source.child.stdout?.off("data", onLine);
      source.child.stderr?.off("data", onLine);
    }
  };

  // Auto-stop when the child exits naturally — no point polling a dead pid.
  if (source.mode === "stream") {
    source.child.once("exit", stop);
    source.child.once("close", stop);
    source.child.once("error", stop);
  }

  return {
    stallKilled: () => killed,
    silenceMs: () => clock.now() - lastActivityAt,
    stop,
  };
}
