/**
 * Read-only audit for gstack-build state ↔ living-plan ↔ on-disk-artifacts
 * consistency. Pure functions only; never writes.
 *
 * Findings come in two severities:
 *   - P0 (exit code 1): silent drift the user would not otherwise notice.
 *     The F1/F2 manual-ship reconciliation gap is the motivating case.
 *   - P1 (exit code 0 with WARN): housekeeping concerns that don't break
 *     anything today but signal stale state.
 *
 * The doctor never proposes auto-fixes — it always names the exact CLI
 * invocation the user should run (typically `gstack-build reconcile
 * --from-artifacts`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { findCodexReviewArtifacts } from "./artifact-reconcile";
import type { BuildState } from "./types";

export type DoctorSeverity = "P0" | "P1";

export interface DoctorFinding {
  severity: DoctorSeverity;
  /** Short label for the check, e.g. "committed-null-review-with-artifacts". */
  check: string;
  /** Human-readable one-line message naming the affected phase/file. */
  message: string;
  /** Concrete CLI invocation to fix this, or undefined if read-only context. */
  remediation?: string;
}

export interface DoctorReport {
  planFile: string;
  stateFile: string;
  logDir: string;
  findings: DoctorFinding[];
  /** Convenience: highest severity present, or null when findings is empty. */
  worstSeverity: DoctorSeverity | null;
}

const CHECKBOX_UNCHECKED_RE = /^\s*-\s+\[\s\]\s+\*\*/;

export interface BuildDoctorReportArgs {
  planFile: string;
  stateFile: string;
  state: BuildState;
  planContent: string;
  logDir: string;
}

/**
 * Build the report. All inputs are values (no fs reads) except for the
 * artifact scan, which goes through `findCodexReviewArtifacts` and is
 * resilient to missing directories.
 */
