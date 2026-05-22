import { describe, expect, test } from "bun:test";
import { applyResult } from "../phase-runner";
import type { Action } from "../phase-runner";
import type { PhaseState } from "../types";
import type { SubAgentResult } from "../sub-agents";

function state(): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "Provider failure propagation",
    status: "test_spec_running",
    kind: "code",
  };
}

function result(overrides: Partial<SubAgentResult>): SubAgentResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 1,
    timedOut: false,
    stallKilled: false,
    stallSilenceMs: 0,
    exitSignal: null,
    logPath: "/tmp/role.log",
    durationMs: 1,
    retries: 0,
    ...overrides,
  };
}

describe("provider failure replay across role paths", () => {
  const cases: Array<{
    role: string;
    action: Action;
    initialStatus: PhaseState["status"];
  }> = [
    {
      role: "test-writer",
      action: { type: "RUN_GEMINI_TEST_SPEC", phaseIndex: 0, iteration: 1 },
      initialStatus: "test_spec_running",
    },
    {
      role: "primary-impl",
      action: { type: "RUN_GEMINI", phaseIndex: 0, iteration: 1 },
      initialStatus: "tests_red",
    },
    {
      role: "test-fixer",
      action: { type: "RUN_GEMINI_FIX", phaseIndex: 0, iteration: 1 },
      initialStatus: "test_fix_running",
    },
    {
      role: "review",
      action: { type: "RUN_CODEX_REVIEW", phaseIndex: 0, iteration: 1 },
      initialStatus: "codex_running",
    },
    {
      role: "dual-impl",
      action: { type: "RUN_DUAL_IMPL", phaseIndex: 0, iteration: 1 },
      initialStatus: "dual_impl_running",
    },
    {
      role: "judge",
      action: { type: "RUN_JUDGE", phaseIndex: 0, iteration: 1 },
      initialStatus: "dual_judge_pending",
    },
  ];

  for (const c of cases) {
    test(`${c.role} persists failureRender and provider verdict`, () => {
      const initial = { ...state(), status: c.initialStatus };
      const next = applyResult(
        initial,
        c.action,
        result({
          stderr: "API Error: 529 Overloaded",
          exitCode: 1,
          logPath: `/tmp/${c.role}.log`,
        }),
      );
      expect(next.status).toBe("failed");
      expect(next.failureRender?.[c.role]?.logPath).toBe(`/tmp/${c.role}.log`);
      expect((next.failureRender?.[c.role] as any)?.providerFailure?.kind).toBe(
        "capacity",
      );
    });
  }

  test("Kimi zero-output stall does not look like a retry-cap failure", () => {
    const next = applyResult(
      state(),
      { type: "RUN_GEMINI_TEST_SPEC", phaseIndex: 0, iteration: 1 },
      result({
        exitCode: null,
        timedOut: true,
        stallKilled: true,
        stallSilenceMs: 120000,
        exitSignal: "SIGTERM",
      }),
    );
    expect(next.error).toContain("stalled");
    expect(next.error).not.toContain("RETRY_CAP_HIT");
    expect((next.failureRender?.["test-writer"] as any)?.providerFailure?.kind).toBe(
      "stall",
    );
  });

  test("auth prompt evidence persists as auth provider verdict", () => {
    const next = applyResult(
      state(),
      { type: "RUN_GEMINI_TEST_SPEC", phaseIndex: 0, iteration: 1 },
      result({
        stderr: "Please authenticate before continuing",
        exitCode: null,
        timedOut: true,
        stallKilled: true,
        killReason: "auth_required",
      }),
    );
    expect(next.error).toContain("authentication required");
    expect((next.failureRender?.["test-writer"] as any)?.providerFailure?.kind).toBe(
      "auth",
    );
  });
});
