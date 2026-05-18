import { describe, it, expect } from "bun:test";
import { buildGeminiPromptBody } from "../cli";
import type { Phase } from "../types";

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    index: 0,
    number: "1.1",
    name: "Implement auth",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "Auth",
    implementationDone: false,
    reviewDone: false,
    testSpecDone: true,
    body: "Add a login form and wire it to /api/auth.",
    implementationCheckboxLine: 5,
    reviewCheckboxLine: 6,
    testSpecCheckboxLine: -1,
    dualImpl: false,
    kind: "code",
    ...overrides,
  };
}

describe("buildGeminiPromptBody — NO_CHANGES_NEEDED affordance", () => {
  it("includes the NO_CHANGES_NEEDED instruction when reviewFeedback is non-null", () => {
    const prompt = buildGeminiPromptBody(
      makePhase(),
      "/path/to/plan.md",
      "fix/feature-x",
      "GATE FAIL: missing test coverage on the empty-input branch",
    );
    expect(prompt).toContain("NO_CHANGES_NEEDED");
    expect(prompt).toContain("on its own line");
    expect(prompt).toContain("do NOT make a commit");
  });

  it("omits the NO_CHANGES_NEEDED instruction on the first pass (no reviewFeedback)", () => {
    const prompt = buildGeminiPromptBody(
      makePhase(),
      "/path/to/plan.md",
      "fix/feature-x",
    );
    expect(prompt).not.toContain("NO_CHANGES_NEEDED");
  });

  it("omits the NO_CHANGES_NEEDED instruction when reviewFeedback is null", () => {
    const prompt = buildGeminiPromptBody(
      makePhase(),
      "/path/to/plan.md",
      "fix/feature-x",
      null,
    );
    expect(prompt).not.toContain("NO_CHANGES_NEEDED");
  });

  it("places the NO_CHANGES_NEEDED instruction AFTER the review-feedback block, not inside it", () => {
    const feedback = "GATE FAIL: foo";
    const prompt = buildGeminiPromptBody(
      makePhase(),
      "/path/to/plan.md",
      "fix/feature-x",
      feedback,
    );
    const feedbackEnd = prompt.indexOf("<<<REVIEW_FEEDBACK_END>>>");
    const sentinelInstruction = prompt.indexOf("NO_CHANGES_NEEDED");
    expect(feedbackEnd).toBeGreaterThanOrEqual(0);
    expect(sentinelInstruction).toBeGreaterThan(feedbackEnd);
  });
});
