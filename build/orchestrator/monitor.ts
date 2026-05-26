import { spawn, spawnSync } from "./child-registry";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeRunRecordPath,
  defaultActiveRunRegistryDir,
  isPidAlive,
  readActiveRunRecords,
} from "./active-runs";
import { sourcePlanClaimPaths } from "./plan-claims";
import { cleanupDeadLock, statePath } from "./state";
import type {
  BuildRunManifest,
  BuildRunManifestRun,
  BuildState,
  PhaseStatus,
  SkillFaultDetectedEvent,
  SkillFaultEvent,
  SkillFaultResolvedEvent,
} from "./types";
import {
  detectSkillFaults,
  faultId as computeFaultId,
  loadLearnedPatterns,
} from "./skill-fault-detector";
import {
  buildHaltSnapshot,
  emitHaltEvent,
  type HaltSeverity,
} from "./halt-events";

export type MonitorEventName =
  | "RUN_RUNNING"
  | "RUN_STALE"
  | "RUN_RESUMED"
  | "RUN_HALTED_STALEMATE"
  | "RUN_HALTED_RESTART_CAP"
  | "HOST_CONTEXT_SAVE_REQUIRED"
  | "USER_ACTION_REQUIRED"
  | "RUN_FAILED"
  | "ALL_RUNS_COMPLETE"
  | "MONITOR_ERROR"
  | "MONITOR_REENTER"
  | "MONITOR_AGENT_ESCALATION";

export const MONITOR_EXIT_CODES: Record<MonitorEventName, number> = {
  RUN_RUNNING: 12,
  RUN_STALE: 12,
  RUN_RESUMED: 12,
  // Both halt events require operator attention; reuse USER_ACTION_REQUIRED's
  // exit code (11) so wrappers that already key on it get the same signal.
  RUN_HALTED_STALEMATE: 11,
  RUN_HALTED_RESTART_CAP: 11,
  HOST_CONTEXT_SAVE_REQUIRED: 10,
  USER_ACTION_REQUIRED: 11,
  RUN_FAILED: 20,
  ALL_RUNS_COMPLETE: 0,
  MONITOR_ERROR: 30,
  MONITOR_REENTER: 12,
  MONITOR_AGENT_ESCALATION: 11,
};

export interface MonitorEvent {
  event: MonitorEventName;
  timestamp: string;
  runId?: string;
  repoSlug?: string;
  stateSlug?: string;
  status?: string;
  message: string;
  committed?: number;
  countFile?: string;
  pidFile?: string;
  stateFile?: string;
  stdoutLog?: string;
  resumeAttempted?: boolean;
  exitCode?: number;
  sourceEvent?: MonitorEventName;
  verdict?: "host_action_required" | "user_action_required" | "no_action";
  summary?: string;
  attempted?: string[];
  recommendedHostAction?: string;
  suggestedCommands?: string[];
  userChoices?: string[];
  originalExitCode?: number;
  monitorAgent?: {
    provider?: string;
    model?: string;
    timedOut?: boolean;
    exitCode?: number;
    logPath?: string;
    outputPath?: string;
  };
}

interface MonitorRunSnapshot {
  run: BuildRunManifestRun;
  stateFile: string;
  state: BuildState | null;
  stateError?: string;
  stateDir: string;
  pid: number | null;
  pidAlive: boolean;
  registryPidAlive: boolean;
  registryOk: boolean;
  identityOk: boolean;
  completed: boolean;
  failed: boolean;
  committedCount: number;
  contextSaveCountFile: string;
  priorContextSaveCount: number;
  lastUpdatedAtMs: number | null;
  recentProcessActivity: boolean;
  stale: boolean;
  /**
   * How long the orchestrator's progress signals (state.lastUpdatedAt +
   * drainProcessedCount, read from the heartbeat sidecar) have been frozen,
   * in ms. `null` when no sidecar is available or trust gate failed —
   * monitor falls back to the existing decision tree in that case. A
   * positive value above the configured threshold triggers the new
   * USER_ACTION_REQUIRED stall arm.
   */
  heartbeatStalledMs: number | null;
}

export interface MonitorOnceOptions {
  manifestPath: string;
  pollMs?: number;
  now?: Date;
  spawnResume?: boolean;
  /**
   * Directory holding the disk-backed active-fault registry. When set, the
   * monitor diffs the current tick's faults against the registry and emits
   * SKILL_FAULT_RESOLVED for ids that disappeared. When omitted, the
   * monitor stays append-only (back-compat: every tick emits DETECTED for
   * every active fault, no RESOLVED events).
   *
   * Per-runId file: `<dir>/<safeRunId>.json`. Atomic tmp+rename writes.
   */
  activeFaultRegistryDir?: string;
  /**
   * Optional path to the gstack-config binary. When set, monitor reads the
   * `build_stall_threshold_ms` knob to override the default 15-min stall
   * threshold. Pattern matches drain-faults.ts's `fault_investigator_model`
   * read. Tests can pass an empty/undefined value to force the default.
   */
  gstackConfigBin?: string;
  /**
   * Override the build stall threshold directly, bypassing gstack-config.
   * Test-only escape hatch — production callers should set gstackConfigBin
   * (or rely on the default).
   */
  buildStallThresholdMs?: number;
}