export function buildDoctorReport(args: BuildDoctorReportArgs): DoctorReport {
  const findings: DoctorFinding[] = [];

  // P1: state.planFile points somewhere that no longer exists.
  if (
    typeof args.state.planFile === "string" &&
    args.state.planFile.length > 0
  ) {
    if (!fs.existsSync(args.state.planFile)) {
      findings.push({
        severity: "P1",
        check: "stale-state-planFile",
        message: `state.planFile references a path that no longer exists: ${args.state.planFile}`,
        remediation: undefined,
      });
    }
  }

  const phases = args.state.phases ?? [];
  const phaseNumbers = new Set(phases.map((p) => p.number));
  const planLines = args.planContent.split(/\r?\n/);

  for (let i = 0; i < phases.length; i++) {
    const ps = phases[i];
    if (ps.status !== "committed") continue;

    const artifacts = findCodexReviewArtifacts(args.logDir, ps.number);

    // P0: committed but codexReview=null/undefined while artifacts exist.
    // This is the F2 signature — review work ran on disk, JSON state
    // forgot it.
    if (
      (ps.codexReview === null || ps.codexReview === undefined) &&
      artifacts.iterations > 0
    ) {
      findings.push({
        severity: "P0",
        check: "committed-null-review-with-artifacts",
        message: `Phase ${ps.number} is committed but codexReview is null; ${artifacts.reviewLogs.length + artifacts.qaLogs.length + artifacts.mergedFiles.length} artifact(s) exist on disk (review=${artifacts.reviewLogs.length}, qa=${artifacts.qaLogs.length}, merged=${artifacts.mergedFiles.length}).`,
        remediation: `gstack-build reconcile --from-artifacts --plan ${args.planFile} --state ${args.stateFile}`,
      });
    }
  }

  // P0 (variant): living-plan checkbox row still `[ ]` for a phase whose
  // state.status === "committed". The /build loop's plan-rewriter never
  // fired (e.g. manual ship bypass), and the user sees a misleading
  // unchecked row.
  for (let i = 0; i < phases.length; i++) {
    const ps = phases[i];
    if (ps.status !== "committed") continue;
    // Scan lines looking for a `### Phase <N>:` header, then check the
    // next ~12 lines for any unchecked `- [ ] **...**` checkbox.
    // This is a heuristic — the canonical mapping happens in parsePlan,
    // but we deliberately stay out of parser internals for the doctor.
    const headerRe = new RegExp(
      `^###\\s+Phase\\s+${ps.number.replace(/[.*+?^${}()|[\\]/g, "\\$&")}\\b`,
      "i",
    );
    let headerIdx = -1;
    for (let j = 0; j < planLines.length; j++) {
      if (headerRe.test(planLines[j])) {
        headerIdx = j;
        break;
      }
    }
    if (headerIdx === -1) continue;
    let uncheckedCount = 0;
    for (
      let j = headerIdx + 1;
      j < planLines.length && j < headerIdx + 12;
      j++
    ) {
      if (CHECKBOX_UNCHECKED_RE.test(planLines[j])) {
        uncheckedCount++;
      }
      if (planLines[j].startsWith("### ") || planLines[j].startsWith("## ")) {
        break;
      }
    }
    if (uncheckedCount > 0) {
      findings.push({
        severity: "P0",
        check: "committed-with-unchecked-plan-row",
        message: `Phase ${ps.number} is committed but has ${uncheckedCount} unchecked checkbox(es) in the living plan.`,
        remediation: `gstack-build reconcile --plan ${args.planFile} --state ${args.stateFile}`,
      });
    }
  }

  // P1: orphan artifact files referencing phase numbers absent from state.
  // Either the state was reset and forgot a phase, or a stale log dir is
  // sitting around.
  try {
    const entries = fs.readdirSync(args.logDir);
    const orphanPhases = new Set<string>();
    for (const name of entries) {
      const m =
        /^phase-(.+?)-(?:review|qa|review-merged|gemini|gemini-fix|gemini-testspec|gemini-rerun|codex)-(?:\d+)/.exec(
          name,
        );
      if (!m) continue;
      const phaseNum = m[1];
      if (!phaseNumbers.has(phaseNum)) orphanPhases.add(phaseNum);
    }
    if (orphanPhases.size > 0) {
      findings.push({
        severity: "P1",
        check: "orphan-artifact-phase",
        message: `On-disk artifacts reference phase number(s) [${[...orphanPhases].sort().join(", ")}] that don't exist in state.phases.`,
        remediation: undefined,
      });
    }
  } catch {
    /* logDir missing is not a finding — fresh state has no artifacts yet. */
  }

  let worstSeverity: DoctorSeverity | null = null;
  for (const f of findings) {
    if (f.severity === "P0") {
      worstSeverity = "P0";
      break;
    }
    if (f.severity === "P1") worstSeverity = "P1";
  }

  return {
    planFile: args.planFile,
    stateFile: args.stateFile,
    logDir: args.logDir,
    findings,
    worstSeverity,
  };
}

/**
 * Format the report for stdout. Returns a single string with a trailing
 * newline. Exit code logic lives in the caller (`runDoctorMode`).
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("gstack-build doctor");
  lines.push("");
  lines.push(`  plan:    ${report.planFile}`);
  lines.push(`  state:   ${report.stateFile}`);
  lines.push(`  log dir: ${report.logDir}`);
  lines.push("");
  if (report.findings.length === 0) {
    lines.push(
      "HEALTHY — no drift detected between state, plan, and on-disk artifacts.",
    );
    lines.push("");
    return lines.join("\n");
  }
  const p0 = report.findings.filter((f) => f.severity === "P0");
  const p1 = report.findings.filter((f) => f.severity === "P1");
  lines.push(
    `Findings: ${report.findings.length} (P0: ${p0.length}, P1: ${p1.length})`,
  );
  lines.push("");
  for (const f of report.findings) {
    lines.push(`[${f.severity}] ${f.check}`);
    lines.push(`  ${f.message}`);
    if (f.remediation) lines.push(`  → fix: ${f.remediation}`);
    lines.push("");
  }
  if (report.worstSeverity === "P0") {
    lines.push(
      "P0 findings indicate silent drift. Run the suggested reconcile command(s) above to resync state with on-disk truth.",
    );
  } else {
    lines.push(
      "P1 findings are housekeeping — no action strictly required, but worth a glance.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Resolve the log dir for a given state-file path. Mirrors the heuristic
 * used by backfill-checkboxes.ts so the doctor scans the same directory.
 */
export function resolveLogDirForState(stateFile: string): string {
  return path.join(path.dirname(stateFile), path.basename(stateFile, ".json"));
}
