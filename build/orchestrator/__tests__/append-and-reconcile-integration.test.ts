/**
 * End-to-end seam test: appendFeaturePhases (plan-mutator) →
 * parsePlan (parser) → reconcileStatePhasesAfterReparse (state).
 *
 * Walks the exact sequence the orchestrator runs after a
 * FEATURE_NEEDS_PHASES verdict, on a real plan file (no fixtures),
 * and asserts that:
 *
 *   1. Feature 1 gets a new pending PhaseState for the appended review
 *      phase.
 *   2. Feature 2's PhaseState retains its runtime evidence (the bug
 *      the old slice-tail merge silently corrupted).
 *   3. The inner phase-loop's `featureState.phaseIndexes.find(...)`
 *      query (cli.ts:8824) lands on the new review phase, not on a
 *      stale-aliased Feature 2 phase.
 *
 * If this test passes, the multi-feature FEATURE_NEEDS_PHASES loop
 * converges — the build skill picks up the new review phase, runs it,
 * commits code, and the next feature-review cycle sees the diff.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePlan } from "../parser";
import { appendFeaturePhases } from "../plan-mutator";
import { reconcileStatePhasesAfterReparse } from "../state";
import type { BuildState } from "../types";

function writeTmpPlan(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-merge-test-"));
  const p = path.join(dir, "plan.md");
  fs.writeFileSync(p, content);
  return p;
}

describe("append → reparse → reconcile (end-to-end seam)", () => {
  it("multi-feature plan: Feature 1 review-1 lands as new pending, Feature 2 phase keeps its runtime state", () => {
    const initialPlan = `# Plan

## Feature 1: Auth

### Phase 1: Schema
- [x] **Implementation**: build schema
- [x] **Review**: review schema

## Feature 2: Billing

### Phase 2: Stripe wire
- [x] **Implementation**: wire stripe
- [x] **Review**: review billing
`;
    const planFile = writeTmpPlan(initialPlan);

    // Initial parse — what the orchestrator's BuildState reflects pre-append.
    const initial = parsePlan(initialPlan, {});
    expect(initial.phases).toHaveLength(2);
    expect(initial.features).toHaveLength(2);
    expect(initial.features[0].phaseIndexes).toEqual([0]);
    expect(initial.features[1].phaseIndexes).toEqual([1]);

    // Hand-build the state the orchestrator would have after both phases
    // shipped. Inflate Feature 2's PhaseState with distinctive evidence
    // we'll verify is preserved across the reconcile.
    const state: BuildState = {
      slug: "merge-test",
      planFile,
      branch: "main",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 1,
      phases: initial.phases.map((p) => ({
        index: p.index,
        number: p.number,
        name: p.name,
        status: "committed" as const,
        kind: p.kind,
      })),
      features: initial.features.map((f) => ({
        index: f.index,
        number: f.number,
        name: f.name,
        phaseIndexes: [...f.phaseIndexes],
        status: "phases_done" as const,
      })),
      completed: false,
    };
    state.phases[1].codexReview = {
      iterations: 4,
      outputLogPaths: ["feature-2-evidence.log"],
    } as any;
    state.phases[1].committedAt = "2026-05-18T00:00:00.000Z";

    // Orchestrator's FEATURE_NEEDS_PHASES path: append a review phase
    // under Feature 1 (NOT the last feature).
    const reviewBlock = `### Phase 1.review-1: Wire missing routes
- [ ] **Implementation**: wire the four route paths
- [ ] **Review**: confirm route ordering`;
    appendFeaturePhases({
      planFile,
      featureNumber: "1",
      phasesMd: reviewBlock,
    });

    // Re-parse the mutated plan — the parser walks top-to-bottom, so
    // Phase 1.review-1 lands at index 1 and Feature 2's Phase 2 shifts
    // from index 1 to index 2.
    const reparsedContent = fs.readFileSync(planFile, "utf8");
    const reparsed = parsePlan(reparsedContent, {});
    expect(reparsed.phases).toHaveLength(3);
    expect(reparsed.phases.map((p) => p.number)).toEqual([
      "1",
      "1.review-1",
      "2",
    ]);
    expect(reparsed.features[0].phaseIndexes).toEqual([0, 1]);
    expect(reparsed.features[1].phaseIndexes).toEqual([2]);

    // Reconcile state.phases against the reparsed plan.
    const { addedNumbers } = reconcileStatePhasesAfterReparse(
      state,
      reparsed.phases,
      reparsed.features,
    );

    expect(addedNumbers).toEqual(["1.review-1"]);

    // Assertion #1: Feature 1's new review phase is pending and indexed correctly.
    expect(state.phases[1].number).toBe("1.review-1");
    expect(state.phases[1].status).toBe("pending");
    expect(state.phases[1].index).toBe(1);

    // Assertion #2: Feature 2's runtime evidence survived the re-key.
    // (This is the bug-proving assertion — the old slice-tail merge
    // silently aliased the new review phase over this PhaseState.)
    expect(state.phases[2].number).toBe("2");
    expect(state.phases[2].status).toBe("committed");
    expect(state.phases[2].index).toBe(2);
    expect(state.phases[2].codexReview?.iterations).toBe(4);
    expect(state.phases[2].codexReview?.outputLogPaths).toEqual([
      "feature-2-evidence.log",
    ]);
    expect(state.phases[2].committedAt).toBe("2026-05-18T00:00:00.000Z");

    // Assertion #3: The inner phase-loop query (cli.ts:8824) lands on
    // the new review phase, not on a stale-aliased Feature 2 phase.
    const feature1State = state.features![0];
    feature1State.phaseIndexes = [...reparsed.features[0].phaseIndexes];
    feature1State.status = "running";
    const nextPhaseIdx = feature1State.phaseIndexes.find(
      (phaseIdx) => state.phases[phaseIdx]?.status !== "committed",
    );
    expect(nextPhaseIdx).toBe(1);
    expect(state.phases[nextPhaseIdx!].number).toBe("1.review-1");

    fs.rmSync(path.dirname(planFile), { recursive: true });
  });

  it("last-feature case still works (regression guard against over-correction)", () => {
    // When the target feature IS the last in the plan, appendFeaturePhases
    // appends at EOF. The reconciler must still behave correctly —
    // no over-shifting, no spurious adds.
    const initialPlan = `# Plan

## Feature 1: Only

### Phase 1: A
- [x] **Implementation**: a
- [x] **Review**: b
`;
    const planFile = writeTmpPlan(initialPlan);
    const initial = parsePlan(initialPlan, {});

    const state: BuildState = {
      slug: "merge-test-2",
      planFile,
      branch: "main",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 0,
      phases: initial.phases.map((p) => ({
        index: p.index,
        number: p.number,
        name: p.name,
        status: "committed" as const,
        kind: p.kind,
      })),
      features: initial.features.map((f) => ({
        index: f.index,
        number: f.number,
        name: f.name,
        phaseIndexes: [...f.phaseIndexes],
        status: "phases_done" as const,
      })),
      completed: false,
    };

    appendFeaturePhases({
      planFile,
      featureNumber: "1",
      phasesMd: `### Phase 1.review-1: Polish
- [ ] **Implementation**: polish
- [ ] **Review**: review polish`,
    });

    const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"), {});
    const { addedNumbers } = reconcileStatePhasesAfterReparse(
      state,
      reparsed.phases,
      reparsed.features,
    );

    expect(addedNumbers).toEqual(["1.review-1"]);
    expect(state.phases).toHaveLength(2);
    expect(state.phases[0].status).toBe("committed");
    expect(state.phases[1].number).toBe("1.review-1");
    expect(state.phases[1].status).toBe("pending");
    expect(state.features![0].phaseIndexes).toEqual([0, 1]);

    fs.rmSync(path.dirname(planFile), { recursive: true });
  });
});
