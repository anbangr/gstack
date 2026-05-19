import { describe, it, expect } from "bun:test";
import type {
  PlanReviewVerdict,
  TriageDecision,
  ConvergenceSnapshot,
} from "../types";

describe("types: convergence extensions", () => {
  it("PlanReviewVerdict accepts optional triageDecisions field", () => {
    const v: PlanReviewVerdict = {
      verdict: "REVISE",
      objections: [],
      assessment: "",
      reviewedBy: "test",
      round: 1,
      triageDecisions: [
        { objectionIndex: 0, decision: "accept", rationale: "ok" },
      ],
      roundHistoryPath: "/tmp/history.jsonl",
      convergence: {
        objectionCountRaw: 1,
        objectionCountAccepted: 1,
        priorRoundAccepted: null,
        delta: null,
        reRaises: 0,
        newObjections: 1,
        noForwardProgress: false,
      },
    };
    expect(v.triageDecisions?.[0].decision).toBe("accept");
  });

  it("TriageDecision narrows the decision union", () => {
    const t: TriageDecision = { objectionIndex: 0, decision: "defer" };
    expect(t.decision).toBe("defer");
  });

  it("ConvergenceSnapshot has all expected fields", () => {
    const c: ConvergenceSnapshot = {
      objectionCountRaw: 5,
      objectionCountAccepted: 3,
      priorRoundAccepted: null,
      delta: null,
      reRaises: 0,
      newObjections: 5,
      noForwardProgress: false,
    };
    expect(c.objectionCountRaw).toBe(5);
  });
});
