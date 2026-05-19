import { describe, it, expect } from "bun:test";
import {
  computeConvergenceSnapshot,
  shouldBailAdaptive,
  type AdaptiveCapDecision,
} from "../plan-review-loop";
import type { PlanReviewObjection } from "../types";
import type { RoundAnnotation } from "../plan-reviewer";

const crit = (location: string, issue = "x"): PlanReviewObjection => ({
  severity: "CRITICAL",
  location,
  issue,
  suggestion: "y",
});

describe("computeConvergenceSnapshot", () => {
  it("round 1: priorRoundAccepted null, delta null, no reRaises, all new", () => {
    const snap = computeConvergenceSnapshot({
      round: 1,
      rawObjections: [crit("F1, P1"), crit("F1, P2"), crit("F1, P3")],
      acceptedIndices: [0, 1, 2],
      priorAnnotations: [],
    });
    expect(snap.priorRoundAccepted).toBeNull();
    expect(snap.delta).toBeNull();
    expect(snap.reRaises).toBe(0);
    expect(snap.newObjections).toBe(3);
    expect(snap.noForwardProgress).toBe(false);
  });

  it("round 2 with all new objections: reRaises=0, noForwardProgress=false", () => {
    const prior: RoundAnnotation[] = [
      {
        location: "F1, P1",
        severity: "CRITICAL",
        issue: "old",
        suggestion: "fix",
        rounds: [
          { round: 1, userDecision: "accept", resolution: "fixed in synth" },
        ],
      },
    ];
    const snap = computeConvergenceSnapshot({
      round: 2,
      rawObjections: [crit("F1, P2"), crit("F1, P3"), crit("F1, P4")],
      acceptedIndices: [0, 1, 2],
      priorAnnotations: prior,
    });
    expect(snap.reRaises).toBe(0);
    expect(snap.newObjections).toBe(3);
    expect(snap.noForwardProgress).toBe(false);
  });

  it("round 2 with all re-raises and zero new: noForwardProgress=true", () => {
    const prior: RoundAnnotation[] = [
      {
        location: "F1, P1",
        severity: "CRITICAL",
        issue: "x",
        suggestion: "y",
        rounds: [{ round: 1, userDecision: "accept", resolution: "synth fixed" }],
      },
      {
        location: "F1, P2",
        severity: "CRITICAL",
        issue: "x",
        suggestion: "y",
        rounds: [{ round: 1, userDecision: "accept", resolution: "synth fixed" }],
      },
    ];
    const snap = computeConvergenceSnapshot({
      round: 2,
      rawObjections: [crit("F1, P1"), crit("F1, P2")],
      acceptedIndices: [0, 1],
      priorAnnotations: prior,
    });
    expect(snap.reRaises).toBe(2);
    expect(snap.newObjections).toBe(0);
    expect(snap.noForwardProgress).toBe(true);
  });

  it("does NOT count rejected-prior-round entries as re-raises (those are user rejections, not synth fix failures)", () => {
    const prior: RoundAnnotation[] = [
      {
        location: "F1, P1",
        severity: "CRITICAL",
        issue: "x",
        suggestion: "y",
        rounds: [{ round: 1, userDecision: "reject", userRationale: "no" }],
      },
    ];
    const snap = computeConvergenceSnapshot({
      round: 2,
      rawObjections: [crit("F1, P1")],
      acceptedIndices: [0],
      priorAnnotations: prior,
    });
    expect(snap.reRaises).toBe(0);
    expect(snap.newObjections).toBe(1);
    expect(snap.noForwardProgress).toBe(false);
  });
});

describe("shouldBailAdaptive", () => {
  it("round 1 never bails", () => {
    const d: AdaptiveCapDecision = shouldBailAdaptive({
      round: 1,
      maxRounds: 5,
      adaptiveEnabled: true,
      acceptedCount: 3,
      priorAcceptedCount: null,
      reRaises: 0,
      newObjections: 3,
    });
    expect(d.action).toBe("continue");
  });

  it("round 2, all re-raises, zero new: bail with adaptive_cap_re_raises_only", () => {
    const d = shouldBailAdaptive({
      round: 2, maxRounds: 5, adaptiveEnabled: true,
      acceptedCount: 2, priorAcceptedCount: 2, reRaises: 2, newObjections: 0,
    });
    expect(d.action).toBe("bail_out_gate");
    expect(d.exitReason).toBe("adaptive_cap_re_raises_only");
  });

  it("round 3, count increased: bail with adaptive_cap_regression", () => {
    const d = shouldBailAdaptive({
      round: 3, maxRounds: 5, adaptiveEnabled: true,
      acceptedCount: 5, priorAcceptedCount: 3, reRaises: 0, newObjections: 5,
    });
    expect(d.action).toBe("bail_out_gate");
    expect(d.exitReason).toBe("adaptive_cap_regression");
  });

  it("round 2, mostly re-raises but one new objection: continue", () => {
    const d = shouldBailAdaptive({
      round: 2, maxRounds: 5, adaptiveEnabled: true,
      acceptedCount: 3, priorAcceptedCount: 3, reRaises: 2, newObjections: 1,
    });
    expect(d.action).toBe("continue");
  });

  it("MAX_ROUNDS reached: stalemate regardless of state", () => {
    const d = shouldBailAdaptive({
      round: 5, maxRounds: 5, adaptiveEnabled: true,
      acceptedCount: 2, priorAcceptedCount: 3, reRaises: 0, newObjections: 2,
    });
    expect(d.action).toBe("stalemate_gate");
    expect(d.exitReason).toBe("max_rounds_hit");
  });

  it("adaptive disabled: count regression does NOT bail", () => {
    const d = shouldBailAdaptive({
      round: 3, maxRounds: 5, adaptiveEnabled: false,
      acceptedCount: 5, priorAcceptedCount: 3, reRaises: 0, newObjections: 5,
    });
    expect(d.action).toBe("continue");
  });
});
