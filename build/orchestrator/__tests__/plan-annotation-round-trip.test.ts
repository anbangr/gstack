import { describe, it, expect } from "bun:test";
import {
  parseRoundAnnotations,
  writeRoundAnnotation,
  type RoundAnnotation,
} from "../plan-reviewer";

const SAMPLE_PLAN = `# Living Plan

## Feature 1: Crypto skeleton

### Phase 2: Implementation
<!-- ROUND 1 CRITICAL [Feature 1, Phase 2]: EIP-712 digest missing chainId → add chainId field
     ROUND 1 USER: accept ("agreed, real bug")
     ROUND 1 RESOLUTION: synth added chainId to digest struct
     ROUND 2 REVIEWER: not re-raised -->

- [ ] **Test Specification (test-writer role)**: ...
`;

describe("parseRoundAnnotations", () => {
  it("extracts a single annotation block with full history", () => {
    const annotations = parseRoundAnnotations(SAMPLE_PLAN);
    expect(annotations).toHaveLength(1);
    const a = annotations[0];
    expect(a.location).toBe("Feature 1, Phase 2");
    expect(a.severity).toBe("CRITICAL");
    expect(a.issue).toBe("EIP-712 digest missing chainId");
    expect(a.suggestion).toBe("add chainId field");
    expect(a.rounds).toHaveLength(1);
    expect(a.rounds[0].round).toBe(1);
    expect(a.rounds[0].userDecision).toBe("accept");
    expect(a.rounds[0].userRationale).toBe("agreed, real bug");
    expect(a.rounds[0].resolution).toBe("synth added chainId to digest struct");
    expect(a.rounds[0].reviewerOutcome).toBe("not re-raised");
  });

  it("returns empty array when no annotations present", () => {
    expect(parseRoundAnnotations("# plain plan\n## Feature 1\n")).toEqual([]);
  });

  it("tolerates malformed blocks by skipping them, not throwing", () => {
    const malformed = `### Phase 2
<!-- ROUND 1 CRITICAL [bad: no closing bracket -->
<!-- ROUND 1 CRITICAL [Feature 1, Phase 2]: real → fix
     ROUND 1 USER: accept -->`;
    const result = parseRoundAnnotations(malformed);
    expect(result).toHaveLength(1);
    expect(result[0].location).toBe("Feature 1, Phase 2");
  });
});

describe("writeRoundAnnotation", () => {
  it("inserts a new annotation block above the matching Phase heading", () => {
    const plan = `## Feature 1\n### Phase 2: Impl\n- [ ] task\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 2",
      severity: "CRITICAL",
      issue: "missing test",
      suggestion: "add test",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "ok",
          resolution: "pending",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    expect(updated).toContain(
      "<!-- ROUND 1 CRITICAL [Feature 1, Phase 2]: missing test → add test",
    );
    expect(updated).toContain('ROUND 1 USER: accept ("ok")');
    expect(updated).toContain("ROUND 1 RESOLUTION: pending");
    expect(updated.indexOf("<!-- ROUND 1")).toBeLessThan(
      updated.indexOf("### Phase 2"),
    );
  });

  it("appends a new round to an existing annotation block with matching (location, severity)", () => {
    const plan = `### Phase 2: Impl
<!-- ROUND 1 CRITICAL [Feature 1, Phase 2]: x → y
     ROUND 1 USER: reject ("misread") -->
- [ ] task`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 2",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 2,
          userDecision: "reject",
          userRationale: "same misread",
          reviewerOutcome: "re-raised",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    expect(updated).toContain("ROUND 1 USER: reject");
    expect(updated).toContain("ROUND 2 REVIEWER: re-raised");
    expect(updated).toContain('ROUND 2 USER: reject ("same misread")');
    // Should not have created a second annotation block
    expect((updated.match(/ROUND 1 CRITICAL \[Feature 1, Phase 2\]/g) ?? []).length).toBe(1);
  });

  it("round-trips: write then parse recovers the same data", () => {
    let plan = `## Feature 1\n### Phase 2: Impl\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 2",
      severity: "CRITICAL",
      issue: "issue text",
      suggestion: "suggestion text",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "rationale",
          resolution: "pending",
        },
      ],
    };
    plan = writeRoundAnnotation(plan, ann);
    const parsed = parseRoundAnnotations(plan);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(ann);
  });
});