export interface MonitorEvaluation {
  manifest?: BuildRunManifest;
  events: MonitorEvent[];
  /**
   * Mix of SKILL_FAULT_DETECTED (new faults) and SKILL_FAULT_RESOLVED
   * (faults that stopped firing on this tick). Order: detected events
   * before resolved events, then in the order the corresponding faults
   * were emitted by detectSkillFaults / the registry diff.
   */
  skillFaultEvents: SkillFaultEvent[];
  terminalEvent: MonitorEvent;
}

function nowIso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function event(
  args: Omit<MonitorEvent, "timestamp">,
  now?: Date,
): MonitorEvent {
  return { timestamp: nowIso(now), ...args };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`manifest run missing ${field}`);
  }
  return value;
}

function requireStringArray(
  obj: Record<string, unknown>,
  field: string,
): string[] {
  const value = obj[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`manifest run missing ${field}`);
  }
  return [...value] as string[];
}

function optionalString(
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = obj[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalStringRecord(
  obj: Record<string, unknown>,
  field: string,
): Record<string, string> | undefined {
  const value = obj[field];
  if (value == null) return undefined;
  const record = asObject(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new Error(`manifest run ${field}.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

export function loadMonitorManifest(manifestPath: string): BuildRunManifest {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = asObject(JSON.parse(raw));
  const manifestId = requireString(parsed, "manifestId");
  const runGroupId = requireString(parsed, "runGroupId");
  const tmpDir = path.resolve(requireString(parsed, "tmpDir"));
  const runsRaw = parsed.runs;
  if (!Array.isArray(runsRaw) || runsRaw.length === 0) {
    throw new Error("manifest missing non-empty runs array");
  }
  const runs: BuildRunManifestRun[] = runsRaw.map((rawRun) => {
    const run = asObject(rawRun);
    return {
      runId: requireString(run, "runId"),
      repoPath: path.resolve(requireString(run, "repoPath")),
      repoSlug: requireString(run, "repoSlug"),
      sourcePlanPath: optionalString(run, "sourcePlanPath"),
      livingPlanPath: path.resolve(requireString(run, "livingPlanPath")),
      originPlanPath: optionalString(run, "originPlanPath"),
      worktreePath: path.resolve(requireString(run, "worktreePath")),
      stateSlug: requireString(run, "stateSlug"),
      branchPrefix: requireString(run, "branchPrefix"),
      pidFile: path.resolve(requireString(run, "pidFile")),
      stdoutLog: path.resolve(requireString(run, "stdoutLog")),
      launchCommand: requireStringArray(run, "launchCommand"),
      launchEnv: optionalStringRecord(run, "launchEnv"),
    };
  });
  return {
    manifestId,
    runGroupId,
    tmpDir,
    workspaceRoot:
      typeof parsed.workspaceRoot === "string"
        ? path.resolve(parsed.workspaceRoot)
        : undefined,
    gstackRepo:
      typeof parsed.gstackRepo === "string"
        ? path.resolve(parsed.gstackRepo)
        : undefined,
    runs,
  };
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readPid(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function registryDirFromLaunchCommand(run: BuildRunManifestRun): string {
  const idx = run.launchCommand.indexOf("--active-run-registry");
  if (idx >= 0 && run.launchCommand[idx + 1]) {
    return path.resolve(run.launchCommand[idx + 1]);
  }
  return defaultActiveRunRegistryDir();
}

function normalizeRepoIdentity(
  repoPath: string | undefined,
): string | undefined {
  return repoPath ? path.resolve(repoPath) : undefined;
}

function registryRunInfo(run: BuildRunManifestRun): {
  ok: boolean;
  liveOwner: boolean;
} {
  const registryDir = registryDirFromLaunchCommand(run);
  const records = readActiveRunRecords(registryDir).filter(
    (record) => record.runId === run.runId,
  );
  if (records.length === 0) return { ok: true, liveOwner: false };
  const expected = normalizeRepoIdentity(run.repoPath);
  const ok = records.every((record) => {
    const actual = normalizeRepoIdentity(
      record.baseProjectRoot ?? record.repoPath,
    );
    return actual === expected;
  });
  const liveOwner = records.some(
    (record) =>
      record.status !== "completed" &&
      record.status !== "failed" &&
      isPidAlive(record.pid),
  );
  return { ok, liveOwner };
}

function stateMatchesRun(state: BuildState, run: BuildRunManifestRun): boolean {
  return (
    state.slug === run.stateSlug &&
    state.planFile === run.livingPlanPath &&
    state.launch?.runId === run.runId &&
    path.resolve(state.launch?.projectRoot ?? "") === run.worktreePath &&
    path.resolve(state.launch?.baseProjectRoot ?? "") === run.repoPath
  );
}

function committedPhaseCount(state: BuildState | null): number {
  return (state?.phases ?? []).filter((phase) => phase.status === "committed")
    .length;
}

// Per docs/orchestrator-state-machine.md §1.3, `failed` is recoverable, not
// terminal. Inv A pairs state.failedAtPhase=N with phases[N].status="failed";
// once recovery advances the phase (manual edit or --mark-phase-committed),
// the integer becomes stale metadata. The monitor must consult the phase's
// actual status, not the lingering integer. The failureReason+paused/failed
// feature branch preserves the documented terminal class where /ship dies
// mid-flight and leaves a feature paused with a failureReason but no
// failedAtPhase set.
function isStateFailed(state: BuildState | null): boolean {
  if (!state) return false;
  const idx = state.failedAtPhase;
  if (idx != null && state.phases?.[idx]?.status === "failed") return true;
  if (
    state.failureReason &&
    state.features?.some((f) => f.status === "paused" || f.status === "failed")
  ) {
    return true;
  }
  return false;
}

function phaseStatus(state: BuildState | null): PhaseStatus | "missing" {
  if (!state) return "missing";
  return state.phases[state.currentPhaseIndex]?.status ?? "pending";
}

function readContextSaveCount(filePath: string): number {
  try {
    const value = Number(fs.readFileSync(filePath, "utf8").trim());
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat sidecar + per-run stall tracker
// ---------------------------------------------------------------------------
//
// Background: the existing decision tree at the bottom of evaluateMonitorOnce
// treats `recentProcessActivity` (stdoutLog mtime touched within 3*pollMs) as
// "the orchestrator is alive, give it more time". heartbeat.ts writes a JSON
// line to stdout every 30s, which keeps stdoutLog mtime fresh even when the
// orchestrator is wedged inside a long await. That created the false-alive
// bug (auto-drain hung for 47 minutes, monitor never escalated).
//
// Fix shape (plan v1.40.7.0, codex-revised):
//   1. heartbeat.ts writes a per-run sidecar `<stateDir>/<slug>.heartbeat.json`
//      carrying state.lastUpdatedAt + drainProcessedCount + runId + pid.
//   2. The monitor reads that sidecar, gates trust on runId+pid matching the
//      run it's evaluating (PID reuse defense), and persists a per-run tracker
//      file recording when the progress signals last changed.
//   3. When pidAlive AND recentProcessActivity AND (now - tracker.lastChangedAt)
//      exceeds the configured threshold, the monitor escalates instead of
//      logging "waiting for state update" indefinitely.
//
// All read/write is best-effort: a missing sidecar, malformed JSON, or
// disk write failure leaves the monitor falling back to its pre-fix
// behavior (existing decision tree, no new silent failure mode).

interface HeartbeatSidecar {
  ts: string;
  runId: string;
  pid: number;
  stateSlug: string;
  phase?: number;
  stateLastUpdatedAt?: string;
  drainProcessedCount?: number;
}

interface HeartbeatTracker {
  /**
   * Retained for backwards-compat with pre-fix tracker files on disk. Read
   * but no longer compared — `stateLastUpdatedAt` is a write timestamp that
   * gets touched on every state rewrite (including no-op rewrites from
   * auto-resume), so it cannot be used as a progress signal. The tracker
   * upgrades silently: pre-fix files still parse, the field is preserved
   * on write for forward-compat, but the moved-check ignores it.
   */
  lastSeenStateLastUpdatedAt?: string;
  lastSeenDrainProcessedCount?: number;
  /** Phase index seen on the last sidecar tick. Phase advance = real progress. */
  lastSeenPhase?: number;
  /** Wall-clock ms when either of the tracked signals last changed. */
  lastChangedAt: number;
}

const DEFAULT_BUILD_STALL_THRESHOLD_MS = 15 * 60 * 1000;

function heartbeatSidecarPath(stateDir: string, stateSlug: string): string {
  return path.join(stateDir, `${stateSlug}.heartbeat.json`);
}

function heartbeatTrackerPath(stateDir: string, stateSlug: string): string {
  return path.join(stateDir, `${stateSlug}.heartbeat-track.json`);
}

function readHeartbeatSidecar(
  filePath: string,
  expectedRunId: string,
  expectedPid: number | null,
): HeartbeatSidecar | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: HeartbeatSidecar;
  try {
    parsed = JSON.parse(raw) as HeartbeatSidecar;
  } catch {
    return null;
  }
  // Trust gate: a stale sidecar from a crashed prior run on the same slug
  // (PID got reused, cleanup failed, etc.) must NOT be treated as fresh.
  // Mismatched runId or pid → null the sidecar; the monitor falls back to
  // the existing recentProcessActivity branch.
  if (parsed.runId !== expectedRunId) return null;
  if (expectedPid != null && parsed.pid !== expectedPid) return null;
  return parsed;
}

function readHeartbeatTracker(filePath: string): HeartbeatTracker | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as HeartbeatTracker;
    if (!Number.isFinite(parsed.lastChangedAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeHeartbeatTracker(
  filePath: string,
  tracker: HeartbeatTracker,
): void {
  try {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(tracker), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort. If the tracker write fails the monitor regresses to
    // its existing behavior on this tick — i.e. no new silent failure mode.
  }
}

/**
 * Per-run auto-resume counter, persisted to a sidecar file so it survives
 * monitor restarts. Fix C component 2 of the plan-review-loop restart-storm
 * fix: caps the total number of auto-resumes for a single run so that even
 * if the heartbeat-tracker (component 1, user's bd10c04c) and the
 * synth_failure_stalemate guard miss something, the monitor stops trying
 * after N attempts.
 *
 * Cap is controlled by `GSTACK_MONITOR_MAX_AUTO_RESUME`, default 3.
 * Reset semantics: once a run completes successfully or reaches a terminal
 * failure state (handled by other monitor code paths), the counter file
 * naturally goes stale; the next run on a different stateSlug gets a fresh
 * counter file. Counter files are stored at `<stateDir>/<stateSlug>.resume-count`.
 */
function resumeCounterPath(stateDir: string, stateSlug: string): string {
  return path.join(stateDir, `${stateSlug}.resume-count`);
}

function readResumeCount(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeResumeCount(filePath: string, count: number): void {
  try {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, String(count), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort; failure to write means the next monitor tick gets a
    // potentially-stale count. The synth_failure_stalemate guard above is
    // the primary defense, so the cap is a secondary safety net.
  }
}

const DEFAULT_MAX_AUTO_RESUME = 3;

function maxAutoResumeFromEnv(): number {
  const raw = process.env.GSTACK_MONITOR_MAX_AUTO_RESUME;
  if (!raw) return DEFAULT_MAX_AUTO_RESUME;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_AUTO_RESUME;
  return n;
}

/**
 * Resolve the gstack-config binary path. Production callers don't pass one
 * explicitly — they get the canonical `~/.claude/skills/gstack/bin/gstack-config`
 * location, the same default `resolveInvestigatorRole` uses. Tests can pass
 * the empty string "" to force the no-binary code path.
 */
function resolveGstackConfigBin(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  return path.join(
    os.homedir(),
    ".claude",
    "skills",
    "gstack",
    "bin",
    "gstack-config",
  );
}

function readBuildStallThresholdMs(gstackConfigBin?: string): number {
  const bin = resolveGstackConfigBin(gstackConfigBin);
  // Empty string = explicit "no binary" (test escape hatch).
  if (!bin) return DEFAULT_BUILD_STALL_THRESHOLD_MS;
  try {
    const result = spawnSync(bin, ["get", "build_stall_threshold_ms"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const parsed = Number(result.stdout.trim());
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Fall through to default.
  }
  return DEFAULT_BUILD_STALL_THRESHOLD_MS;
}

/**
 * Read the per-run heartbeat sidecar, compare against the prior tick's
 * tracker, and return how long the orchestrator's progress signals have
 * been frozen (in ms). Updates the tracker on disk whenever either signal
 * has moved since the prior poll.
 *
 * Returns:
 *   - `null` when the sidecar is missing, malformed, or fails the
 *     runId+pid trust gate. Caller treats null as "no signal this tick"
 *     and falls back to the existing recentProcessActivity branch.
 *   - `0` when the sidecar shows progress on this poll vs the tracker.
 *   - A positive ms value when both signals are frozen vs the tracker —
 *     this is the number the stall threshold is compared against.
 */
export function evaluateHeartbeatStall(
  stateDir: string,
  run: BuildRunManifestRun,
  pid: number | null,
  nowMs: number,
): { sidecar: HeartbeatSidecar | null; stalledMs: number | null } {
  const sidecarPath = heartbeatSidecarPath(stateDir, run.stateSlug);
  const sidecar = readHeartbeatSidecar(sidecarPath, run.runId, pid);
  if (!sidecar) return { sidecar: null, stalledMs: null };

  const trackerPath = heartbeatTrackerPath(stateDir, run.stateSlug);
  const tracker = readHeartbeatTracker(trackerPath);

  // Progress-signal selection: only `drainProcessedCount` and `phase` count as
  // real work. `stateLastUpdatedAt` was the original signal but is a write
  // timestamp — it ticks on every state rewrite, including the no-op rewrite
  // performed by spawnResume when it loads saved state into a fresh process.
  // That allowed the watchdog to be permanently reset by auto-resume cycles.
  // The check below compares only monotonic-progress signals; the
  // timestamp is still preserved on the tracker for diagnostic purposes.
  //
  // Phase comparison is gated on `tracker.lastSeenPhase !== undefined` so
  // pre-fix tracker files (which never recorded phase) keep working — they
  // fall back to drainProcessedCount-only comparison. Once the monitor writes
  // a fresh tracker on disk, `lastSeenPhase` is populated and the full
  // comparison takes effect.
  const moved =
    !tracker ||
    sidecar.drainProcessedCount !== tracker.lastSeenDrainProcessedCount ||
    (tracker.lastSeenPhase !== undefined &&
      sidecar.phase !== tracker.lastSeenPhase);

  if (moved || !tracker) {
    writeHeartbeatTracker(trackerPath, {
      lastSeenStateLastUpdatedAt: sidecar.stateLastUpdatedAt,
      lastSeenDrainProcessedCount: sidecar.drainProcessedCount,
      lastSeenPhase: sidecar.phase,
      lastChangedAt: nowMs,
    });
    return { sidecar, stalledMs: 0 };
  }

  return { sidecar, stalledMs: Math.max(0, nowMs - tracker.lastChangedAt) };
}

function readRunSnapshot(
  run: BuildRunManifestRun,
  pollMs: number,
  now: Date,
): MonitorRunSnapshot {
  const stateFile = statePath(run.stateSlug);
  let state: BuildState | null = null;
  let stateError: string | undefined;
  try {
    state = readJsonFile<BuildState>(stateFile);
  } catch (err) {
    stateError = (err as Error).message;
  }
  const pid = readPid(run.pidFile);
  const pidAlive = pid != null && isPidAlive(pid);
  const registry = registryRunInfo(run);
  const registryOk = registry.ok;
  const identityOk = state
    ? stateMatchesRun(state, run) && registryOk
    : registryOk;
  const committedCount = committedPhaseCount(state);
  const staleWindowMs = Math.max(3 * pollMs, 1_000);
  const contextSaveCountFile = path.join(
    path.dirname(stateFile),
    run.stateSlug,
    ".host-context-save-count",
  );
  const lastUpdatedAtMs = state?.lastUpdatedAt
    ? Date.parse(state.lastUpdatedAt)
    : null;
  const recentProcessActivity = [
    fileMtimeMs(run.pidFile),
    fileMtimeMs(run.stdoutLog),
  ].some((mtime) => mtime != null && now.getTime() - mtime < staleWindowMs);
  // Heartbeat sidecar stall detection (plan v1.40.7.0 §Change 2). Tracker
  // file written here so the per-poll comparison persists across monitor
  // restarts — evaluateMonitorOnce itself is stateless.
  const stateDir = path.dirname(stateFile);
  const heartbeatResult = evaluateHeartbeatStall(
    stateDir,
    run,
    pid,
    now.getTime(),
  );
  return {
    run,
    stateFile,
    stateDir,
    state,
    stateError,
    pid,
    pidAlive,
    registryPidAlive: registry.liveOwner,
    registryOk,
    identityOk,
    completed: state?.completed === true,
    failed: isStateFailed(state),
    committedCount,
    contextSaveCountFile,
    priorContextSaveCount: readContextSaveCount(contextSaveCountFile),
    lastUpdatedAtMs: Number.isFinite(lastUpdatedAtMs) ? lastUpdatedAtMs : null,
    recentProcessActivity,
    stale:
      lastUpdatedAtMs != null &&
      now.getTime() - lastUpdatedAtMs >= staleWindowMs,
    heartbeatStalledMs: heartbeatResult.stalledMs,
  };
}

function writeClaimStatus(
  manifest: BuildRunManifest,
  run: BuildRunManifestRun,
  status: "completed" | "failed",
  now: Date,
): void {
  if (!manifest.gstackRepo) return;
  const sourcePlanPath = run.sourcePlanPath ?? run.originPlanPath;
  if (!sourcePlanPath) return;
  if (
    path.dirname(path.resolve(sourcePlanPath)) !==
    path.join(manifest.gstackRepo, "inbox")
  ) {
    return;
  }
  const claimPath = sourcePlanClaimPaths(
    manifest.gstackRepo,
    sourcePlanPath,
  ).find((candidatePath) => fs.existsSync(candidatePath));
  if (!claimPath) return;
  const claim = readJsonFile<Record<string, any>>(claimPath);
  if (!claim) return;
  const updatedAt = now.toISOString();
  const timeField = status === "completed" ? "completedAt" : "failedAt";
  claim.runStatuses = claim.runStatuses ?? {};
  claim.runStatuses[run.runId] = {
    status,
    updatedAt,
    [timeField]: updatedAt,
  };
  const runIds = Array.isArray(claim.runIds) ? claim.runIds : [run.runId];
  const allTerminal = runIds.every((id: string) =>
    ["completed", "failed"].includes(claim.runStatuses?.[id]?.status ?? ""),
  );
  const allCompleted =
    runIds.length > 0 &&
    runIds.every(
      (id: string) => claim.runStatuses?.[id]?.status === "completed",
    );
  const anyFailed = runIds.some(
    (id: string) => claim.runStatuses?.[id]?.status === "failed",
  );
  claim.status = allCompleted
    ? "completed"
    : allTerminal && anyFailed
      ? "failed"
      : "running";
  claim.updatedAt = updatedAt;
  if (claim.status === "completed") {
    claim.completedAt = updatedAt;
    delete claim.failedAt;
  } else if (claim.status === "failed") {
    claim.failedAt = updatedAt;
    delete claim.completedAt;
  } else {
    delete claim.completedAt;
    delete claim.failedAt;
  }
  const tmpPath = `${claimPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(claim, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, claimPath);
}

export function cleanupCompletedWorktree(run: BuildRunManifestRun): void {
  const ok = spawnSync(
    "git",
    ["-C", run.worktreePath, "rev-parse", "--is-inside-work-tree"],
    {
      encoding: "utf8",
    },
  );
  if (ok.status !== 0) return;
  const removed = spawnSync(
    "git",
    ["-C", run.repoPath, "worktree", "remove", run.worktreePath],
    {
      encoding: "utf8",
    },
  );
  if (removed.status !== 0) {
    console.warn(
      `[monitor] worktree cleanup failed for completed run ${run.runId}: ${removed.stderr || removed.stdout}`,
    );
  }
}

function spawnResume(run: BuildRunManifestRun): number {
  fs.mkdirSync(path.dirname(run.pidFile), { recursive: true });
  fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
  if (
    path.isAbsolute(run.launchCommand[0]) &&
    !fs.existsSync(run.launchCommand[0])
  ) {
    throw new Error(`resume executable not found: ${run.launchCommand[0]}`);
  }
  const outFd = fs.openSync(run.stdoutLog, "a");
  try {
    const child = spawn(run.launchCommand[0], run.launchCommand.slice(1), {
      cwd: run.worktreePath,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: { ...process.env, ...(run.launchEnv ?? {}) },
    });
    fs.writeFileSync(run.pidFile, `${child.pid}\n`);
    child.unref();
    return child.pid ?? 0;
  } finally {
    fs.closeSync(outFd);
  }
}

function runEvent(
  name: MonitorEventName,
  snapshot: MonitorRunSnapshot,
  message: string,
  now: Date,
  extra: Partial<MonitorEvent> = {},
): MonitorEvent {
  return event(
    {
      event: name,
      runId: snapshot.run.runId,
      repoSlug: snapshot.run.repoSlug,
      stateSlug: snapshot.run.stateSlug,
      status: phaseStatus(snapshot.state),
      message,
      pidFile: snapshot.run.pidFile,
      stateFile: snapshot.stateFile,
      stdoutLog: snapshot.run.stdoutLog,
      ...extra,
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Active-fault registry (disk-backed) — for the DETECTED → RESOLVED diff.
// Per-runId JSON file at <activeFaultRegistryDir>/<safeRunId>.json shaped as:
//   { [faultId: string]: { firstDetectedAt, lastDetectedAt, fault } }
// Atomic write via tmp+rename so a crashed monitor doesn't corrupt state.
// ---------------------------------------------------------------------------

interface ActiveFaultEntry {
  firstDetectedAt: string;
  lastDetectedAt: string;
  fault: import("./skill-fault-detector").SkillFault;
}

type ActiveFaultRegistry = Record<string, ActiveFaultEntry>;

function safeRegistryRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function registryPathFor(dir: string, runId: string): string {
  return path.join(dir, `${safeRegistryRunId(runId)}.json`);
}

function readActiveFaultRegistry(
  dir: string,
  runId: string,
): ActiveFaultRegistry {
  const file = registryPathFor(dir, runId);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ActiveFaultRegistry;
    }
  } catch {
    // ENOENT or malformed → start fresh.
  }
  return {};
}

function writeActiveFaultRegistry(
  dir: string,
  runId: string,
  registry: ActiveFaultRegistry,
): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = registryPathFor(dir, runId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort: don't break the monitor for a registry write failure.
  }
}

export function evaluateMonitorOnce(
  opts: MonitorOnceOptions,
): MonitorEvaluation {
  const now = opts.now ?? new Date();
  const pollMs = opts.pollMs ?? 60_000;
  const skillFaultEvents: SkillFaultEvent[] = [];
  const registryDir = opts.activeFaultRegistryDir;
  const buildStallThresholdMs =
    opts.buildStallThresholdMs ??
    readBuildStallThresholdMs(opts.gstackConfigBin);
  try {
    const manifest = loadMonitorManifest(opts.manifestPath);
    const events: MonitorEvent[] = [];
    const snapshots = manifest.runs.map((run) =>
      readRunSnapshot(run, pollMs, now),
    );
    const learnedPatterns = loadLearnedPatterns();

    for (const snapshot of snapshots) {
      try {
        const faults = detectSkillFaults(
          {
            state: snapshot.state,
            worktreePath: snapshot.run.worktreePath,
            stdoutLogPath: snapshot.run.stdoutLog,
            stateDir: snapshot.stateDir,
            livingPlanPath: snapshot.run.livingPlanPath,
          },
          learnedPatterns,
        );

        if (registryDir) {
          // Diff against the disk-backed registry. New ids → DETECTED.
          // Still-active ids → bump lastDetectedAt, no event. Vanished
          // ids → RESOLVED.
          const runId = snapshot.run.runId;
          const registry = readActiveFaultRegistry(registryDir, runId);
          const ts = nowIso(now);
          const currentIds = new Set<string>();
          const newFaults: typeof faults = [];
          for (const fault of faults) {
            const id = computeFaultId(fault);
            currentIds.add(id);
            if (registry[id]) {
              // Still firing: bump timestamp.
              registry[id].lastDetectedAt = ts;
            } else {
              // New: register + flag for DETECTED emission.
              registry[id] = {
                firstDetectedAt: ts,
                lastDetectedAt: ts,
                fault,
              };
              newFaults.push(fault);
            }
          }
          if (newFaults.length > 0) {
            // Stamp faultId on each fault payload so downstream consumers
            // (drain-faults, log readers) can pair DETECTED with RESOLVED.
            const stampedFaults = newFaults.map((f) => ({
              ...f,
              faultId: computeFaultId(f),
            }));
            skillFaultEvents.push({
              event: "SKILL_FAULT_DETECTED",
              timestamp: ts,
              runId: snapshot.run.runId,
              stateSlug: snapshot.run.stateSlug,
              stateFile: snapshot.stateFile,
              manifestPath: opts.manifestPath,
              faults: stampedFaults as typeof faults,
            });
            // Dual-emit each new fault into the halt-events queue so
            // drain-faults can be the single sink. The SKILL_FAULT_DETECTED
            // event shape above is unchanged; this is purely additive.
            for (const fault of newFaults) {
              try {
                emitHaltEvent({
                  kind: "PHASE_FAILED",
                  runId: snapshot.run.runId,
                  stateSlug: snapshot.run.stateSlug,
                  severity: fault.severity as HaltSeverity,
                  message: `[${fault.category}] ${fault.description}`,
                  pointers: {
                    stateFile: snapshot.stateFile,
                    stdoutLog: snapshot.run.stdoutLog,
                    livingPlan: snapshot.run.livingPlanPath,
                    worktreePath: snapshot.run.worktreePath,
                  },
                  snapshot: buildHaltSnapshot({
                    state: snapshot.state,
                    stdoutLogPath: snapshot.run.stdoutLog,
                    worktreePath: snapshot.run.worktreePath,
                    phaseIndex: fault.evidence?.phaseIndex,
                  }),
                });
              } catch {
                // Best-effort queue write — never break the monitor.
              }
            }
          }
          // Resolved: registry entries that aren't in the current tick.
          for (const [id, entry] of Object.entries(registry)) {
            if (!currentIds.has(id)) {
              skillFaultEvents.push({
                event: "SKILL_FAULT_RESOLVED",
                timestamp: ts,
                runId: snapshot.run.runId,
                faultId: id,
                firstDetectedAt: entry.firstDetectedAt,
                lastDetectedAt: entry.lastDetectedAt,
              });
              delete registry[id];
            }
          }
          writeActiveFaultRegistry(registryDir, runId, registry);
        } else if (faults.length > 0) {
          // Back-compat path: no registry, every tick emits DETECTED.
          skillFaultEvents.push({
            event: "SKILL_FAULT_DETECTED",
            timestamp: nowIso(now),
            runId: snapshot.run.runId,
            stateSlug: snapshot.run.stateSlug,
            stateFile: snapshot.stateFile,
            manifestPath: opts.manifestPath,
            faults,
          });
          // Dual-emit each fault into the halt-events queue (additive). On
          // this back-compat path every tick re-emits, which is fine — the
          // queue file name is deterministic on faultId so re-emits idempotently
          // overwrite (atomic tmp+rename) the same on-disk record.
          for (const fault of faults) {
            try {
              emitHaltEvent({
                kind: "PHASE_FAILED",
                runId: snapshot.run.runId,
                stateSlug: snapshot.run.stateSlug,
                severity: fault.severity as HaltSeverity,
                message: `[${fault.category}] ${fault.description}`,
                pointers: {
                  stateFile: snapshot.stateFile,
                  stdoutLog: snapshot.run.stdoutLog,
                  livingPlan: snapshot.run.livingPlanPath,
                  worktreePath: snapshot.run.worktreePath,
                },
                snapshot: buildHaltSnapshot({
                  state: snapshot.state,
                  stdoutLogPath: snapshot.run.stdoutLog,
                  worktreePath: snapshot.run.worktreePath,
                  phaseIndex: fault.evidence?.phaseIndex,
                }),
              });
            } catch {
              // Best-effort queue write — never break the monitor.
            }
          }
        }
      } catch {
        // swallow
      }
      if (snapshot.stateError) {
        const terminalEvent = runEvent(
          "MONITOR_ERROR",
          snapshot,
          `state file is unreadable: ${snapshot.stateError}`,
          now,
        );
        return {
          manifest,
          events: [...events, terminalEvent],
          skillFaultEvents,
          terminalEvent,
        };
      }
      if (!snapshot.registryOk || (snapshot.state && !snapshot.identityOk)) {
        const terminalEvent = runEvent(
          "USER_ACTION_REQUIRED",
          snapshot,
          "run identity is ambiguous; refusing automatic recovery",
          now,
        );
        return {
          manifest,
          events: [...events, terminalEvent],
          skillFaultEvents,
          terminalEvent,
        };
      }
      if (
        snapshot.committedCount > snapshot.priorContextSaveCount &&
        snapshot.committedCount > 0
      ) {
        const terminalEvent = runEvent(
          "HOST_CONTEXT_SAVE_REQUIRED",
          snapshot,
          "host session must run /context-save before monitoring continues",
          now,
          {
            committed: snapshot.committedCount,
            countFile: snapshot.contextSaveCountFile,
          },
        );
        return {
          manifest,
          events: [...events, terminalEvent],
          skillFaultEvents,
          terminalEvent,
        };
      }
      if (snapshot.failed) {
        writeClaimStatus(manifest, snapshot.run, "failed", now);
        const terminalEvent = runEvent(
          "RUN_FAILED",
          snapshot,
          snapshot.state?.failureReason ?? "build run failed",
          now,
        );
        return {
          manifest,
          events: [...events, terminalEvent],
          skillFaultEvents,
          terminalEvent,
        };
      }
      if (snapshot.completed) {
        writeClaimStatus(manifest, snapshot.run, "completed", now);
        cleanupCompletedWorktree(snapshot.run);
        events.push(
          runEvent("RUN_RUNNING", snapshot, "run is complete", now, {
            status: "completed",
          }),
        );
        continue;
      }
      if (snapshot.stale) {
        if (snapshot.pidAlive || snapshot.registryPidAlive) {
          if (snapshot.recentProcessActivity) {
            // New stall arm (plan v1.40.7.0 §Change 2). The heartbeat ticker
            // keeps stdoutLog mtime fresh whether or not the orchestrator is
            // making progress, so recentProcessActivity alone can no longer
            // be trusted to mean "actually doing work". When the per-run
            // heartbeat sidecar reports BOTH state.lastUpdatedAt AND
            // drainProcessedCount frozen for >buildStallThresholdMs, we
            // escalate. When the sidecar is unavailable (missing, malformed,
            // runId/pid mismatch) we fall through to the existing
            // "waiting for state update" branch — i.e. regress to the
            // pre-fix behavior, no new silent failure mode.
            if (
              snapshot.heartbeatStalledMs != null &&
              snapshot.heartbeatStalledMs > buildStallThresholdMs
            ) {
              const minutes = Math.round(snapshot.heartbeatStalledMs / 60_000);
              const terminalEvent = runEvent(
                "USER_ACTION_REQUIRED",
                snapshot,
                `orchestrator process alive but state has not advanced for ${minutes} minutes`,
                now,
              );
              return {
                manifest,
                events: [...events, terminalEvent],
                skillFaultEvents,
                terminalEvent,
              };
            }
            events.push(
              runEvent(
                "RUN_RUNNING",
                snapshot,
                "run process is alive; waiting for state update",
                now,
              ),
            );
            continue;
          }
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            "run process or active-run registry owner is alive but state is stale",
            now,
          );
          return {
            manifest,
            events: [...events, terminalEvent],
            skillFaultEvents,
            terminalEvent,
          };
        }
        if (!snapshot.state || !snapshot.identityOk) {
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            "run is stale but identity could not be proven",
            now,
          );
          return {
            manifest,
            events: [...events, terminalEvent],
            skillFaultEvents,
            terminalEvent,
          };
        }
        const lockCleanup = cleanupDeadLock(snapshot.run.stateSlug);
        if (lockCleanup.status === "live") {
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            "run state is stale but its lock is still held by a live process",
            now,
          );
          return {
            manifest,
            events: [...events, terminalEvent],
            skillFaultEvents,
            terminalEvent,
          };
        }
        if (
          lockCleanup.status === "invalid" ||
          lockCleanup.status === "unreadable"
        ) {
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            `run state is stale but its lock cannot be safely verified (${lockCleanup.status})`,
            now,
          );
          return {
            manifest,
            events: [...events, terminalEvent],
            skillFaultEvents,
            terminalEvent,
          };
        }
        // Fix C component 2: refuse to auto-resume when prior session left
        // a synth_failure_stalemate status. Auto-resume would spawn a
        // process that hits the cli.ts stalemate guard (Fix B), exits 3
        // immediately, and the next monitor tick sees RUN_STALE again →
        // resume loop. The user's bd10c04c heartbeat-tracker fix prevents
        // false-progress signals during the cycle, but the cleanest stop
        // is to never start the cycle in the first place.
        const stalemateStatus = (
          (snapshot.state as any)?.planReview as any
        )?.status;
        if (
          stalemateStatus === "synth_failure_stalemate" ||
          stalemateStatus === "synth_failure"
        ) {
          const terminalEvent = runEvent(
            "RUN_HALTED_STALEMATE",
            snapshot,
            `plan-review-loop stalemate detected (status=${stalemateStatus}); refusing auto-resume — operator intervention required`,
            now,
            { stalemateStatus },
          );
          return {
            manifest,
            events: [...events, terminalEvent],
            skillFaultEvents,
            terminalEvent,
          };
        }

        // Fix C component 2: per-run restart cap. Secondary safety net for
        // any future failure class where the monitor keeps auto-resuming
        // without converging. Counter is stored at
        // <stateDir>/<stateSlug>.resume-count, default cap 3, overridable
        // via GSTACK_MONITOR_MAX_AUTO_RESUME.
        const counterPath = resumeCounterPath(
          snapshot.stateDir,
          snapshot.run.stateSlug,
        );
        const priorCount = readResumeCount(counterPath);
        const maxResumes = maxAutoResumeFromEnv();
        if (priorCount >= maxResumes) {
          const terminalEvent = runEvent(
            "RUN_HALTED_RESTART_CAP",
            snapshot,
            `auto-resume cap reached (${priorCount}/${maxResumes}); refusing further auto-resume — operator intervention required (set GSTACK_MONITOR_MAX_AUTO_RESUME=N to change the cap)`,
            now,
            { resumeCount: priorCount, maxResumes },
          );
          return {
            manifest,
            events: [...events, terminalEvent],
            skillFaultEvents,
            terminalEvent,
          };
        }

        let resumedPid = 0;
        if (opts.spawnResume !== false) {
          resumedPid = spawnResume(snapshot.run);
          // Increment the per-run counter only when we actually spawned a
          // resume — dry-run (spawnResume === false) doesn't burn the budget.
          writeResumeCount(counterPath, priorCount + 1);
        }
        const terminalEvent = runEvent(
          "RUN_RESUMED",
          snapshot,
          resumedPid > 0
            ? `stale run auto-resumed as pid ${resumedPid} (attempt ${priorCount + 1}/${maxResumes})`
            : "stale run would be auto-resumed",
          now,
          {
            resumeAttempted: true,
            resumeCount: priorCount + 1,
            maxResumes,
          },
        );
        return {
          manifest,
          events: [...events, terminalEvent],
          skillFaultEvents,
          terminalEvent,
        };
      }
      events.push(
        runEvent(
          snapshot.pidAlive || snapshot.registryPidAlive
            ? "RUN_RUNNING"
            : "RUN_STALE",
          snapshot,
          snapshot.pidAlive || snapshot.registryPidAlive
            ? "run process is alive"
            : "run process not found; waiting for state or stale threshold",
          now,
        ),
      );
    }

    const allComplete = snapshots.every((snapshot) => snapshot.completed);
    const terminalEvent = event(
      {
        event: allComplete ? "ALL_RUNS_COMPLETE" : "MONITOR_REENTER",
        message: allComplete
          ? "all manifest runs are complete"
          : "monitor pass complete; no terminal action required",
      },
      now,
    );
    return {
      manifest,
      events: [...events, terminalEvent],
      skillFaultEvents,
      terminalEvent,
    };
  } catch (err) {
    const terminalEvent = event(
      {
        event: "MONITOR_ERROR",
        message: (err as Error).message,
      },
      now,
    );
    return { events: [terminalEvent], skillFaultEvents, terminalEvent };
  }
}

export function monitorExitCode(name: MonitorEventName): number {
  return MONITOR_EXIT_CODES[name] ?? 30;
}

export function activeRunRegistryPathForRun(run: BuildRunManifestRun): string {
  return activeRunRecordPath(registryDirFromLaunchCommand(run), run.runId);
}
