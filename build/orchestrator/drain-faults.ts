/**
 * Drain pending skill-fault investigations from a build's monitor-output.log.
 *
 * This is the TS port of Step M3.5's bash dispatch logic (build/SKILL.md.tmpl).
 * It exists because:
 *
 *   - The skill agent running /build can die between MONITOR_REENTER cycles
 *     (context limit, host crash, manual abort). When that happens, faults
 *     that the monitor detected are stranded in monitor-output.log with no
 *     investigation report ever produced.
 *
 *   - This module gives two recovery paths:
 *       1. The /build skill calls `gstack-build drain-faults --manifest ...`
 *          at the top of Step M3.5 so any backlog drains before the new run's
 *          dispatch fires.
 *       2. monitor.ts itself calls drainFaults() inline on terminal events
 *          (RUN_FAILED, ALL_RUNS_COMPLETE) so faults drain even if no skill
 *          agent is alive to call the subcommand. Belt-and-suspenders.
 *
 *   - Users can also run `gstack-build drain-faults --build-tmp-dir <path>`
 *     to recover investigations for an old/abandoned build.
 *
 * Key behavior differences from the bash dispatch:
 *
 *   - Looser catch-all trigger: fires discovery investigator when log contains
 *     RUN_FAILED AND zero SKILL_FAULT_DETECTED events, regardless of the
 *     monitor-exit-code file. (The bash requires _MONITOR_EXIT==20, but that
 *     file is exactly what gets corrupted in the bug we're fixing.)
 *
 *   - Defensive monitor-exit-code parsing: empty/malformed file returns null
 *     and downstream code falls back to log-content trigger.
 *
 *   - Dedup-by-glob is filename-compatible with the bash: shared
 *     sanitizeForFilename() must mirror `tr -c 'A-Za-z0-9._-' '_'` exactly.
 *
 *   - Table-driven provider dispatch: one Record<Provider, ArgvBuilder> instead
 *     of 5 case branches.
 *
 *   - Per-investigator stall watchdog (default 10min) via attachStallWatchdog
 *     in mtime mode on the report file. An investigator that keeps writing to
 *     its report runs as long as it needs; only a genuinely silent investigator
 *     gets killed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "./child-registry";
import { attachStallWatchdog, killProcessAndGroup } from "./stall-watchdog";
import {
  loadPendingEntries,
  loadPendingInvestigations,
  markInvestigated,
  pendingInvestigationsDir,
  processedDir,
  type HaltEvent,
  type HaltSeverity,
} from "./halt-events";

// Provider-halt kinds consumed by the queue printer + dedup key.
const PROVIDER_HALT_KINDS = [
  "PROVIDER_TIMEOUT",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_OVERLOADED",
  "PROVIDER_TRANSPORT_ERROR",
  "PROVIDER_AUTH_REQUIRED",
] as const;
import {
  buildInvestigatorPrompt,
  parseInvestigationReport,
  type InvestigationReport,
} from "./investigator-dispatch";
import { defaultInboxDir } from "./investigate-report-writer";
import { AUDIT_HALT_KINDS, loadLearnedPatterns } from "./skill-fault-detector";
const AUDIT_HALT_KIND_SET = new Set<string>(AUDIT_HALT_KINDS);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvestigatorProvider = "claude" | "codex" | "gemini" | "kimi";

export interface DrainFaultsOptions {
  /** Path to build-run-manifest.json (mutually exclusive with buildTmpDir). */
  manifestPath?: string;
  /** Path to BUILD_TMP_DIR directly (mutually exclusive with manifestPath). */
  buildTmpDir?: string;
  /** Primary report directory. Defaults to $GSTACK_HOME/skill-faults. */
  primaryDir?: string;
  /**
   * Optional secondary mirror directory. Defaults to <fork>/inbox/skill-faults
   * via the symlink the user maintains (or null if it doesn't exist).
   */
  secondaryDir?: string | null;
  /** Custom investigator command (shell), overrides provider/model resolution. */
  investigatorCommand?: string;
  /** Investigator provider. Resolved from configure.cm if unset. */
  investigatorProvider?: InvestigatorProvider;
  /** Investigator model id. Resolved from configure.cm if unset. */
  investigatorModel?: string;
  /** Reasoning effort for codex provider. Defaults to "high". */
  investigatorReasoning?: string;
  /** If true, parse + dedup + report intent without spawning. */
  dryRun?: boolean;
  /**
   * If true, fire a discovery investigator when the log shows RUN_FAILED with
   * no SKILL_FAULT_DETECTED events. (Looser trigger than the bash, which
   * additionally requires _MONITOR_EXIT==20.)
   */
  catchAll?: boolean;
  /** Per-investigator timeout in milliseconds. Default 10 minutes. */
  investigatorTimeoutMs?: number;
  /** For tests: override gstack-config binary path. */
  gstackConfigBin?: string;
  /** For tests: override configure.cm path. */
  configureFile?: string;
}

export interface DrainFaultsResult {
  monitorLog: string;
  /** Whether monitor-output.log existed and was readable. */
  logExists: boolean;
  /** Total SKILL_FAULT_DETECTED lines in the log (before dedup). */
  totalEvents: number;
  /** After dedup by (runId, category). */
  uniqueFaults: number;
  /** Investigators successfully spawned this run (excludes dry-run). */
  reportsSpawned: number;
  /** Faults skipped because a matching report already exists on disk. */
  reportsSkipped: number;
  /** Investigator commands that exited non-zero or hit timeout. */
  reportsFailed: number;
  /** Primary paths of new reports. */
  reportPaths: string[];
  /** Catch-all discovery investigators fired (0 if !catchAll). */
  discoverySpawned: number;
  /** Defensive parse warning: monitor-exit-code was empty/malformed. */
  monitorExitCodeCorrupt: boolean;
  /** Parsed exit code if numeric, else null. */
  monitorExitCode: number | null;
}

interface FaultRow {
  runId: string;
  category: string;
  fault: SkillFaultPayload;
  event: SkillFaultDetectedPayload;
}

interface SkillFaultPayload {
  category?: string;
  severity?: string;
  description?: string;
  sourceFiles?: string[];
  evidence?: Record<string, unknown>;
}

