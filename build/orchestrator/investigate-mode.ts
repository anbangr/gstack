import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveInvestigationContext,
  tailStdoutLog,
  type InvestigationContext,
} from "./investigate-context";
import { parseInvestigationReport } from "./investigator-dispatch";
import {
  acquireFaultLock,
  releaseFaultLock,
} from "./investigate-lock";
import {
  writeMachineReport,
  writeBugReport,
} from "./investigate-report-writer";

export interface InvestigateModeArgs {
  faultId?: string;
  runId?: string;
  statePath?: string;
  runDir?: string;
  symptoms?: string;
  severityOverride?: "CRITICAL" | "HIGH" | "MEDIUM";
  noInbox?: boolean;
  emitJson?: boolean;
  faultsDir?: string;
  activeRunsRegistryDir?: string;
}

export interface InvestigateFinalizeArgs {
  runId: string;
  faultId: string;
  reportPath: string;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM";
  noInbox?: boolean;
  faultsDir?: string;
  inboxDir?: string;
}

function defaultFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

export async function runInvestigateMode(
  args: InvestigateModeArgs,
): Promise<number> {
  let ctx: InvestigationContext | null;
  try {
    ctx = await resolveInvestigationContext({
      faultId: args.faultId,
      runId: args.runId,
      statePath: args.statePath,
      runDir: args.runDir,
      symptoms: args.symptoms,
      severityOverride: args.severityOverride,
      faultsDir: args.faultsDir,
      activeRunsRegistryDir: args.activeRunsRegistryDir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 2;
  }

  if (!ctx) {
    if (args.faultId) {
      process.stderr.write(`error: fault not found: ${args.faultId}\n`);
      return 2;
    }
    process.stderr.write(
      "error: no context auto-detected and stdin is not a TTY. Pass --state, --run-id, --fault-id, or --symptoms explicitly.\n",
    );
    return 3;
  }

  const lock = acquireFaultLock({
    runId: ctx.runId,
    faultId: ctx.faultId,
    faultsDir: args.faultsDir,
  });
  if (!lock) {
    process.stderr.write(
      `error: another investigation is already in progress for ${ctx.faultId}\n`,
    );
    return 2;
  }

  let stdoutTail = "";
  if (ctx.stdoutLogPath) {
    let recentErrors: { timestamp: string; summary?: string }[] = [];
    if (ctx.statePath && fs.existsSync(ctx.statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(ctx.statePath, "utf8"));
        if (Array.isArray(state.recentErrors)) recentErrors = state.recentErrors;
      } catch {
        // state file may be partial mid-write
      }
    }
    stdoutTail = tailStdoutLog({
      stdoutPath: ctx.stdoutLogPath,
      recentErrors,
      tailLines: 500,
      windowLines: 50,
    });
  }

  const briefing = {
    runId: ctx.runId,
    faultId: ctx.faultId,
    severity: ctx.severity,
    source: ctx.source,
    statePath: ctx.statePath,
    stdoutLogPath: ctx.stdoutLogPath,
    stdoutTail,
    livingPlanPath: ctx.livingPlanPath,
    worktreePath: ctx.worktreePath,
    haltEvent: ctx.haltEvent,
    symptoms: ctx.symptoms,
    finalizeHint:
      `When your investigation is complete, write the InvestigationReport JSON to a tmp file and run: ` +
      `gstack-build investigate-finalize --run-id ${ctx.runId} --fault-id ${ctx.faultId} --report <path>${args.noInbox ? " --no-inbox" : ""}`,
  };

  process.stdout.write("<<<GSTACK_INVESTIGATE_BRIEFING>>>\n");
  process.stdout.write(JSON.stringify(briefing, null, 2) + "\n");
  process.stdout.write("<<<END>>>\n");
  // Lock is held on disk; finalize will release. In-process handle is intentionally discarded.
  void lock;
  return 0;
}

export async function runInvestigateFinalize(
  args: InvestigateFinalizeArgs,
): Promise<number> {
  if (!fs.existsSync(args.reportPath)) {
    process.stderr.write(`error: report file not found: ${args.reportPath}\n`);
    return 2;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(args.reportPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: cannot read report file: ${(err as Error).message}\n`,
    );
    return 2;
  }

  let report: ReturnType<typeof parseInvestigationReport>;
  try {
    report = parseInvestigationReport(raw, args.faultId);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    releaseLockByPath(args);
    return 2;
  }

  const ctx: InvestigationContext = {
    runId: args.runId,
    faultId: args.faultId,
    severity: args.severity ?? "HIGH",
    source: "auto-detect",
    haltEvent: null,
    statePath: null,
    stdoutLogPath: null,
    livingPlanPath: null,
    worktreePath: null,
    symptoms: null,
  };

  const machinePath = writeMachineReport({
    report,
    ctx,
    faultsDir: args.faultsDir,
  });

  let bugPath: string | null = null;
  try {
    const bugResult = writeBugReport({
      report,
      ctx,
      inboxDir: args.inboxDir,
      noInbox: args.noInbox,
    });
    if (!bugResult.skipped) bugPath = bugResult.path;
  } catch (err) {
    process.stderr.write(
      `warning: bug report write failed: ${(err as Error).message}\n`,
    );
  }

  releaseLockByPath(args);

  const lines = [
    `investigation finalized for ${args.faultId} (${report.outcome})`,
    `  machine report: ${machinePath}`,
  ];
  if (bugPath) lines.push(`  bug report:     ${bugPath}`);
  if (report.learnedPatternProposal) {
    lines.push(
      `  pattern proposal present — run \`gstack-build learn-fault-patterns\` to absorb it`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");

  if (report.outcome === "needs-human" || report.outcome === "no-context") {
    return 1;
  }
  return 0;
}

function releaseLockByPath(args: InvestigateFinalizeArgs): void {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const lockPath = path.join(faultsDir, args.runId, `.${args.faultId}.lock`);
  releaseFaultLock({ lockPath });
}
