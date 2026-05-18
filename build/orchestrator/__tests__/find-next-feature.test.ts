import { describe, it, expect } from "bun:test";
import {
  findNextFeatureIndex,
  isFeatureTerminal,
  allFeaturesReachedPhasesDone,
} from "../cli";
import type { BuildState, FeatureState } from "../types";

function feature(overrides: Partial<FeatureState> = {}): FeatureState {
  return {
    index: 0,
    number: "1",
    name: "Test Feature",
    phaseIndexes: [0],
    status: "pending",
    ...overrides,
  };
}

function state(features: FeatureState[]): BuildState {
  return {
    planFile: "plan.md",
    planBasename: "plan",
    slug: "test-slug",
    branch: "main",
    startedAt: "2026-05-08T00:00:00.000Z",
    lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    currentPhaseIndex: 0,
    currentFeatureIndex: 0,
    phases: [],
    features,
    completed: false,
  } as unknown as BuildState;
}

describe("findNextFeatureIndex", () => {
  it("returns first non-committed feature", () => {
    const s = state([
      feature({
        index: 0,
        status: "committed",
        completedAt: "2026-05-08T01:00:00.000Z",
      }),
      feature({ index: 1, number: "2", status: "pending" }),
      feature({ index: 2, number: "3", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(1);
  });

  it("returns -1 when all features are fully committed", () => {
    const s = state([
      feature({
        index: 0,
        status: "committed",
        completedAt: "2026-05-08T01:00:00.000Z",
      }),
      feature({
        index: 1,
        number: "2",
        status: "committed",
        completedAt: "2026-05-08T02:00:00.000Z",
      }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(-1);
  });

  it("does NOT skip a feature whose status is committed but completedAt is missing", () => {
    // Regression test: a manual JSON state patch can set status=committed
    // without going through ship+land+verify (no completedAt). The CLI
    // must re-process the feature, not silently skip it.
    const s = state([
      feature({
        index: 0,
        status: "committed",
        // no completedAt — simulates a manual patch
      }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(0);
  });

  it("skips origin_verified features when skipOriginVerified is true", () => {
    const s = state([
      feature({ index: 0, status: "origin_verified" }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s, { skipOriginVerified: true })).toBe(1);
    expect(findNextFeatureIndex(s, { skipOriginVerified: false })).toBe(0);
  });

  it("returns the manually-patched feature even when later features are also committed", () => {
    const s = state([
      feature({
        index: 0,
        status: "committed",
        // missing completedAt — manual patch
      }),
      feature({
        index: 1,
        number: "2",
        status: "committed",
        completedAt: "2026-05-08T02:00:00.000Z",
      }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(0);
  });

  it("skips a release_queued feature with shippedAt + prNumber", () => {
    const s = state([
      feature({
        index: 0,
        status: "release_queued",
        shippedAt: "2026-05-08T01:00:00.000Z",
        prNumber: 42,
      }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(1);
  });

  it("does NOT skip a release_queued feature missing prNumber", () => {
    const s = state([
      feature({
        index: 0,
        status: "release_queued",
        shippedAt: "2026-05-08T01:00:00.000Z",
        // no prNumber — simulates a manual patch
      }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s)).toBe(0);
  });

  it("skips phases_done features when skipPhasesDone is true (--ship-on-plan-complete defer path)", () => {
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(findNextFeatureIndex(s, { skipPhasesDone: true })).toBe(1);
    // Default behavior: don't skip phases_done (so the ship gate can fire).
    expect(findNextFeatureIndex(s)).toBe(0);
  });

  it("returns -1 when every feature is phases_done AND skipPhasesDone is true", () => {
    // Once allFeaturesReachedPhasesDone() flips true the caller stops
    // passing skipPhasesDone, so this case re-surfaces feature 0 for ship.
    // But while skipPhasesDone is still true (mid-loop), -1 means "nothing
    // left with phase work" — which is exactly what we want to terminate
    // the phase-execution loop and fall through to the ship pass.
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "phases_done" }),
    ]);
    expect(findNextFeatureIndex(s, { skipPhasesDone: true })).toBe(-1);
    expect(findNextFeatureIndex(s)).toBe(0);
  });
});

describe("allFeaturesReachedPhasesDone", () => {
  it("returns false when any feature is still pending", () => {
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "pending" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(false);
  });

  it("returns false when any feature is running", () => {
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "running" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(false);
  });

  it("returns false when any feature is in feature-review limbo", () => {
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "feature_review_running" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(false);
  });

  it("returns true when every feature reached phases_done", () => {
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "phases_done" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(true);
  });

  it("returns true when features are mixed phases_done / shipping / landed (all past gate)", () => {
    const s = state([
      feature({ index: 0, status: "landed" }),
      feature({ index: 1, number: "2", status: "shipping" }),
      feature({ index: 2, number: "3", status: "phases_done" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(true);
  });

  it("blocks the gate when any feature is failed (adversarial fix 3a)", () => {
    // A failed feature can leave the worktree dirty. Treating it as
    // "done" lets that dirt leak into sibling ships. Block the
    // deferred-ship gate so the user investigates. Features INDEXED
    // BEFORE the failed feature can still ship via the per-feature
    // outer loop; features after will not — safe default.
    const s = state([
      feature({ index: 0, status: "failed" }),
      feature({ index: 1, number: "2", status: "phases_done" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(false);
  });

  it("blocks the gate when any feature is paused (adversarial fix 3b)", () => {
    // Paused = a ship attempt failed mid-batch. Letting later features
    // ship while an earlier one is stuck would violate the
    // ship-in-feature-order invariant. User must triage first.
    const s = state([
      feature({ index: 0, status: "phases_done" }),
      feature({ index: 1, number: "2", status: "paused" }),
    ]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(false);
  });

  it("returns false for an empty feature list", () => {
    // Defensive: no features means there's nothing to ship anyway, but
    // returning true would risk firing the deferred-ship pass on a
    // genuinely empty plan. Stay false.
    const s = state([]);
    expect(allFeaturesReachedPhasesDone(s)).toBe(false);
  });
});

describe("isFeatureTerminal", () => {
  it("returns true for committed with completedAt", () => {
    expect(
      isFeatureTerminal(
        feature({
          status: "committed",
          completedAt: "2026-05-08T01:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("returns false for committed without completedAt", () => {
    expect(isFeatureTerminal(feature({ status: "committed" }))).toBe(false);
  });

  it("returns true for release_queued with shippedAt + prNumber", () => {
    expect(
      isFeatureTerminal(
        feature({
          status: "release_queued",
          shippedAt: "2026-05-08T01:00:00.000Z",
          prNumber: 42,
        }),
      ),
    ).toBe(true);
  });

  it("returns false for release_queued missing prNumber", () => {
    expect(
      isFeatureTerminal(
        feature({
          status: "release_queued",
          shippedAt: "2026-05-08T01:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("returns false for release_queued missing shippedAt", () => {
    expect(
      isFeatureTerminal(feature({ status: "release_queued", prNumber: 42 })),
    ).toBe(false);
  });

  it("returns false for non-terminal statuses", () => {
    expect(isFeatureTerminal(feature({ status: "pending" }))).toBe(false);
    expect(isFeatureTerminal(feature({ status: "phases_done" }))).toBe(false);
  });
});
