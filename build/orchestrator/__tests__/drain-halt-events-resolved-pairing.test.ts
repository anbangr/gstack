import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainFaultsFromHaltEventsQueue } from "../drain-faults";
import {
  emitHaltEvent,
  emitHaltEventResolved,
  loadPendingEntries,
} from "../halt-events";

describe("DETECTED + RESOLVED pair collapse in drainFaultsFromHaltEventsQueue", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dhe-rp-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("loadPendingEntries surfaces both detected and resolved rows with kind discriminator", () => {
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
    emitHaltEventResolved(faultId, "r1", { queueDir: skillFaults });

    const entries = loadPendingEntries({ queueDir: skillFaults });
    expect(entries.length).toBe(2);
    const detected = entries.find((e) => e.kind === "detected");
    const resolved = entries.find((e) => e.kind === "resolved");
    expect(detected).toBeDefined();
    expect(resolved).toBeDefined();
    if (detected?.kind === "detected") {
      expect(detected.event.faultId).toBe(faultId);
    }
    if (resolved?.kind === "resolved") {
      expect(resolved.faultId).toBe(faultId);
      expect(resolved.runId).toBe("r1");
    }
  });

  test("T4: DETECTED+RESOLVED pair collapses before dispatch (codex not called)", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "transient failure that self-recovered",
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
    emitHaltEventResolved(faultId, "r1", { queueDir: skillFaults });

    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        throw new Error("must not dispatch for collapsed pair");
      },
    });

    // Both files moved out of pending-investigations/
    const pendingDir = path.join(skillFaults, "pending-investigations");
    expect(fs.readdirSync(pendingDir).length).toBe(0);
    // The original DETECTED file lives at processed/<runId>-<faultId>.json
    const processedDir = path.join(skillFaults, "processed");
    const processed = fs.readdirSync(processedDir);
    expect(processed.some((f) => f.includes(faultId) && !f.includes("RESOLVED"))).toBe(true);
    // result.processed stays 0 (no dispatch); collapsed pairs don't count.
    expect(result.processed).toBe(0);
    expect(result.shortCircuited).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("runIdFilter leaves unrelated DETECTED+RESOLVED pairs pending", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "other-run",
        stateSlug: "other-state",
        severity: "CRITICAL",
        message: "unrelated transient failure",
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
    emitHaltEventResolved(faultId, "other-run", { queueDir: skillFaults });

    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      runIdFilter: "current-run",
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        throw new Error("must not dispatch for unrelated run");
      },
    });

    expect(result.processed).toBe(0);
    expect(result.shortCircuited).toBe(0);
    expect(result.failed).toBe(0);
    const entries = loadPendingEntries({ queueDir: skillFaults });
    expect(entries.length).toBe(2);
    expect(entries.some((e) => e.kind === "detected")).toBe(true);
    expect(entries.some((e) => e.kind === "resolved")).toBe(true);
  });

  test("T5: orphan DETECTED (no matching RESOLVED) still dispatches normally", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r2",
        stateSlug: "s2",
        severity: "CRITICAL",
        message: "real fault, no recovery",
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
    expect(faultId).toBeDefined();
  });

  test("T6: orphan RESOLVED (no matching DETECTED) is silently moved to processed/", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    // Emit only a RESOLVED — no DETECTED for it
    emitHaltEventResolved("STALE_FAULT:all:abcd1234", "r3", {
      queueDir: skillFaults,
    });

    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      inboxDir: path.join(tmp, "inbox"),
      mockInvestigator: () => {
        throw new Error("orphan RESOLVED should never invoke the investigator");
      },
    });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    // Orphan RESOLVED moved out of pending-investigations/
    const pendingDir = path.join(skillFaults, "pending-investigations");
    expect(fs.readdirSync(pendingDir).length).toBe(0);
  });
});
