import { describe, test, expect } from "bun:test";
import { computeFaultId, type HaltEvent } from "../halt-events";

describe("computeFaultId", () => {
  test("deterministic for identical inputs", () => {
    const a = computeFaultId({
      kind: "PHASE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "phase 2 spec-flip failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { stdoutTail: "" },
    });
    const b = computeFaultId({
      kind: "PHASE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "phase 2 spec-flip failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { stdoutTail: "" },
    });
    expect(a).toBe(b);
  });

  test("differs across phase indices", () => {
    const base = {
      kind: "PHASE_FAILED" as const,
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL" as const,
      message: "same",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
    };
    const a = computeFaultId({
      ...base,
      snapshot: { phase: { index: 0, status: "failed" } as any, stdoutTail: "" },
    });
    const b = computeFaultId({
      ...base,
      snapshot: { phase: { index: 1, status: "failed" } as any, stdoutTail: "" },
    });
    expect(a).not.toBe(b);
  });

  test("uses f<number> for feature-scoped events", () => {
    const id = computeFaultId({
      kind: "FEATURE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "ship failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { feature: { number: "3", status: "failed" } as any, stdoutTail: "" },
    });
    expect(id.startsWith("FEATURE_FAILED:f3:")).toBe(true);
  });
});
