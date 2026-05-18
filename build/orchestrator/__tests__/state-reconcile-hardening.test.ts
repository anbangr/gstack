/**
 * Hardening tests for the FEATURE_NEEDS_PHASES reconciler.
 *
 * PR #42 landed `reconcileStatePhasesAfterReparse` (state.ts) and its
 * cli.ts call-site. This file covers three additive hardening pieces:
 *
 *  1. Parser-side duplicate-number rejection. The reconciler's JSDoc
 *     claimed phase numbers are "unique within a plan because the
 *     parser rejects duplicate headings" — but the parser does NOT
 *     dedupe. The reconciler now throws on duplicates from either side.
 *  2. State-side duplicate-number rejection. A pre-fix gstack version's
 *     slice-tail merge could leave a duplicate in state.phases on disk.
 *     The reconciler throws rather than silently dropping the earlier
 *     entry's runtime state via Map last-write-wins.
 *  3. `arePhasesAligned` predicate covering both phases AND features —
 *     used by the cli.ts fail-closed resume guard. Feature-only drift
 *     (user renamed a `## Feature N:` heading between runs) must
 *     trigger the guard, not slip past.
 *
 * These tests use the same minimal scaffolding as state-reconcile.test.ts.
 */

import { describe, it, expect } from "bun:test";
import { reconcileStatePhasesAfterReparse, arePhasesAligned } from "../state";
import type { BuildState, Feature, Phase, PhaseState } from "../types";

function mkPhase(opts: {
  index: number;
  number: string;
  featureIndex: number;
  featureNumber: string;
  name?: string;
}): Phase {
  return {
    index: opts.index,
    number: opts.number,
    name: opts.name ?? `Phase ${opts.number}`,
    featureIndex: opts.featureIndex,
    featureNumber: opts.featureNumber,
    featureName: `Feature ${opts.featureNumber}`,
    testSpecDone: true,
    implementationDone: false,
    reviewDone: false,
    body: "",
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: -1,
    reviewCheckboxLine: -1,
    kind: "code",
    dualImpl: false,
    auditOnly: false,
  };
}

function mkFeature(opts: {
  index: number;
  number: string;
  phaseIndexes: number[];
}): Feature {
  return {
    index: opts.index,
    number: opts.number,
    name: `Feature ${opts.number}`,
    body: "",
    phaseIndexes: opts.phaseIndexes,
  };
}

function mkPhaseState(p: Phase, status: PhaseState["status"]): PhaseState {
  return {
    index: p.index,
    number: p.number,
    name: p.name,
    status,
    kind: p.kind,
  };
}

function mkState(args: {
  phases: PhaseState[];
  features: Feature[];
  currentPhaseIndex?: number;
}): BuildState {
  return {
    slug: "test-slug",
    planFile: "/tmp/plan.md",
    branch: "test",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    currentPhaseIndex: args.currentPhaseIndex ?? 0,
    phases: args.phases,
    features: args.features.map((f) => ({
      index: f.index,
      number: f.number,
      name: f.name,
      phaseIndexes: [...f.phaseIndexes],
      status: "running" as const,
    })),
    completed: false,
  } as BuildState;
}

describe("reconcileStatePhasesAfterReparse — duplicate-number defense", () => {
  it("throws when the re-parsed plan contains a duplicate phase number", () => {
    // Realistic scenario: a feature reviewer's LLM emits the same
    // `### Phase 1.review-1` heading twice in additionalPhasesMd, and the
    // parser passes both through. By-number Map would alias the same
    // PhaseState into two array slots — status writes on one would
    // mutate both.
    const p1 = mkPhase({
      index: 0,
      number: "1",
      featureIndex: 0,
      featureNumber: "1",
    });
    const oldFeature = mkFeature({ index: 0, number: "1", phaseIndexes: [0] });
    const state = mkState({
      phases: [mkPhaseState(p1, "committed")],
      features: [oldFeature],
    });

    const reparsedPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
      // Duplicate of "1.review-1" — should throw.
      mkPhase({
        index: 2,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
    ];
    const reparsedFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1, 2] }),
    ];

    expect(() =>
      reconcileStatePhasesAfterReparse(state, reparsedPhases, reparsedFeatures),
    ).toThrow(/duplicate phase number "1\.review-1"/);
  });

  it("throws BEFORE mutating state when the parser-side duplicate is detected", () => {
    // Defense must fail closed before any state.phases / .features mutation.
    // If the reconciler started rebuilding and threw mid-way, state would
    // be half-merged and saveState would persist a corrupt array.
    const p1 = mkPhase({
      index: 0,
      number: "1",
      featureIndex: 0,
      featureNumber: "1",
    });
    const oldFeature = mkFeature({ index: 0, number: "1", phaseIndexes: [0] });
    const state = mkState({
      phases: [mkPhaseState(p1, "committed")],
      features: [oldFeature],
    });
    const phasesBefore = state.phases;
    const featuresBefore = state.features;

    const reparsedPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
      mkPhase({
        index: 2,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
    ];
    const reparsedFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1, 2] }),
    ];

    expect(() =>
      reconcileStatePhasesAfterReparse(state, reparsedPhases, reparsedFeatures),
    ).toThrow();

    // state references and their content remain pristine.
    expect(state.phases).toBe(phasesBefore);
    expect(state.features).toBe(featuresBefore);
    expect(state.phases.length).toBe(1);
    expect(state.phases[0].status).toBe("committed");
  });

  it("throws when state.phases contains a duplicate phase number (pre-fix corruption)", () => {
    // Scenario: pre-fix gstack-build's slice-tail merge pushed a
    // duplicate of the actually-last phase onto state.phases. The state
    // is then loaded by a fixed gstack and an in-run FEATURE_NEEDS_PHASES
    // path tries to reconcile — but the duplicate means byNumber Map
    // would silently last-write-wins and drop the earlier entry's
    // runtime state. The reconciler now refuses; the cli.ts catch
    // block surfaces the corruption via BLOCKED-feature-N.md.
    const p1 = mkPhase({
      index: 0,
      number: "1",
      featureIndex: 0,
      featureNumber: "1",
    });
    const oldFeature = mkFeature({
      index: 0,
      number: "1",
      phaseIndexes: [0, 1],
    });
    const state = mkState({
      phases: [
        mkPhaseState(p1, "committed"),
        // Hand-rolled duplicate at index 1.
        {
          index: 1,
          number: "1",
          name: "duplicate phase 1",
          status: "pending",
          kind: "code",
        },
      ],
      features: [oldFeature],
    });

    const reparsedPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
    ];
    const reparsedFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0] }),
    ];

    expect(() =>
      reconcileStatePhasesAfterReparse(state, reparsedPhases, reparsedFeatures),
    ).toThrow(/state\.phases contains duplicate phase number "1"/);
  });
});

