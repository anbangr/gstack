import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InvestigationContext } from "./investigate-context";
import type { InvestigationReport } from "./investigator-dispatch";

function defaultFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

/**
 * Default destination for auto-filed bug reports and halt-event inbox markdown.
 * Lives under GSTACK_HOME so it never pollutes the cwd or any workspace root.
 * Callers can override via an explicit `inboxDir` argument or `GSTACK_INBOX_DIR`.
 */
export function defaultInboxDir(): string {
  return path.join(defaultFaultsDir(), "inbox");
}

export function bugReportSlug(args: {
  report: InvestigationReport;
  ctx: InvestigationContext;
}): string {
  const category = args.ctx.faultId
    .split(":")[0]
    .toLowerCase()
    .replace(/_/g, "-");
  const hash = crypto
    .createHash("sha256")
    .update(args.report.rootCause)
    .digest("hex")
    .slice(0, 6);
  return `build-${category}-${hash}`;
}

export function writeMachineReport(args: {
  report: InvestigationReport;
  ctx: InvestigationContext;
  faultsDir?: string;
}): string {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const runDir = path.join(faultsDir, args.ctx.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, `${args.ctx.faultId}.md`);
  const content = renderMachineReportMarkdown(args.report, args.ctx);
  const tmpPath = `${reportPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, reportPath);
  return reportPath;
}

function renderMachineReportMarkdown(
  report: InvestigationReport,
  ctx: InvestigationContext,
): string {
  if (report.outcome === "duplicate-of") {
    return `# Investigation: ${ctx.faultId}\n\n**Outcome:** duplicate-of\n\nDuplicate of: ${report.duplicateOfPath ?? "(path not provided)"}\n`;
  }
  const lines: string[] = [];
  lines.push(`# Investigation: ${ctx.faultId}`);
  lines.push("");
  lines.push(`- **Run id:** ${ctx.runId}`);
  lines.push(`- **Fault id:** ${ctx.faultId}`);
  lines.push(`- **Severity:** ${ctx.severity}`);
  lines.push(`- **Source:** ${ctx.source}`);
  lines.push(`- **Outcome:** ${report.outcome}`);
  lines.push("");
  lines.push("## Root cause");
  lines.push("");
  lines.push(report.rootCause);
  lines.push("");
  if (report.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const e of report.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  if (report.proposedFix && report.proposedFix.options.length > 0) {
    lines.push("## Proposed fix");
    lines.push("");
    let i = 1;
    for (const opt of report.proposedFix.options) {
      lines.push(
        `### Option ${i}: ${opt.label} (blast_radius: ${opt.blast_radius})`,
      );
      lines.push("");
      lines.push(opt.description);
      lines.push("");
      i++;
    }
  }
  if (report.learnedPatternProposal) {
    const lp = report.learnedPatternProposal;
    lines.push("## Learned pattern proposal");
    lines.push("");
    lines.push(`- **Category:** ${lp.category}`);
    lines.push(`- **Matcher kind:** ${lp.matcherKind}`);
    lines.push(`- **Severity:** ${lp.severity}`);
    lines.push("");
    lines.push("```");
    lines.push(lp.pattern);
    lines.push("```");
    lines.push("");
    lines.push(lp.description);
    lines.push("");
  }
  return lines.join("\n");
}

export { renderMachineReportMarkdown };

export interface WriteBugReportResult {
  skipped: boolean;
  path: string | null;
  reason?: string;
}

