/**
 * Unit tests for build/orchestrator/skill-fault-detector.ts (tier: free).
 *
 * RED phase of TDD — these tests are written before any implementation exists.
 * All tests MUST fail until skill-fault-detector.ts is created.
 *
 * Coverage:
 *   - detectSkillFaults() returns [] for null state and no-fault inputs
 *   - CODEX_CONVERGENCE: iterations >= DEFAULT_MAX_CODEX_ITERATIONS
 *   - TEST_FIXER_LOOP: iterations >= DEFAULT_MAX_TEST_ITERATIONS
 *   - PREMATURE_COMPLETION: [x] Implementation / [x] Review & QA in plan for non-committed phases
 *   - PLAN_SYNTHESIS_INVALID: phase block missing Origin trace: or Acceptance:
 *   - WORKTREE_LEAK: completed=true but worktreePath dir exists
 *   - RED_SPEC_TRIVIAL: failureReason contains 'trivially' or 'without implementation'
 *   - PLAN_MUTATOR_MISMATCH: failureReason contains 'line not found' or 'checkbox'
 *   - PLAN_REVIEW_STALEMATE: plan-review-report.json has round>=3 and CRITICAL objection
 *   - FEATURE_VERIFIER_SCOPE: stdoutLogPath contains "VERIFICATION: GAPS"
 *   - No throw on bad inputs (null state, non-existent paths, malformed files)
 *   - Analytics failures don't block fault return
 *   - Analytics appended to ${GSTACK_HOME}/analytics/skill-faults.jsonl
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  detectSkillFaults,
  detectLearnedFaults,
  faultId,
  loadLearnedPatterns,
  extractFeatureBlocks,
  type DetectorInput,
  type SkillFault,
  type LearnedPattern,
} from "../build/orchestrator/skill-fault-detector";
import {
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_MAX_TEST_ITERATIONS,
} from "../build/orchestrator/phase-runner";
import type { BuildState, PhaseState } from "../build/orchestrator/types";
import { useIsolatedGstackHome } from "./helpers/test-home";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Isolate GSTACK_HOME for every test in this file. Without this, the 50+
// detectSkillFaults() calls below would each append a line to the real
// ~/.gstack/analytics/skill-faults.jsonl. Tests that need a specific
// GSTACK_HOME value (e.g. the analytics-write tests) can still override
// process.env.GSTACK_HOME in their body — the helper's afterEach restores
// the prior value cleanly.
useIsolatedGstackHome("skill-fault-detector-home-");

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(os.tmpdir(), "skill-fault-detector-test-"),
  );
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpDirs.length = 0;
});

/** Minimal valid PhaseState for a committed phase. */
function committedPhase(index = 0): PhaseState {
  return {
    index,
    number: String(index + 1),
    name: `Phase ${index + 1}`,
    status: "committed",
  };
}

/** Minimal valid BuildState with one committed phase. */
function baseState(overrides: Partial<BuildState> = {}): BuildState {
  return {
    planFile: "/tmp/plan.md",
    planBasename: "plan",
    slug: "build-test",
    branch: "main",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    currentPhaseIndex: 0,
    phases: [committedPhase(0)],
    completed: false,
    ...overrides,
  };
}

/**
 * Valid living plan content: each `## Feature` block has Origin trace: and
 * Acceptance: in its header (matching build/SKILL.md.tmpl:426-428).
 */
function validPlanContent(numPhases = 1): string {
  const phases = Array.from({ length: numPhases }, (_, i) =>
    [
      `### Phase ${i + 1}: Something`,
      "",
      `- [ ] **Implementation**: implement it`,
      `- [ ] **Review & QA**: review it`,
    ].join("\n"),
  );
  return [
    "# Test Plan",
    "",
    "## Feature 1: Core",
    "Origin trace: Source plan Week 1",
    "Acceptance: tests pass",
    "",
    phases.join("\n\n"),
  ].join("\n");
}

