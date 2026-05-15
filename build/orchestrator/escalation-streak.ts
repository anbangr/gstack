/**
 * Verdict-agnostic loop guard for MONITOR_AGENT_ESCALATION exits.
 *
 * Why: even after Fix 1 (heartbeat) removes the most common false-positive
 * escalation, the supervisor can in principle still escalate repeatedly
 * (e.g. Kimi unreachable, repeated fallback verdicts). Without a guard,
 * the host can wedge in a re-enter loop. We track every consecutive
 * MONITOR_AGENT_ESCALATION exit; on the N-th within an M-minute window,
 * we suppress the supervisor-recommended re-entry and surface a
 * USER_ACTION_REQUIRED event so the user can decide whether to keep
 * waiting or abort. Reset on any non-escalation terminal event.
 *
 * Default thresholds: N=3, M=15 minutes. Tunable via the
 * GSTACK_BUILD_ESCALATION_STREAK_MAX and
 * GSTACK_BUILD_ESCALATION_STREAK_WINDOW_MS env vars (envNumberOrDefault
 * in build-config).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { envNumberOrDefault } from "./build-config";
import { logDir } from "./state";

export const STREAK_FILENAME = "escalation-streak.json";
const RECENT_VERDICTS_CAP = 5;

export const STREAK_LIMIT = envNumberOrDefault(
  "GSTACK_BUILD_ESCALATION_STREAK_MAX",
  3,
);
export const STREAK_WINDOW_MS = envNumberOrDefault(
  "GSTACK_BUILD_ESCALATION_STREAK_WINDOW_MS",
  15 * 60 * 1000,
);

export interface EscalationStreakFile {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  recentVerdicts: string[];
}

export function streakPath(stateSlug: string): string {
  return path.join(logDir(stateSlug), STREAK_FILENAME);
}

function readStreak(file: string): EscalationStreakFile | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<EscalationStreakFile>;
    if (
      typeof parsed.count !== "number" ||
      typeof parsed.firstSeenAt !== "string" ||
      typeof parsed.lastSeenAt !== "string" ||
      !Array.isArray(parsed.recentVerdicts)
    ) {
      return null;
    }
    return {
      count: parsed.count,
      firstSeenAt: parsed.firstSeenAt,
      lastSeenAt: parsed.lastSeenAt,
      recentVerdicts: parsed.recentVerdicts.filter(
        (v): v is string => typeof v === "string",
      ),
    };
  } catch {
    return null;
  }
}

function writeStreak(file: string, data: EscalationStreakFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Record a MONITOR_AGENT_ESCALATION exit. Returns the resulting streak
 * state. Caller should compare `count >= STREAK_LIMIT` to decide
 * whether to surface USER_ACTION_REQUIRED instead of re-entering.
 *
 * If the previous entry is older than STREAK_WINDOW_MS, the streak
 * resets — only an in-window run counts toward the limit.
 */
export function recordEscalation(
  stateSlug: string,
  verdict: string,
  now: Date = new Date(),
): EscalationStreakFile {
  const file = streakPath(stateSlug);
  const prior = readStreak(file);
  const nowIso = now.toISOString();

  let next: EscalationStreakFile;
  if (
    prior &&
    now.getTime() - Date.parse(prior.lastSeenAt) <= STREAK_WINDOW_MS
  ) {
    const verdicts = [...prior.recentVerdicts, verdict].slice(
      -RECENT_VERDICTS_CAP,
    );
    next = {
      count: prior.count + 1,
      firstSeenAt: prior.firstSeenAt,
      lastSeenAt: nowIso,
      recentVerdicts: verdicts,
    };
  } else {
    // No prior streak, or prior entry aged out of the window: start fresh.
    next = {
      count: 1,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      recentVerdicts: [verdict],
    };
  }
  writeStreak(file, next);
  return next;
}

/**
 * Reset the streak counter. Call on any non-escalation terminal event
 * (RUN_RESUMED, ALL_RUNS_COMPLETE, HOST_CONTEXT_SAVE_REQUIRED,
 * MONITOR_REENTER). Idempotent — deleting a non-existent file is fine.
 */
export function resetStreak(stateSlug: string): void {
  const file = streakPath(stateSlug);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unexpected; surface so we don't silently leak streak state.
      throw err;
    }
  }
}

/**
 * Test-only read of the current streak. Production code should use the
 * return value of recordEscalation() rather than re-reading.
 */
export function peekStreak(stateSlug: string): EscalationStreakFile | null {
  return readStreak(streakPath(stateSlug));
}

/** Returns true when the streak has reached the surface threshold. */
export function shouldSurface(streak: EscalationStreakFile): boolean {
  return streak.count >= STREAK_LIMIT;
}

/**
 * Construct the user-facing message for the surface event. The message
 * includes the streak count, window age in minutes, and the recent
 * verdict history so the user can distinguish "Kimi keeps saying
 * no_action" from "Kimi keeps timing out".
 */
export function streakSurfaceMessage(
  streak: EscalationStreakFile,
  now: Date = new Date(),
): string {
  const ageMs = now.getTime() - Date.parse(streak.firstSeenAt);
  const ageMin = Math.max(1, Math.round(ageMs / 60_000));
  return (
    `monitor agent escalated ${streak.count} times in ${ageMin}min ` +
    `(verdicts: ${streak.recentVerdicts.join(",")}) — orchestrator may be ` +
    `stuck or supervisor may be unreachable; confirm whether to keep ` +
    `waiting or abort`
  );
}
