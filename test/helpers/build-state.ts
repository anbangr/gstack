import type { BuildState } from "../../build/orchestrator/types";

export function makeMockState(overrides: Partial<BuildState> = {}): BuildState {
  return {
    planFile: "/tmp/test-plan.md",
    planBasename: "test-plan",
    slug: "test-build-slug",
    branch: "test-branch",
    startedAt: "2026-05-21T00:00:00Z",
    lastUpdatedAt: "2026-05-21T00:00:00Z",
    currentPhaseIndex: 0,
    phases: [],
    completed: false,
    ...overrides,
  };
}
