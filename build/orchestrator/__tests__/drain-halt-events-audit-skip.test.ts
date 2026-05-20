import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainFaultsFromHaltEventsQueue } from "../drain-faults";
import { emitHaltEvent } from "../halt-events";

describe("drainFaultsFromHaltEventsQueue — investigate:false short-circuit", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df-audit-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("T1: audit event (investigate:false) skips dispatch, moves to processed/, logs audit-skipped", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "MANUAL_RECOVERY_INVOKED",
        runId: "drain-faults",
        stateSlug: "drain-faults-no-plan",
        severity: "HIGH",
        message: "drain-faults subcommand invoked (queue)",
        investigate: false,
        pointers: {
          stateFile: "",
          stdoutLog: "",
          livingPlan: "",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );

    let mockCalls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        mockCalls += 1;
        throw new Error(
          "investigator must NOT be called for investigate:false events",
        );
      },
    });

    expect(mockCalls).toBe(0);
    expect(result.shortCircuited).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.inboxFiled).toBe(0);

    // File moved to processed/
    const pending = fs.readdirSync(
      path.join(skillFaults, "pending-investigations"),
    );
    expect(pending.length).toBe(0);
    const processed = fs.readdirSync(path.join(skillFaults, "processed"));
    expect(processed.length).toBe(1);
    expect(processed[0]).toContain(faultId);

    // Analytics row written with outcome: audit-skipped
    const analyticsPath = path.join(tmp, "analytics", "skill-faults.jsonl");
    expect(fs.existsSync(analyticsPath)).toBe(true);
    const row = fs.readFileSync(analyticsPath, "utf8").trim();
    const parsed = JSON.parse(row);
    expect(parsed.faultId).toBe(faultId);
    expect(parsed.outcome).toBe("audit-skipped");
  });

  test("T2: non-audit event (no investigate field) still dispatches normally", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "real failure",
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

    let mockCalls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        mockCalls += 1;
        return {
          faultId,
          outcome: "self-healed",
          rootCause: "transient",
          evidence: [],
          proposedFix: null,
          learnedPatternProposal: null,
        };
      },
    });

    expect(mockCalls).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.shortCircuited).toBe(0);
  });

  test("T3: mixed queue — audit event short-circuits, real fault investigates", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const auditId = emitHaltEvent(
      {
        kind: "MANUAL_RECOVERY_INVOKED",
        runId: "drain-faults",
        stateSlug: "drain-faults-no-plan",
        severity: "HIGH",
        message: "drain-faults subcommand invoked (queue)",
        investigate: false,
        pointers: {
          stateFile: "",
          stdoutLog: "",
          livingPlan: "",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );
    const realId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "real failure",
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

    let mockCalls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: (he) => {
        mockCalls += 1;
        // Investigator must NEVER see the audit event
        expect(he.faultId).toBe(realId);
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

    expect(mockCalls).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.shortCircuited).toBe(1);

    // Both files moved to processed/
    const pending = fs.readdirSync(
      path.join(skillFaults, "pending-investigations"),
    );
    expect(pending.length).toBe(0);
    const processed = fs.readdirSync(path.join(skillFaults, "processed"));
    expect(processed.length).toBe(2);
    // Sanity: both files are accounted for
    const names = processed.join(",");
    expect(names).toContain(auditId);
    expect(names).toContain(realId);
  });

  test("T4: legacy row without investigate field dispatches (back-compat)", async () => {
    // Simulates a row written by PR 2 before the investigate flag existed.
    // The consumer must treat absent investigate field as "dispatch" (true).
    const skillFaults = path.join(tmp, "skill-faults");
    const pendingDir = path.join(skillFaults, "pending-investigations");
    fs.mkdirSync(pendingDir, { recursive: true });
    const faultId = "MANUAL_RECOVERY_INVOKED:all:abc12345";
    const legacyRow = {
      faultId,
      runId: "drain-faults",
      stateSlug: "drain-faults-no-plan",
      kind: "MANUAL_RECOVERY_INVOKED",
      severity: "HIGH",
      timestamp: "2026-05-19T00:00:00.000Z",
      message: "drain-faults subcommand invoked (queue)",
      // NB: no `investigate` field — this is the legacy shape
      pointers: {
        stateFile: "",
        stdoutLog: "",
        livingPlan: "",
        worktreePath: tmp,
      },
      snapshot: { stdoutTail: "" },
    };
    fs.writeFileSync(
      path.join(pendingDir, `drain-faults-${faultId}.json`),
      JSON.stringify(legacyRow, null, 2),
    );

    let mockCalls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        mockCalls += 1;
        return {
          faultId,
          outcome: "root-cause-identified",
          rootCause: "test",
          evidence: [],
          proposedFix: null,
          learnedPatternProposal: null,
        };
      },
    });

    // Legacy row must dispatch — this is the failure mode that the
    // /gstack-upgrade migration in Phase 3 will fix retroactively. Before
    // the migration runs, the consumer can't tell legacy audit rows from
    // legacy investigation rows, so it defaults to "dispatch."
    expect(mockCalls).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.shortCircuited).toBe(0);
  });
});
