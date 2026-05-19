import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildState } from "./types";

const STDOUT_TAIL_LINES = 200;

export type HaltEventKind =
  | "PHASE_FAILED"
  | "FEATURE_FAILED"
  | "RETRY_CAP_HIT"
  | "DUAL_IMPL_SWAP"
  | "MANUAL_RECOVERY_INVOKED"
  | "SILENT_STATE_MUTATION"
  | "PHASE_REWIND"
  | "SOFT_HALT_WARN"
  | "SOFT_HALT_ERROR"
  | "STALL_KILLED";

export type HaltSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface HaltEvent {
  faultId: string;
  runId: string;
  stateSlug: string;
  kind: HaltEventKind;
  severity: HaltSeverity;
  timestamp: string;
  message: string;
  pointers: {
    stateFile: string;
    stdoutLog: string;
    livingPlan: string;
    worktreePath: string;
  };
  snapshot: {
    phase?: BuildState["phases"][number];
    feature?: BuildState["features"][number];
    failureReason?: string;
    iterationHistory?: {
      testRun?: number;
      testFix?: number;
      codexReview?: number;
    };
    worktreeHead?: string;
    stdoutTail: string;
  };
}

export function severityFor(kind: HaltEventKind): HaltSeverity {
  switch (kind) {
    case "PHASE_FAILED":
    case "FEATURE_FAILED":
      return "CRITICAL";
    case "RETRY_CAP_HIT":
    case "MANUAL_RECOVERY_INVOKED":
    case "SILENT_STATE_MUTATION":
    case "STALL_KILLED":
      return "HIGH";
    case "PHASE_REWIND":
    case "DUAL_IMPL_SWAP":
    case "SOFT_HALT_ERROR":
      return "MEDIUM";
    case "SOFT_HALT_WARN":
      return "LOW";
  }
}

export function computeFaultId(
  event: Omit<HaltEvent, "faultId" | "timestamp">,
): string {
  const phaseIdx = event.snapshot.phase?.index;
  const featureIdx = event.snapshot.feature?.number;
  const idx =
    typeof phaseIdx === "number"
      ? `p${phaseIdx}`
      : typeof featureIdx === "string" && featureIdx.length > 0
        ? `f${featureIdx}`
        : "all";
  const hash = crypto
    .createHash("sha256")
    .update(`${event.kind}:${idx}:${event.message}`)
    .digest("hex")
    .slice(0, 8);
  return `${event.kind}:${idx}:${hash}`;
}

function defaultSkillFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

function safeRegistryRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function pendingInvestigationsDir(opts?: { queueDir?: string }): string {
  return path.join(
    opts?.queueDir ?? defaultSkillFaultsDir(),
    "pending-investigations",
  );
}

export function processedDir(opts?: { queueDir?: string }): string {
  return path.join(opts?.queueDir ?? defaultSkillFaultsDir(), "processed");
}

export function emitHaltEvent(
  event: Omit<HaltEvent, "faultId" | "timestamp">,
  opts?: { queueDir?: string; now?: Date },
): string {
  const faultId = computeFaultId(event);
  const timestamp = (opts?.now ?? new Date()).toISOString();
  const full: HaltEvent = { ...event, faultId, timestamp };
  const dir = pendingInvestigationsDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const safeRun = safeRegistryRunId(event.runId);
  const finalPath = path.join(dir, `${safeRun}-${faultId}.json`);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);
  return faultId;
}

export function loadPendingInvestigations(opts?: {
  queueDir?: string;
}): HaltEvent[] {
  const dir = pendingInvestigationsDir(opts);
  if (!fs.existsSync(dir)) return [];
  const out: HaltEvent[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      out.push(JSON.parse(raw) as HaltEvent);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function markInvestigated(
  runId: string,
  faultId: string,
  // _outcome is reserved for future use; logging happens at the call site.
  _outcome: "investigated" | "skipped-no-context" | "self-healed",
  opts?: { queueDir?: string },
): void {
  const safeRun = safeRegistryRunId(runId);
  const fileName = `${safeRun}-${faultId}.json`;
  const src = path.join(pendingInvestigationsDir(opts), fileName);
  const dstDir = processedDir(opts);
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, fileName);
  fs.renameSync(src, dst);
}

export interface BuildHaltSnapshotInput {
  state: BuildState | null;
  stdoutLogPath: string;
  worktreePath: string;
  phaseIndex?: number;
  featureIndex?: number;
  failureReason?: string;
}

export function buildHaltSnapshot(
  input: BuildHaltSnapshotInput,
): HaltEvent["snapshot"] {
  const phase =
    typeof input.phaseIndex === "number"
      ? input.state?.phases?.[input.phaseIndex]
      : undefined;
  const feature =
    typeof input.featureIndex === "number"
      ? input.state?.features?.[input.featureIndex]
      : undefined;
  const iterationHistory = phase
    ? {
        testRun: phase.testRun?.iterations,
        testFix: phase.testFix?.iterations,
        codexReview: phase.codexReview?.iterations,
      }
    : undefined;
  let stdoutTail = "";
  try {
    const raw = fs.readFileSync(input.stdoutLogPath, "utf8");
    const lines = raw.split("\n");
    stdoutTail = lines.slice(Math.max(0, lines.length - STDOUT_TAIL_LINES)).join("\n");
  } catch {
    stdoutTail = "";
  }
  let worktreeHead: string | undefined;
  try {
    const res = spawnSync(
      "git",
      ["-C", input.worktreePath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    if (res.status === 0) worktreeHead = res.stdout.trim();
  } catch {
    // ignore
  }
  return {
    phase,
    feature,
    failureReason: input.failureReason,
    iterationHistory,
    worktreeHead,
    stdoutTail,
  };
}
