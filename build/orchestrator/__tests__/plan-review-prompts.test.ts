import { describe, it, expect } from "bun:test";
import {
  PLAN_REVIEW_PROMPT,
  SYNTH_REVISION_PROMPT,
} from "../plan-reviewer";

describe("PLAN_REVIEW_PROMPT (reviewer)", () => {
  it("contains the original review criteria", () => {
    expect(PLAN_REVIEW_PROMPT).toContain("COMPLETENESS");
    expect(PLAN_REVIEW_PROMPT).toContain("FEASIBILITY");
    expect(PLAN_REVIEW_PROMPT).toContain("PLAN_REVIEW: APPROVE | REVISE");
  });

  it("teaches the reviewer to read prior-round annotations", () => {
    expect(PLAN_REVIEW_PROMPT).toContain("ROUND 1 USER: accept");
    expect(PLAN_REVIEW_PROMPT).toContain("USER: reject");
    expect(PLAN_REVIEW_PROMPT).toContain("RESOLUTION");
    expect(PLAN_REVIEW_PROMPT).toContain("do NOT re-raise");
  });

  it("snapshot — fails if prompt drifts", () => {
    expect(PLAN_REVIEW_PROMPT).toMatchSnapshot();
  });
});

describe("SYNTH_REVISION_PROMPT (synthesizer)", () => {
  it("instructs the synth to address only USER:accept items", () => {
    expect(SYNTH_REVISION_PROMPT).toContain("USER: accept");
    expect(SYNTH_REVISION_PROMPT).toContain("RESOLUTION: pending");
    expect(SYNTH_REVISION_PROMPT).toContain("Do NOT address objections the user rejected");
  });

  it("supports the disputed escape hatch", () => {
    expect(SYNTH_REVISION_PROMPT).toContain("RESOLUTION: disputed");
  });

  it("preserves the one-phase two-gate contract for non-code phases", () => {
    expect(SYNTH_REVISION_PROMPT).toContain("Do NOT split a non-code phase");
    expect(SYNTH_REVISION_PROMPT).toContain("[writing]");
    expect(SYNTH_REVISION_PROMPT).toContain("**Draft**");
    expect(SYNTH_REVISION_PROMPT).toContain("**Review**");
    expect(SYNTH_REVISION_PROMPT).toContain("one phase");
  });

  it("snapshot — fails if prompt drifts", () => {
    expect(SYNTH_REVISION_PROMPT).toMatchSnapshot();
  });
});