/** Write a living plan file and return its path. */
function writePlan(dir: string, content: string): string {
  const p = path.join(dir, "plan.md");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/** Build a minimal DetectorInput. */
function makeInput(
  dir: string,
  overrides: Partial<DetectorInput> = {},
): DetectorInput {
  const planPath = path.join(dir, "plan.md");
  if (!fs.existsSync(planPath)) {
    writePlan(dir, validPlanContent());
  }
  const stdoutLog = path.join(dir, "run.log");
  if (!fs.existsSync(stdoutLog)) {
    fs.writeFileSync(stdoutLog, "", "utf8");
  }
  return {
    state: baseState(),
    livingPlanPath: planPath,
    worktreePath: path.join(dir, "worktree-nonexistent"),
    stateDir: dir,
    stdoutLogPath: stdoutLog,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Null / no-fault baseline
// ---------------------------------------------------------------------------

describe("detectSkillFaults — null / no-fault cases", () => {
  test("returns empty array when state is null", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, { state: null });
    const faults = detectSkillFaults(input);
    expect(Array.isArray(faults)).toBe(true);
    expect(faults).toHaveLength(0);
  });

  test("returns empty array when state is null even if artifacts contain fault markers", () => {
    const dir = makeTmpDir();
    const invalidPlan = writePlan(
      dir,
      [
        "# Plan",
        "",
        "### Phase 1: Missing required fields",
        "",
        "- [x] **Implementation (Gemini Sub-agent)**: done",
      ].join("\n"),
    );
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(stdoutLog, "VERIFICATION: GAPS found\n", "utf8");
    const input = makeInput(dir, {
      state: null,
      livingPlanPath: invalidPlan,
      stdoutLogPath: stdoutLog,
    });
    const faults = detectSkillFaults(input);
    expect(faults).toHaveLength(0);
  });

  test("returns empty array when no faults apply (clean state)", () => {
    const dir = makeTmpDir();
    const faults = detectSkillFaults(makeInput(dir));
    expect(faults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CODEX_CONVERGENCE
// ---------------------------------------------------------------------------

describe("CODEX_CONVERGENCE", () => {
  test("detected when codexReview.iterations >= DEFAULT_MAX_CODEX_ITERATIONS", () => {
    const dir = makeTmpDir();
    const phaseWithHitLimit: PhaseState = {
      ...committedPhase(0),
      codexReview: {
        iterations: DEFAULT_MAX_CODEX_ITERATIONS,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseWithHitLimit] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "CODEX_CONVERGENCE");
    expect(fault).toBeDefined();
    expect(fault!.severity).toMatch(/^(CRITICAL|HIGH|MEDIUM)$/);
    expect(fault!.evidence.phaseIndex).toBe(0);
    expect(fault!.evidence.iterationCount).toBe(DEFAULT_MAX_CODEX_ITERATIONS);
  });

  test("not detected when codexReview.iterations is one below limit", () => {
    const dir = makeTmpDir();
    const phaseUnderLimit: PhaseState = {
      ...committedPhase(0),
      codexReview: {
        iterations: DEFAULT_MAX_CODEX_ITERATIONS - 1,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseUnderLimit] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "CODEX_CONVERGENCE"),
    ).toBeUndefined();
  });

  test("detected when codexReview.iterations exceeds limit", () => {
    const dir = makeTmpDir();
    const phaseOverLimit: PhaseState = {
      ...committedPhase(0),
      codexReview: {
        iterations: DEFAULT_MAX_CODEX_ITERATIONS + 2,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseOverLimit] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "CODEX_CONVERGENCE"),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TEST_FIXER_LOOP
// ---------------------------------------------------------------------------

describe("TEST_FIXER_LOOP", () => {
  test("detected when testFix.iterations >= DEFAULT_MAX_TEST_ITERATIONS", () => {
    const dir = makeTmpDir();
    const phaseAtLimit: PhaseState = {
      ...committedPhase(0),
      testFix: {
        iterations: DEFAULT_MAX_TEST_ITERATIONS,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseAtLimit] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "TEST_FIXER_LOOP");
    expect(fault).toBeDefined();
    expect(fault!.evidence.phaseIndex).toBe(0);
    expect(fault!.evidence.iterationCount).toBe(DEFAULT_MAX_TEST_ITERATIONS);
  });

  test("not detected when testFix.iterations is one below limit", () => {
    const dir = makeTmpDir();
    const phaseUnder: PhaseState = {
      ...committedPhase(0),
      testFix: {
        iterations: DEFAULT_MAX_TEST_ITERATIONS - 1,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseUnder] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "TEST_FIXER_LOOP"),
    ).toBeUndefined();
  });

  test("not detected when testFix is undefined", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ phases: [committedPhase(0)] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "TEST_FIXER_LOOP"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PREMATURE_COMPLETION
// ---------------------------------------------------------------------------

describe("PREMATURE_COMPLETION", () => {
  // The detector was tightened in v1.40.2.0+ to only fire on terminal-failed
  // states (failed/blocked/paused). Intermediate states like tests_green,
  // codex_running, and review_clean are legitimate mid-phase transitions
  // where the orchestrator has correctly ticked Implementation checkboxes
  // before reaching `committed`. The previous behavior caused 78
  // false-positive fires for one healthy Phase 2.1 in the agnt2-prototype
  // run on 2026-05-16. See drain-faults plan T5 + skill-fault-detector.ts
  // PREMATURE_COMPLETION_FIRING_STATUSES for the firing-status set.
  test("detected when plan has [x] **Implementation** for failed phase", () => {
    const dir = makeTmpDir();
    const planWithChecked = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [ ] **Review & QA**: not done",
    ].join("\n");
    const planPath = writePlan(dir, planWithChecked);
    const failedPhase: PhaseState = {
      ...committedPhase(0),
      status: "failed",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [failedPhase] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PREMATURE_COMPLETION");
    expect(fault).toBeDefined();
  });

  test("detected when plan has [x] **Review & QA** for blocked phase", () => {
    const dir = makeTmpDir();
    const planWithChecked = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [x] **Review & QA**: done",
    ].join("\n");
    const planPath = writePlan(dir, planWithChecked);
    const blockedPhase: PhaseState = {
      ...committedPhase(0),
      status: "blocked",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [blockedPhase] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PREMATURE_COMPLETION");
    expect(fault).toBeDefined();
  });

  test("detected with role-qualified labels on paused phase", () => {
    const dir = makeTmpDir();
    const planWithQualifiedLabels = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation (Gemini Sub-agent)**: done",
      "- [x] **Review & QA (Codex Sub-agent)**: done",
    ].join("\n");
    const planPath = writePlan(dir, planWithQualifiedLabels);
    const pausedPhase: PhaseState = {
      ...committedPhase(0),
      status: "paused",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [pausedPhase] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PREMATURE_COMPLETION");
    expect(fault).toBeDefined();
  });

  // Regression tests for the agnt2-prototype-bisectiongame-settlement
  // false-positive class (2026-05-16). The detector previously fired during
  // healthy tests_green / codex_running / review_clean transitions.
  test("NOT detected for tests_green (healthy intermediate state — regression)", () => {
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [ ] **Review & QA**: not done",
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const testsGreenPhase: PhaseState = {
      ...committedPhase(0),
      status: "tests_green",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [testsGreenPhase] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PREMATURE_COMPLETION"),
    ).toBeUndefined();
  });

  test("NOT detected for codex_running (healthy intermediate state — regression)", () => {
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [ ] **Review & QA**: not done",
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const codexRunningPhase: PhaseState = {
      ...committedPhase(0),
      status: "codex_running",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [codexRunningPhase] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PREMATURE_COMPLETION"),
    ).toBeUndefined();
  });

  test("NOT detected for review_clean (healthy intermediate state — regression)", () => {
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [x] **Review & QA**: done",
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const reviewCleanPhase: PhaseState = {
      ...committedPhase(0),
      status: "review_clean",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [reviewCleanPhase] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PREMATURE_COMPLETION"),
    ).toBeUndefined();
  });

  test("NOT detected for checked checkboxes whose bold labels only share the gate prefix", () => {
    const dir = makeTmpDir();
    const planWithSimilarLabels = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation notes**: document approach",
      "- [x] **Review & QA notes**: document reviewer feedback",
    ].join("\n");
    const planPath = writePlan(dir, planWithSimilarLabels);
    // Use a firing status (failed) so this test isolates the label-prefix
    // logic — without it, the test would also pass because tests_green
    // is silenced by the firing-status gate.
    const failedPhase: PhaseState = {
      ...committedPhase(0),
      status: "failed",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [failedPhase] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PREMATURE_COMPLETION"),
    ).toBeUndefined();
  });

  test("NOT detected when checked phase status IS committed", () => {
    const dir = makeTmpDir();
    const planWithChecked = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [x] **Review & QA**: done",
    ].join("\n");
    const planPath = writePlan(dir, planWithChecked);
    const committedPh: PhaseState = {
      ...committedPhase(0),
      status: "committed",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [committedPh] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PREMATURE_COMPLETION"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN_SYNTHESIS_INVALID
// ---------------------------------------------------------------------------

describe("PLAN_SYNTHESIS_INVALID", () => {
  test("NOT detected when a valid feature has Origin trace: and Acceptance:", () => {
    const dir = makeTmpDir();
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID"),
    ).toBeUndefined();
  });

  test("detected for only the offending feature (multi-feature plan)", () => {
    const dir = makeTmpDir();
    const planMixed = [
      "# Plan",
      "",
      "## Feature 1: Good",
      "Origin trace: Source plan Week 1",
      "Acceptance: tests pass",
      "",
      "### Phase 1.1: Setup",
      "",
      "- [ ] **Implementation**: implement",
      "",
      "## Feature 2: Bad",
      "Origin trace: Source plan Week 2",
      // Missing Acceptance:
      "",
      "### Phase 2.1: Setup",
      "",
      "- [ ] **Implementation**: implement",
      "",
      "<!-- gstack-synthesis-complete",
      "ts: 2026-05-17T08:00:00Z",
      "-->",
    ].join("\n");
    const planPath = writePlan(dir, planMixed);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const synthesisInvalid = faults.filter(
      (f) => f.category === "PLAN_SYNTHESIS_INVALID",
    );
    expect(synthesisInvalid.length).toBe(1);
    expect(synthesisInvalid[0].description).toContain("Feature block 2");
    expect(synthesisInvalid[0].description).toContain("Acceptance:");
  });

  test("NOT detected when feature has Origin trace/Acceptance even if phases do not", () => {
    // Matches build/SKILL.md.tmpl:426-428 — Origin trace/Acceptance live on
    // `## Feature X:`, not on every `### Phase`. Phases inherit from feature.
    const dir = makeTmpDir();
    const planFeatureLevel = [
      "# Plan",
      "",
      "## Feature 1: Core",
      "Origin trace: Source plan Week 1-2",
      "Acceptance: tests pass and benchmarks meet target",
      "",
      "### Phase 1: Setup",
      "",
      "- [ ] **Implementation**: implement phase 1",
      "",
      "### Phase 2: Wiring",
      "",
      "- [ ] **Implementation**: implement phase 2",
    ].join("\n");
    const planPath = writePlan(dir, planFeatureLevel);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID"),
    ).toBeUndefined();
  });

  test("detected when a feature block is missing Origin trace:", () => {
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "## Feature 1: Core",
      "Acceptance: tests pass",
      "",
      "### Phase 1: Setup",
      "",
      "- [ ] **Implementation**: implement",
      "",
      "<!-- gstack-synthesis-complete ts: 2026-05-17T08:00:00Z -->",
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID");
    expect(fault).toBeDefined();
    expect(fault?.description).toContain("Origin trace:");
  });

  test("detected when a feature block is missing Acceptance:", () => {
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "## Feature 1: Core",
      "Origin trace: Source plan Week 1",
      "",
      "### Phase 1: Setup",
      "",
      "- [ ] **Implementation**: implement",
      "",
      "<!-- gstack-synthesis-complete ts: 2026-05-17T08:00:00Z -->",
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID");
    expect(fault).toBeDefined();
    expect(fault?.description).toContain("Acceptance:");
  });

  test("NOT detected when plan has no features and no phases (header-only)", () => {
    // A plan that's only a stub (table of contents, prose) should not be flagged.
    const dir = makeTmpDir();
    const plan = ["# Plan", "", "## Overview", "", "TBD"].join("\n");
    const planPath = writePlan(dir, plan);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID"),
    ).toBeUndefined();
  });

  // ---- Sentinel gate (Fix #1) ------------------------------------------

  test("NOT detected when sentinel is absent, even with missing Acceptance (synthesis-in-progress)", () => {
    // The synthesizer subagent has not yet finished writing the plan. The
    // file exists but the synthesis-complete sentinel hasn't been appended.
    // Without the sentinel the detector MUST stay silent to avoid racing
    // mid-write and reporting transient false positives.
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "## Feature 1: In-progress",
      "Origin trace: Source plan Week 1",
      // Missing Acceptance:
      "",
      "### Phase 1: Setup",
      // No <!-- gstack-synthesis-complete --> sentinel
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID"),
    ).toBeUndefined();
  });

  test("gate fires on rich multi-line sentinel with extra unknown fields", () => {
    // The sentinel format is permissive: only the prefix is required, any
    // additional `key: value` lines are tolerated for forensics.
    const dir = makeTmpDir();
    const plan = [
      "# Plan",
      "",
      "## Feature 1: Bad",
      "Acceptance: tests pass",
      "",
      "### Phase 1: Setup",
      "",
      "<!-- gstack-synthesis-complete",
      "ts: 2026-05-17T08:00:00Z",
      "provider: claude",
      "model: claude-opus-4-7",
      "reasoning: xhigh",
      "round: 1",
      "self_check: passed",
      "future_unknown_key: should_not_break_detector",
      "-->",
    ].join("\n");
    const planPath = writePlan(dir, plan);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID");
    expect(fault).toBeDefined();
    expect(fault?.description).toContain("Origin trace:");
  });
});

// ---------------------------------------------------------------------------
// extractFeatureBlocks (helper, used by detector + validate-living-plan.ts)
// ---------------------------------------------------------------------------

describe("extractFeatureBlocks", () => {
  test("excludes a `## Features overview` summary list (Fix #3 regression)", () => {
    // The agnt2-paper fault investigation observed the OLD substring-match
    // logic incorrectly counting `## Features overview` checklist items as
    // feature blocks. The heading-anchored helper must filter them out by
    // requiring the exact `## Feature N:` heading shape.
    const plan = [
      "# Plan",
      "",
      "## Features overview",
      "",
      "- [ ] Feature 1 — Setup (Phases 1.1, 1.2)",
      "- [ ] Feature 2 — Wiring (Phases 2.1, 2.2)",
      "",
      "## Feature 1: Setup",
      "Origin trace: Week 1",
      "Acceptance: tests pass",
      "",
      "### Phase 1.1: Bootstrap",
      "",
      "## Feature 2: Wiring",
      "Origin trace: Week 2",
      "Acceptance: builds run",
      "",
      "### Phase 2.1: Connect",
    ].join("\n");
    const blocks = extractFeatureBlocks(plan);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].number).toBe(1);
    expect(blocks[0].name).toBe("Setup");
    expect(blocks[1].number).toBe(2);
    expect(blocks[1].name).toBe("Wiring");
  });

  test("parses real-world heading with parens, em dash, and hyphens", () => {
    // The mitosis plan Feature 5 heading shape — must round-trip cleanly
    // through the parser. This shape comes straight from a production
    // synthesizer output and must not regress.
    const plan = [
      "## Feature 5: F5 — Tag validation (P1, parallel with F4)",
      "Origin trace: Source plan §F5",
      "Acceptance: tags validate against schema",
      "",
      "### Phase 5.1: Schema",
    ].join("\n");
    const blocks = extractFeatureBlocks(plan);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].number).toBe(5);
    expect(blocks[0].name).toBe("F5 — Tag validation (P1, parallel with F4)");
    expect(blocks[0].hasOriginTrace).toBe(true);
    expect(blocks[0].hasAcceptance).toBe(true);
  });

  test("detects run-on Acceptance prose as hasAcceptance=false", () => {
    // The mitosis Feature 5 defect class: synthesizer wrote
    //   `Origin trace: ... (cite). Acceptance: ...`
    // on a single line as flowing prose. The line-anchored regex must not
    // match because no line STARTS with `Acceptance:`.
    const plan = [
      "## Feature 1: Run-on",
      "Origin trace: Source plan §1 (cite this). Acceptance: tests pass",
      "",
      "### Phase 1: Setup",
    ].join("\n");
    const blocks = extractFeatureBlocks(plan);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hasOriginTrace).toBe(true);
    expect(blocks[0].hasAcceptance).toBe(false);
  });

  test("returns empty array on empty input", () => {
    expect(extractFeatureBlocks("")).toHaveLength(0);
  });

  test("returns empty array on plan with no Feature blocks", () => {
    const plan = ["# Plan", "", "## Overview", "", "TBD"].join("\n");
    expect(extractFeatureBlocks(plan)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WORKTREE_LEAK
// ---------------------------------------------------------------------------

describe("WORKTREE_LEAK", () => {
  test("detected when state.completed=true but worktreePath directory exists", () => {
    const dir = makeTmpDir();
    const worktreePath = path.join(dir, "leaked-worktree");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "WORKTREE_LEAK");
    expect(fault).toBeDefined();
  });

  test("NOT detected when state.completed=true and worktreePath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath: path.join(dir, "nonexistent-worktree"),
    });
    const faults = detectSkillFaults(input);
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeUndefined();
  });

  test("NOT detected when state.completed=false even if worktreePath exists", () => {
    const dir = makeTmpDir();
    const worktreePath = path.join(dir, "active-worktree");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: false }),
      worktreePath,
    });
    const faults = detectSkillFaults(input);
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RED_SPEC_TRIVIAL
// ---------------------------------------------------------------------------

describe("RED_SPEC_TRIVIAL", () => {
  test("detected when failureReason contains 'trivially'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({
        failureReason: "Tests passed trivially without implementation",
      }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "RED_SPEC_TRIVIAL");
    expect(fault).toBeDefined();
    expect(fault!.evidence.stateValue).toContain("trivially");
  });

  test("detected when failureReason contains 'without implementation'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Spec passed without implementation" }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "RED_SPEC_TRIVIAL");
    expect(fault).toBeDefined();
  });

  test("NOT detected when failureReason is unrelated", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Network timeout during Gemini call" }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "RED_SPEC_TRIVIAL"),
    ).toBeUndefined();
  });

  test("NOT detected when failureReason is undefined", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "RED_SPEC_TRIVIAL"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN_MUTATOR_MISMATCH
// ---------------------------------------------------------------------------

describe("PLAN_MUTATOR_MISMATCH", () => {
  test("detected when failureReason contains 'line not found'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({
        failureReason: "Plan mutation failed: line not found in plan file",
      }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_MUTATOR_MISMATCH");
    expect(fault).toBeDefined();
  });

  test("detected when failureReason contains 'checkbox'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({
        failureReason: "Could not find checkbox in plan to flip",
      }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_MUTATOR_MISMATCH");
    expect(fault).toBeDefined();
  });

  test("NOT detected when failureReason is unrelated", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Gemini timed out after 30 minutes" }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PLAN_MUTATOR_MISMATCH"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN_REVIEW_STALEMATE
// ---------------------------------------------------------------------------

describe("PLAN_REVIEW_STALEMATE", () => {
  function writePlanReviewReport(stateDir: string, report: object): void {
    fs.writeFileSync(
      path.join(stateDir, "plan-review-report.json"),
      JSON.stringify(report),
      "utf8",
    );
  }

  test("detected when plan-review-report.json has round>=3 and CRITICAL objection", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 3,
      objections: [
        {
          severity: "CRITICAL",
          location: "Feature 1, Phase 1",
          issue: "missing tests",
          suggestion: "add tests",
        },
      ],
      assessment: "critical gap",
      reviewedBy: "gpt-5",
    });
    const input = makeInput(dir);
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE");
    expect(fault).toBeDefined();
    expect(fault!.evidence.planReviewRound).toBe(3);
  });

  test("detected when round > 3", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 5,
      objections: [
        { severity: "CRITICAL", location: "F1P1", issue: "x", suggestion: "y" },
      ],
      assessment: "",
      reviewedBy: "gpt-5",
    });
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeDefined();
  });

  test("NOT detected when round >= 3 but no CRITICAL objection", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 4,
      objections: [
        {
          severity: "IMPORTANT",
          location: "F1P1",
          issue: "x",
          suggestion: "y",
        },
      ],
      assessment: "",
      reviewedBy: "gpt-5",
    });
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });

  test("NOT detected when round < 3 even with CRITICAL objection", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 2,
      objections: [
        { severity: "CRITICAL", location: "F1P1", issue: "x", suggestion: "y" },
      ],
      assessment: "",
      reviewedBy: "gpt-5",
    });
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });

  test("NOT detected when plan-review-report.json does not exist", () => {
    const dir = makeTmpDir();
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });

  test("NOT detected when plan-review-report.json is malformed JSON", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, "plan-review-report.json"),
      "{not valid",
      "utf8",
    );
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FEATURE_VERIFIER_SCOPE
// ---------------------------------------------------------------------------

