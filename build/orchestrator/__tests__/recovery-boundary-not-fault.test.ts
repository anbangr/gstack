/**
 * Tests for PR8 — RECOVERY_BOUNDARY rename + miner exclusion.
 *
 * T1: Auto-drain over a queue containing only RECOVERY_BOUNDARY events
 *     emits zero pattern proposals because the investigate:false short-circuit
 *     skips investigator dispatch entirely.
 *
 * Edge cases:
 *   - Post-upgrade RECOVERY_BOUNDARY passes through unchanged (short-circuited).
 *   - Mixed queue: RECOVERY_BOUNDARY short-circuits, real fault investigates
 *     and may produce a proposal.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainFaultsFromHaltEventsQueue } from "../drain-faults";
import { loadPendingInvestigations, processedDir } from "../halt-events";

describe("RECOVERY_BOUNDARY — miner exclusion (zero pattern proposals)", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-nf-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("T1: drain over only RECOVERY_BOUNDARY events → zero proposals", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const pendingDir = path.join(skillFaults, "pending-investigations");
    fs.mkdirSync(pendingDir, { recursive: true });

    const faultId = "RECOVERY_BOUNDARY:all:abc12345";
    const event = {
      faultId,
      runId: "drain-faults",
      stateSlug: "drain-faults-no-plan",
      kind: "RECOVERY_BOUNDARY",
      severity: "HIGH",
      timestamp: "2026-05-21T00:00:00.000Z",
      message: "drain-faults subcommand invoked (queue)",
      investigate: false,
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
      JSON.stringify(event, null, 2),
    );

    let mockCalls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        mockCalls += 1;
        throw new Error("investigator must NOT be called for RECOVERY_BOUNDARY");
      },
    });

    expect(mockCalls).toBe(0);
    expect(result.shortCircuited).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.proposalsAppended).toBe(0);

    // No pending-patterns.jsonl should have been created
    const proposalPath = path.join(skillFaults, "pending-patterns.jsonl");
    expect(fs.existsSync(proposalPath)).toBe(false);

    // Event moved to processed/
    const pending = fs.readdirSync(pendingDir);
    expect(pending.length).toBe(0);
    const processed = fs.readdirSync(processedDir({ queueDir: skillFaults }));
    expect(processed.length).toBe(1);
  });

  test("edge: post-upgrade RECOVERY_BOUNDARY passes through unchanged", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const pendingDir = path.join(skillFaults, "pending-investigations");
    fs.mkdirSync(pendingDir, { recursive: true });

    const faultId = "RECOVERY_BOUNDARY:all:postupgrade99";
    const event = {
      faultId,
      runId: "mark-shipped",
      stateSlug: "s1",
      kind: "RECOVERY_BOUNDARY",
      severity: "HIGH",
      timestamp: "2026-05-21T00:00:00.000Z",
      message: "mark-shipped subcommand invoked for feature 3",
      investigate: false,
      pointers: {
        stateFile: "",
        stdoutLog: "",
        livingPlan: "",
        worktreePath: tmp,
      },
      snapshot: { stdoutTail: "" },
    };
    fs.writeFileSync(
      path.join(pendingDir, `mark-shipped-${faultId}.json`),
      JSON.stringify(event, null, 2),
    );

    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        throw new Error("must not dispatch");
      },
    });

    expect(result.shortCircuited).toBe(1);
    expect(result.proposalsAppended).toBe(0);
    expect(fs.existsSync(path.join(skillFaults, "pending-patterns.jsonl"))).toBe(
      false,
    );
  });

  test("edge: mixed queue — RECOVERY_BOUNDARY short-circuits, real fault proposes", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const pendingDir = path.join(skillFaults, "pending-investigations");
    fs.mkdirSync(pendingDir, { recursive: true });

    const auditId = "RECOVERY_BOUNDARY:all:audit001";
    fs.writeFileSync(
      path.join(pendingDir, `r1-${auditId}.json`),
      JSON.stringify({
        faultId: auditId,
        runId: "r1",
        stateSlug: "s1",
        kind: "RECOVERY_BOUNDARY",
        severity: "HIGH",
        timestamp: "2026-05-21T00:00:00.000Z",
        message: "--mark-phase-committed invoked for phase 2.1",
        investigate: false,
        pointers: {
          stateFile: "",
          stdoutLog: "",
          livingPlan: "",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      }),
    );

    const realId = "PHASE_FAILED:p0:real001";
    fs.writeFileSync(
      path.join(pendingDir, `r1-${realId}.json`),
      JSON.stringify({
        faultId: realId,
        runId: "r1",
        stateSlug: "s1",
        kind: "PHASE_FAILED",
        severity: "CRITICAL",
        timestamp: "2026-05-21T00:00:00.000Z",
        message: "real failure",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      }),
    );

    let mockCalls = 0;
    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: (he) => {
        mockCalls += 1;
        expect(he.faultId).toBe(realId);
        return {
          faultId: he.faultId,
          outcome: "root-cause-identified",
          rootCause: "test",
          evidence: [],
          proposedFix: null,
          learnedPatternProposal: {
            category: "NEW_PATTERN",
            matcherKind: "stdout_contains",
            pattern: "real failure",
            severity: "HIGH",
            description: "test pattern",
          },
        };
      },
    });

    expect(mockCalls).toBe(1);
    expect(result.shortCircuited).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.proposalsAppended).toBe(1);

    // The real fault produced a proposal; the audit event did not.
    const proposalPath = path.join(skillFaults, "pending-patterns.jsonl");
    expect(fs.existsSync(proposalPath)).toBe(true);
    const proposals = fs.readFileSync(proposalPath, "utf8");
    expect(proposals).toContain("NEW_PATTERN");
  });
});
