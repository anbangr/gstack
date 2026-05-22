import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeMachineReport,
  bugReportSlug,
} from "../investigate-report-writer";
import type { InvestigationContext } from "../investigate-context";
import type { InvestigationReport } from "../investigator-dispatch";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-rw-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");

const ctx: InvestigationContext = {
  runId: "run-X",
  faultId: "CAT:p0:abc",
  severity: "HIGH",
  source: "auto-detect",
  haltEvent: null,
  statePath: "/tmp/s.json",
  stdoutLogPath: "/tmp/o.log",
  livingPlanPath: "/tmp/p.md",
  worktreePath: "/tmp/wt",
  symptoms: null,
};

const report: InvestigationReport = {
  faultId: "CAT:p0:abc",
  outcome: "root-cause-identified",
  rootCause: "Plan lacks acceptance criteria; codex loops forever.",
  evidence: ["build/orchestrator/cli.ts:123"],
  proposedFix: {
    options: [
      {
        label: "Add acceptance checklist",
        description: "Prepend an Acceptance section",
        blast_radius: "narrow",
      },
    ],
  },
  learnedPatternProposal: null,
};

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeMachineReport", () => {
  test("writes to <faultsDir>/<runId>/<faultId>.md", () => {
    const written = writeMachineReport({ report, ctx, faultsDir });
    expect(written).toBe(path.join(faultsDir, "run-X", "CAT:p0:abc.md"));
    expect(fs.existsSync(written)).toBe(true);
  });

  test("overwrites on second call (latest investigation wins)", () => {
    writeMachineReport({ report, ctx, faultsDir });
    const second: InvestigationReport = { ...report, rootCause: "DIFFERENT" };
    const written = writeMachineReport({ report: second, ctx, faultsDir });
    const content = fs.readFileSync(written, "utf8");
    expect(content).toContain("DIFFERENT");
    expect(content).not.toContain("Plan lacks acceptance");
  });

  test("includes runId, faultId, outcome, rootCause, evidence in markdown", () => {
    const written = writeMachineReport({ report, ctx, faultsDir });
    const content = fs.readFileSync(written, "utf8");
    expect(content).toContain("run-X");
    expect(content).toContain("CAT:p0:abc");
    expect(content).toContain("root-cause-identified");
    expect(content).toContain("Plan lacks acceptance criteria");
    expect(content).toContain("build/orchestrator/cli.ts:123");
  });

  test("writes duplicate-of stub when outcome is duplicate-of", () => {
    const dup: InvestigationReport = {
      ...report,
      outcome: "duplicate-of",
      duplicateOfPath: "~/.gstack/skill-faults/run-Y/CAT:p0:def.md",
    };
    const written = writeMachineReport({ report: dup, ctx, faultsDir });
    const content = fs.readFileSync(written, "utf8");
    expect(content).toContain("Duplicate of");
    expect(content).toContain("~/.gstack/skill-faults/run-Y/CAT:p0:def.md");
  });
});

describe("bugReportSlug", () => {
  test("derives slug from fault category + hash of rootCause", () => {
    const slug = bugReportSlug({ report, ctx });
    expect(slug).toMatch(/^build-cat-[a-f0-9]{6}$/);
  });

  test("symptoms-only context uses MANUAL prefix", () => {
    const manualCtx: InvestigationContext = {
      ...ctx,
      faultId: "MANUAL_INVESTIGATION:0:abc12345",
      source: "symptoms",
    };
    const slug = bugReportSlug({ report, ctx: manualCtx });
    expect(slug).toMatch(/^build-manual-investigation-[a-f0-9]{6}$/);
  });
});
