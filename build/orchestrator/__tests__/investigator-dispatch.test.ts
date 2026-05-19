import { describe, test, expect } from "bun:test";
import {
  buildInvestigatorPrompt,
  parseInvestigationReport,
} from "../investigator-dispatch";

describe("buildInvestigatorPrompt", () => {
  test("embeds halt-event JSON and the four-phase discipline", () => {
    const prompt = buildInvestigatorPrompt({
      haltEvent: {
        faultId: "PHASE_FAILED:p0:abc12345",
        runId: "r1",
        stateSlug: "s1",
        kind: "PHASE_FAILED",
        severity: "CRITICAL",
        timestamp: "2026-05-19T00:00:00Z",
        message: "spec-flip failed",
        pointers: {
          stateFile: "/x/state.json",
          stdoutLog: "/x/stdout.log",
          livingPlan: "/x/plan.md",
          worktreePath: "/x/wt",
        },
        snapshot: { stdoutTail: "" },
      },
      existingCategories: ["CODEX_CONVERGENCE", "HAND_MERGED_FEATURE"],
    });
    expect(prompt).toContain("PHASE_FAILED");
    expect(prompt).toContain("Phase 1: investigate");
    expect(prompt).toContain("Phase 4: propose fix");
    expect(prompt).toContain("HAND_MERGED_FEATURE");
    expect(prompt).toContain("InvestigationReport");
    expect(prompt).toContain("PHASE_FAILED:p0:abc12345");
  });

  test("handles empty existingCategories list", () => {
    const prompt = buildInvestigatorPrompt({
      haltEvent: {
        faultId: "X:p0:a",
        runId: "r",
        stateSlug: "s",
        kind: "PHASE_FAILED",
        severity: "CRITICAL",
        timestamp: "2026-05-19T00:00:00Z",
        message: "x",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      existingCategories: [],
    });
    expect(prompt).toContain("(no existing categories)");
  });
});

describe("parseInvestigationReport", () => {
  test("parses well-formed JSON report", () => {
    const raw = JSON.stringify({
      faultId: "PHASE_FAILED:p0:abc",
      outcome: "root-cause-identified",
      rootCause: "spec-flip raced the test writer",
      evidence: ["cli.ts:5783"],
      proposedFix: {
        options: [
          { label: "lock", description: "serialize", blast_radius: "narrow" },
        ],
      },
      learnedPatternProposal: null,
    });
    const r = parseInvestigationReport(raw, "PHASE_FAILED:p0:abc");
    expect(r.outcome).toBe("root-cause-identified");
    expect(r.rootCause).toContain("spec-flip");
  });

  test("rejects mismatched faultId", () => {
    const raw = JSON.stringify({
      faultId: "WRONG:p0:abc",
      outcome: "self-healed",
      rootCause: "x",
      evidence: [],
      proposedFix: null,
      learnedPatternProposal: null,
    });
    expect(() =>
      parseInvestigationReport(raw, "PHASE_FAILED:p0:abc"),
    ).toThrow(/faultId mismatch/);
  });

  test("rejects unknown outcome", () => {
    const raw = JSON.stringify({
      faultId: "PHASE_FAILED:p0:abc",
      outcome: "made-it-up",
      rootCause: "x",
      evidence: [],
      proposedFix: null,
      learnedPatternProposal: null,
    });
    expect(() =>
      parseInvestigationReport(raw, "PHASE_FAILED:p0:abc"),
    ).toThrow(/invalid outcome/);
  });

  test("rejects non-string rootCause", () => {
    const raw = JSON.stringify({
      faultId: "PHASE_FAILED:p0:abc",
      outcome: "self-healed",
      rootCause: 123,
      evidence: [],
      proposedFix: null,
      learnedPatternProposal: null,
    });
    expect(() =>
      parseInvestigationReport(raw, "PHASE_FAILED:p0:abc"),
    ).toThrow();
  });

  test("rejects non-array evidence", () => {
    const raw = JSON.stringify({
      faultId: "PHASE_FAILED:p0:abc",
      outcome: "self-healed",
      rootCause: "x",
      evidence: "not-an-array",
      proposedFix: null,
      learnedPatternProposal: null,
    });
    expect(() =>
      parseInvestigationReport(raw, "PHASE_FAILED:p0:abc"),
    ).toThrow();
  });

  test("rejects invalid matcherKind in learnedPatternProposal", () => {
    const raw = JSON.stringify({
      faultId: "X:p0:a",
      outcome: "root-cause-identified",
      rootCause: "x",
      evidence: [],
      proposedFix: null,
      learnedPatternProposal: {
        category: "X",
        matcherKind: "javascript_eval",
        pattern: "x",
        severity: "HIGH",
        description: "x",
      },
    });
    expect(() => parseInvestigationReport(raw, "X:p0:a")).toThrow(
      /invalid matcherKind/,
    );
  });

  test("extracts JSON from codex fenced output", () => {
    const raw =
      "Here is the report:\n```json\n" +
      JSON.stringify({
        faultId: "PHASE_FAILED:p0:abc",
        outcome: "no-context",
        rootCause: "worktree gone",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }) +
      "\n```\n\nDone.";
    const r = parseInvestigationReport(raw, "PHASE_FAILED:p0:abc");
    expect(r.outcome).toBe("no-context");
  });

  test("extracts JSON from unfenced prose-wrapped output", () => {
    const raw =
      "I think this is the answer: " +
      JSON.stringify({
        faultId: "X:p0:a",
        outcome: "self-healed",
        rootCause: "fixed itself",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }) +
      " — done.";
    const r = parseInvestigationReport(raw, "X:p0:a");
    expect(r.outcome).toBe("self-healed");
  });
});