interface SkillFaultDetectedPayload {
  event?: string;
  timestamp?: string;
  runId?: string;
  stateSlug?: string;
  stateFile?: string;
  manifestPath?: string;
  faults?: SkillFaultPayload[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INVESTIGATOR_MODEL = "claude-sonnet-4-6";
const DEFAULT_INVESTIGATOR_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MONITOR_LOG_NAME = "monitor-output.log";
const MONITOR_EXIT_CODE_NAME = "monitor-exit-code";
const BUILD_RUN_MANIFEST_NAME = "build-run-manifest.json";

// ---------------------------------------------------------------------------
// Filename sanitization (MUST mirror the bash `tr -c 'A-Za-z0-9._-' '_'`).
// Cross-path dedup depends on TS and bash producing identical filenames.
// ---------------------------------------------------------------------------

export function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Provider dispatch table — DRY across 5 providers (per 2A).
// Each builder returns the argv to execute. Env is layered separately.
// ---------------------------------------------------------------------------

interface SpawnContext {
  prompt: string;
  model: string;
  reasoning: string;
  cwd: string;
}

const PROVIDER_DISPATCH: Record<
  InvestigatorProvider,
  (ctx: SpawnContext) => { cmd: string; args: string[] }
> = {
  claude: (ctx) => ({
    cmd: "claude",
    args: ["--model", ctx.model, "-p", ctx.prompt],
  }),
  gemini: (ctx) => ({
    cmd: "gemini",
    args: ["-p", ctx.prompt, "-m", ctx.model, "--yolo"],
  }),
  kimi: (ctx) => ({
    cmd: "kimi",
    args: [
      "--work-dir",
      ctx.cwd,
      "-p",
      ctx.prompt,
      "-m",
      ctx.model,
      "--yolo",
      "--print",
      "--final-message-only",
    ],
  }),
  codex: (ctx) => ({
    cmd: "codex",
    args: [
      "exec",
      ctx.prompt,
      "-m",
      ctx.model,
      "-s",
      "workspace-write",
      "-c",
      `model_reasoning_effort="${ctx.reasoning}"`,
      "-C",
      ctx.cwd,
    ],
  }),
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getGstackHome(): string {
  return process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
}

function defaultPrimaryDir(): string {
  return path.join(getGstackHome(), "skill-faults");
}

/**
 * Resolve the secondary mirror directory.
 *
 * Per eng-review decision 1E: prefer the user-maintained `inbox/skill-faults`
 * symlink at the fork-repo root. The bash M3.5 used `readlink ~/.claude/skills/gstack`
 * which only works when gstack is installed via symlink (not via rsync), so
 * that path is unreliable for fork-copy installs.
 *
 * Returns null if no usable secondary location is found. The drain logic
 * treats null as "primary-only" and proceeds without error.
 */
function resolveSecondaryDir(): string | null {
  // The user has historically maintained inbox/skill-faults → ~/.gstack/skill-faults
  // as a symlink. Walking up from cwd to find the fork repo is fragile here,
  // so let the caller pass in the value when they know it. Default to null
  // for the common case (drain called from non-fork dir or no symlink).
  return null;
}

// ---------------------------------------------------------------------------
// Config resolution (mirrors bash lines 1086-1098)
// ---------------------------------------------------------------------------

interface InvestigatorConfig {
  provider: InvestigatorProvider | "";
  model: string;
  reasoning: string;
}

function readGstackConfigValue(
  key: string,
  gstackConfigBin: string | undefined,
): string {
  if (!gstackConfigBin) return "";
  try {
    const result = spawnSync(gstackConfigBin, ["get", key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout.trim();
    }
  } catch {
    // Best-effort; missing binary or non-existent key returns "".
  }
  return "";
}

function readConfigureCmField(configureFile: string, field: string): string {
  try {
    if (!fs.existsSync(configureFile)) return "";
    const content = fs.readFileSync(configureFile, "utf-8");
    const parsed = JSON.parse(content) as {
      roles?: { faultInvestigator?: Record<string, unknown> };
    };
    const raw = parsed?.roles?.faultInvestigator?.[field];
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}

function heuristicProvider(model: string): InvestigatorProvider {
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("kimi")) return "kimi";
  if (model.startsWith("gpt-") || /^o\d/.test(model)) return "codex";
  return "claude";
}

function resolveInvestigatorConfig(
  opts: DrainFaultsOptions,
): InvestigatorConfig {
  const gstackConfigBin =
    opts.gstackConfigBin ??
    path.join(
      os.homedir(),
      ".claude",
      "skills",
      "gstack",
      "bin",
      "gstack-config",
    );
  const configureFile =
    opts.configureFile ??
    path.join(
      os.homedir(),
      ".claude",
      "skills",
      "gstack",
      "build",
      "configure.cm",
    );

  let model = opts.investigatorModel ?? "";
  if (!model)
    model = readGstackConfigValue("fault_investigator_model", gstackConfigBin);
  if (!model) model = readConfigureCmField(configureFile, "model");
  if (!model) model = DEFAULT_INVESTIGATOR_MODEL;

  let provider: InvestigatorProvider | "" = opts.investigatorProvider ?? "";
  if (!provider) {
    const raw = readGstackConfigValue(
      "fault_investigator_provider",
      gstackConfigBin,
    );
    if (
      raw === "claude" ||
      raw === "codex" ||
      raw === "gemini" ||
      raw === "kimi"
    ) {
      provider = raw;
    }
  }
  if (!provider) {
    const raw = readConfigureCmField(configureFile, "provider");
    if (
      raw === "claude" ||
      raw === "codex" ||
      raw === "gemini" ||
      raw === "kimi"
    ) {
      provider = raw;
    }
  }
  if (!provider) provider = heuristicProvider(model);

  const reasoning =
    opts.investigatorReasoning ??
    readConfigureCmField(configureFile, "reasoning") ??
    "high";

  return { provider, model, reasoning: reasoning || "high" };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse monitor-output.log into FaultRow tuples, deduplicated by (runId, category).
 *
 * Malformed lines are skipped silently (the bash uses `jq 2>/dev/null` so the
 * same lenience applies). The first occurrence of each (runId, category) wins.
 */
export function parseFaultLog(logContent: string): {
  rows: FaultRow[];
  totalEvents: number;
  hasRunFailed: boolean;
} {
  // Order-aware scan. Walk events linearly, tracking per-(runId, faultId)
  // "open" state. DETECTED opens a session for that fault id. RESOLVED
  // closes the session AND drops any pending row that opened it. A second
  // DETECTED after a RESOLVED is a fresh session (the transient cleared,
  // then came back) — it survives.
  //
  // Per-(runId, category) dedup runs on top: among surviving DETECTEDs,
  // the FIRST one we kept wins the row slot (matches the prior behavior
  // for legacy logs without faultId).
  //
  // Legacy logs whose DETECTED events lack faultId never match RESOLVED
  // events (different keying) and follow the old dedup-by-category path.
  let totalEvents = 0;
  let hasRunFailed = false;
  const seen = new Set<string>();
  const rows: FaultRow[] = [];
  // Open DETECTED-row ids → index in `rows`. A later RESOLVED removes the
  // open id from the map AND splices the row out of `rows`.
  const openRowIndex = new Map<string, number>();

  for (const line of logContent.split("\n")) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.event === "RUN_FAILED") {
      hasRunFailed = true;
      continue;
    }
    if (parsed?.event === "SKILL_FAULT_RESOLVED") {
      if (
        typeof parsed.runId === "string" &&
        typeof parsed.faultId === "string"
      ) {
        const pairKey = `${parsed.runId}|${parsed.faultId}`;
        const rowIdx = openRowIndex.get(pairKey);
        if (typeof rowIdx === "number") {
          // Splice the open row out (drop from investigator queue).
          const removed = rows.splice(rowIdx, 1);
          if (removed.length > 0) {
            const removedCategoryKey = `${sanitizeForFilename(removed[0].runId)}|${sanitizeForFilename(removed[0].category)}`;
            seen.delete(removedCategoryKey);
          }
          openRowIndex.delete(pairKey);
          // Reindex subsequent open entries to account for the splice.
          for (const [k, v] of openRowIndex) {
            if (v > rowIdx) openRowIndex.set(k, v - 1);
          }
        }
      }
      continue;
    }
    if (parsed?.event !== "SKILL_FAULT_DETECTED") continue;
    if (!Array.isArray(parsed.faults)) continue;

    const runId = typeof parsed.runId === "string" ? parsed.runId : "unknown";
    for (const fault of parsed.faults) {
      totalEvents += 1;
      const category =
        typeof fault.category === "string" ? fault.category : "UNKNOWN";
      const categoryKey = `${sanitizeForFilename(runId)}|${sanitizeForFilename(category)}`;
      if (seen.has(categoryKey)) continue;
      seen.add(categoryKey);
      rows.push({ runId, category, fault, event: parsed });
      // Track open state by faultId so a later RESOLVED can splice this
      // row out if the session closes before drain time.
      const faultId = (fault as any).faultId;
      if (typeof faultId === "string") {
        openRowIndex.set(`${runId}|${faultId}`, rows.length - 1);
      }
    }
  }

  return { rows, totalEvents, hasRunFailed };
}

/**
 * Defensive parse of the monitor-exit-code file (per eng-review 2C).
 *
 * Returns the parsed integer if the file content is a valid number.
 * Returns null for missing file, empty content (the actual bug shape:
 * 1-byte newline-only file), or non-numeric content. Callers should treat
 * null as "unknown" rather than as "0".
 */
export function parseMonitorExitCode(filePath: string): {
  code: number | null;
  corrupt: boolean;
} {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { code: null, corrupt: false };
  }
  const trimmed = content.trim();
  if (trimmed === "") return { code: null, corrupt: true };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return { code: null, corrupt: true };
  return { code: n, corrupt: false };
}

// ---------------------------------------------------------------------------
// Resolve the source of monitor-output.log
// ---------------------------------------------------------------------------

function resolveBuildTmpDir(opts: DrainFaultsOptions): string {
  if (opts.buildTmpDir) return opts.buildTmpDir;
  if (opts.manifestPath) return path.dirname(opts.manifestPath);
  throw new Error(
    "drainFaults: must provide either manifestPath or buildTmpDir",
  );
}

// ---------------------------------------------------------------------------
// Investigator spawning
// ---------------------------------------------------------------------------

interface SpawnOpts {
  reportPath: string;
  secondaryPath: string | null;
  faultEvent: string;
  faultCategory: string;
  faultRunId: string;
  reportName: string;
  prompt: string;
  config: InvestigatorConfig;
  investigatorCommand?: string;
  timeoutMs: number;
}

async function spawnInvestigator(opts: SpawnOpts): Promise<"ok" | "failed"> {
  // Ensure the report dir exists.
  fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
  // Open the report file for the investigator's stdout/stderr.
  const out = fs.openSync(opts.reportPath, "w");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAULT_PRIMARY: opts.reportPath,
    FAULT_SECONDARY: opts.secondaryPath ?? "",
    FAULT_EVENT: opts.faultEvent,
    FAULT_CATEGORY: opts.faultCategory,
    FAULT_RUN_ID: opts.faultRunId,
    FAULT_REPORT_NAME: opts.reportName,
    FAULT_INVESTIGATOR_MODEL: opts.config.model,
  };

  let child: ChildProcess;
  if (opts.investigatorCommand) {
    // Custom command via shell — matches GSTACK_FAULT_INVESTIGATOR_COMMAND.
    child = spawn("bash", ["-lc", opts.investigatorCommand], {
      env,
      stdio: ["ignore", out, out],
    });
  } else {
    const builder =
      PROVIDER_DISPATCH[opts.config.provider as InvestigatorProvider];
    if (!builder) {
      fs.closeSync(out);
      return "failed";
    }
    const { cmd, args } = builder({
      prompt: opts.prompt,
      model: opts.config.model,
      reasoning: opts.config.reasoning,
      cwd: process.cwd(),
    });
    child = spawn(cmd, args, { env, stdio: ["ignore", out, out] });
  }

  return await new Promise<"ok" | "failed">((resolve) => {
    let settled = false;
    const settle = (verdict: "ok" | "failed") => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      try {
        fs.closeSync(out);
      } catch {
        // already closed
      }
      // Mirror to secondary if primary has content.
      if (opts.secondaryPath) {
        try {
          if (fs.statSync(opts.reportPath).size > 0) {
            fs.mkdirSync(path.dirname(opts.secondaryPath), { recursive: true });
            fs.copyFileSync(opts.reportPath, opts.secondaryPath);
          }
        } catch {
          // best effort
        }
      }
      resolve(verdict);
    };

    // The investigator pipes stdout/stderr straight to a file descriptor
    // (stdio: ['ignore', out, out]) so we can't tap the streams in Node.
    // mtime-mode watchdog polls the report file at 1s — matches the
    // monitor.ts:344-347 recentProcessActivity pattern. Same liveness
    // semantics as the rest of the orchestrator: only kill if the
    // investigator goes genuinely silent for opts.timeoutMs.
    const watchdog = attachStallWatchdog(
      { mode: "mtime", filePath: opts.reportPath },
      {
        stallMs: opts.timeoutMs,
        provider: opts.config.provider as
          | "claude"
          | "codex"
          | "gemini"
          | "kimi",
        onStallKill: () => {
          // Investigator can be `bash -lc <user-string>` which spawns
          // grandchildren. SIGTERM to the bash leader alone leaves the
          // grandchildren orphaned to init. Signal the whole process
          // group, then escalate to SIGKILL after gracePeriodMs (5s)
          // to match the sub-agent stall-kill path in spawnCaptured.
          const pid = child.pid;
          if (typeof pid === "number" && pid > 0) {
            killProcessAndGroup(pid, "SIGTERM");
            setTimeout(() => {
              killProcessAndGroup(pid, "SIGKILL");
            }, 5000).unref();
          }
          settle("failed");
        },
      },
    );

    child.on("error", () => {
      settle("failed");
    });
    child.on("exit", (code) => {
      settle(code === 0 ? "ok" : "failed");
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Drain pending fault investigations from a build's monitor-output.log.
 *
 * Idempotent: re-running on the same log skips faults that already have a
 * matching skill-fault-*.md report in primaryDir.
 *
 * Never throws on missing log or unreadable manifest. Returns a populated
 * DrainFaultsResult so callers can decide how to surface partial failures.
 */
export async function drainFaults(
  opts: DrainFaultsOptions = {},
): Promise<DrainFaultsResult> {
  const buildTmpDir = resolveBuildTmpDir(opts);
  const monitorLog = path.join(buildTmpDir, MONITOR_LOG_NAME);
  const monitorExitCodeFile = path.join(buildTmpDir, MONITOR_EXIT_CODE_NAME);
  const primaryDir = opts.primaryDir ?? defaultPrimaryDir();
  const secondaryDir =
    opts.secondaryDir === undefined ? resolveSecondaryDir() : opts.secondaryDir;
  const timeoutMs =
    opts.investigatorTimeoutMs ?? DEFAULT_INVESTIGATOR_TIMEOUT_MS;

  const result: DrainFaultsResult = {
    monitorLog,
    logExists: false,
    totalEvents: 0,
    uniqueFaults: 0,
    reportsSpawned: 0,
    reportsSkipped: 0,
    reportsFailed: 0,
    reportPaths: [],
    discoverySpawned: 0,
    monitorExitCodeCorrupt: false,
    monitorExitCode: null,
  };

  // Defensive parse of monitor-exit-code (per 2C)
  const exitParse = parseMonitorExitCode(monitorExitCodeFile);
  result.monitorExitCode = exitParse.code;
  result.monitorExitCodeCorrupt = exitParse.corrupt;

  // Read the monitor log
  let logContent: string;
  try {
    logContent = fs.readFileSync(monitorLog, "utf-8");
    result.logExists = true;
  } catch {
    return result; // No log = nothing to drain. Idempotent no-op.
  }

  const { rows, totalEvents, hasRunFailed } = parseFaultLog(logContent);
  result.totalEvents = totalEvents;
  result.uniqueFaults = rows.length;

  if (rows.length === 0 && !opts.catchAll) {
    return result;
  }

  fs.mkdirSync(primaryDir, { recursive: true });
  const config = resolveInvestigatorConfig(opts);

  // Per-category dispatch
  const spawns: Promise<void>[] = [];
  for (const row of rows) {
    const runSafe = sanitizeForFilename(row.runId);
    const categorySafe = sanitizeForFilename(row.category);
    const reportName = `skill-fault-${runSafe}-${categorySafe}.md`;
    const reportPath = path.join(primaryDir, reportName);
    const secondaryPath = secondaryDir
      ? path.join(secondaryDir, reportName)
      : null;

    // Dedup against on-disk reports
    if (faultReportExists(primaryDir, runSafe, categorySafe)) {
      result.reportsSkipped += 1;
      continue;
    }

    if (opts.dryRun) {
      result.reportPaths.push(reportPath);
      result.reportsSpawned += 1; // accounted as intent
      continue;
    }

    const sourceList = (row.fault.sourceFiles ?? []).join(", ");
    const prompt =
      `A skill fault was detected (category: ${row.category}, runId: ${row.runId}). ` +
      `Source files: ${sourceList || "none"}. Event JSON: ${JSON.stringify(row.event)}. ` +
      `Investigate the root cause. You MUST ONLY read files and write the investigation ` +
      `report to ${reportPath}. Do NOT write code, modify any other file, run tests, ` +
      `or commit anything.`;

    spawns.push(
      (async () => {
        const verdict = await spawnInvestigator({
          reportPath,
          secondaryPath,
          faultEvent: JSON.stringify(row.event),
          faultCategory: row.category,
          faultRunId: row.runId,
          reportName,
          prompt,
          config,
          investigatorCommand: opts.investigatorCommand,
          timeoutMs,
        });
        if (verdict === "ok") {
          result.reportsSpawned += 1;
          result.reportPaths.push(reportPath);
        } else {
          result.reportsFailed += 1;
        }
      })(),
    );
  }

  await Promise.all(spawns);

  // Catch-all discovery (per 1B looser trigger)
  if (opts.catchAll && rows.length === 0 && hasRunFailed) {
    const lastRunId = extractLastRunFailedRunId(logContent) ?? "unknown";
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*/, "");
    const discoveryName = `skill-fault-discovery-${sanitizeForFilename(lastRunId)}-${ts}.md`;
    const discoveryPath = path.join(primaryDir, discoveryName);
    const prompt =
      `A build just failed (runId: ${lastRunId}). No known fault category matched. ` +
      `Read the monitor log at ${monitorLog} for context. Write a detailed investigation: ` +
      `what failed, the root cause, the evidence. You MUST ONLY read files. Do NOT write ` +
      `code, run tests, or commit anything. Write your report to ${discoveryPath}.`;

    if (opts.dryRun) {
      result.discoverySpawned = 1;
      result.reportPaths.push(discoveryPath);
    } else {
      const verdict = await spawnInvestigator({
        reportPath: discoveryPath,
        secondaryPath: secondaryDir
          ? path.join(secondaryDir, discoveryName)
          : null,
        faultEvent: "",
        faultCategory: "catch-all",
        faultRunId: lastRunId,
        reportName: discoveryName,
        prompt,
        config,
        investigatorCommand: opts.investigatorCommand,
        timeoutMs,
      });
      if (verdict === "ok") {
        result.discoverySpawned = 1;
        result.reportPaths.push(discoveryPath);
      } else {
        result.reportsFailed += 1;
      }
    }
  }

  return result;
}

function faultReportExists(
  primaryDir: string,
  runSafe: string,
  categorySafe: string,
): boolean {
  try {
    const exact = path.join(
      primaryDir,
      `skill-fault-${runSafe}-${categorySafe}.md`,
    );
    if (fs.existsSync(exact)) return true;
    // Glob match: any file matching *-{run}-{category}.md (the bash uses this
    // pattern so reports from older versions with timestamp prefixes still dedup).
    const entries = fs.readdirSync(primaryDir);
    const suffix = `-${runSafe}-${categorySafe}.md`;
    return entries.some((e) => e.endsWith(suffix));
  } catch {
    return false;
  }
}

function extractLastRunFailedRunId(logContent: string): string | null {
  let lastRunId: string | null = null;
  for (const line of logContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { event?: string; runId?: string };
      if (parsed.event === "RUN_FAILED" && typeof parsed.runId === "string") {
        lastRunId = parsed.runId;
      }
    } catch {
      continue;
    }
  }
  return lastRunId;
}

/**
 * Convenience entry point for monitor.ts to drain on terminal events without
 * needing to construct DrainFaultsOptions itself. Failures are swallowed so
 * the caller's exit path isn't perturbed.
 */
export async function drainFaultsFromMonitor(
  manifestPath: string,
): Promise<DrainFaultsResult | null> {
  try {
    return await drainFaults({ manifestPath, catchAll: true });
  } catch {
    return null;
  }
}

// ===========================================================================
// Halt-events queue path (PR 5 of the halt-events rollout)
// ===========================================================================
//
// This is the NEW queue-driven path that consumes structured halt events from
// ~/.gstack/skill-faults/pending-investigations/*.json. It runs ALONGSIDE the
// existing log-based drainFaults() above — that path consumes
// monitor-output.log line-by-line. They share the provider-dispatch table
// (PROVIDER_DISPATCH) and the configure.cm resolver, but the new path uses a
// different role (`investigator` instead of `faultInvestigator`) and a
// different default model (codex/gpt-5.5/high instead of claude-sonnet-4-6).
//
// Why a separate function: the queue path captures stdout (to parse as JSON)
// rather than redirecting it to a file (which is what the log path does for
// the markdown report). Different output discipline = different spawn path.

const SEVERITY_RANK: Record<HaltSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export interface DrainHaltEventsOptions {
  /** Override the queue dir. Defaults to $GSTACK_HOME/skill-faults. */
  queueDir?: string;
  /** Cap the number of investigations dispatched per invocation. Default 20. */
  max?: number;
  /** Filter: only process events at or above this severity. Default MEDIUM. */
  severityMin?: HaltSeverity;
  /** Scope to a single runId. */
  runIdFilter?: string;
  /** Override the configure.cm role for the investigator model. */
  investigatorModel?: string;
  /** Per-investigator timeout in ms. Default 10 minutes. */
  investigatorTimeoutMs?: number;
  /**
   * Override inbox dir for auto-filing. Default
   * `~/.gstack/skill-faults/inbox/` (see `defaultInboxDir`). Respects
   * `GSTACK_INBOX_DIR` as a middle-precedence override.
   */
  inboxDir?: string;
  /**
   * TEST-ONLY: synchronous mock returning an InvestigationReport. When set,
   * skips real LLM dispatch entirely. Production paths MUST leave this unset.
   */
  mockInvestigator?: (he: HaltEvent) => InvestigationReport;
  /** For tests: override gstack-config binary path. */
  gstackConfigBin?: string;
  /** For tests: override configure.cm path. */
  configureFile?: string;
  /** If true, parse + report intent without spawning an investigator. */
  dryRun?: boolean;
  /**
   * Optional cancellation signal. When aborted:
   *  - The per-entry loop breaks BEFORE processing the next event.
   *  - Any in-flight `spawnInvestigatorCapture` child receives SIGTERM with
   *    a 5s grace before SIGKILL (same pattern as the per-investigator
   *    timeout path). Already-completed work in this drain stays committed.
   * Production: `runAutoDrainIfEnabled` builds an `AbortSignal.timeout()`
   * for the 30-min wall-clock budget. Manual `gstack-build drain-faults --queue`
   * does not pass a signal and runs unbounded as before.
   */
  signal?: AbortSignal;
  /**
   * Called after each processed/shortCircuited/skipped entry so the
   * orchestrator can bump `state.lastUpdatedAt` (visible to the monitor's
   * stall arm via the heartbeat sidecar) and increment its
   * `drainProcessedCount` counter. Wired from `drainFaultsForBuildRun`;
   * `--queue` callers omit it.
   */
  onEntryProcessed?: () => void;
}

export interface DrainHaltEventsResult {
  /** Investigations dispatched and parsed successfully. */
  processed: number;
  /** Events filtered out by severity gate or runId filter. */
  skipped: number;
  /** Events that matched an existing learned pattern (no dispatch). */
  shortCircuited: number;
  /** Auto-filed to <inbox>/<date>-halt-<faultId>.md. */
  inboxFiled: number;
  /** Pattern proposals appended to pending-patterns.jsonl. */
  proposalsAppended: number;
  /** Events that failed to dispatch or parse. */
  failed: number;
  /**
   * True if the drain stopped because `opts.signal` aborted before the
   * pending queue was drained. Callers can log the remaining count and
   * leave entries in pending-investigations/ for the next run.
   */
  aborted?: boolean;
  /** Pending entries left in the queue when aborted. 0 when not aborted. */
  deferred?: number;
}

/**
 * Read configure.cm and return the resolved investigator role.
 *
 * Falls back to { codex, gpt-5.5, high } if file is missing or role is absent.
 * Distinct from the existing resolveInvestigatorConfig() because:
 *   - It reads `roles.investigator` (not `roles.faultInvestigator`).
 *   - Its fallback is codex/gpt-5.5 (not claude-sonnet-4-6).
 */
function resolveInvestigatorRole(opts: {
  configureFile?: string;
  investigatorModel?: string;
}): InvestigatorConfig {
  const configureFile =
    opts.configureFile ??
    path.join(
      os.homedir(),
      ".claude",
      "skills",
      "gstack",
      "build",
      "configure.cm",
    );
  let provider: InvestigatorProvider = "codex";
  let model = "gpt-5.5";
  let reasoning = "high";
  try {
    if (fs.existsSync(configureFile)) {
      const content = fs.readFileSync(configureFile, "utf-8");
      const parsed = JSON.parse(content) as {
        roles?: { investigator?: Record<string, unknown> };
      };
      const role = parsed?.roles?.investigator;
      if (role) {
        const rawProvider = role.provider;
        if (
          rawProvider === "claude" ||
          rawProvider === "codex" ||
          rawProvider === "gemini" ||
          rawProvider === "kimi"
        ) {
          provider = rawProvider;
        }
        if (typeof role.model === "string" && role.model.trim() !== "") {
          model = role.model;
        }
        if (
          typeof role.reasoning === "string" &&
          role.reasoning.trim() !== ""
        ) {
          reasoning = role.reasoning;
        }
      }
    }
  } catch {
    // fall through to defaults
  }
  if (opts.investigatorModel && opts.investigatorModel.trim() !== "") {
    model = opts.investigatorModel;
    // If user overrode model, re-derive provider via heuristic.
    provider = heuristicProvider(model);
  }
  return { provider, model, reasoning };
}

/**
 * Spawn an investigator and CAPTURE its stdout to a buffer (rather than
 * redirecting to a file like the log-path spawnInvestigator does).
 *
 * Returns the raw stdout string on success, or null on spawn/exit failure or
 * stall-kill. Reuses PROVIDER_DISPATCH for argv construction so all 4
 * providers work identically across log and queue paths.
 */
async function spawnInvestigatorCapture(args: {
  prompt: string;
  config: InvestigatorConfig;
  timeoutMs: number;
  /**
   * Optional cancellation signal. When aborted while the child is running,
   * the child receives SIGTERM and after a 5s grace SIGKILL — same
   * escalation as the wall-clock timeout. The returned promise resolves
   * to `null`.
   */
  signal?: AbortSignal;
}): Promise<string | null> {
  // Short-circuit if the signal is already aborted — don't spawn at all.
  if (args.signal?.aborted) return null;

  const builder =
    PROVIDER_DISPATCH[args.config.provider as InvestigatorProvider];
  if (!builder) return null;
  const { cmd, args: cmdArgs } = builder({
    prompt: args.prompt,
    model: args.config.model,
    reasoning: args.config.reasoning,
    cwd: process.cwd(),
  });
  const child = spawn(cmd, cmdArgs, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
    });
  }
  if (child.stderr) {
    // Drain stderr so codex doesn't backpressure; we don't use it.
    child.stderr.resume();
  }

  // Helper: send SIGTERM with 5s grace before SIGKILL. Reused by both the
  // wall-clock timeout and the AbortSignal handler so the kill semantics
  // are identical.
  const escalateKill = () => {
    const pid = child.pid;
    if (typeof pid === "number" && pid > 0) {
      killProcessAndGroup(pid, "SIGTERM");
      setTimeout(() => {
        killProcessAndGroup(pid, "SIGKILL");
      }, 5000).unref();
    }
  };

  // Wall-clock timeout (no mtime watchdog here since we're streaming stdout
  // directly; this is a different liveness regime than the file-watching
  // log path).
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    escalateKill();
  }, args.timeoutMs);
  // Don't keep the event loop alive solely for this timer.
  if (typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }

  // AbortSignal: when the orchestrator-level budget fires (or the caller
  // cancels for any reason), kill the in-flight child with the same
  // escalation. The listener is removed on exit so a one-off signal doesn't
  // accumulate listeners across many investigator calls.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    escalateKill();
  };
  if (args.signal) {
    if (args.signal.aborted) {
      onAbort();
    } else {
      args.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (args.signal) {
        args.signal.removeEventListener("abort", onAbort);
      }
      resolve(v);
    };
    child.on("error", () => settle(null));
    child.on("exit", (code) => {
      if (timedOut || aborted) {
        settle(null);
        return;
      }
      settle(code === 0 ? stdoutBuf : null);
    });
  });
}

