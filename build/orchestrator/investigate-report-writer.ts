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