describe("FEATURE_VERIFIER_SCOPE", () => {
  test("detected when stdoutLogPath contains a line matching 'VERIFICATION: GAPS'", () => {
    const dir = makeTmpDir();
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(
      stdoutLog,
      [
        "Phase 1 starting...",
        "VERIFICATION: GAPS found in feature coverage",
        "Phase 1 complete.",
      ].join("\n"),
      "utf8",
    );
    const input = makeInput(dir, { stdoutLogPath: stdoutLog });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "FEATURE_VERIFIER_SCOPE");
    expect(fault).toBeDefined();
  });

  test("NOT detected when stdoutLogPath does not contain 'VERIFICATION: GAPS'", () => {
    const dir = makeTmpDir();
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(
      stdoutLog,
      "All verifications passed.\nFeature complete.\n",
      "utf8",
    );
    const input = makeInput(dir, { stdoutLogPath: stdoutLog });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "FEATURE_VERIFIER_SCOPE"),
    ).toBeUndefined();
  });

  test("NOT detected when stdoutLogPath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      stdoutLogPath: path.join(dir, "nonexistent.log"),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "FEATURE_VERIFIER_SCOPE"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Robustness — no throw on bad inputs
// ---------------------------------------------------------------------------

describe("detectSkillFaults — no throw on bad inputs", () => {
  test("does not throw when state is null", () => {
    const dir = makeTmpDir();
    expect(() =>
      detectSkillFaults(makeInput(dir, { state: null })),
    ).not.toThrow();
  });

  test("does not throw when livingPlanPath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      livingPlanPath: path.join(dir, "nonexistent-plan.md"),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when livingPlanPath is malformed/empty", () => {
    const dir = makeTmpDir();
    const emptyPlan = path.join(dir, "empty.md");
    fs.writeFileSync(emptyPlan, "", "utf8");
    const input = makeInput(dir, { livingPlanPath: emptyPlan });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when stateDir does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      stateDir: path.join(dir, "nonexistent-state-dir"),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when stdoutLogPath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      stdoutLogPath: path.join(dir, "no-such-file.log"),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when phases array is empty", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ phases: [] }),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("still returns other faults when one detector errors internally", () => {
    const dir = makeTmpDir();
    // Trigger WORKTREE_LEAK while also having a malformed plan-review-report
    const worktreePath = path.join(dir, "leaked");
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(
      path.join(dir, "plan-review-report.json"),
      "{bad json",
      "utf8",
    );
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });
    const faults = detectSkillFaults(input);
    // WORKTREE_LEAK must still be returned; malformed review report must not throw
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe("analytics", () => {
  test("appends a JSONL line to ${GSTACK_HOME}/analytics/skill-faults.jsonl", () => {
    const dir = makeTmpDir();
    const fakeHome = path.join(dir, "gstack-home");
    fs.mkdirSync(fakeHome);
    process.env.GSTACK_HOME = fakeHome;

    // Trigger at least one fault so analytics fire
    const worktreePath = path.join(dir, "leaked");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });
    detectSkillFaults(input);

    const jsonlPath = path.join(fakeHome, "analytics", "skill-faults.jsonl");
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs
      .readFileSync(jsonlPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("faults");
  });

  test("analytics failures do not block fault return", () => {
    const dir = makeTmpDir();
    // Point GSTACK_HOME at a file (not a directory) so the analytics write will fail
    const fakePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(fakePath, "i am a file");
    process.env.GSTACK_HOME = fakePath;

    const worktreePath = path.join(dir, "leaked");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });

    // Must not throw AND must still return the WORKTREE_LEAK fault
    let faults: SkillFault[] = [];
    expect(() => {
      faults = detectSkillFaults(input);
    }).not.toThrow();
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeDefined();
  });

  test("no analytics appended when zero faults detected", () => {
    const dir = makeTmpDir();
    const fakeHome = path.join(dir, "gstack-home");
    fs.mkdirSync(fakeHome);
    process.env.GSTACK_HOME = fakeHome;

    const faults = detectSkillFaults(makeInput(dir));
    expect(faults).toHaveLength(0);

    const jsonlPath = path.join(fakeHome, "analytics", "skill-faults.jsonl");
    // Either file doesn't exist or it's empty — no line should be written for zero faults
    if (fs.existsSync(jsonlPath)) {
      const content = fs.readFileSync(jsonlPath, "utf8").trim();
      expect(content).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Learned fault detection — helpers
// ---------------------------------------------------------------------------

function makeLearnedPattern(
  overrides: Partial<LearnedPattern> = {},
): LearnedPattern {
  return {
    category: "TEST_LEARNED_FAULT",
    severity: "HIGH",
    description: "A learned fault for testing.",
    matcherKind: "stdout_contains",
    pattern: "OOM killed",
    source: "investigator:test-report.md",
    learnedAt: "2026-01-01T00:00:00Z",
    hitCount: 0,
    ...overrides,
  };
}

function runPhase2Script(dir: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const script = `
    set -e
    FAULT_DIR="${dir}"
    PATTERNS_FILE="$FAULT_DIR/learned-patterns.json"
    ALLOWED_KINDS="stdout_contains stdout_regex failureReason_contains failureReason_regex plan_contains plan_regex"

    # Initialize patterns file if missing
    if [ ! -f "$PATTERNS_FILE" ]; then
      echo "[]" > "$PATTERNS_FILE"
    fi

    # Phase 2: extract mined patterns
    for REPORT_FILE in "$FAULT_DIR"/*.md; do
      [ -f "$REPORT_FILE" ] || continue
      MARKER="\${REPORT_FILE}.pattern-extracted"
      [ -f "$MARKER" ] && continue

      # Check for NO_PATTERN_FOUND sentinel
      if grep -q "GSTACK_NO_PATTERN_FOUND" "$REPORT_FILE"; then
        touch "$MARKER"
        continue
      fi

      # Check for LEARNED_PATTERN block
      if ! grep -q "GSTACK_LEARNED_PATTERN" "$REPORT_FILE"; then
        continue
      fi

      # Extract JSON from the block
      JSON=$(awk '/<!-- GSTACK_LEARNED_PATTERN/{found=1; next} found && /-->/{found=0; next} found{print}' "$REPORT_FILE")

      # Validate JSON fields with jq
      CATEGORY=$(echo "$JSON" | jq -r '.category // empty' 2>/dev/null) || { touch "$MARKER"; continue; }
      MATCHER_KIND=$(echo "$JSON" | jq -r '.matcherKind // empty' 2>/dev/null) || { touch "$MARKER"; continue; }
      PATTERN=$(echo "$JSON" | jq -r '.pattern // empty' 2>/dev/null) || { touch "$MARKER"; continue; }

      [ -z "$CATEGORY" ] && { touch "$MARKER"; continue; }
      [ -z "$MATCHER_KIND" ] && { touch "$MARKER"; continue; }
      [ -z "$PATTERN" ] && { touch "$MARKER"; continue; }

      # Validate UPPER_SNAKE_CASE category (no lowercase letters, must not start with digit)
      case "$CATEGORY" in
        *[a-z]*|[0-9]*) touch "$MARKER"; continue;;
      esac

      # Validate matcherKind
      VALID=0
      for KIND in $ALLOWED_KINDS; do
        [ "$MATCHER_KIND" = "$KIND" ] && VALID=1 && break
      done
      [ "$VALID" = "0" ] && { touch "$MARKER"; continue; }

      # Dedup: skip if category already exists
      if jq -e --arg c "$CATEGORY" 'any(.[]; .category == $c)' "$PATTERNS_FILE" > /dev/null 2>&1; then
        touch "$MARKER"
        continue
      fi

      # Enrich with metadata
      ENRICHED=$(echo "$JSON" | jq \
        --arg src "investigator:$(basename "$REPORT_FILE")" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '. + {source: $src, learnedAt: $ts, hitCount: 0}')

      # Atomic append
      TMP="$PATTERNS_FILE.tmp.$$"
      jq --argjson entry "$ENRICHED" '. + [$entry]' "$PATTERNS_FILE" > "$TMP"
      mv "$TMP" "$PATTERNS_FILE"

      touch "$MARKER"
    done
  `;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function reportNeedsMining(reportPath: string): boolean {
  const content = fs.readFileSync(reportPath, "utf8");
  const markerExists = fs.existsSync(reportPath + ".pattern-extracted");
  return (
    !content.includes("GSTACK_LEARNED_PATTERN") &&
    !content.includes("GSTACK_NO_PATTERN_FOUND") &&
    !markerExists
  );
}

// ---------------------------------------------------------------------------
// detectLearnedFaults — direct calls
// ---------------------------------------------------------------------------

describe("detectLearnedFaults — direct calls", () => {
  test("test 1: stdout_contains fires on literal match", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const pattern = makeLearnedPattern({
      matcherKind: "stdout_contains",
      pattern: "OOM killed",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      null,
      "process OOM killed by kernel",
    );
    expect(faults).toHaveLength(1);
    expect(faults[0].category).toBe(pattern.category);
    expect(faults[0].description.startsWith("[learned] ")).toBe(true);
  });

  test("test 2: stdout_regex fires on regex match", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const pattern = makeLearnedPattern({
      matcherKind: "stdout_regex",
      pattern: "Error: \\w+ timed out",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      null,
      "Error: agent timed out after 30s",
    );
    expect(faults).toHaveLength(1);
  });

  test("test 3: failureReason_contains fires", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Process OOM killed by kernel" }),
    });
    const pattern = makeLearnedPattern({
      matcherKind: "failureReason_contains",
      pattern: "OOM killed",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      null,
      null,
    );
    expect(faults).toHaveLength(1);
  });

  test("test 4: failureReason_regex fires", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "timeout after 60s" }),
    });
    const pattern = makeLearnedPattern({
      matcherKind: "failureReason_regex",
      pattern: "timeout after \\d+s",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      null,
      null,
    );
    expect(faults).toHaveLength(1);
  });

  test("test 5: plan_contains fires", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const pattern = makeLearnedPattern({
      matcherKind: "plan_contains",
      pattern: "MISSING_FEATURE",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      "This plan is MISSING_FEATURE for the new API",
      null,
    );
    expect(faults).toHaveLength(1);
  });

  test("test 6: plan_regex fires", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const pattern = makeLearnedPattern({
      matcherKind: "plan_regex",
      pattern: "Phase \\d+ skipped",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      "Phase 3 skipped due to dependency failure",
      null,
    );
    expect(faults).toHaveLength(1);
  });

  test("test 7: category in staticCategories → skipped (dedup)", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const pattern = makeLearnedPattern({
      category: "CODEX_CONVERGENCE",
      matcherKind: "stdout_contains",
      pattern: "some text",
    });
    const faults = detectLearnedFaults(
      input,
      new Set<string>(["CODEX_CONVERGENCE"]),
      [pattern],
      null,
      "some text that matches",
    );
    expect(faults).toHaveLength(0);
  });

  test("test 8: invalid regex → no throw, empty result", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const pattern = makeLearnedPattern({
      matcherKind: "stdout_regex",
      pattern: "[invalid",
    });
    expect(() =>
      detectLearnedFaults(
        input,
        new Set<string>(),
        [pattern],
        null,
        "[invalid matches",
      ),
    ).not.toThrow();
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [pattern],
      null,
      "[invalid matches",
    );
    expect(faults).toHaveLength(0);
  });

  test("test 9: empty patterns list → empty result, no throw", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    expect(() =>
      detectLearnedFaults(input, new Set<string>(), [], null, "some stdout"),
    ).not.toThrow();
    const faults = detectLearnedFaults(
      input,
      new Set<string>(),
      [],
      null,
      "some stdout",
    );
    expect(faults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadLearnedPatterns
// ---------------------------------------------------------------------------

describe("loadLearnedPatterns", () => {
  test("test 10: reads pattern from $GSTACK_HOME/skill-faults/learned-patterns.json", () => {
    const tmpDir = makeTmpDir();
    process.env.GSTACK_HOME = tmpDir;
    const sfDir = path.join(tmpDir, "skill-faults");
    fs.mkdirSync(sfDir, { recursive: true });
    const validPattern: LearnedPattern = {
      category: "CUSTOM_OOM_KILL",
      severity: "HIGH",
      description: "Process was OOM killed.",
      matcherKind: "stdout_contains",
      pattern: "OOM killed",
      source: "investigator:test.md",
      learnedAt: "2026-01-01T00:00:00Z",
      hitCount: 0,
    };
    fs.writeFileSync(
      path.join(sfDir, "learned-patterns.json"),
      JSON.stringify([validPattern]),
      "utf8",
    );
    const patterns = loadLearnedPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].category).toBe("CUSTOM_OOM_KILL");
    expect(patterns[0].matcherKind).toBe("stdout_contains");
    expect(patterns[0].hitCount).toBe(0);
  });

  test("test 11: returns [] for missing file, no throw", () => {
    const tmpDir = makeTmpDir();
    process.env.GSTACK_HOME = tmpDir;
    // No skill-faults/ dir created
    expect(() => loadLearnedPatterns()).not.toThrow();
    const patterns = loadLearnedPatterns();
    expect(patterns).toHaveLength(0);
  });

  test("test 12: returns [] for malformed JSON, and filters invalid entries", () => {
    const tmpDir = makeTmpDir();
    process.env.GSTACK_HOME = tmpDir;
    const sfDir = path.join(tmpDir, "skill-faults");
    fs.mkdirSync(sfDir, { recursive: true });

    // Malformed JSON — must not throw
    fs.writeFileSync(
      path.join(sfDir, "learned-patterns.json"),
      "{not valid json",
      "utf8",
    );
    expect(() => loadLearnedPatterns()).not.toThrow();
    expect(loadLearnedPatterns()).toHaveLength(0);

    // Now write 2 entries: one valid, one missing severity
    const validEntry: LearnedPattern = {
      category: "VALID_CATEGORY",
      severity: "MEDIUM",
      description: "A valid learned pattern.",
      matcherKind: "failureReason_contains",
      pattern: "crash",
      source: "investigator:report.md",
      learnedAt: "2026-01-01T00:00:00Z",
      hitCount: 0,
    };
    const invalidEntry = {
      category: "INVALID_NO_SEVERITY",
      // missing severity
      description: "Missing severity field.",
      matcherKind: "stdout_contains",
      pattern: "crash",
      source: "investigator:report.md",
      learnedAt: "2026-01-01T00:00:00Z",
      hitCount: 0,
    };
    fs.writeFileSync(
      path.join(sfDir, "learned-patterns.json"),
      JSON.stringify([validEntry, invalidEntry]),
      "utf8",
    );
    const patterns = loadLearnedPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].category).toBe("VALID_CATEGORY");
  });
});

