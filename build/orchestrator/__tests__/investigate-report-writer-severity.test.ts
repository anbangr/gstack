import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeBugReport } from "../investigate-report-writer";
import type { InvestigationContext } from "../investigate-context";
import type { InvestigationReport } from "../investigator-dispatch";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-bug-${process.pid}`);
const inboxDir = path.join(tmpRoot, "inbox");

function makeCtx(
  severity: InvestigationContext["severity"],
  source: InvestigationContext["source"] = "auto-detect",
): InvestigationContext {
  return {
    runId: "run-X",
    faultId: "CAT:p0:abc",
    severity, source,
    haltEvent: null,
    statePath: "/tmp/s.json",
    stdoutLogPath: "/tmp/o.log",
    livingPlanPath: "/tmp/p.md",
    worktreePath: "/tmp/wt",
    symptoms: null,
  };
}

const report: InvestigationReport = {
  faultId: "CAT:p0:abc",
  outcome: "root-cause-identified",
  rootCause: "Plan lacks acceptance criteria; codex loops forever.",
  evidence: ["build/orchestrator/cli.ts:123"],
  proposedFix: {
    options: [
      { label: "Add checklist", description: "Prepend it", blast_radius: "narrow" },
    ],
  },
  learnedPatternProposal: null,
};

beforeEach(() => {
  fs.mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeBugReport severity gating", () => {
  test("HIGH writes the bug report", () => {
    const result = writeBugReport({ report, ctx: makeCtx("HIGH"), inboxDir, dateOverride: "2026-05-22" });
    expect(result.skipped).toBe(false);
    expect(result.path).not.toBeNull();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(result.path).toContain("BUGREPORT-2026-05-22-build-cat-");
  });

  test("CRITICAL writes the bug report", () => {
    const result = writeBugReport({ report, ctx: makeCtx("CRITICAL"), inboxDir, dateOverride: "2026-05-22" });
    expect(result.skipped).toBe(false);
  });

  test("MEDIUM skips bug report (returns skipped=true)", () => {
    const result = writeBugReport({ report, ctx: makeCtx("MEDIUM"), inboxDir, dateOverride: "2026-05-22" });
    expect(result.skipped).toBe(true);
    expect(result.path).toBeNull();
  });

  test("symptoms-only context skips even when severity HIGH", () => {
    const result = writeBugReport({ report, ctx: makeCtx("HIGH", "symptoms"), inboxDir, dateOverride: "2026-05-22" });
    expect(result.skipped).toBe(true);
  });

  test("noInbox=true skips even for CRITICAL", () => {
    const result = writeBugReport({ report, ctx: makeCtx("CRITICAL"), inboxDir, noInbox: true, dateOverride: "2026-05-22" });
    expect(result.skipped).toBe(true);
  });

  test("collision: second write gets -2 suffix", () => {
    const first = writeBugReport({ report, ctx: makeCtx("HIGH"), inboxDir, dateOverride: "2026-05-22" });
    const second = writeBugReport({ report, ctx: makeCtx("HIGH"), inboxDir, dateOverride: "2026-05-22" });
    expect(first.path).not.toBe(second.path);
    expect(second.path).toMatch(/-2\.md$/);
  });
});