export function writeBugReport(args: {
  report: InvestigationReport;
  ctx: InvestigationContext;
  inboxDir?: string;
  noInbox?: boolean;
  dateOverride?: string;
}): WriteBugReportResult {
  const inboxDir =
    args.inboxDir ?? process.env.GSTACK_INBOX_DIR ?? defaultInboxDir();
  if (args.noInbox) {
    return { skipped: true, path: null, reason: "noInbox=true" };
  }
  if (args.ctx.source === "symptoms") {
    return { skipped: true, path: null, reason: "symptoms-only fault" };
  }
  if (args.ctx.severity !== "HIGH" && args.ctx.severity !== "CRITICAL") {
    return {
      skipped: true,
      path: null,
      reason: `severity=${args.ctx.severity}`,
    };
  }
  if (args.report.outcome === "duplicate-of") {
    return { skipped: true, path: null, reason: "duplicate-of outcome" };
  }

  fs.mkdirSync(inboxDir, { recursive: true });
  const date = args.dateOverride ?? new Date().toISOString().slice(0, 10);
  const slug = bugReportSlug({ report: args.report, ctx: args.ctx });
  let basename = `BUGREPORT-${date}-${slug}.md`;
  let candidatePath = path.join(inboxDir, basename);
  let suffix = 2;
  while (fs.existsSync(candidatePath)) {
    basename = `BUGREPORT-${date}-${slug}-${suffix}.md`;
    candidatePath = path.join(inboxDir, basename);
    suffix++;
  }

  const content = renderBugReportMarkdown(args.report, args.ctx, date);
  const tmpPath = `${candidatePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, candidatePath);
  return { skipped: false, path: candidatePath };
}

function renderBugReportMarkdown(
  report: InvestigationReport,
  ctx: InvestigationContext,
  date: string,
): string {
  const title =
    report.rootCause
      .split(/[.!?\n]/, 1)[0]
      .trim()
      .slice(0, 80) || ctx.faultId;
  const lines: string[] = [];
  lines.push(`# Bug: ${title}`);
  lines.push("");
  lines.push(
    `**Severity:** ${ctx.severity} — ${shortImpact(ctx.severity, report)}`,
  );
  lines.push(`**Discovered:** ${date}`);
  lines.push(`**Reporter:** /build investigate (manual, run ${ctx.runId})`);
  lines.push(`**Repro from:** fault ${ctx.faultId}`);
  lines.push("");
  lines.push("## Symptom");
  lines.push("");
  lines.push(
    ctx.haltEvent?.message ??
      ctx.symptoms ??
      "(see machine report for details)",
  );
  lines.push("");
  if (ctx.statePath || ctx.stdoutLogPath || ctx.livingPlanPath) {
    lines.push("## Repro from field");
    lines.push("");
    if (ctx.statePath) lines.push(`- state: \`${ctx.statePath}\``);
    if (ctx.stdoutLogPath) lines.push(`- stdout: \`${ctx.stdoutLogPath}\``);
    if (ctx.livingPlanPath)
      lines.push(`- living plan: \`${ctx.livingPlanPath}\``);
    if (ctx.worktreePath) lines.push(`- worktree: \`${ctx.worktreePath}\``);
    lines.push("");
  }
  lines.push("## Root cause (hypothesis)");
  lines.push("");
  lines.push(report.rootCause);
  lines.push("");
  if (report.evidence.length > 0) {
    for (const e of report.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  lines.push(`## Why ${ctx.severity}`);
  lines.push("");
  lines.push(shortImpact(ctx.severity, report));
  lines.push("");
  if (report.proposedFix && report.proposedFix.options.length > 0) {
    lines.push("## Fix sketch");
    lines.push("");
    let i = 1;
    for (const opt of report.proposedFix.options) {
      lines.push(
        `### Option ${i}: ${opt.label} (blast_radius: ${opt.blast_radius})`,
      );
      lines.push("");
      lines.push(opt.description);
      lines.push("");
      i++;
    }
  }
  lines.push("## Status");
  lines.push("");
  lines.push(
    "Filed by `/build investigate`. Not implementing — see fix options above.",
  );
  lines.push("");
  return lines.join("\n");
}

function shortImpact(
  severity: InvestigationContext["severity"],
  _report: InvestigationReport,
): string {
  if (severity === "CRITICAL")
    return "Blocks the build run from making forward progress.";
  if (severity === "HIGH")
    return "Halts the run loop and requires manual recovery.";
  return "Degrades the run; recovery is possible without manual intervention.";
}

export { renderBugReportMarkdown };
