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
  it("extracts a single annotation block with full multi-round history", () => {
    const annotations = parseRoundAnnotations(SAMPLE_PLAN);
    expect(annotations).toHaveLength(1);
    const a = annotations[0];
    expect(a.location).toBe("Feature 1, Phase 2");
    expect(a.severity).toBe("CRITICAL");
    expect(a.issue).toBe("EIP-712 digest missing chainId");
    expect(a.suggestion).toBe("add chainId field");
    // Two rounds: round 1 has the user decision + resolution; round 2 has
    // only the reviewer outcome (the reviewer observed the annotation but
    // did not re-raise, so there is no ROUND 2 USER line).
    expect(a.rounds).toHaveLength(2);
    expect(a.rounds[0].round).toBe(1);
    expect(a.rounds[0].userDecision).toBe("accept");
    expect(a.rounds[0].userRationale).toBe("agreed, real bug");
    expect(a.rounds[0].resolution).toBe("synth added chainId to digest struct");
    expect(a.rounds[0].reviewerOutcome).toBeUndefined();
    expect(a.rounds[1].round).toBe(2);
    expect(a.rounds[1].userDecision).toBeUndefined();
    expect(a.rounds[1].resolution).toBeUndefined();
    expect(a.rounds[1].reviewerOutcome).toBe("not re-raised");
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

  it("prepends annotation when the Phase heading is not found in plan text", () => {
    const plan = `## Feature 1\n### Phase 1: x\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 99",
      severity: "CRITICAL",
      issue: "missing phase",
      suggestion: "add phase",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "",
          resolution: "pending",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    // The annotation should be prepended (above the Feature heading).
    expect(updated.indexOf("ROUND 1 CRITICAL [Feature 1, Phase 99]")).toBeLessThan(
      updated.indexOf("## Feature 1"),
    );
    // Round-trip: parse what we wrote and confirm it survives.
    const parsed = parseRoundAnnotations(updated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].location).toBe("Feature 1, Phase 99");
  });

  it("does not interpret $& or $1 in annotation fields as replacement patterns", () => {
    const plan = `## Feature 1\n### Phase 2: Impl\n- [ ] task\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 2",
      severity: "CRITICAL",
      issue: "regex contains $& and $1",
      suggestion: "escape $` and $' literally",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "with $& dollar",
          resolution: "pending",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    // `$1` doesn't include `&`, so it survives verbatim. `$&` triggers the
    // `&`-encoding rule, so on disk it appears as `$&amp;`. That is correct
    // behavior — encoding-on-write neutralizes characters that would otherwise
    // break the comment-block syntax (here `&`, conservatively, to anchor the
    // escape table). The user-facing invariant is round-trip recovery, not
    // verbatim on-disk text — see the decoded assertions below.
    expect(updated).toContain("$1");
    expect(updated).toContain("escape $` and $' literally");
    // Round-trip: parse the result and confirm fields survive verbatim after decode.
    const parsed = parseRoundAnnotations(updated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].issue).toBe("regex contains $& and $1");
    expect(parsed[0].suggestion).toBe("escape $` and $' literally");
    expect(parsed[0].rounds[0].userRationale).toBe("with $& dollar");
  });
});

describe("annotation injection-safety (round-trip invariants)", () => {
  it("rationale containing --> round-trips correctly", () => {
    const plan = `## Feature 1\n### Phase 1: setup\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 1",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "evil --> bad",
          resolution: "pending",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    const parsed = parseRoundAnnotations(updated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rounds[0].userRationale).toBe("evil --> bad");
  });

  it("rationale containing double-quotes round-trips correctly", () => {
    const plan = `## Feature 1\n### Phase 1: setup\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 1",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: 'they said "hi" loudly',
          resolution: "pending",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    const parsed = parseRoundAnnotations(updated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rounds[0].userRationale).toBe('they said "hi" loudly');
  });

  it("location containing brackets round-trips correctly", () => {
    const plan = `## Feature 1\n### Phase 2: impl\n`;
    const ann: RoundAnnotation = {
      location: "F[1], Phase 2",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
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
    const parsed = parseRoundAnnotations(updated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].location).toBe("F[1], Phase 2");
  });

  it("issue, suggestion, resolution, reviewerOutcome all escape and survive round-trip", () => {
    const plan = `## Feature 1\n### Phase 1: setup\n`;
    const ann: RoundAnnotation = {
      location: "Feature 1, Phase 1",
      severity: "CRITICAL",
      issue: "use --> instead of ->",
      suggestion: "don't use --> in code",
      rounds: [
        {
          round: 1,
          userDecision: "accept",
          userRationale: "agreed",
          resolution: "synth applied: ban --> entirely",
          reviewerOutcome: "not re-raised --> resolved",
        },
      ],
    };
    const updated = writeRoundAnnotation(plan, ann);
    const parsed = parseRoundAnnotations(updated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].issue).toBe("use --> instead of ->");
    expect(parsed[0].suggestion).toBe("don't use --> in code");
    expect(parsed[0].rounds[0].resolution).toBe("synth applied: ban --> entirely");
    expect(parsed[0].rounds[0].reviewerOutcome).toBe("not re-raised --> resolved");
  });

  it("merge survives whitespace divergence in existing annotation block", () => {
    // Simulate a synth (or external editor) that wrote the existing block with
    // 8-space indent instead of canonical 5-space.
    const planWith8SpaceIndent = `## Feature 1
### Phase 1: setup
<!-- ROUND 1 CRITICAL [Feature 1, Phase 1]: x → y
        ROUND 1 USER: accept ("round 1 rationale")
        ROUND 1 RESOLUTION: pending -->
- [ ] task
`;
    const round2: RoundAnnotation = {
      location: "Feature 1, Phase 1",
      severity: "CRITICAL",
      issue: "x",
      suggestion: "y",
      rounds: [
        {
          round: 2,
          userDecision: "reject",
          userRationale: "round 2 wants to reject",
          reviewerOutcome: "re-raised",
        },
      ],
    };
    const merged = writeRoundAnnotation(planWith8SpaceIndent, round2);
    // The output must differ from the input (the silent no-op bug).
    expect(merged).not.toBe(planWith8SpaceIndent);
    // The merged result must have BOTH rounds.
    const parsed = parseRoundAnnotations(merged);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rounds).toHaveLength(2);
    expect(parsed[0].rounds[0].round).toBe(1);
    expect(parsed[0].rounds[0].userRationale).toBe("round 1 rationale");
    expect(parsed[0].rounds[1].round).toBe(2);
    expect(parsed[0].rounds[1].userDecision).toBe("reject");
    expect(parsed[0].rounds[1].userRationale).toBe("round 2 wants to reject");
  });
});
