import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainFaultsFromHaltEventsQueue } from "../drain-faults";
import { emitHaltEvent, processedDir } from "../halt-events";

describe("drainFaultsFromHaltEventsQueue", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df-he-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("processes one halt event, writes 3 sinks, moves to processed/", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "test failure",
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
        rootCause: "test cause",
        evidence: ["test.ts:42"],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    });

    expect(result.processed).toBe(1);
    expect(result.inboxFiled).toBe(1); // CRITICAL + root-cause-identified

    // Sink 1: analytics jsonl
    const analytics = fs.readFileSync(
      path.join(tmp, "analytics", "skill-faults.jsonl"),
      "utf8",
    );
    expect(analytics).toContain(faultId);

    // Sink 2: markdown
    expect(
      fs.existsSync(path.join(skillFaults, "r1", `${faultId}.md`)),
    ).toBe(true);

    // Sink 3: inbox
    expect(fs.readdirSync(path.join(tmp, "inbox")).length).toBe(1);

    // Moved to processed/
    const pending = fs.readdirSync(
      path.join(skillFaults, "pending-investigations"),
    );
    expect(pending.length).toBe(0);
    const processed = fs.readdirSync(processedDir({ queueDir: skillFaults }));
    expect(processed.length).toBe(1);
  });

  test("self-healed outcome does NOT auto-file inbox", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "x",
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
      mockInvestigator: () => ({
        faultId,
        outcome: "self-healed",
        rootCause: "resolved itself",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    });
    expect(result.processed).toBe(1);
    expect(result.inboxFiled).toBe(0);
    expect(fs.existsSync(path.join(tmp, "inbox"))).toBe(false);
  });

  test("--severity-min HIGH filters out LOW", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitHaltEvent(
      {
        kind: "SOFT_HALT_WARN",
        runId: "r1",
        stateSlug: "s1",
        severity: "LOW",
        message: "low",
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
      severityMin: "HIGH",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        throw new Error("should not be called");
      },
    });
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("learnedPatternProposal appended to pending-patterns.jsonl", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "x",
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

    await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => ({
        faultId,
        outcome: "root-cause-identified",
        rootCause: "x",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: {
          category: "NEW_PATTERN",
          matcherKind: "state_jsonpath",
          pattern: "$.features[*][?(@.status == 'foo')]",
          severity: "HIGH",
          description: "test",
        },
      }),
    });

    const pending = fs.readFileSync(
      path.join(skillFaults, "pending-patterns.jsonl"),
      "utf8",
    );
    expect(pending).toContain("NEW_PATTERN");
  });

  test("max cap honored", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    for (let i = 0; i < 5; i++) {
      emitHaltEvent(
        {
          kind: "PHASE_FAILED",
          runId: "r1",
          stateSlug: "s1",
          severity: "CRITICAL",
          message: `event ${i}`,
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
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 2,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: (he) => ({
        faultId: he.faultId,
        outcome: "self-healed",
        rootCause: "x",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    });
    expect(result.processed).toBe(2);
    // The other 3 events remain in pending-investigations (not skipped — just not yet processed)
    const stillPending = fs.readdirSync(
      path.join(skillFaults, "pending-investigations"),
    );
    expect(stillPending.length).toBe(3);
  });
});
