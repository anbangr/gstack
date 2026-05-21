import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAutoDrainIfEnabled } from "../cli";
import { emitManualRecoveryInvoked } from "../halt-event-helpers";
import { emitHaltEvent } from "../halt-events";
import {
  createDrainProgressCounter,
  drainFaultsForBuildRun,
  drainFaultsFromHaltEventsQueue,
} from "../drain-faults";
import { makeMockState } from "../../../test/helpers/build-state";

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

  test("drainFaultsForBuildRun calls saveState + bumps counter per processed entry", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    for (let i = 0; i < 3; i++) {
      emitHaltEvent(
        {
          kind: "PHASE_FAILED",
          runId: "r-build",
          stateSlug: "s-build",
          severity: "CRITICAL",
          message: `t${i}`,
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
    }

    const state = makeMockState({ slug: "s-build" });
    const initialTs = state.lastUpdatedAt;
    const saveCalls: string[] = [];
    const progress = createDrainProgressCounter();

    const result = await drainFaultsForBuildRun(
      state,
      (s) => {
        saveCalls.push(s.lastUpdatedAt);
      },
      {
        queueDir: skillFaults,
        max: 10,
        severityMin: "MEDIUM",
        inboxDir: path.join(tmp, "inbox"),
        mockInvestigator: (he) => ({
          faultId: he.faultId,
          outcome: "root-cause-identified",
          rootCause: "test",
          evidence: [],
          proposedFix: null,
          learnedPatternProposal: null,
        }),
      },
      progress,
    );

    expect(result.processed).toBe(3);
    // One saveState call per processed entry.
    expect(saveCalls.length).toBe(3);
    // Counter saw every bump too.
    expect(progress.count()).toBe(3);
    // state.lastUpdatedAt actually advanced from the mock's initial value.
    expect(state.lastUpdatedAt).not.toBe(initialTs);
    // The captured timestamps are all valid ISO strings.
    for (const ts of saveCalls) {
      expect(typeof ts).toBe("string");
      expect(Number.isFinite(Date.parse(ts))).toBe(true);
    }
  });

  test("createDrainProgressCounter starts at 0 and bump() is monotonic", () => {
    const c = createDrainProgressCounter();
    expect(c.count()).toBe(0);
    c.bump();
    c.bump();
    c.bump();
    expect(c.count()).toBe(3);
  });

  test("base drainFaultsFromHaltEventsQueue still works without state (--queue path)", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r-cli",
        stateSlug: "s-cli",
        severity: "CRITICAL",
        message: "cli-path",
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
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: (he) => ({
        faultId: he.faultId,
        outcome: "root-cause-identified",
        rootCause: "test",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    });
    expect(result.processed).toBe(1);
    expect(result.aborted).toBe(false);
    expect(result.deferred).toBe(0);
  });

  test("aborted signal halts the loop before the next entry and reports deferred count", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    for (let i = 0; i < 5; i++) {
      emitHaltEvent(
        {
          kind: "PHASE_FAILED",
          runId: "r-abort",
          stateSlug: "s-abort",
          severity: "CRITICAL",
          message: `e${i}`,
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
    }

    const ac = new AbortController();
    let calls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      signal: ac.signal,
      mockInvestigator: (he) => {
        calls += 1;
        // Fire abort AFTER processing the 2nd entry. The next loop iteration
        // observes opts.signal.aborted and breaks.
        if (calls === 2) ac.abort();
        return {
          faultId: he.faultId,
          outcome: "root-cause-identified",
          rootCause: "test",
          evidence: [],
          proposedFix: null,
          learnedPatternProposal: null,
        };
      },
    });

    expect(result.aborted).toBe(true);
    expect(result.processed).toBe(2);
    expect(result.deferred).toBeGreaterThan(0);
    // calls counts mockInvestigator invocations: should be 2, not all 5.
    expect(calls).toBe(2);
  });

  test("signal pre-aborted: drain returns immediately with deferred = full queue", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    for (let i = 0; i < 3; i++) {
      emitHaltEvent(
        {
          kind: "PHASE_FAILED",
          runId: "r-pre-abort",
          stateSlug: "s-pre",
          severity: "CRITICAL",
          message: `e${i}`,
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
    }
    const ac = new AbortController();
    ac.abort();
    let invoked = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      signal: ac.signal,
      mockInvestigator: () => {
        invoked += 1;
        return {
          faultId: "x",
          outcome: "root-cause-identified",
          rootCause: "",
          evidence: [],
          proposedFix: null,
          learnedPatternProposal: null,
        };
      },
    });
    expect(result.aborted).toBe(true);
    expect(result.processed).toBe(0);
    expect(invoked).toBe(0);
    expect(result.deferred).toBe(3);
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
