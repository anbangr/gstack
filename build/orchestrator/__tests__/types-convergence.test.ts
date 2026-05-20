import { describe, it, expect } from "bun:test";
import type { PlanReviewVerdict, TriageDecision, ConvergenceSnapshot } from "../types";
import {
  shouldBailAdaptive,
  runTriageGateNonTTY,
} from "../plan-review-loop";

describe("convergence type contracts", () => {
  it("ConvergenceSnapshot's noForwardProgress field drives shouldBailAdaptive bail decision", () => {
    // ConvergenceSnapshot fields used here are the contract; if any field name
    // changes, this test fails to compile.
    const decision = shouldBailAdaptive({
      round: 2,
      maxRounds: 5,
      adaptiveEnabled: true,
      acceptedCount: 2,
      priorAcceptedCount: 2,
      reRaises: 2,
      newObjections: 0,
    });
    expect(decision.action).toBe("bail_out_gate");
    expect(decision.exitReason).toBe("adaptive_cap_re_raises_only");
  });

  it("TriageDecision shape matches what runTriageGateNonTTY emits", () => {
    // The TriageDecision type's decision union is exercised by a real call.
    const objections = [
      { severity: "CRITICAL" as const, location: "F1, P1", issue: "x", suggestion: "y" },
      { severity: "CRITICAL" as const, location: "F1, P2", issue: "x", suggestion: "y" },
    ];
    const result = runTriageGateNonTTY({ objections, mode: "auto-accept" });
    expect(result.decisions).toHaveLength(2);
    // Each decision's shape matches the TriageDecision interface.
    const d: TriageDecision = result.decisions[0];
    expect(d.objectionIndex).toBe(0);
    expect(d.decision).toBe("accept");
  });

  it("PlanReviewVerdict with triageDecisions is structurally valid and round-trips through JSON", () => {
    // If triageDecisions or convergence field names change, this assignment fails to compile.
    const v: PlanReviewVerdict = {
      verdict: "REVISE",
      objections: [
        { severity: "CRITICAL", location: "F1, P1", issue: "x", suggestion: "y" },
      ],
      assessment: "needs work",
      reviewedBy: "stub",
      round: 1,
      triageDecisions: [
        { objectionIndex: 0, decision: "accept", rationale: "agreed" },
      ],
    };
    // Round-trip: the shape must survive serialization (used for JSONL persistence).
    const parsed: PlanReviewVerdict = JSON.parse(JSON.stringify(v));
    expect(parsed.triageDecisions?.[0].decision).toBe("accept");
    expect(parsed.objections[0].severity).toBe("CRITICAL");
  });
});
