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
