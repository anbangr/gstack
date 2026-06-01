import { describe, it, expect } from "bun:test";
import { parseArgs } from "../cli";

describe("cli args: plan-review flags (single-round)", () => {
  it("--plan-review-noninteractive=auto-reject parses to that mode", () => {
    const args = parseArgs([
      "plan.md",
      "--plan-review-noninteractive=auto-reject",
    ]);
    expect((args as any).planReviewNoninteractive).toBe("auto-reject");
  });

  it("--plan-review-noninteractive fail-fast (space form) parses identically", () => {
    const args = parseArgs([
      "plan.md",
      "--plan-review-noninteractive",
      "fail-fast",
    ]);
    expect((args as any).planReviewNoninteractive).toBe("fail-fast");
  });

  it("default planReviewNoninteractive is 'auto-accept'", () => {
    const args = parseArgs(["plan.md"]);
    expect((args as any).planReviewNoninteractive).toBe("auto-accept");
  });

  it("default noPlanReview is false (plan review runs by default)", () => {
    const args = parseArgs(["plan.md"]);
    expect((args as any).noPlanReview).toBe(false);
  });

  it("--no-plan-review parses to args.noPlanReview=true", () => {
    const args = parseArgs(["plan.md", "--no-plan-review"]);
    expect((args as any).noPlanReview).toBe(true);
  });

  it("rejects invalid noninteractive mode", () => {
    expect(() =>
      parseArgs(["plan.md", "--plan-review-noninteractive=bogus"]),
    ).toThrow();
  });

  it("removed multi-round flags no longer set fields", () => {
    // --legacy-plan-review / --plan-review-max-rounds / --plan-review-no-adaptive-cap
    // were removed when plan review became single-round. They no longer parse
    // into recognized args (treated as unknown flags, ignored or surfaced by
    // the generic handler — never set the old fields).
    const args = parseArgs(["plan.md"]);
    expect((args as any).legacyPlanReview).toBeUndefined();
    expect((args as any).planReviewMaxRounds).toBeUndefined();
    expect((args as any).planReviewNoAdaptiveCap).toBeUndefined();
  });
});
