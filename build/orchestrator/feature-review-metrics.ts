/**
 * T1: per-spawn JSONL instrumentation for feature-review.
 *
 * Captures baseline performance data for runFeatureReviewIteration so we can
 * answer "does codex write incrementally or only at end?" — the gate for
 * whether T5 (verdict-tail kill-on-pass) saves any time before we build it.
 *
 * Schema is intentionally flat. One row per spawn, appended JSONL.
 * Best-effort write: never throws into the caller; failures only surface
 * under GSTACK_BUILD_DEBUG.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FeatureReviewMetricsRow {
  ts: string;
  feature: string;
  cycle: number;
  reasoning: string;
  verdict: string;
  promptBytes: number;
  outputBytes: number;
  wallMs: number;
  spawnToFirstWriteMs: number | null;
  firstWriteToCompletionMs: number | null;
  endedBy: "exit0" | "watchdog" | "signal" | "exit-nonzero";
  passEvidenceTimeout: boolean;
}

function metricsDir(): string {
  // GSTACK_BUILD_STATE_DIR is used by tests as `<tmpdir>/build-state`.
  // Put metrics in a sibling `analytics/` so tests can inspect without
  // polluting ~/.gstack/.
  if (process.env.GSTACK_BUILD_STATE_DIR) {
    return path.resolve(process.env.GSTACK_BUILD_STATE_DIR, "..", "analytics");
  }
  return path.join(os.homedir(), ".gstack", "analytics");
}

export function writeFeatureReviewMetrics(row: FeatureReviewMetricsRow): void {
  try {
    const dir = metricsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "feature-review-metrics.jsonl"),
      JSON.stringify(row) + "\n",
    );
  } catch (err) {
    if (process.env.GSTACK_BUILD_DEBUG) {
      console.warn(
        `feature-review-metrics: write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export interface FirstWriteWatcher {
  /** ms since spawnStart when outputFilePath first became non-empty; null if never wrote. */
  firstWriteAt(): number | null;
  /** Stop polling. Idempotent. */
  stop(): void;
}

/**
 * Poll outputFilePath until it becomes non-empty, recording the elapsed time
 * (ms since spawnStart) of the first observed write. Returns immediately —
 * polling continues in the background via setTimeout chain. Caller MUST call
 * stop() in a finally block to avoid leaking the timer if the file never
 * gets written.
 *
 * Polling stops automatically after the first non-empty observation, so the
 * steady-state cost is one stat per pollMs only until firstWrite is seen.
 */
export function watchFirstWrite(
  outputFilePath: string,
  spawnStart: number,
  pollMs = 250,
): FirstWriteWatcher {
  let firstWriteMs: number | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (stopped) return;
    try {
      const st = fs.statSync(outputFilePath);
      if (st.size > 0 && firstWriteMs === null) {
        firstWriteMs = Date.now() - spawnStart;
        return; // first write captured; stop polling
      }
    } catch {
      // ENOENT etc. — file not yet written; keep polling
    }
    timer = setTimeout(tick, pollMs);
  };
  timer = setTimeout(tick, pollMs);

  return {
    firstWriteAt: () => firstWriteMs,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
