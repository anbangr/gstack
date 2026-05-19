import { describe, it, expect } from "bun:test";
import type {
  PlanReviewVerdict,
  TriageDecision,
  ConvergenceSnapshot,
} from "../types";

describe("types: convergence extensions", () => {
  it("PlanReviewVerdict accepts optional triage_decisions field", () => {
    const v: PlanReviewVerdict = {
      verdict: "REVISE",
      objections: [],
      assessment: "",
      reviewedBy: "test",
      round: 1,
      triage_decisions: [
        { objection_index: 0, decision: "accept", rationale: "ok" },
      ],
      round_history_path: "/tmp/history.jsonl",
      convergence: {
        objection_count_raw: 1,
        objection_count_accepted: 1,
        prior_round_accepted: null,
        delta: null,
        re_raises: 0,
        new_objections: 1,
        no_forward_progress: false,
      },
    };
    expect(v.triage_decisions?.[0].decision).toBe("accept");
  });

  it("TriageDecision narrows the decision union", () => {
    const t: TriageDecision = { objection_index: 0, decision: "defer" };
    expect(t.decision).toBe("defer");
  });

  it("ConvergenceSnapshot has all expected fields", () => {
    const c: ConvergenceSnapshot = {
      objection_count_raw: 5,
      objection_count_accepted: 3,
      prior_round_accepted: null,
      delta: null,
      re_raises: 0,
      new_objections: 5,
      no_forward_progress: false,
    };
    expect(c.objection_count_raw).toBe(5);
  });
});
