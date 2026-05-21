/**
 * Periodic stdout heartbeat + sidecar for the gstack-build orchestrator.
 *
 * The monitor's `recentProcessActivity` check (monitor.ts) only knows that
 * the orchestrator process is alive — not whether it is making progress.
 * The stdout JSON line keeps stdoutLog mtime fresh and is the cheap noise
 * filter the existing decision tree expects. The new sidecar file
 * (`heartbeat.json`) carries the orchestrator's own snapshot of progress
 * (`stateLastUpdatedAt`, `drainProcessedCount`) so the monitor can detect
 * "process alive but state has not advanced" stalls without parsing
 * stdoutLog. The two outputs are intentionally redundant: the line keeps
 * the existing branches working unchanged, the sidecar enables the new
 * stall arm.
 *
 * The sidecar is written atomically (`tmp + rename`) so the monitor never
 * observes a partial JSON read.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_INTERVAL_MS = 30_000;

export interface HeartbeatStateSnapshot {
  lastUpdatedAt?: string;
  currentPhaseIndex?: number;
  drainProcessedCount?: number;
}

export interface HeartbeatOptions {
  runId: string;
  getPhase?: () => number | undefined;
  intervalMs?: number;
  /** Inject for tests. Defaults to process.stdout.write. */
  write?: (line: string) => void;
  /** Inject for tests. Defaults to setInterval. */
  schedule?: (fn: () => void, ms: number) => HeartbeatHandle;
  /**
   * Returns the orchestrator's current progress snapshot, read fresh per
   * tick. Fields are optional because state may not be loaded yet at
   * orchestrator startup. The monitor treats missing fields as "no signal
   * this tick" rather than "stalled" — see monitor.ts stall arm.
   */
  getStateSnapshot?: () => HeartbeatStateSnapshot;
  /**
   * Sidecar path. Should be per-run, e.g.
   * `<stateDir>/<stateSlug>.heartbeat.json`. Concurrent builds must NOT
   * share this path. When omitted the sidecar is not written (stdout-only
   * mode), kept for tests and back-compat.
   */
  heartbeatFilePath?: string;
  /**
   * Stable identifier of the writing process. Embedded in the sidecar so
   * the monitor can reject stale sidecars from a crashed prior run with
   * the same stateSlug.
   */
  pid?: number;
  /** Stable slug identifying the run. Embedded in the sidecar. */
  stateSlug?: string;
  /** Inject for tests. Defaults to fs.writeFileSync + fs.renameSync. */
  writeSidecar?: (filePath: string, payload: string) => void;
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

function defaultWriteSidecar(filePath: string, payload: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatController {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const write =
    opts.write ?? ((line: string) => process.stdout.write(line));
  const schedule =
    opts.schedule ??
    ((fn, ms) => setInterval(fn, ms) as unknown as HeartbeatHandle);
  const writeSidecar = opts.writeSidecar ?? defaultWriteSidecar;

  let stopped = false;
  let handle: HeartbeatHandle | null = null;
  let sidecarWriteFailed = false;

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

    const snapshot = opts.getStateSnapshot ? opts.getStateSnapshot() : undefined;
    const phaseFromGetter = opts.getPhase ? opts.getPhase() : undefined;
    const phase = phaseFromGetter ?? snapshot?.currentPhaseIndex;
    const timestamp = new Date().toISOString();

    const line =
      JSON.stringify({
        event: "RUN_HEARTBEAT",
        timestamp,
        runId: opts.runId,
        phase,
        stateLastUpdatedAt: snapshot?.lastUpdatedAt,
        drainProcessedCount: snapshot?.drainProcessedCount,
      }) + "\n";
    try {
      write(line);
    } catch {
      // Pipe closed, tee died, or stdout otherwise unhealthy. Stop the
      // interval so we don't keep throwing on every tick.
      stop();
      return;
    }

    // Sidecar write is independent of stdout. A filesystem hiccup (ENOSPC,
    // permission flip) must NOT crash the orchestrator: log once via the
    // stdout pipe, then keep ticking stdout only. The monitor will treat a
    // missing sidecar as "no heartbeat available" and fall back to its
    // existing recentProcessActivity branch — i.e. regress to today's
    // behavior, not introduce a new silent failure.
    if (opts.heartbeatFilePath) {
      const sidecarPayload = JSON.stringify({
        ts: timestamp,
        runId: opts.runId,
        pid: opts.pid,
        stateSlug: opts.stateSlug,
        phase,
        stateLastUpdatedAt: snapshot?.lastUpdatedAt,
        drainProcessedCount: snapshot?.drainProcessedCount,
      });
      try {
        writeSidecar(opts.heartbeatFilePath, sidecarPayload);
      } catch (err) {
        if (!sidecarWriteFailed) {
          sidecarWriteFailed = true;
          try {
            write(
              JSON.stringify({
                event: "RUN_HEARTBEAT_SIDECAR_FAILED",
                timestamp,
                runId: opts.runId,
                error: (err as Error).message,
              }) + "\n",
            );
          } catch {
            // If even the warning write fails, fall through; stdout has its
            // own stop path on next tick.
          }
        }
      }
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

/**
 * Best-effort sidecar cleanup. Caller (cli.ts `finally`) invokes this so a
 * normal shutdown leaves no stale heartbeat.json behind. SIGKILL paths skip
 * it; the monitor's runId+pid trust gate handles stragglers.
 */
export function removeHeartbeatSidecar(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort. A leftover file is handled by the monitor's trust gate.
  }
}

export const __heartbeatInternals = {
  defaultWriteSidecar,
  sidecarPathFor(stateDir: string, stateSlug: string): string {
    return path.join(stateDir, `${stateSlug}.heartbeat.json`);
  },
};
