import { describe, it, expect } from "bun:test";
import { parsePlan } from "../parser";

describe("parsePlan — sublettered phase numbers", () => {
  it("accepts Phase X.Ya headings and preserves the suffix in number", () => {
    const md = `# Plan

### Phase 2.1a: Split the bootstrap
- [ ] **Implementation (Gemini Sub-agent)**: do half
- [ ] **Review & QA (Codex Sub-agent)**: review half

### Phase 2.1b: Other half
- [ ] **Implementation (Gemini Sub-agent)**: do other half
- [ ] **Review & QA (Codex Sub-agent)**: review other half
`;
    const { phases, warnings, droppedPhasesCount } = parsePlan(md);
    expect(warnings).toEqual([]);
    expect(droppedPhasesCount).toBe(0);
    expect(phases).toHaveLength(2);
    expect(phases[0].number).toBe("2.1a");
    expect(phases[0].name).toBe("Split the bootstrap");
    expect(phases[1].number).toBe("2.1b");
  });

  it("accepts plain Phase N and Phase N.M alongside sublettered phases", () => {
    const md = `# Plan

### Phase 1: Top level
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y

### Phase 2.1: Sub
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y

### Phase 2.1a: Sub-sub
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y
`;
    const { phases } = parsePlan(md);
    expect(phases.map((p) => p.number)).toEqual(["1", "2.1", "2.1a"]);
  });
});

describe("parsePlan — malformed phase headings warn instead of disappearing", () => {
  it("emits a warning when a phase heading has an unsupported number format", () => {
    const md = `# Plan

### Phase 2.1.3: Too many dots
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y

### Phase 3: Properly numbered
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases).toHaveLength(1);
    expect(phases[0].number).toBe("3");
    expect(warnings.some((w) => w.includes("malformed phase heading"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("Phase 2.1.3"))).toBe(true);
  });

  it("emits a warning for headings missing the colon delimiter", () => {
    const md = `# Plan

### Phase 1 No colon here
prose

### Phase 2: Good
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases).toHaveLength(1);
    expect(phases[0].number).toBe("2");
    expect(warnings.some((w) => w.includes("malformed phase heading"))).toBe(
      true,
    );
  });

  it("does NOT warn for the well-formed `### Phase N:` headings", () => {
    const md = `# Plan

### Phase 1: All good
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y
`;
    const { warnings } = parsePlan(md);
    expect(warnings).toEqual([]);
  });

  it("ignores `### Phase` lines inside fenced code blocks", () => {
    const md = `# Plan

\`\`\`
### Phase 99: documentation example
\`\`\`

### Phase 1: Real
- [ ] **Implementation (Gemini Sub-agent)**: x
- [ ] **Review & QA (Codex Sub-agent)**: y
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
