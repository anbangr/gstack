import { describe, it, expect } from "bun:test";
import {
  runTriageGateNonTTY,
  type NonInteractiveMode,
} from "../plan-review-loop";
import type { PlanReviewObjection } from "../types";

const objs: PlanReviewObjection[] = [
  { severity: "CRITICAL", location: "F1, P1", issue: "x", suggestion: "y" },
  { severity: "CRITICAL", location: "F1, P2", issue: "x", suggestion: "y" },
];

describe("runTriageGateNonTTY", () => {
  it("auto-accept marks all as accepted", () => {
    const r = runTriageGateNonTTY({ objections: objs, mode: "auto-accept" });
    expect(r.decisions).toHaveLength(2);
    expect(r.decisions.every((d) => d.decision === "accept")).toBe(true);
    expect(r.shouldFailFast).toBe(false);
  });

  it("auto-reject marks all as rejected", () => {
    const r = runTriageGateNonTTY({ objections: objs, mode: "auto-reject" });
    expect(r.decisions.every((d) => d.decision === "reject")).toBe(true);
    expect(r.shouldFailFast).toBe(false);
  });

  it("fail-fast returns empty decisions and shouldFailFast=true", () => {
    const r = runTriageGateNonTTY({ objections: objs, mode: "fail-fast" });
    expect(r.decisions).toEqual([]);
    expect(r.shouldFailFast).toBe(true);
  });

  it("empty objection list returns no decisions for all modes", () => {
    for (const mode of ["auto-accept", "auto-reject", "fail-fast"] as NonInteractiveMode[]) {
      const r = runTriageGateNonTTY({ objections: [], mode });
      expect(r.decisions).toEqual([]);
      // fail-fast still won't fire if there are no objections.
      expect(r.shouldFailFast).toBe(false);
    }
  });
});
