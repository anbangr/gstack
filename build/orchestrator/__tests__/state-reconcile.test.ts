import { describe, it, expect } from "bun:test";
import { reconcileStatePhasesAfterReparse } from "../state";
import type { BuildState, Feature, Phase, PhaseState } from "../types";

// Minimal helpers to build Phase/PhaseState/Feature/BuildState fixtures
// without hand-rolling every required field. Tests only exercise the
// fields the reconciler touches; everything else stays inert.

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

describe("reconcileStatePhasesAfterReparse", () => {
  it("preserves runtime state for unchanged phases and adds new phase at the end (last-feature case)", () => {
    // BEFORE: single feature with two phases, both committed.
    const f1Old = mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] });
    const oldPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({ index: 1, number: "2", featureIndex: 0, featureNumber: "1" }),
    ];
    const state = mkState({
      phases: [
        mkPhaseState(oldPhases[0], "committed"),
        mkPhaseState(oldPhases[1], "committed"),
      ],
      features: [f1Old],
    });
    // Inflate some runtime state we want preserved across reconcile.
    state.phases[0].codexReview = { iterations: 2, outputLogPaths: [] } as any;
    state.phases[1].gemini = { retries: 3 } as any;

    // AFTER: same plan with Phase 1.review-1 appended under Feature 1 (last feature → end-of-array).
    const newPhases = [
      ...oldPhases,
      mkPhase({
        index: 2,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
    ];
    const newFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1, 2] }),
    ];

    const result = reconcileStatePhasesAfterReparse(
      state,
      newPhases,
      newFeatures,
    );

    expect(result.addedNumbers).toEqual(["1.review-1"]);
    expect(state.phases).toHaveLength(3);
    // Runtime state for phases 1 and 2 was preserved.
    expect(state.phases[0].status).toBe("committed");
    expect(state.phases[0].codexReview?.iterations).toBe(2);
    expect(state.phases[1].status).toBe("committed");
    expect(state.phases[1].gemini?.retries).toBe(3);
    // New phase has pending status and the parser-assigned index.
    expect(state.phases[2].number).toBe("1.review-1");
    expect(state.phases[2].status).toBe("pending");
    expect(state.phases[2].index).toBe(2);
    // featureState.phaseIndexes was rebuilt to include the new phase.
    expect(state.features?.[0].phaseIndexes).toEqual([0, 1, 2]);
  });

  it("preserves Feature 2's runtime state when Feature 1 gets a mid-array review phase inserted (THIS IS THE BUG)", () => {
    // BEFORE: Feature 1 has one committed phase; Feature 2 has one committed phase.
    // This is the multi-feature scenario the old slice-tail merge silently broke.
    const oldPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({ index: 1, number: "2", featureIndex: 1, featureNumber: "2" }),
    ];
    const state = mkState({
      phases: [
        mkPhaseState(oldPhases[0], "committed"),
        mkPhaseState(oldPhases[1], "committed"),
      ],
      features: [
        mkFeature({ index: 0, number: "1", phaseIndexes: [0] }),
        mkFeature({ index: 1, number: "2", phaseIndexes: [1] }),
      ],
    });
    // Mark Feature 2's phase with distinctive runtime evidence we'll
    // verify is preserved across the reconcile.
    state.phases[1].codexReview = {
      iterations: 5,
      outputLogPaths: ["feature-2-evidence"],
    } as any;
    state.phases[1].committedAt = "2026-01-01T00:00:00.000Z";

    // AFTER: appendFeaturePhases inserted Phase 1.review-1 BEFORE Feature 2's heading.
    // Parser now produces:
    //   index 0 → Phase 1 (Feature 1)         — unchanged
    //   index 1 → Phase 1.review-1 (Feature 1) — NEW
    //   index 2 → Phase 2 (Feature 2)          — SHIFTED from index 1 → 2
    const newPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
      mkPhase({ index: 2, number: "2", featureIndex: 1, featureNumber: "2" }),
    ];
    const newFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] }),
      mkFeature({ index: 1, number: "2", phaseIndexes: [2] }),
    ];

    const result = reconcileStatePhasesAfterReparse(
      state,
      newPhases,
      newFeatures,
    );

    expect(result.addedNumbers).toEqual(["1.review-1"]);
    expect(state.phases).toHaveLength(3);

    // Phase 1 (Feature 1) — unchanged.
    expect(state.phases[0].number).toBe("1");
    expect(state.phases[0].status).toBe("committed");

    // Phase 1.review-1 — new, pending.
    expect(state.phases[1].number).toBe("1.review-1");
    expect(state.phases[1].status).toBe("pending");
    expect(state.phases[1].index).toBe(1);

    // Phase 2 (Feature 2) — SHIFTED to index 2, but runtime state preserved.
    // This is the bug-proving assertion: the old slice-tail merge corrupted
    // this PhaseState entirely.
    expect(state.phases[2].number).toBe("2");
    expect(state.phases[2].status).toBe("committed");
    expect(state.phases[2].index).toBe(2);
    expect(state.phases[2].codexReview?.iterations).toBe(5);
    expect(state.phases[2].codexReview?.outputLogPaths).toEqual([
      "feature-2-evidence",
    ]);
    expect(state.phases[2].committedAt).toBe("2026-01-01T00:00:00.000Z");

    // Feature 1 phaseIndexes: [0, 1]; Feature 2 phaseIndexes: [2].
    expect(state.features?.[0].phaseIndexes).toEqual([0, 1]);
    expect(state.features?.[1].phaseIndexes).toEqual([2]);
  });

  it("handles a second review append (review-2 after review-1) without losing review-1 state", () => {
    // BEFORE: Feature 1 with Phase 1 (committed) and Phase 1.review-1 (committed).
    const oldPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
    ];
    const state = mkState({
      phases: [
        mkPhaseState(oldPhases[0], "committed"),
        mkPhaseState(oldPhases[1], "committed"),
      ],
      features: [mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] })],
    });
    state.phases[1].committedAt = "2026-01-02T00:00:00.000Z";

    // AFTER: Phase 1.review-2 appended.
    const newPhases = [
      ...oldPhases,
      mkPhase({
        index: 2,
        number: "1.review-2",
        featureIndex: 0,
        featureNumber: "1",
      }),
    ];
    const newFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1, 2] }),
    ];

    const result = reconcileStatePhasesAfterReparse(
      state,
      newPhases,
      newFeatures,
    );

    expect(result.addedNumbers).toEqual(["1.review-2"]);
    expect(state.phases[1].number).toBe("1.review-1");
    expect(state.phases[1].status).toBe("committed");
    expect(state.phases[1].committedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(state.phases[2].number).toBe("1.review-2");
    expect(state.phases[2].status).toBe("pending");
  });

  it("is a no-op when the re-parsed plan matches the state phases by number", () => {
    const oldPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({ index: 1, number: "2", featureIndex: 1, featureNumber: "2" }),
    ];
    const state = mkState({
      phases: [
        mkPhaseState(oldPhases[0], "committed"),
        mkPhaseState(oldPhases[1], "running"),
      ],
      features: [
        mkFeature({ index: 0, number: "1", phaseIndexes: [0] }),
        mkFeature({ index: 1, number: "2", phaseIndexes: [1] }),
      ],
    });
    const beforeJson = JSON.stringify(state);

    const result = reconcileStatePhasesAfterReparse(state, oldPhases, [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0] }),
      mkFeature({ index: 1, number: "2", phaseIndexes: [1] }),
    ]);

    expect(result.addedNumbers).toEqual([]);
    expect(JSON.stringify(state)).toBe(beforeJson);
  });

  it("fails closed when a phase present in state is missing from the re-parsed plan", () => {
    const oldPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({ index: 1, number: "2", featureIndex: 0, featureNumber: "1" }),
    ];
    const state = mkState({
      phases: [
        mkPhaseState(oldPhases[0], "committed"),
        mkPhaseState(oldPhases[1], "running"),
      ],
      features: [mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] })],
    });

    // Re-parsed plan has only Phase 1 — Phase 2 disappeared.
    const newPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
    ];
    const newFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0] }),
    ];

    expect(() =>
      reconcileStatePhasesAfterReparse(state, newPhases, newFeatures),
    ).toThrow(/missing from re-parsed plan: 2/);
  });

  it("chases currentPhaseIndex forward by phase number across a mid-array insert", () => {
    // Mid-array insert means Feature 2's Phase 2 shifts from index 1 to index 2.
    // currentPhaseIndex (pointing at Phase 2) must follow.
    const oldPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({ index: 1, number: "2", featureIndex: 1, featureNumber: "2" }),
    ];
    const state = mkState({
      phases: [
        mkPhaseState(oldPhases[0], "committed"),
        mkPhaseState(oldPhases[1], "running"),
      ],
      features: [
        mkFeature({ index: 0, number: "1", phaseIndexes: [0] }),
        mkFeature({ index: 1, number: "2", phaseIndexes: [1] }),
      ],
      currentPhaseIndex: 1, // Phase 2
    });

    const newPhases = [
      mkPhase({ index: 0, number: "1", featureIndex: 0, featureNumber: "1" }),
      mkPhase({
        index: 1,
        number: "1.review-1",
        featureIndex: 0,
        featureNumber: "1",
      }),
      mkPhase({ index: 2, number: "2", featureIndex: 1, featureNumber: "2" }),
    ];
    const newFeatures = [
      mkFeature({ index: 0, number: "1", phaseIndexes: [0, 1] }),
      mkFeature({ index: 1, number: "2", phaseIndexes: [2] }),
    ];

    reconcileStatePhasesAfterReparse(state, newPhases, newFeatures);

    expect(state.currentPhaseIndex).toBe(2);
    expect(state.phases[state.currentPhaseIndex!].number).toBe("2");
  });
});
