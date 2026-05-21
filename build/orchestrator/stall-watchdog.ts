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
 * Three modes:
 *   - `stream`: subscribes to a ChildProcess's stdout/stderr line streams.
 *     Any non-empty line resets the activity timer. Used for the standard
 *     execFile/spawn call sites where the orchestrator owns the streams.
 *   - `mtime`: polls a file's mtime at 1s intervals. Used for call sites
 *     that pipe the child's stdout to a file descriptor directly (no Node
 *     stream available), like drain-faults.ts:545's `stdio: ['ignore', out, out]`
 *     pattern. Matches monitor.ts:344-347's existing recentProcessActivity
 *     mechanism.
 *   - `cpu`: keeps the `stream` stdout/stderr listeners AND polls kernel CPU
 *     time for the child's process group via `sampleCpuFn`. Non-zero stdout
 *     OR positive CPU delta resets the activity timer. Designed for sub-agents
 *     that run silently by design (e.g., `kimi --print --final-message-only`,
 *     `codex exec` without `--json`): a healthy run still burns CPU every
 *     scheduler tick; a deadlocked process accumulates none. CPU is the
 *     canonical signal, stdout is the safety net for blocking-syscall cases.
 *
 * Provider classifiers (`classifyClaudeLine` etc.) are stubbed in as pure
 * helpers. v1 of the watchdog uses the any-non-empty-line fallback for all
 * providers because current Claude/Gemini/Codex/Kimi invocations don't run
 * with `--output-format stream-json`. When that flips later, the classifiers
 * become the strict signal and the fallback degrades gracefully.
 */

import * as fs from "node:fs";
import { spawnSync, type ChildProcess } from "./child-registry";

export type Provider = "claude" | "gemini" | "codex" | "kimi" | "shell";

