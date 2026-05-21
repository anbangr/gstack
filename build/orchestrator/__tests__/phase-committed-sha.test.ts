/**
 * T7: PhaseState.committedSha — set on every commit via markCommitted,
 * cleared on FEATURE_REDO reset via resetPhaseStateForRedo.
 *
 * Prerequisite for T8 (per-phase diff blocks). Downstream consumers
 * compute `git diff <prev-sha>..<this-sha>` for review prompts, so the
 * field MUST be set when HEAD resolves, and MUST be cleared on REDO so
 * a re-run phase doesn't carry stale tracking from the prior attempt.
 */
import { describe, expect, test } from "bun:test";
import { markCommitted } from "../phase-runner";
import { resetPhaseStateForRedo } from "../cli";
import type { BuildState, PhaseState } from "../types";

function basePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "Test Phase",
    status: "review_clean",
    ...overrides,
  };
}

function buildStateWith(phases: PhaseState[]): BuildState {
  return {
    planFile: "/tmp/plan.md",
    planBasename: "plan",
    slug: "test-slug",
    branch: "test-branch",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    currentPhaseIndex: 0,
    phases,
    completed: false,
  };
}

describe("markCommitted committedSha tracking (T7)", () => {
  test("with committedSha sets the field on the result", () => {
    const before = basePhase();
    const after = markCommitted(before, "abc1234");
    expect(after.committedSha).toBe("abc1234");
    expect(after.committedAt).toBeDefined();
    expect(after.status).toBe("committed");
  });

  test("without committedSha leaves the field undefined", () => {
    const before = basePhase();
    const after = markCommitted(before);
    expect(after.committedSha).toBeUndefined();
    expect(after.committedAt).toBeDefined();
    expect(after.status).toBe("committed");
  });

  test("preserves all other PhaseState fields", () => {
    const before: PhaseState = {
      ...basePhase(),
      codexReview: { iterations: 2, outputLogPaths: ["/tmp/r1.md"] },
      testRun: { iterations: 1, finalStatus: "green" },
      coverageResult: { actual: 92, target: 90 },
    };
    const after = markCommitted(before, "xyz789a");
    expect(after.committedSha).toBe("xyz789a");
    expect(after.codexReview).toEqual({
      iterations: 2,
      outputLogPaths: ["/tmp/r1.md"],
    });
    expect(after.testRun).toEqual({ iterations: 1, finalStatus: "green" });
    expect(after.coverageResult).toEqual({ actual: 92, target: 90 });
    expect(after.index).toBe(before.index);
    expect(after.number).toBe(before.number);
    expect(after.name).toBe(before.name);
  });

  test("empty-string committedSha is treated as undefined (defensive)", () => {
    // markCommitted's spread guards on `committedSha ? ... : {}`, so an
    // empty string (falsy) skips assignment. Caller-side resolves
    // git rev-parse failures to undefined explicitly, but be defensive.
    const after = markCommitted(basePhase(), "");
    expect(after.committedSha).toBeUndefined();
  });
});

describe("resetPhaseStateForRedo committedSha cleanup (T7)", () => {
  test("clears committedSha", () => {
    const state = buildStateWith([
      {
        ...basePhase({ status: "committed" }),
        committedAt: "2026-05-21T00:00:00Z",
        committedSha: "deadbee",
      },
    ]);
    resetPhaseStateForRedo(state, 0);
    expect(state.phases[0].committedSha).toBeUndefined();
    expect(state.phases[0].status).toBe("pending");
  });

  test("clears committedAt AND committedSha (regression: both must be cleared)", () => {
    // Regression guard. If a future contributor adds a new commit-tracking
    // field and forgets the parallel delete here, FEATURE_REDO will leak
    // stale state into the re-run attempt. This test pins both fields.
    const state = buildStateWith([
      {
        ...basePhase({ status: "committed" }),
        committedAt: "2026-05-21T00:00:00Z",
        committedSha: "cafef00",
        codexReview: { iterations: 1, outputLogPaths: [] },
        testRun: { iterations: 1, finalStatus: "green" },
      },
    ]);
    resetPhaseStateForRedo(state, 0);
    expect(state.phases[0].committedAt).toBeUndefined();
    expect(state.phases[0].committedSha).toBeUndefined();
    // Sanity: the existing reset surface still works.
    expect(state.phases[0].codexReview).toBeUndefined();
    expect(state.phases[0].testRun).toBeUndefined();
    expect(state.phases[0].status).toBe("pending");
  });

  test("is a no-op when phaseIndex is out of bounds", () => {
    const state = buildStateWith([basePhase()]);
    // Should not throw.
    expect(() => resetPhaseStateForRedo(state, 99)).not.toThrow();
    expect(state.phases[0].status).toBe("review_clean");
  });
});
