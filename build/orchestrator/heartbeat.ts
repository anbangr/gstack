/**
 * Periodic stdout heartbeat for the gstack-build orchestrator.
 *
 * Why: the monitor's `recentProcessActivity` check on stdoutLog mtime
 * (monitor.ts:344-347) goes silent while the orchestrator is `await`-ing
 * a long sub-agent call, which makes the monitor falsely escalate via
 * USER_ACTION_REQUIRED -> MONITOR_AGENT_ESCALATION. Emitting one JSON
 * line every interval keeps stdoutLog mtime fresh (the outer
 * `tee "$stdoutLog"` in build/SKILL.md.tmpl:962 captures it) and lets
 * the existing check do its job.
 */

const DEFAULT_INTERVAL_MS = 30_000;

export interface HeartbeatOptions {
  runId: string;
  getPhase?: () => number | undefined;
  intervalMs?: number;
  /** Inject for tests. Defaults to process.stdout.write. */
  write?: (line: string) => void;
  /** Inject for tests. Defaults to setInterval. */
  schedule?: (fn: () => void, ms: number) => HeartbeatHandle;
}

export interface HeartbeatHandle {
  ref?: () => void;
  unref?: () => void;
}

export interface HeartbeatController {
  stop: () => void;
  /** Test helper: emit one tick on demand. */
  tickNow: () => void;
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatController {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const write =
    opts.write ?? ((line: string) => process.stdout.write(line));
  const schedule =
    opts.schedule ??
    ((fn, ms) => setInterval(fn, ms) as unknown as HeartbeatHandle);

  let stopped = false;
  let handle: HeartbeatHandle | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (handle) {
      const native = handle as unknown as NodeJS.Timeout;
      try {
        clearInterval(native);
      } catch {
        // Defensive: a custom schedule injector may not be a real timer.
      }
      handle = null;
    }
  };

  const tick = () => {
    if (stopped) return;
    const line =
      JSON.stringify({
        event: "RUN_HEARTBEAT",
        timestamp: new Date().toISOString(),
        runId: opts.runId,
        phase: opts.getPhase ? opts.getPhase() : undefined,
      }) + "\n";
    try {
      write(line);
    } catch {
      // Pipe closed, tee died, or stdout otherwise unhealthy. Stop the
      // interval so we don't keep throwing on every tick.
      stop();
    }
  };

  handle = schedule(tick, intervalMs);
  // Let the event loop exit naturally when the rest of the work is done.
  try {
    handle.unref?.();
  } catch {
    // Custom schedule injectors may not implement unref; harmless.
  }

  return {
    stop,
    tickNow: tick,
  };
}
