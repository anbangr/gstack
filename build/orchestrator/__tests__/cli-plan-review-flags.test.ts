import { describe, it, expect } from "bun:test";
import { parseArgs } from "../cli";

describe("cli args: plan-review flags", () => {
  it("--plan-review-max-rounds=5 parses to args.planReviewMaxRounds=5", () => {
    const args = parseArgs(["plan.md", "--plan-review-max-rounds=5"]);
    expect((args as any).planReviewMaxRounds).toBe(5);
  });

  it("--plan-review-max-rounds 3 (space form) parses identically", () => {
    const args = parseArgs(["plan.md", "--plan-review-max-rounds", "3"]);
    expect((args as any).planReviewMaxRounds).toBe(3);
  });

  it("--plan-review-no-adaptive-cap parses to args.planReviewNoAdaptiveCap=true", () => {
    const args = parseArgs(["plan.md", "--plan-review-no-adaptive-cap"]);
    expect((args as any).planReviewNoAdaptiveCap).toBe(true);
  });

  it("--plan-review-noninteractive=auto-reject parses to that mode", () => {
    const args = parseArgs([
      "plan.md",
      "--plan-review-noninteractive=auto-reject",
    ]);
    expect((args as any).planReviewNoninteractive).toBe("auto-reject");
  });

  it("default planReviewMaxRounds is 5", () => {
    const args = parseArgs(["plan.md"]);
    expect((args as any).planReviewMaxRounds).toBe(5);
  });

  it("default planReviewNoninteractive is 'auto-accept'", () => {
    const args = parseArgs(["plan.md"]);
    expect((args as any).planReviewNoninteractive).toBe("auto-accept");
  });

  it("rejects invalid noninteractive mode", () => {
    expect(() =>
      parseArgs(["plan.md", "--plan-review-noninteractive=bogus"]),
    ).toThrow();
  });

  it("--legacy-plan-review absent: default legacyPlanReview is false", () => {
    const args = parseArgs(["plan.md"]);
    expect((args as any).legacyPlanReview).toBe(false);
  });

  it("--legacy-plan-review parses to args.legacyPlanReview=true", () => {
    const args = parseArgs(["plan.md", "--legacy-plan-review"]);
    expect((args as any).legacyPlanReview).toBe(true);
  });
});
