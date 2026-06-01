import { describe, it, expect } from "bun:test";
import { generatePlanFileDiscovery } from "../scripts/resolvers/review";

describe("generatePlanFileDiscovery — explicit/structured, no fuzzy search", () => {
  const block = generatePlanFileDiscovery();

  it("keeps explicit + conversation-context as the top signals", () => {
    expect(block).toContain("--plan");
    expect(block.toLowerCase()).toContain("conversation");
  });

  it("uses the structured spec_branch exact-match binding", () => {
    expect(block).toContain("^spec_branch: $BRANCH$");
    expect(block).toContain("projects/${SLUG:-unknown}/specs");
  });

  it("delegates /build living plans to the deterministic resolver", () => {
    expect(block).toContain("gstack-build plan-status");
  });

  it("STOPS instead of fuzzy-guessing — no content-grep / mtime / extra dirs", () => {
    // The whole point: these fuzzy patterns must be GONE.
    expect(block).not.toContain('grep -l "$REPO"');
    expect(block).not.toContain("-mmin -1440");
    expect(block).not.toContain(".codex/plans");
    expect(block).not.toContain(".claude/plans");
    // And it must surface ambiguity / absence explicitly.
    expect(block).toContain("NO_PLAN_FILE");
    expect(block).toContain("PLAN_AMBIGUOUS");
  });
});