// ---------------------------------------------------------------------------
// detectSkillFaults with learned patterns
// ---------------------------------------------------------------------------

describe("detectSkillFaults with learned patterns", () => {
  test("test 13: integration — learned faults appear alongside static faults", () => {
    const dir = makeTmpDir();
    // Create a real worktree dir to trigger WORKTREE_LEAK
    const worktreePath = path.join(dir, "leaked-worktree");
    fs.mkdirSync(worktreePath);

    // Write a stdout log that matches the learned pattern
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(stdoutLog, "process OOM killed by kernel\n", "utf8");

    const learnedPattern = makeLearnedPattern({
      category: "CUSTOM_OOM_KILL",
      matcherKind: "stdout_contains",
      pattern: "OOM killed",
    });

    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
      stdoutLogPath: stdoutLog,
    });

    const faults = detectSkillFaults(input, [learnedPattern]);
    const categories = faults.map((f) => f.category);
    expect(categories).toContain("WORKTREE_LEAK");
    expect(categories).toContain("CUSTOM_OOM_KILL");
  });

  test("test 14: hitCount increments 0→1 after a learned fault fires", () => {
    const tmpDir = makeTmpDir();
    process.env.GSTACK_HOME = tmpDir;
    const sfDir = path.join(tmpDir, "skill-faults");
    fs.mkdirSync(sfDir, { recursive: true });

    const patternsFile = path.join(sfDir, "learned-patterns.json");
    const pattern: LearnedPattern = {
      category: "CUSTOM_OOM_KILL",
      severity: "HIGH",
      description: "Process was OOM killed.",
      matcherKind: "stdout_contains",
      pattern: "OOM killed",
      source: "investigator:test.md",
      learnedAt: "2026-01-01T00:00:00Z",
      hitCount: 0,
    };
    fs.writeFileSync(patternsFile, JSON.stringify([pattern]), "utf8");

    // Write stdout log that matches
    const dir = makeTmpDir();
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(stdoutLog, "process OOM killed by kernel\n", "utf8");

    const input = makeInput(dir, { stdoutLogPath: stdoutLog });
    const faults = detectSkillFaults(input, [pattern]);

    // Fault should have fired
    expect(faults.map((f) => f.category)).toContain("CUSTOM_OOM_KILL");

    // Read back and verify hitCount incremented
    const updated = JSON.parse(fs.readFileSync(patternsFile, "utf8")) as Array<{
      category: string;
      hitCount: number;
    }>;
    const entry = updated.find((e) => e.category === "CUSTOM_OOM_KILL");
    expect(entry).toBeDefined();
    expect(entry!.hitCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M3.6 Phase 2 bash extraction
// ---------------------------------------------------------------------------

describe("M3.6 Phase 2 bash extraction", () => {
  test("test 15: un-mined report (no pattern block, no sentinel, no marker) needs mining", () => {
    const dir = makeTmpDir();
    const reportPath = path.join(dir, "fault-report.md");
    fs.writeFileSync(
      reportPath,
      "# Fault Report\n\nSomething went wrong but no pattern extracted yet.\n",
      "utf8",
    );
    expect(reportNeedsMining(reportPath)).toBe(true);
  });

  test("test 16: GSTACK_NO_PATTERN_FOUND sentinel → marker written immediately", () => {
    const dir = makeTmpDir();
    const reportPath = path.join(dir, "fault-report.md");
    fs.writeFileSync(
      reportPath,
      '# Fault Report\n\n<!-- GSTACK_NO_PATTERN_FOUND reason="not specific enough" -->\n',
      "utf8",
    );
    const result = runPhase2Script(dir);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(reportPath + ".pattern-extracted")).toBe(true);
  });

  test("test 17: valid GSTACK_LEARNED_PATTERN → JSON updated, marker written", () => {
    const dir = makeTmpDir();
    const reportPath = path.join(dir, "fault-report.md");
    fs.writeFileSync(
      reportPath,
      [
        "# Fault Report",
        "",
        "<!-- GSTACK_LEARNED_PATTERN",
        JSON.stringify({
          category: "TEST_OOM_KILL",
          severity: "HIGH",
          description: "Process was OOM killed.",
          matcherKind: "stdout_contains",
          pattern: "OOM killed",
        }),
        "-->",
      ].join("\n"),
      "utf8",
    );

    const result = runPhase2Script(dir);
    expect(result.exitCode).toBe(0);

    // Marker file must exist
    expect(fs.existsSync(reportPath + ".pattern-extracted")).toBe(true);

    // learned-patterns.json must exist with the entry
    const patternsFile = path.join(dir, "learned-patterns.json");
    expect(fs.existsSync(patternsFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(patternsFile, "utf8")) as Array<{
      category: string;
      source: string;
      learnedAt: string;
      hitCount: number;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].category).toBe("TEST_OOM_KILL");
    expect(typeof parsed[0].source).toBe("string");
    expect(typeof parsed[0].learnedAt).toBe("string");
    expect(parsed[0].hitCount).toBe(0);
  });

  test("test 18: report with .pattern-extracted marker → skipped, no entries added", () => {
    const dir = makeTmpDir();
    const reportPath = path.join(dir, "fault-report.md");
    fs.writeFileSync(
      reportPath,
      [
        "# Fault Report",
        "",
        "<!-- GSTACK_LEARNED_PATTERN",
        JSON.stringify({
          category: "TEST_OOM_KILL",
          severity: "HIGH",
          description: "Process was OOM killed.",
          matcherKind: "stdout_contains",
          pattern: "OOM killed",
        }),
        "-->",
      ].join("\n"),
      "utf8",
    );
    // Touch the marker file first so the report is already processed
    fs.writeFileSync(reportPath + ".pattern-extracted", "", "utf8");

    const result = runPhase2Script(dir);
    expect(result.exitCode).toBe(0);

    // The patterns file is initialized to [] by the script but no entries are added
    const patternsFile = path.join(dir, "learned-patterns.json");
    const content = fs.readFileSync(patternsFile, "utf8");
    expect(JSON.parse(content)).toEqual([]);
  });

  test("test 19: malformed JSON in pattern block → marker written, JSON unchanged", () => {
    const dir = makeTmpDir();
    const reportPath = path.join(dir, "fault-report.md");
    fs.writeFileSync(
      reportPath,
      [
        "# Fault Report",
        "",
        "<!-- GSTACK_LEARNED_PATTERN",
        "{not valid json}",
        "-->",
      ].join("\n"),
      "utf8",
    );

    // Pre-create an empty patterns file
    const patternsFile = path.join(dir, "learned-patterns.json");
    fs.writeFileSync(patternsFile, "[]", "utf8");

    const result = runPhase2Script(dir);
    expect(result.exitCode).toBe(0);

    // Marker must be written
    expect(fs.existsSync(reportPath + ".pattern-extracted")).toBe(true);
    // Patterns file must still be empty array
    const content = fs.readFileSync(patternsFile, "utf8");
    expect(JSON.parse(content)).toEqual([]);
  });

  test("test 20: duplicate category → marker written, no duplicate in JSON", () => {
    const dir = makeTmpDir();
    const reportPath = path.join(dir, "fault-report.md");
    fs.writeFileSync(
      reportPath,
      [
        "# Fault Report",
        "",
        "<!-- GSTACK_LEARNED_PATTERN",
        JSON.stringify({
          category: "TEST_OOM_KILL",
          severity: "HIGH",
          description: "Process was OOM killed.",
          matcherKind: "stdout_contains",
          pattern: "OOM killed",
        }),
        "-->",
      ].join("\n"),
      "utf8",
    );

    // Pre-create patterns file with an existing TEST_OOM_KILL entry
    const patternsFile = path.join(dir, "learned-patterns.json");
    const existingEntry: LearnedPattern = {
      category: "TEST_OOM_KILL",
      severity: "HIGH",
      description: "Existing entry.",
      matcherKind: "stdout_contains",
      pattern: "OOM killed",
      source: "investigator:old-report.md",
      learnedAt: "2025-01-01T00:00:00Z",
      hitCount: 3,
    };
    fs.writeFileSync(patternsFile, JSON.stringify([existingEntry]), "utf8");

    const result = runPhase2Script(dir);
    expect(result.exitCode).toBe(0);

    // Marker must be written
    expect(fs.existsSync(reportPath + ".pattern-extracted")).toBe(true);

    // Only 1 entry (no duplicate)
    const parsed = JSON.parse(fs.readFileSync(patternsFile, "utf8")) as Array<{
      category: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].category).toBe("TEST_OOM_KILL");
  });
});

// ---------------------------------------------------------------------------
// validate-living-plan.ts CLI (Fix #2 — structural gate)
// ---------------------------------------------------------------------------

describe("validate-living-plan.ts CLI", () => {
  const VALIDATOR = path.resolve(
    __dirname,
    "..",
    "build",
    "orchestrator",
    "validate-living-plan.ts",
  );

  function runValidator(args: string[]): {
    code: number;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync("bun", ["run", VALIDATOR, ...args], {
      encoding: "utf8",
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  test("exits 0 on a valid plan", () => {
    const dir = makeTmpDir();
    const plan = [
      "## Feature 1: Good",
      "Origin trace: Source plan Week 1",
      "Acceptance: tests pass",
      "Out of scope: none",
      "",
      "### Phase 1: Setup",
    ].join("\n");
    const planPath = path.join(dir, "valid.md");
    fs.writeFileSync(planPath, plan, "utf8");
    const { code } = runValidator([planPath]);
    expect(code).toBe(0);
  });

  test("exits 2 with JSON violation when Acceptance: is missing", () => {
    const dir = makeTmpDir();
    const plan = [
      "## Feature 1: NoAcceptance",
      "Origin trace: Source plan Week 1",
      "",
      "### Phase 1: Setup",
    ].join("\n");
    const planPath = path.join(dir, "no-acc.md");
    fs.writeFileSync(planPath, plan, "utf8");
    const { code, stderr } = runValidator([planPath]);
    expect(code).toBe(2);
    const report = JSON.parse(stderr.trim());
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].featureNumber).toBe(1);
    expect(report.violations[0].missing).toEqual(["acceptance"]);
  });

  test("exits 2 with JSON violation when Origin trace: is missing", () => {
    const dir = makeTmpDir();
    const plan = [
      "## Feature 1: NoOrigin",
      "Acceptance: tests pass",
      "",
      "### Phase 1: Setup",
    ].join("\n");
    const planPath = path.join(dir, "no-origin.md");
    fs.writeFileSync(planPath, plan, "utf8");
    const { code, stderr } = runValidator([planPath]);
    expect(code).toBe(2);
    const report = JSON.parse(stderr.trim());
    expect(report.violations[0].missing).toEqual(["originTrace"]);
  });

  test("exits 2 on run-on Acceptance prose (mitosis Feature 5 shape)", () => {
    const dir = makeTmpDir();
    const plan = [
      "## Feature 5: F5 — Tag validation (P1, parallel with F4)",
      "Origin trace: Source plan §F5 (sub-track A). Acceptance: tags validate",
      "",
      "### Phase 5.1: Schema",
    ].join("\n");
    const planPath = path.join(dir, "runon.md");
    fs.writeFileSync(planPath, plan, "utf8");
    const { code, stderr } = runValidator([planPath]);
    expect(code).toBe(2);
    const report = JSON.parse(stderr.trim());
    expect(report.violations[0].featureNumber).toBe(5);
    expect(report.violations[0].missing).toEqual(["acceptance"]);
  });

  test("exits 1 when given a nonexistent plan path", () => {
    const { code, stderr } = runValidator([
      "/tmp/this-path-should-not-exist-validate-test.md",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("error:");
  });

  test("exits 1 when given no arguments", () => {
    const { code, stderr } = runValidator([]);
    expect(code).toBe(1);
    expect(stderr).toContain("usage:");
  });

  test("exits 2 on plan with no Feature blocks (synthesizer wrote a stub)", () => {
    const dir = makeTmpDir();
    const plan = ["# Plan", "", "## Overview", "", "TBD"].join("\n");
    const planPath = path.join(dir, "stub.md");
    fs.writeFileSync(planPath, plan, "utf8");
    const { code, stderr } = runValidator([planPath]);
    expect(code).toBe(2);
    const report = JSON.parse(stderr.trim());
    expect(report.featureCount).toBe(0);
    expect(report.violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// faultId helper — composite identity for the monitor's active-fault registry.
// Fixes the SKILL_FAULT_DETECTED_IS_APPEND_ONLY_TELEMETRY issue: monitor needs
// a stable key per (category, phase, source) to diff DETECTED → RESOLVED
// across ticks. Two phases sharing a category (e.g. PREMATURE_COMPLETION on
// phase 1 AND phase 2) must resolve independently.
// ---------------------------------------------------------------------------

describe("faultId", () => {
  function mkFault(over: Partial<SkillFault> = {}): SkillFault {
    return {
      category: "PREMATURE_COMPLETION",
      severity: "HIGH",
      description: "test",
      sourceFiles: [],
      evidence: {},
      ...over,
    };
  }

  test("same category + phaseIndex + sourceFile → same id", () => {
    const a = mkFault({
      category: "X",
      sourceFiles: ["plan.md"],
      evidence: { phaseIndex: 2 },
    });
    const b = mkFault({
      category: "X",
      sourceFiles: ["plan.md"],
      evidence: { phaseIndex: 2 },
    });
    expect(faultId(a)).toBe(faultId(b));
  });

  test("different phaseIndex → different id", () => {
    const a = mkFault({ evidence: { phaseIndex: 1 } });
    const b = mkFault({ evidence: { phaseIndex: 2 } });
    expect(faultId(a)).not.toBe(faultId(b));
  });

  test("different category → different id", () => {
    const a = mkFault({ category: "PREMATURE_COMPLETION" });
    const b = mkFault({ category: "CODEX_CONVERGENCE" });
    expect(faultId(a)).not.toBe(faultId(b));
  });

  test("different first sourceFile → different id", () => {
    const a = mkFault({ sourceFiles: ["plan-a.md"] });
    const b = mkFault({ sourceFiles: ["plan-b.md"] });
    expect(faultId(a)).not.toBe(faultId(b));
  });

  test("missing phaseIndex collapses to stable 'all' placeholder", () => {
    const a = mkFault({ evidence: {} });
    const b = mkFault({ evidence: {} });
    expect(faultId(a)).toBe(faultId(b));
    expect(faultId(a)).toContain(":all:");
  });

  test("missing sourceFiles collapses to stable '*' placeholder", () => {
    const a = mkFault({ sourceFiles: [] });
    const b = mkFault({ sourceFiles: [] });
    expect(faultId(a)).toBe(faultId(b));
    expect(faultId(a)).toContain(":*");
  });

  test("only the FIRST sourceFile contributes to identity", () => {
    // Two faults with the same category+phaseIndex but different second
    // sourceFiles still share an id — the second is additional evidence,
    // not a different "fault".
    const a = mkFault({ sourceFiles: ["plan.md", "log-1.txt"] });
    const b = mkFault({ sourceFiles: ["plan.md", "log-2.txt"] });
    expect(faultId(a)).toBe(faultId(b));
  });
});