export type StallWatchdogMode =
  | { mode: "stream"; child: ChildProcess }
  | { mode: "mtime"; filePath: string }
  | { mode: "cpu"; child: ChildProcess };

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
  /**
   * Test hook: CPU-time sampler for cpu mode. Receives the child pid (also
   * used as pgid since children are spawned detached). Returns a `Map<pid,
   * cpuMs>` of every live process in the group, or null when the group is
   * gone / the platform call failed. The watchdog resets the activity timer
   * whenever ANY pid in the new map shows a positive CPU delta vs the prior
   * sample (or appears for the first time with a positive value). Null is
   * NOT treated as activity. Defaults to a `ps -o pid=,cputime= -g <pgid>`
   * shell-out implemented in `sampleProcessTreeCpuMs`.
   */
  sampleCpuFn?: (pid: number | undefined) => Map<number, number> | null;
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
export function killProcessAndGroup(pid: number, signal: NodeJS.Signals): void {
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
 * Parse a `ps -o cputime=` cell. The cell shape is `[DD-][HH:]MM:SS[.ss]`.
 * Linux procps emits a leading `DD-` (days) when a process has accumulated
 * ≥1 day of CPU; pre-fix that produced NaN and a silent 0-ms reading, which
 * meant a long-lived pair-agent shell would look frozen forever to the
 * watchdog. macOS BSD ps stays in `[HH:]MM:SS` even past 24h, so the
 * days branch only fires on Linux. Returns milliseconds. Unparseable input
 * returns 0 (counts as no activity), never throws — the watchdog must not
 * crash on a weird ps line.
 */
export function parseCpuTime(raw: string): number {
  let s = raw.trim();
  if (!s) return 0;
  // Reject leading-minus inputs early. A bare `-01:00` would otherwise
  // parse `Number("-01") * 60` as -60 seconds; we don't want negative
  // cputime sneaking into the activity-delta math (it would falsely
  // satisfy `cur > prior` on the next sample and reset the watchdog).
  if (s.startsWith("-")) return 0;
  let days = 0;
  const dashIdx = s.indexOf("-");
  if (dashIdx > 0) {
    const dayPart = s.slice(0, dashIdx);
    const rest = s.slice(dashIdx + 1);
    const d = Number(dayPart);
    if (!Number.isFinite(d) || d < 0) return 0;
    days = d;
    s = rest;
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return 0;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return 0;
  let seconds = days * 86400;
  if (nums.length === 2) {
    seconds += nums[0] * 60 + nums[1];
  } else {
    seconds += nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  return Math.round(seconds * 1000);
}

/**
 * Sample per-process CPU-time (ms) for every member of the leader pid's
 * group. Returns `Map<pid, cpuMs>` so the caller can detect activity by
 * comparing per-pid CPU between samples — NOT by summing across the group.
 *
 * Why per-pid: when a short-lived helper exits, its CPU disappears from the
 * sum, dropping the total even while the surviving leader keeps burning CPU.
 * The previous sum-based design false-positive-killed any group that shrank
 * between samples (kimi entry shells fork a helper, helper exits, leader
 * settles into the long LLM call — and the watchdog tripped on the drop).
 *
 * Returns null when ps fails or the group is empty. The caller treats null
 * as "no signal this tick" and does NOT count it as activity, so a fully
 * exited group naturally stalls into the kill path within stallMs.
 *
 * Cross-platform note on `ps -g`:
 *   - macOS (BSD ps): `-g <numeric>` selects by **process group ID** (PGID).
 *   - Linux (procps-ng): `-g <numeric>` selects by **session ID** (SID).
 * Children of this orchestrator are spawned with `detached: true`, which on
 * both platforms makes pid == sid == pgid for the immediate child, so the
 * sample correctly includes the leader. For grandchildren that explicitly
 * call `setpgid()` (rare for our sub-agents), the two platforms diverge:
 * Linux still finds them (still in the session), macOS does not (now in a
 * different pgrp). This means cpu-mode may be slightly more lenient on
 * Linux than macOS for that case. Acceptable for v1; replacing `-g` with
 * a `/proc/<pid>/task/<tid>/children` walk on Linux is the durable fix.
 */
export function sampleProcessTreeCpuMs(
  pid: number | undefined,
): Map<number, number> | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const result = spawnSync("ps", ["-o", "pid=,cputime=", "-g", String(pid)], {
      encoding: "utf8",
      // 500ms is plenty for a ps call that typically runs in 5-15ms.
      // Higher values let a hung ps inflate the effective poll cadence
      // by orders of magnitude, which delays kill detection.
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return null;
    const out = typeof result.stdout === "string" ? result.stdout : "";
    const map = new Map<number, number>();
    for (const rawLine of out.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      // First whitespace-separated token is the pid, rest is cputime cell.
      const sp = line.search(/\s/);
      if (sp <= 0) continue;
      const pidNum = Number(line.slice(0, sp));
      if (!Number.isInteger(pidNum) || pidNum <= 0) continue;
      const cpuMs = parseCpuTime(line.slice(sp + 1));
      map.set(pidNum, cpuMs);
    }
    if (map.size === 0) return null;
    return map;
  } catch {
    return null;
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
    opts.pollIntervalMs ??
    Math.max(10, Math.min(1000, Math.floor(stallMs / 2)));
  const clock = opts.clock ?? {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown,
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  };
  const stat = opts.statFn ?? ((p: string) => fs.statSync(p));
  const sampleCpu = opts.sampleCpuFn ?? sampleProcessTreeCpuMs;

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

  // Per-pid CPU-time map for cpu-mode. Each entry tracks the last cputime
  // observed for one pid in the group. Activity = any pid in the new sample
  // shows a positive delta vs its prior reading, OR appears for the first
  // time with a positive value. Disappearing pids are dropped from the map
  // silently — they do NOT count as activity or as no-activity. This avoids
  // the false-positive kill when a group shrinks (helper exits → sum drops
  // → previous design tripped stallMs against a healthy surviving leader).
  const cpuByPid = new Map<number, number>();

  const recordActivity = () => {
    lastActivityAt = clock.now();
  };

  const onLine = (chunk: Buffer | string) => {
    if (stopped) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Single non-whitespace byte anywhere in the chunk counts as activity.
    // Equivalent to: any line in chunk.split(/\r?\n/) has trim().length > 0.
    // Regex test is a single short-circuit pass; the prior split-and-loop
    // allocated a string array per chunk just to discover the same answer.
    if (/\S/.test(text)) recordActivity();
  };

  if (source.mode === "stream" || source.mode === "cpu") {
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

    if (source.mode === "cpu") {
      const sample = sampleCpu(source.child.pid);
      if (sample !== null) {
        // Activity if ANY pid in the new sample shows a positive delta vs
        // its prior reading, OR appears fresh with a non-zero value. We do
        // NOT require the sum to increase — a shrinking group is normal
        // (short-lived helpers exit while the leader keeps working).
        let activityObserved = false;
        for (const [pidNum, cpuMs] of sample) {
          const prior = cpuByPid.get(pidNum);
          if (prior === undefined) {
            // First sighting. A fresh pid with non-zero cputime is activity;
            // a zero-cputime brand-new pid is recorded but not yet activity.
            if (cpuMs > 0) activityObserved = true;
          } else if (cpuMs > prior) {
            activityObserved = true;
          }
          cpuByPid.set(pidNum, cpuMs);
        }
        // Drop pids that disappeared this tick. Their CPU is frozen in the
        // kernel; not tracking them anymore means they can't accidentally
        // resurrect as "activity" via PID reuse later in this watchdog's life.
        for (const tracked of cpuByPid.keys()) {
          if (!sample.has(tracked)) cpuByPid.delete(tracked);
        }
        if (activityObserved) recordActivity();
      }
      // Null sample: ps failed or the group is gone. Either way, no signal
      // — fall through to the silence check. If the group has truly died
      // (auto-stop on 'exit' hasn't fired yet for some reason), the silence
      // window will trip and the kill becomes a no-op against an empty pgrp.
    }

    const silence = clock.now() - lastActivityAt;
    if (silence >= stallMs) {
      killed = true;
      try {
        opts.onStallKill?.(silence);
      } catch {
        // Callback errors are swallowed — caller's logging concern, not ours.
      }
      if (source.mode === "stream" || source.mode === "cpu") {
        const pid = source.child.pid;
        if (typeof pid === "number") {
          killProcessAndGroup(pid, "SIGTERM");
          killTimerHandle = clock.setTimeout(() => {
            killProcessAndGroup(pid, "SIGKILL");
          }, gracePeriodMs);
        }
        // Stop the poll loop and stream listeners, but DO NOT call stop()
        // here — stop() clears killTimerHandle, which would cancel our
        // SIGKILL escalation before it fires. The grace timer survives
        // until the child emits 'exit' (auto-stop below) at which point
        // stop() runs and clears it (a stale SIGKILL would race with PID
        // reuse). If the child ignores SIGTERM, the timer fires SIGKILL
        // as designed.
        if (pollHandle !== null) {
          clock.clearInterval(pollHandle);
          pollHandle = null;
        }
        source.child.stdout?.off("data", onLine);
        source.child.stderr?.off("data", onLine);
      } else {
        // In mtime mode the caller (drain-faults) owns the child handle
        // and does its own kill + grace timer. The watchdog just signals
        // via onStallKill and stops polling.
        stop();
      }
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
    if (source.mode === "stream" || source.mode === "cpu") {
      source.child.stdout?.off("data", onLine);
      source.child.stderr?.off("data", onLine);
    }
  };

  // Auto-stop when the child exits naturally — no point polling a dead pid.
  if (source.mode === "stream" || source.mode === "cpu") {
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