describe("arePhasesAligned — resume-time drift predicate", () => {
  it("returns true when phases and features match the parser by index and number", () => {
    const f1 = mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] });
    const f2 = mkFeature({ index: 1, number: "2", phaseIndexes: [2] });
    const phases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
      mkPhase({ index: 2, number: "2.1", featureIndex: 1, featureNumber: "2" }),
    ];
    const state = mkState({
      phases: phases.map((p) => mkPhaseState(p, "pending")),
      features: [f1, f2],
    });

    expect(arePhasesAligned(state, { phases, features: [f1, f2] })).toBe(true);
  });

  it("returns false when phase count disagrees", () => {
    const f1 = mkFeature({ index: 0, number: "1", phaseIndexes: [0] });
    const onePhase = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
    ];
    const state = mkState({
      phases: onePhase.map((p) => mkPhaseState(p, "pending")),
      features: [f1],
    });

    const twoPhases = [
      ...onePhase,
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
    ];
    expect(arePhasesAligned(state, { phases: twoPhases, features: [f1] })).toBe(
      false,
    );
  });

  it("returns false when a per-index phase number disagrees (the pre-fix bug shape)", () => {
    // Original bug: parser inserted "1.review-1" at index 1, shifting
    // "2.1" from index 1 to index 2. state.phases still has "2.1" at
    // index 1 (slice-tail merge mis-aligned downstream). Resume must
    // detect this.
    const f1 = mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] });
    const f2 = mkFeature({ index: 1, number: "2", phaseIndexes: [2] });
    const stalePhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({ index: 1, number: "2.1", featureIndex: 1, featureNumber: "2" }),
      mkPhase({ index: 2, number: "2.2", featureIndex: 1, featureNumber: "2" }),
    ];
    const state = mkState({
      phases: stalePhases.map((p) => mkPhaseState(p, "pending")),
      features: [f1, f2],
    });

    const freshPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
      mkPhase({ index: 2, number: "2.1", featureIndex: 1, featureNumber: "2" }),
    ];
    expect(
      arePhasesAligned(state, { phases: freshPhases, features: [f1, f2] }),
    ).toBe(false);
  });

  it("returns false when feature count disagrees even though phase count matches", () => {
    const f1 = mkFeature({ index: 0, number: "1", phaseIndexes: [0] });
    const phases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
    ];
    const state = mkState({
      phases: phases.map((p) => mkPhaseState(p, "pending")),
      features: [f1],
    });

    const f1Same = mkFeature({ index: 0, number: "1", phaseIndexes: [0] });
    const f2New = mkFeature({ index: 1, number: "2", phaseIndexes: [] });
    expect(arePhasesAligned(state, { phases, features: [f1Same, f2New] })).toBe(
      false,
    );
  });

  it("returns false when feature numbers disagree at the same index (user-renamed heading)", () => {
    // User edited the plan to renumber Feature 1 → Feature 2 without
    // changing phase headings. Phase count still matches, but
    // state.features[0].number ("1") disagrees with parsed.features[0]
    // .number ("2"). Resume must catch this — downstream code reads
    // `state.features[featureIndex]` and would update the WRONG
    // FeatureState.
    const phases = [
      mkPhase({ index: 0, number: "9.9", featureIndex: 0, featureNumber: "2" }),
    ];
    const stateFeature = mkFeature({
      index: 0,
      number: "1",
      phaseIndexes: [0],
    });
    const state = mkState({
      phases: phases.map((p) => mkPhaseState(p, "pending")),
      features: [stateFeature],
    });

    const parsedFeature = mkFeature({
      index: 0,
      number: "2",
      phaseIndexes: [0],
    });
    expect(arePhasesAligned(state, { phases, features: [parsedFeature] })).toBe(
      false,
    );
  });

  it("tolerates undefined state.features (treats as length 0)", () => {
    // Defensive: a malformed state.json with `features: undefined`
    // shouldn't NPE the predicate. Treat as length 0 — alignment fails
    // whenever the parsed plan has any features.
    const phases: Phase[] = [];
    const state = mkState({
      phases: [],
      features: [],
    });
    // Hand-rolled undefined features (the helper would default to []).
    (state as unknown as { features: undefined }).features = undefined;

    // Empty-on-both-sides is genuinely aligned — no NPE on undefined.
    expect(arePhasesAligned(state, { phases, features: [] })).toBe(true);
    // But parsed plan with any feature drifts against undefined state.features.
    expect(
      arePhasesAligned(state, {
        phases,
        features: [mkFeature({ index: 0, number: "1", phaseIndexes: [] })],
      }),
    ).toBe(false);
  });
});