/**
 * Render the InvestigationReport into the per-fault markdown report.
 * Written to <queueDir>/<runId>/<faultId>.md.
 */
function renderInvestigationMarkdown(
  he: HaltEvent,
  report: InvestigationReport,
): string {
  const lines: string[] = [];
  lines.push(`# Halt investigation: ${he.faultId}`);
  lines.push("");
  lines.push(`**Kind:** ${he.kind}`);
  lines.push(`**Severity:** ${he.severity}`);
  lines.push(`**Outcome:** ${report.outcome}`);
  lines.push(`**Halt message:** ${he.message}`);
  lines.push("");
  lines.push("## Root cause");
  lines.push("");
  lines.push(report.rootCause);
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  if (report.evidence.length === 0) {
    lines.push("(none)");
  } else {
    for (const e of report.evidence) lines.push(`- ${e}`);
  }
  lines.push("");
  if (report.proposedFix && report.proposedFix.options.length > 0) {
    lines.push("## Proposed fix");
    lines.push("");
    for (const opt of report.proposedFix.options) {
      lines.push(`### ${opt.label} (blast: ${opt.blast_radius})`);
      lines.push("");
      lines.push(opt.description);
      lines.push("");
    }
  }
  if (report.learnedPatternProposal) {
    const lp = report.learnedPatternProposal;
    lines.push("## Learned pattern proposal");
    lines.push("");
    lines.push(`Category: ${lp.category}`);
    lines.push(`Matcher: ${lp.matcherKind}`);
    lines.push(`Pattern: \`${lp.pattern}\``);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Render the inbox auto-file markdown — Garry's signal that a halt needs
 * triage. Only written when severity >= HIGH AND outcome is actionable.
 */
function renderInboxMarkdown(
  he: HaltEvent,
  report: InvestigationReport,
  now: Date,
): string {
  const lines: string[] = [];
  lines.push(`# Halt investigation: ${he.kind}`);
  lines.push("");
  lines.push(`**Auto-filed by drain-faults** (${now.toISOString()})`);
  lines.push(`**Halt severity:** ${he.severity}`);
  lines.push(`**Outcome:** ${report.outcome}`);
  lines.push(`**Run:** ${he.runId}`);
  lines.push("");
  lines.push("## Symptom");
  lines.push("");
  lines.push(he.message);
  lines.push("");
  lines.push("## Root cause (investigator)");
  lines.push("");
  lines.push(report.rootCause);
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  if (report.evidence.length === 0) {
    lines.push("(none)");
  } else {
    for (const e of report.evidence) lines.push(`- ${e}`);
  }
  lines.push("");
  if (report.proposedFix && report.proposedFix.options.length > 0) {
    lines.push("## Proposed fix");
    lines.push("");
    for (const opt of report.proposedFix.options) {
      lines.push(`### ${opt.label} (blast: ${opt.blast_radius})`);
      lines.push("");
      lines.push(opt.description);
      lines.push("");
    }
  } else {
    lines.push("## Proposed fix");
    lines.push("");
    lines.push("(none — investigator did not propose one)");
    lines.push("");
  }
  return lines.join("\n");
}

function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Check if any existing learned pattern matches this halt event's symptoms.
 *
 * Crude first cut: scan against stdoutTail / failureReason via the same
 * matcherKind semantics the detector uses. Returns the matched pattern's
 * category, or null. On match, callers short-circuit the investigator.
 */
function learnedPatternMatch(he: HaltEvent): { category: string } | null {
  let patterns;
  try {
    patterns = loadLearnedPatterns();
  } catch {
    return null;
  }
  if (!patterns || patterns.length === 0) return null;
  const stdoutTail = he.snapshot?.stdoutTail ?? "";
  const failureReason = he.snapshot?.failureReason ?? "";
  for (const lp of patterns) {
    try {
      let hit = false;
      switch (lp.matcherKind) {
        case "stdout_contains":
          hit = stdoutTail.includes(lp.pattern);
          break;
        case "stdout_regex":
          hit = new RegExp(lp.pattern).test(stdoutTail);
          break;
        case "failureReason_contains":
          hit = failureReason.includes(lp.pattern);
          break;
        case "failureReason_regex":
          hit = new RegExp(lp.pattern).test(failureReason);
          break;
        // plan_*/state_jsonpath would need re-reading the plan/state file
        // referenced by pointers. Out of scope for the queue's short-circuit
        // (the detector already evaluates these against live state).
        default:
          hit = false;
      }
      if (hit) return { category: lp.category };
    } catch {
      // ignore malformed pattern
    }
  }
  return null;
}

/**
 * Drain halt events from ~/.gstack/skill-faults/pending-investigations/.
 *
 * For each pending halt event:
 *   1. Severity gate + runId filter
 *   2. Check learned-patterns for a short-circuit. If hit, log + move to
 *      processed/, skip investigator dispatch.
 *   3. Dispatch investigator (real via configure.cm role, or mockInvestigator
 *      for tests). Parse the InvestigationReport from stdout.
 *   4. Write 3 sinks:
 *      - Append to ~/.gstack/analytics/skill-faults.jsonl
 *      - <queueDir>/<runId>/<faultId>.md
 *      - If severity >= HIGH AND outcome in {root-cause-identified, needs-human}:
 *        <inboxDir>/<YYYY-MM-DD>-halt-<faultId>.md
 *   5. If learnedPatternProposal is non-null: append to pending-patterns.jsonl
 *   6. Move queue file from pending-investigations/ to processed/.
 *
 * Guardrails: opts.max (default 20), opts.severityMin (default MEDIUM),
 * opts.runIdFilter.
 */
export async function drainFaultsFromHaltEventsQueue(
  opts: DrainHaltEventsOptions = {},
): Promise<DrainHaltEventsResult> {
  const result: DrainHaltEventsResult = {
    processed: 0,
    skipped: 0,
    shortCircuited: 0,
    inboxFiled: 0,
    proposalsAppended: 0,
    failed: 0,
  };

  const queueDir = opts.queueDir ?? path.join(getGstackHome(), "skill-faults");
  const max = opts.max ?? 20;
  const severityMin = opts.severityMin ?? "MEDIUM";
  const minRank = SEVERITY_RANK[severityMin];
  const timeoutMs =
    opts.investigatorTimeoutMs ?? DEFAULT_INVESTIGATOR_TIMEOUT_MS;

  // ---- DETECTED + RESOLVED pair-collapse pre-pass ----
  // The wrap-console emitter writes a DETECTED row, and code paths that
  // detect their own recovery (Kimi→Gemini fallback success in
  // sub-agents.ts; plan-reviewer.ts critical_exit_pending resolution in
  // cli.ts) call emitHaltEventResolved to write a paired RESOLVED row.
  // Before dispatching codex, collapse every pair by (runId, faultId):
  // move both files to processed/ and skip the per-event loop entirely.
  // Orphan RESOLVED rows (no matching DETECTED) get moved to processed/
  // silently — they represent transient faults whose DETECTED already
  // drained on a prior run.
  const pendingDir = pendingInvestigationsDir({ queueDir });
  const processedTo = processedDir({ queueDir });
  const allEntries = loadPendingEntries({ queueDir }).filter((entry) => {
    if (!opts.runIdFilter) return true;
    return entry.kind === "detected"
      ? entry.event.runId === opts.runIdFilter
      : entry.runId === opts.runIdFilter;
  });
  const detectedByKey = new Map<
    string,
    Extract<(typeof allEntries)[number], { kind: "detected" }>
  >();
  for (const e of allEntries) {
    if (e.kind === "detected") {
      const key = `${e.event.runId}|${e.event.faultId}`;
      detectedByKey.set(key, e);
    }
  }
  const collapsedDetectedKeys = new Set<string>();
  for (const e of allEntries) {
    if (e.kind !== "resolved") continue;
    const key = `${e.runId}|${e.faultId}`;
    const detected = detectedByKey.get(key);
    if (detected) {
      // Pair found: move BOTH files to processed/.
      try {
        fs.mkdirSync(processedTo, { recursive: true });
        fs.renameSync(
          path.join(pendingDir, detected.file),
          path.join(processedTo, detected.file),
        );
        fs.renameSync(
          path.join(pendingDir, e.file),
          path.join(processedTo, e.file),
        );
        collapsedDetectedKeys.add(key);
      } catch (err) {
        // Best-effort: a concurrent drain may have moved one side already.
        process.stderr.write(
          `[drain-faults] pair-collapse rename failed for ${key}: ${(err as Error).message}\n`,
        );
      }
    } else {
      // Orphan RESOLVED: no DETECTED to collapse. Move to processed/ so
      // the queue doesn't accumulate stale resolution markers. No
      // analytics row — orphan RESOLVEDs are silent.
      try {
        fs.mkdirSync(processedTo, { recursive: true });
        fs.renameSync(
          path.join(pendingDir, e.file),
          path.join(processedTo, e.file),
        );
      } catch {
        // ignore — concurrent drain race or already moved
      }
    }
  }

  // Now load the surviving detected events for the normal dispatch loop.
  // Filter out any whose key was just collapsed (defensive: the rename
  // above already removed the file, but loadPendingInvestigations was
  // taken before the renames in the unlikely case of a future re-order).
  const events = loadPendingInvestigations({ queueDir }).filter(
    (he) => !collapsedDetectedKeys.has(`${he.runId}|${he.faultId}`),
  );

  // Dedup provider-halt events by (runId, kind) — same underlying
  // evidence (timeout, quota, etc.) from the same run should only be
  // investigated once per drain invocation.
  const providerKindSet = new Set<string>(PROVIDER_HALT_KINDS);
  const seenEvents = new Set<string>();
  const dedupedEvents: HaltEvent[] = [];
  for (const he of events) {
    if (providerKindSet.has(he.kind)) {
      const key = `${he.runId}|${he.kind}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
    }
    dedupedEvents.push(he);
  }

  // Existing learned-pattern categories — passed to the prompt so the
  // investigator doesn't propose duplicates.
  let existingCategories: string[] = [];
  try {
    existingCategories = loadLearnedPatterns().map((lp) => lp.category);
  } catch {
    // ignore
  }

  let processedCount = 0;
  let abortedDuringLoop = false;
  for (const he of dedupedEvents) {
    // Cooperative cancellation: check BEFORE every entry so the abort
    // doesn't have to wait for a slow investigator to finish. If we just
    // dispatched and the signal fires during the await, spawnInvestigatorCapture
    // will see the abort and kill the child.
    if (opts.signal?.aborted) {
      abortedDuringLoop = true;
      break;
    }
    // Severity gate. Skipped entries do NOT bump the progress signal:
    // they represent queue noise filtered before any real work, and
    // claiming progress on them would let a flood of low-severity entries
    // keep the monitor stall arm quiet forever even if nothing is actually
    // moving. (For shortCircuited entries see further down — those DO
    // bump because they atomically move the queue file to processed/, so
    // they represent real forward progress on disk even though no
    // investigator ran.)
    if (SEVERITY_RANK[he.severity] < minRank) {
      result.skipped += 1;
      continue;
    }
    // runId filter. Same reasoning as the severity gate: a fault for
    // another run isn't progress for THIS run.
    if (opts.runIdFilter && he.runId !== opts.runIdFilter) {
      result.skipped += 1;
      continue;
    }
    // max cap (count only events that would be processed, after filters)
    if (processedCount >= max) {
      // Leave remaining events in pending-investigations/ for the next run.
      continue;
    }
    processedCount += 1;

    // investigate:false short-circuit — audit events from manual-recovery
    // sites (drain-faults / mark-shipped / --mark-phase-committed) are
    // observability signals, not investigation requests. Skip dispatch,
    // move directly to processed/, record outcome: "audit-skipped" in
    // analytics. Closes the drain-faults --queue self-enqueue loop where
    // the queue consumer would otherwise pay codex (~$0.30) to investigate
    // its own invocation.
    //
    // Gates (post-codex-adversarial hardening):
    //   - kind === RECOVERY_BOUNDARY (M1 fix): the flag is scoped to
    //     manual-recovery audit events. A corrupted PHASE_FAILED row with
    //     investigate:false must NOT bypass investigation.
    //   - dryRun honored BEFORE the move (L1 fix): --dry-run is read-only.
    //   - markInvestigated success required before recording the skip
    //     (H3 fix): the previous shape swallowed every error and still
    //     reported a successful short-circuit. Concurrent-drain losers
    //     correctly increment shortCircuited because the rename did move
    //     the file (just by the other process); but EACCES / bad queue
    //     paths leave the file in pending/ and must NOT be counted as
    //     skipped or appended to analytics.
    if (he.investigate === false && AUDIT_HALT_KIND_SET.has(he.kind)) {
      if (opts.dryRun) {
        // Dry-run mode is read-only: report the intent without moving the
        // file or writing analytics. Count under shortCircuited so the
        // caller's accounting matches the production behavior they're
        // simulating.
        result.shortCircuited += 1;
        continue;
      }
      let moved = false;
      try {
        markInvestigated(he.runId, he.faultId, "audit-skipped", { queueDir });
        moved = true;
      } catch (err) {
        // The file may have been moved by a concurrent drain (ENOENT is
        // expected in that case — the other process won the race and the
        // skip has effectively happened, so still count it). For other
        // errors (EACCES, EROFS, bad queue path), the file is still in
        // pending/ and reporting a skip would silently lose the event.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          moved = true;
        } else {
          process.stderr.write(
            `[drain-faults] markInvestigated failed for audit event ${he.faultId}: ${(err as Error).message}; leaving in pending-investigations/\n`,
          );
          result.failed += 1;
          continue;
        }
      }
      if (moved) {
        try {
          const analyticsDir = path.join(getGstackHome(), "analytics");
          fs.mkdirSync(analyticsDir, { recursive: true });
          const analyticsPath = path.join(analyticsDir, "skill-faults.jsonl");
          const row = JSON.stringify({
            ts: new Date().toISOString(),
            faultId: he.faultId,
            outcome: "audit-skipped",
          });
          fs.appendFileSync(analyticsPath, row + "\n");
        } catch (err) {
          process.stderr.write(
            `[drain-faults] analytics audit-skipped sink failed for ${he.faultId}: ${(err as Error).message}\n`,
          );
        }
        result.shortCircuited += 1;
        opts.onEntryProcessed?.();
      }
      continue;
    }

    // Learned-pattern short-circuit
    const lpMatch = learnedPatternMatch(he);
    if (lpMatch) {
      process.stderr.write(
        `[drain-faults] matched learned ${lpMatch.category} for ${he.faultId}; skipping investigator\n`,
      );
      try {
        markInvestigated(he.runId, he.faultId, "self-healed", { queueDir });
      } catch {
        // ignore — file may have been moved by a concurrent drain
      }
      result.shortCircuited += 1;
      opts.onEntryProcessed?.();
      continue;
    }

    if (opts.dryRun) {
      result.processed += 1;
      opts.onEntryProcessed?.();
      continue;
    }

    // Dispatch investigator (real or mock)
    let report: InvestigationReport | null = null;
    if (opts.mockInvestigator) {
      try {
        report = opts.mockInvestigator(he);
      } catch (err) {
        process.stderr.write(
          `[drain-faults] mockInvestigator threw for ${he.faultId}: ${(err as Error).message}\n`,
        );
        result.failed += 1;
        continue;
      }
    } else {
      const config = resolveInvestigatorRole({
        configureFile: opts.configureFile,
        investigatorModel: opts.investigatorModel,
      });
      const prompt = buildInvestigatorPrompt({
        haltEvent: he,
        existingCategories,
      });
      const raw = await spawnInvestigatorCapture({
        prompt,
        config,
        timeoutMs,
        signal: opts.signal,
      });
      // Abort-vs-failure disambiguation: spawnInvestigatorCapture returns null
      // on BOTH (a) genuine investigator failure and (b) AbortSignal-driven
      // SIGTERM kill. If we just no-op `result.failed += 1; continue;` here,
      // an abort that fires during the LAST entry's investigator would never
      // tip the loop into the abortedDuringLoop branch — the budget-exceeded
      // warning would be silently lost and `aborted: false` would be returned
      // even though the budget DID fire. Check the signal explicitly after
      // the await: aborted means this entry deferred, not failed.
      if (opts.signal?.aborted) {
        abortedDuringLoop = true;
        break;
      }
      if (raw === null) {
        process.stderr.write(
          `[drain-faults] investigator dispatch failed for ${he.faultId}\n`,
        );
        result.failed += 1;
        continue;
      }
      try {
        report = parseInvestigationReport(raw, he.faultId);
      } catch (err) {
        process.stderr.write(
          `[drain-faults] failed to parse InvestigationReport for ${he.faultId}: ${(err as Error).message}\n`,
        );
        result.failed += 1;
        continue;
      }
    }

    if (!report) {
      result.failed += 1;
      continue;
    }

    // Write the 3 sinks + proposal
    const now = new Date();

    // Sink 1: analytics jsonl
    try {
      const analyticsDir = path.join(getGstackHome(), "analytics");
      fs.mkdirSync(analyticsDir, { recursive: true });
      const analyticsPath = path.join(analyticsDir, "skill-faults.jsonl");
      const row = JSON.stringify({
        ts: now.toISOString(),
        faultId: he.faultId,
        investigation: report,
      });
      fs.appendFileSync(analyticsPath, row + "\n");
    } catch (err) {
      process.stderr.write(
        `[drain-faults] analytics sink failed for ${he.faultId}: ${(err as Error).message}\n`,
      );
    }

    // Sink 2: per-fault markdown
    try {
      const runDir = path.join(queueDir, he.runId);
      fs.mkdirSync(runDir, { recursive: true });
      const md = renderInvestigationMarkdown(he, report);
      fs.writeFileSync(path.join(runDir, `${he.faultId}.md`), md);
    } catch (err) {
      process.stderr.write(
        `[drain-faults] markdown sink failed for ${he.faultId}: ${(err as Error).message}\n`,
      );
    }

    // Sink 3: inbox auto-file (severity >= HIGH AND actionable outcome)
    const actionable =
      report.outcome === "root-cause-identified" ||
      report.outcome === "needs-human";
    if (SEVERITY_RANK[he.severity] >= SEVERITY_RANK.HIGH && actionable) {
      try {
        const inboxDir = opts.inboxDir ?? defaultInboxDir();
        fs.mkdirSync(inboxDir, { recursive: true });
        // Collision-avoidance suffix loop (F3): a same-UTC-day re-emit of the
        // same faultId computes the identical base filename. A bare write would
        // silently clobber the earlier triage signal yet still bump inboxFiled,
        // so the filed count would over-report the files actually on disk. Walk
        // -2, -3, ... (the same shape writeBugReport uses) so both day-of
        // signals survive and inboxFiled matches what landed.
        const inboxBase = `${isoDateUtc(now)}-halt-${he.faultId}`;
        let inboxName = `${inboxBase}.md`;
        let inboxSeq = 2;
        while (fs.existsSync(path.join(inboxDir, inboxName))) {
          inboxName = `${inboxBase}-${inboxSeq}.md`;
          inboxSeq += 1;
        }
        fs.writeFileSync(
          path.join(inboxDir, inboxName),
          renderInboxMarkdown(he, report, now),
        );
        result.inboxFiled += 1;
      } catch (err) {
        process.stderr.write(
          `[drain-faults] inbox sink failed for ${he.faultId}: ${(err as Error).message}\n`,
        );
      }
    }

    // Pattern proposal
    if (report.learnedPatternProposal && !AUDIT_HALT_KIND_SET.has(he.kind)) {
      try {
        const proposalPath = path.join(queueDir, "pending-patterns.jsonl");
        fs.mkdirSync(path.dirname(proposalPath), { recursive: true });
        const row = JSON.stringify({
          ts: now.toISOString(),
          faultId: he.faultId,
          proposal: report.learnedPatternProposal,
        });
        fs.appendFileSync(proposalPath, row + "\n");
        result.proposalsAppended += 1;
      } catch (err) {
        process.stderr.write(
          `[drain-faults] proposal sink failed for ${he.faultId}: ${(err as Error).message}\n`,
        );
      }
    }

    // Move to processed/
    try {
      markInvestigated(he.runId, he.faultId, "investigated", { queueDir });
    } catch (err) {
      process.stderr.write(
        `[drain-faults] markInvestigated failed for ${he.faultId}: ${(err as Error).message}\n`,
      );
    }

    result.processed += 1;
    opts.onEntryProcessed?.();
  }

  // Aborted accounting: every event that did not contribute to one of the
  // counted categories is "deferred" — still sitting in pending-investigations/
  // for the next run to pick up.
  if (abortedDuringLoop) {
    result.aborted = true;
    const accounted =
      result.processed + result.skipped + result.shortCircuited + result.failed;
    result.deferred = Math.max(0, events.length - accounted);
  } else {
    result.aborted = false;
    result.deferred = 0;
  }

  // Reference imports so unused-import linting doesn't strip the type re-export.
  void pendingInvestigationsDir;
  return result;
}

// ---------------------------------------------------------------------------
// drainFaultsForBuildRun — production wrapper for end-of-build auto-drain
// ---------------------------------------------------------------------------

/**
 * Production wrapper around `drainFaultsFromHaltEventsQueue` that ties the
 * drain to a live `BuildState`:
 *
 *   1. Calls `saveState(state, ...)` after each processed entry so the
 *      monitor's stall arm sees `state.lastUpdatedAt` advancing — proves
 *      the orchestrator is making per-entry progress, distinct from the
 *      heartbeat ticker which only proves the event loop is running.
 *   2. Increments an in-memory `drainProcessedCount` exposed via a getter.
 *      The heartbeat reads this counter into the sidecar payload so the
 *      monitor can distinguish "looping on the same broken entry" from
 *      "no progress at all" (codex finding #6, plan v1.40.7.0 §Change 2).
 *
 * The base `drainFaultsFromHaltEventsQueue` keeps its existing optional
 * shape so the `gstack-build drain-faults --queue` CLI subcommand — which
 * runs without a `BuildState` — continues to work unchanged.
 */
export function createDrainProgressCounter(): {
  count: () => number;
  bump: () => void;
} {
  let counter = 0;
  return {
    count: () => counter,
    bump: () => {
      counter += 1;
    },
  };
}

export async function drainFaultsForBuildRun(
  state: BuildStateLike,
  saveState: (state: BuildStateLike) => void,
  opts: DrainHaltEventsOptions,
  progress?: { bump: () => void },
): Promise<DrainHaltEventsResult> {
  return drainFaultsFromHaltEventsQueue({
    ...opts,
    onEntryProcessed: () => {
      // Bump state.lastUpdatedAt so the heartbeat sidecar's stateLastUpdatedAt
      // field moves on the next tick. Persist via the caller-provided
      // saveState (we don't import the cli.ts saveState wrapper directly to
      // avoid a circular dep — cli.ts wires the projection here).
      state.lastUpdatedAt = new Date().toISOString();
      try {
        saveState(state);
      } catch (err) {
        process.stderr.write(
          `[drain-faults] saveState during drain progress failed: ${(err as Error).message}\n`,
        );
      }
      progress?.bump();
      // Compose with a caller-provided onEntryProcessed if any (none today
      // but keeps the wrapper composable for tests).
      opts.onEntryProcessed?.();
    },
  });
}

/**
 * Minimal shape of BuildState that drainFaultsForBuildRun needs. Kept narrow
 * so this module stays decoupled from the full BuildState type (defined in
 * types.ts) and so tests can pass a 2-field mock without constructing a full
 * BuildState. The production caller passes the real BuildState — TypeScript
 * structural typing accepts it.
 */
export interface BuildStateLike {
  lastUpdatedAt: string;
}
