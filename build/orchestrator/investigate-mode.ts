import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveInvestigationContext,
  tailStdoutLog,
  type ContextSource,
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
  faultsDir?: string;
  activeRunsRegistryDir?: string;
}

export interface InvestigateFinalizeArgs {
  runId: string;
  faultId: string;
  reportPath: string;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM";
  // Source from the briefing — controls whether bug-report severity gating
  // applies the symptoms-only skip. If absent, defaults to "auto-detect"
  // which is conservative (the symptoms-only skip won't fire).
  source?: ContextSource;
  // Nonce from the briefing — required to prove the caller owns the lock.
  // Without a matching nonce, releaseFaultLock refuses to delete the lock
  // file, preventing one investigation's finalize from clobbering another
  // investigation's lock when both raced through stale-reclaim.
  nonce?: string;
  noInbox?: boolean;
  faultsDir?: string;
  inboxDir?: string;
}

function defaultFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

// Defense-in-depth: faultId and runId are used in path.join and embedded into
// the finalizeHint shell command. Internal sources (computeFaultId,
// synthesizeManualFaultId, halt-event filenames) already produce safe values,
// but external CLI paths (--fault-id, --run-id) reach this code unvalidated.
const SAFE_ID_RE = /^[A-Za-z0-9._:\-]+$/;
const SAFE_NONCE_RE = /^[A-Fa-f0-9]{1,64}$/;

function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(
      `invalid ${label}: ${JSON.stringify(value)} — must match ${SAFE_ID_RE}`,
    );
  }
}

// Cap for the --report file read. Reports are LLM output, usually a few KB.
// 1 MiB is wildly generous and protects against /dev/zero or accidentally
// pointing at a multi-GB log.
const REPORT_READ_CAP_BYTES = 1 * 1024 * 1024;

export async function runInvestigateMode(
  args: InvestigateModeArgs,
): Promise<number> {
  // Validate caller-supplied IDs BEFORE any filesystem lookup.
  try {
    if (args.faultId) assertSafeId("faultId", args.faultId);
    if (args.runId) assertSafeId("runId", args.runId);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

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

  try {
    assertSafeId("runId", ctx.runId);
    assertSafeId("faultId", ctx.faultId);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
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

  // Lock is acquired. From here, any throw MUST release it — otherwise the
  // user is blocked for the full 1-hour stale-reclaim window.
  let releaseOnError = true;
  try {
    let stdoutTail = "";
    if (ctx.stdoutLogPath) {
      let recentErrors: { timestamp: string; summary?: string }[] = [];
      if (ctx.statePath && fs.existsSync(ctx.statePath)) {
        try {
          const state = JSON.parse(fs.readFileSync(ctx.statePath, "utf8"));
          if (Array.isArray(state.recentErrors))
            recentErrors = state.recentErrors;
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
      nonce: lock.nonce,
      statePath: ctx.statePath,
      stdoutLogPath: ctx.stdoutLogPath,
      stdoutTail,
      livingPlanPath: ctx.livingPlanPath,
      worktreePath: ctx.worktreePath,
      haltEvent: ctx.haltEvent,
      symptoms: ctx.symptoms,
      finalizeHint:
        `When your investigation is complete, write the InvestigationReport JSON to a tmp file and run: ` +
        `gstack-build investigate-finalize --run-id ${ctx.runId} --fault-id ${ctx.faultId} --nonce ${lock.nonce} --severity ${ctx.severity} --source ${ctx.source} --report <path>${args.noInbox ? " --no-inbox" : ""}`,
    };

    process.stdout.write("<<<GSTACK_INVESTIGATE_BRIEFING>>>\n");
    process.stdout.write(JSON.stringify(briefing, null, 2) + "\n");
    process.stdout.write("<<<END>>>\n");
    // Briefing emitted successfully. The lock stays held on disk; finalize
    // will release it via the nonce-checked release path. Don't release on
    // exit from this function.
    releaseOnError = false;
    return 0;
  } finally {
    if (releaseOnError) {
      releaseFaultLock(lock);
    }
  }
}

export async function runInvestigateFinalize(
  args: InvestigateFinalizeArgs,
): Promise<number> {
  try {
    assertSafeId("runId", args.runId);
    assertSafeId("faultId", args.faultId);
    if (args.nonce && !SAFE_NONCE_RE.test(args.nonce)) {
      throw new Error(
        `invalid nonce: must match ${SAFE_NONCE_RE}`,
      );
    }
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (!fs.existsSync(args.reportPath)) {
    process.stderr.write(`error: report file not found: ${args.reportPath}\n`);
    return 2;
  }

  // Lock is held on disk from runInvestigateMode. ALWAYS release it before
  // returning, even on unexpected throws.
  try {
    let raw: string;
    try {
      const stat = fs.statSync(args.reportPath);
      if (stat.size > REPORT_READ_CAP_BYTES) {
        process.stderr.write(
          `error: report file exceeds ${REPORT_READ_CAP_BYTES} bytes (got ${stat.size}); refusing to read\n`,
        );
        return 2;
      }
      if (!stat.isFile()) {
        process.stderr.write(
          `error: report path is not a regular file: ${args.reportPath}\n`,
        );
        return 2;
      }
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
      return 2;
    }

    const ctx: InvestigationContext = {
      runId: args.runId,
      faultId: args.faultId,
      severity: args.severity ?? "HIGH",
      source: args.source ?? "auto-detect",
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
  } finally {
    releaseLockByPath(args);
  }
}

function releaseLockByPath(args: InvestigateFinalizeArgs): void {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const lockPath = path.join(faultsDir, args.runId, `.${args.faultId}.lock`);
  // If no nonce was supplied (legacy or symptoms-only without a real lock),
  // fall back to best-effort unlink via a passthrough nonce. The lock's
  // own release function will compare against the on-disk nonce — without
  // a match the release is a no-op and returns false, which is the safe
  // outcome for a missing nonce.
  releaseFaultLock({ lockPath, nonce: args.nonce ?? "" });
}
