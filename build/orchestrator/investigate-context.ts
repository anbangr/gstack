import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { HaltEvent } from "./halt-events";
import {
  defaultActiveRunRegistryDir,
  readActiveRunRecords,
  type ActiveRunRecord,
} from "./active-runs";

export interface RecentErrorRef {
  timestamp: string;
  summary?: string;
}

export interface TailStdoutLogArgs {
  stdoutPath: string;
  recentErrors: RecentErrorRef[];
  tailLines: number;
  windowLines: number;
}

// Hard cap on bytes read from stdout log. A long-running build can produce
// gigabytes of stdout; loading the full file just to slice the last 500 lines
// would OOM. 4 MiB is ~40k lines of typical orchestrator output — well above
// the 500-line tail + window-around-error budget.
const STDOUT_READ_CAP_BYTES = 4 * 1024 * 1024;

export function tailStdoutLog(args: TailStdoutLogArgs): string {
  const { stdoutPath, recentErrors, tailLines, windowLines } = args;
  if (!fs.existsSync(stdoutPath)) return "";
  const content = readLastBytes(stdoutPath, STDOUT_READ_CAP_BYTES);
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;
  const include = new Set<number>();

  for (let i = Math.max(0, total - tailLines); i < total; i++) include.add(i);

  const lineTimestamps = lines.map((line) => parseLineTimestamp(line));
  for (const err of recentErrors) {
    const errMs = Date.parse(err.timestamp);
    if (Number.isNaN(errMs)) continue;
    let anchor = -1;
    for (let i = 0; i < total; i++) {
      const t = lineTimestamps[i];
      if (t !== null && t >= errMs) {
        anchor = i;
        break;
      }
    }
    if (anchor < 0) continue;
    for (
      let i = Math.max(0, anchor - windowLines);
      i < Math.min(total, anchor + windowLines + 1);
      i++
    ) {
      include.add(i);
    }
  }

  const sorted = [...include].sort((a, b) => a - b);
  return sorted.map((i) => lines[i]).join("\n");
}

function parseLineTimestamp(line: string): number | null {
  const match = line.match(/^\[([^\]]+)\]/);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? null : ms;
}

function readLastBytes(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    const raw = buf.toString("utf8");
    // First "line" is likely truncated mid-line. Drop everything before the
    // first newline so we only return complete lines.
    const firstNewline = raw.indexOf("\n");
    return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
  } finally {
    fs.closeSync(fd);
  }
}

export type ContextSource =
  | "auto-detect"
  | "explicit-fault-id"
  | "explicit-state"
  | "explicit-run-id"
  | "symptoms"
  | "user-picked";

export interface InvestigationContext {
  runId: string;
  faultId: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  source: ContextSource;
  haltEvent: HaltEvent | null;
  statePath: string | null;
  stdoutLogPath: string | null;
  livingPlanPath: string | null;
  worktreePath: string | null;
  symptoms: string | null;
}

function defaultFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

export function loadHaltEventByFaultId(args: {
  faultId: string;
  faultsDir?: string;
}): HaltEvent | null {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const dirs = [
    path.join(faultsDir, "pending-investigations"),
    path.join(faultsDir, "processed"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      if (!entry.includes(args.faultId)) continue;
      try {
        const event = JSON.parse(
          fs.readFileSync(path.join(dir, entry), "utf8"),
        ) as HaltEvent;
        if (event.faultId === args.faultId) return event;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function pickMostRecentActiveRun(args: {
  registryDir?: string;
}): ActiveRunRecord | null {
  const registryDir = args.registryDir ?? defaultActiveRunRegistryDir();
  const records = readActiveRunRecords(registryDir);
  if (records.length === 0) return null;
  return records
    .slice()
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))[0];
}

function synthesizeManualFaultId(symptoms: string): {
  runId: string;
  faultId: string;
} {
  const ts = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(symptoms)
    .digest("hex")
    .slice(0, 8);
  return {
    runId: `manual-${ts}`,
    faultId: `MANUAL_INVESTIGATION:0:${hash}`,
  };
}

export interface ResolveContextArgs {
  faultId?: string;
  runId?: string;
  statePath?: string;
  runDir?: string;
  symptoms?: string;
  severityOverride?: "CRITICAL" | "HIGH" | "MEDIUM";
  faultsDir?: string;
  activeRunsRegistryDir?: string;
}

export async function resolveInvestigationContext(
  args: ResolveContextArgs,
): Promise<InvestigationContext | null> {
  if (args.statePath) {
    if (!fs.existsSync(args.statePath)) {
      throw new Error(`state file not found: ${args.statePath}`);
    }
    const state = JSON.parse(fs.readFileSync(args.statePath, "utf8"));
    const runId = String(state.runId ?? "unknown-run");
    return {
      runId,
      faultId: args.faultId ?? `EXPLICIT_STATE:0:${runId}`,
      severity: args.severityOverride ?? "MEDIUM",
      source: "explicit-state",
      haltEvent: null,
      statePath: args.statePath,
      stdoutLogPath: null,
      livingPlanPath: null,
      worktreePath: null,
      symptoms: args.symptoms ?? null,
    };
  }

  if (args.faultId) {
    const event = loadHaltEventByFaultId({
      faultId: args.faultId,
      faultsDir: args.faultsDir,
    });
    if (!event) return null;
    return contextFromHaltEvent(event, "explicit-fault-id", args);
  }

  if (args.symptoms) {
    const { runId, faultId } = synthesizeManualFaultId(args.symptoms);
    return {
      runId,
      faultId,
      severity: args.severityOverride ?? "MEDIUM",
      source: "symptoms",
      haltEvent: null,
      statePath: null,
      stdoutLogPath: null,
      livingPlanPath: null,
      worktreePath: null,
      symptoms: args.symptoms,
    };
  }

  const run = pickMostRecentActiveRun({
    registryDir: args.activeRunsRegistryDir,
  });
  if (!run) return null;
  const pendingDir = path.join(
    args.faultsDir ?? defaultFaultsDir(),
    "pending-investigations",
  );
  if (!fs.existsSync(pendingDir)) return null;
  const candidates = fs
    .readdirSync(pendingDir)
    .filter((n) => n.startsWith(`${run.runId}-`) && n.endsWith(".json"))
    .filter((n) => !n.includes("-RESOLVED-"));
  if (candidates.length === 0) return null;
  const sorted = candidates
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(pendingDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  const event = JSON.parse(
    fs.readFileSync(path.join(pendingDir, sorted[0].name), "utf8"),
  ) as HaltEvent;
  return contextFromHaltEvent(event, "auto-detect", args);
}

function contextFromHaltEvent(
  event: HaltEvent,
  source: ContextSource,
  args: ResolveContextArgs,
): InvestigationContext {
  const severity =
    args.severityOverride ??
    (event.severity === "LOW" ? "MEDIUM" : event.severity);
  return {
    runId: event.runId,
    faultId: event.faultId,
    severity,
    source,
    haltEvent: event,
    statePath: event.pointers.stateFile,
    stdoutLogPath: event.pointers.stdoutLog,
    livingPlanPath: event.pointers.livingPlan,
    worktreePath: event.pointers.worktreePath,
    symptoms: args.symptoms ?? null,
  };
}
