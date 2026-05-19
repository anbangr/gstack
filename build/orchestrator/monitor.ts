import { spawn, spawnSync } from "./child-registry";
import * as fs from "node:fs";
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
  return {
    run,
    stateFile,
    stateDir: path.dirname(stateFile),
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
        let resumedPid = 0;
        if (opts.spawnResume !== false) {
          resumedPid = spawnResume(snapshot.run);
        }
        const terminalEvent = runEvent(
          "RUN_RESUMED",
          snapshot,
          resumedPid > 0
            ? `stale run auto-resumed as pid ${resumedPid}`
            : "stale run would be auto-resumed",
          now,
          { resumeAttempted: true },
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
