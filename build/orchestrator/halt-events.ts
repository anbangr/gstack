import * as crypto from "node:crypto";
import type { BuildState } from "./types";

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
