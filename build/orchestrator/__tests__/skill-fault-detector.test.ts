/**
 * Co-located unit tests for build/orchestrator/skill-fault-detector.ts.
 *
 * The broader corpus lives at test/skill-fault-detector.test.ts. This file
 * adds the focused coverage for additions that landed alongside the halt-events
 * detector work:
 *   - state_jsonpath learned-pattern matcherKind
 *   - HAND_MERGED_FEATURE static detector (the 2026-05-17 polis regression)
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  detectLearnedFaults,
  detectSkillFaults,
  type LearnedPattern,
} from "../skill-fault-detector";

describe("state_jsonpath learned pattern", () => {
  test("fires on hand-merged feature shape", () => {
    const state = {
      phases: [],
      features: [
        { number: "1", status: "committed", completedAt: "2026-05-19" },
        { number: "2", status: "committed", mergeSha: "abc", prNumber: 7 },
      ],
    } as any;
    const lp: LearnedPattern = {
      category: "HAND_MERGED_FEATURE_LEARNED",
      severity: "HIGH",
      description: "hand-merged feature lacks completedAt",
      matcherKind: "state_jsonpath",
      pattern:
        "$.features[*][?(@.status == 'committed' && !@.completedAt && @.mergeSha && @.prNumber)]",
      source: "investigator:test",
      learnedAt: new Date().toISOString(),
      hitCount: 0,
    };
    const out = detectLearnedFaults(
      {
        state,
        livingPlanPath: "/x",
        worktreePath: "/x",
        stateDir: "/x",
        stdoutLogPath: "/x",
      },
      new Set<string>(),
      [lp],
      null,
      null,
    );
    expect(out.length).toBe(1);
    expect(out[0].category).toBe("HAND_MERGED_FEATURE_LEARNED");
  });

  test("does not fire when pattern doesn't match", () => {
    const state = {
      phases: [],
      features: [{ number: "1", status: "running" }],
    } as any;
    const lp: LearnedPattern = {
      category: "X",
      severity: "HIGH",
      description: "X",
      matcherKind: "state_jsonpath",
      pattern: "$.features[*][?(@.status == 'committed')]",
      source: "x",
      learnedAt: "x",
      hitCount: 0,
    };
    const out = detectLearnedFaults(
      {
        state,
        livingPlanPath: "/x",
        worktreePath: "/x",
        stateDir: "/x",
        stdoutLogPath: "/x",
      },
      new Set<string>(),
      [lp],
      null,
      null,
    );
    expect(out.length).toBe(0);
  });

  test("malformed pattern doesn't throw, just doesn't fire", () => {
    const state = { phases: [], features: [{ status: "committed" }] } as any;
    const lp: LearnedPattern = {
      category: "Y",
      severity: "MEDIUM",
      description: "Y",
      matcherKind: "state_jsonpath",
      pattern: "$..()malformed",
      source: "x",
      learnedAt: "x",
      hitCount: 0,
    };
    expect(() => {
      detectLearnedFaults(
        {
          state,
          livingPlanPath: "/x",
          worktreePath: "/x",
          stateDir: "/x",
          stdoutLogPath: "/x",
        },
        new Set<string>(),
        [lp],
        null,
        null,
      );
    }).not.toThrow();
  });
});

describe("HAND_MERGED_FEATURE detector", () => {
  test("fires on polis state shape", () => {
    const state = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "halt-events",
          "hand-merged-feature-state.json",
        ),
        "utf8",
      ),
    );
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    const f = out.find((x) => x.category === "HAND_MERGED_FEATURE");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("HIGH");
  });

  test("does NOT fire when completedAt is present", () => {
    const state = {
      phases: [],
      features: [
        {
          index: 0,
          number: "1",
          status: "committed",
          mergeSha: "abc",
          prNumber: 1,
          completedAt: "2026-05-19",
        },
      ],
    } as any;
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    expect(out.find((x) => x.category === "HAND_MERGED_FEATURE")).toBeFalsy();
  });

  test("does NOT fire without mergeSha", () => {
    const state = {
      phases: [],
      features: [{ index: 0, number: "1", status: "committed", prNumber: 1 }],
    } as any;
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    expect(out.find((x) => x.category === "HAND_MERGED_FEATURE")).toBeFalsy();
  });
});
