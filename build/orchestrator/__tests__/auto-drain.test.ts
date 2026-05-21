import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAutoDrainIfEnabled } from "../cli";
import { emitManualRecoveryInvoked } from "../halt-event-helpers";
import { emitHaltEvent } from "../halt-events";
import { drainFaultsFromHaltEventsQueue } from "../drain-faults";

/**
 * The end-of-build auto-drain hook is wired inline in cli.ts's main()
 * (see runAutoDrainIfEnabled). Testing the hook end-to-end requires
 * spawning the CLI, which is out of scope for unit tests. This file
 * pins the contract that the hook depends on: the shape and counts
 * returned by drainFaultsFromHaltEventsQueue — which the hook reads to
 * decide whether to log, what to telemetry, and whether to stay silent.
 */
describe("auto-drain hook contract", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-drain-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("drain returns the counts the telemetry row expects", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "test",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => ({
        faultId,
        outcome: "root-cause-identified",
        rootCause: "test",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    });
    // The hook reads every one of these fields when building its
    // telemetry row. If any of these stops being a number, the hook's
    // JSON.stringify will write garbage and downstream readers break.
    expect(typeof result.processed).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(typeof result.shortCircuited).toBe("number");
    expect(typeof result.inboxFiled).toBe("number");
    expect(typeof result.proposalsAppended).toBe("number");
  });

  test("empty queue: zero counts (hook stays silent)", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        throw new Error("should not be called on empty queue");
      },
    });
    // Empty queues must stay cheap and quiet: no investigator work, no
    // short-circuits, and no skipped rows to report.
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.shortCircuited).toBe(0);
  });

  test("auto-drain leaves unrelated run events pending", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitManualRecoveryInvoked({
      runId: "other-project-run",
      stateSlug: "other-project",
      message: "--mark-phase-committed invoked for phase 1.1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: tmp,
      },
      queueDir: skillFaults,
    });

    await runAutoDrainIfEnabled(
      { noAutoDrain: false } as never,
      {
        slug: "current-state",
        launch: { runId: "current-run" },
      } as never,
    );

    const pending = fs.readdirSync(
      path.join(skillFaults, "pending-investigations"),
    );
    expect(pending.length).toBe(1);
  });
});
