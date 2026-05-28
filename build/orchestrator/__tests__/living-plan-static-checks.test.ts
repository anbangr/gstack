/**
 * Living-plan static-check validator tests.
 *
 * These tests exercise the extended `validate-living-plan.ts` checks that
 * catch synthesizer blind-spots before they reach the build loop:
 *   - unused imports in phase code snippets
 *   - field references in acceptance that do not exist in code
 *   - non-existent files referenced in acceptance
 *   - multi-arm experiment plans split across phases
 *   - stale file:line quotes in acceptance
 *   - inbox / audit-path exemptions
 *   - bounded-retry compatibility
 *
 * Every fixture plan encodes one defect class. Tests MUST fail before the
 * implementation is added to `validate-living-plan.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "validate-living-plan.ts");
const TEMPLATE = path.resolve(__dirname, "..", "..", "SKILL.md.tmpl");

function runValidator(planPath: string) {
  return spawnSync("bun", ["run", SCRIPT, planPath], { encoding: "utf8" });
}

function tmpPlan(dir: string, content: string): string {
  const p = path.join(dir, "plan.md");
  fs.writeFileSync(p, content);
  return p;
}

describe("living-plan static checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-static-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T1 — unused import detected
  // ─────────────────────────────────────────────────────────────────────────
  it("T1: returns non-zero when an import is unused in the same phase", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Unused import

Origin trace: test
Acceptance: passes validation

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { foo } from "./bar";
const x = 1;
\`\`\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unused import:\s*foo/i);
  });

  it("T1-edge: Bun built-in imports are allow-listed and do not trigger false positives", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Bun built-in

Origin trace: test
Acceptance: 0 unused-import violations on bun built-ins
Out of scope: none

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { spawn } from "bun";
spawn(["echo", "hi"]);
\`\`\`

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| \`src/example.ts\` | modify | 5 | add spawn call |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });

  it("T1-edge: type-only annotation counts as usage (no false positive)", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Type-only usage

Origin trace: test
Acceptance: 0 unused-import violations with type-only annotation usage
Out of scope: none

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { FailureRender } from "./halt-event-helpers";
function wrap(r: FailureRender): string { return r.kind; }
\`\`\`

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| \`src/example.ts\` | modify | 3 | add wrap function |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });

  it("T1-edge: default-plus-named imports still report unused named identifiers", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Mixed import

Origin trace: test
Acceptance: passes validation

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import foo, { bar } from "./mod";
foo();
\`\`\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unused import:\s*bar/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T2 — missing field reference
  // ─────────────────────────────────────────────────────────────────────────
  it("T2: returns non-zero when acceptance claims a field absent from current code", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Missing field

Origin trace: test
Acceptance: \`phaseState.gemini.failureRender2\` must exist in code

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/field not in current code/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3 — non-existent file in acceptance
  // ─────────────────────────────────────────────────────────────────────────
  it("T3: returns non-zero when acceptance references a file that does not exist", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Missing file

Origin trace: test
Acceptance: \`build/orchestrator/imaginary.ts\` must exist

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/referenced file does not exist/i);
  });

  it("T3-edge: a planned new file under the same phase is allowed", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Planned file

Origin trace: test
Acceptance: \`build/orchestrator/__tests__/future-helper.test.ts\` must exist, 0 validator violations
Out of scope: none

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

Add \`build/orchestrator/__tests__/future-helper.test.ts\`.

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| \`build/orchestrator/__tests__/future-helper.test.ts\` | create | 20 | new test helper |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });

  it("T3-edge: a planned new file in a different feature does not exempt this feature", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Missing file

Origin trace: test
Acceptance: \`build/orchestrator/__tests__/future-other-feature.test.ts\` must exist

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

## Feature 2: Later planned file

Origin trace: test
Acceptance: future file is created here

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

Add \`build/orchestrator/__tests__/future-other-feature.test.ts\`.
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/referenced file does not exist/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T4 — multi-arm split
  // ─────────────────────────────────────────────────────────────────────────
  it("T4: returns non-zero when a registry entry is split from its orchestrator across phases", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Registry entry

Origin trace: test
Acceptance: registry entry added

### Phase 1: Add to registry
- [ ] **Implementation**: add entry
- [ ] **Review**: review

Add \`recordProviderTimeout\` to \`child-registry.ts\`.

## Feature 2: Orchestrator wiring

Origin trace: test
Acceptance: orchestrator updated

### Phase 1: Wire orchestrator
- [ ] **Implementation**: wire it
- [ ] **Review**: review

Call \`recordProviderTimeout\` in \`phase-runner.ts\`.
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/registry entry must land with orchestrator/i);
  });

  it("T4: returns non-zero when registry and orchestrator work split across phases in one feature", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Split phase wiring

Origin trace: test
Acceptance: registry and orchestrator must ship atomically

### Phase 1: Add registry entry
- [ ] **Implementation**: add entry
- [ ] **Review**: review

Add \`recordProviderTimeout\` to \`child-registry.ts\`.

### Phase 2: Wire orchestrator
- [ ] **Implementation**: wire it
- [ ] **Review**: review

Call \`recordProviderTimeout\` in \`phase-runner.ts\`.
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/registry entry must land with orchestrator/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T5 — helper file:line stale
  // ─────────────────────────────────────────────────────────────────────────
  it("T5: returns non-zero when a quoted file:line does not match on-disk content", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Stale line quote

Origin trace: test
Acceptance: \`build/orchestrator/validate-living-plan.ts:1\` contains "this is definitely wrong"

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/quoted file:line drifted/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T6 — valid plan passes
  // ─────────────────────────────────────────────────────────────────────────
  it("T6: returns zero when all five rules are satisfied", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Valid plan

Origin trace: Source plan §test
Acceptance: 0 validator violations, all 5 static rules satisfied end-to-end
Out of scope: none

### Phase 1: Good phase
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { foo } from "./bar";
foo();
\`\`\`

Verify \`build/orchestrator/validate-living-plan.ts\` exists.

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| \`build/orchestrator/validate-living-plan.ts\` | modify | 10 | add new check |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T7 — inbox / audit path exempt
  // ─────────────────────────────────────────────────────────────────────────
  it("T7: returns zero for inbox or audit artifacts that do not yet exist", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Audit path

Origin trace: test
Acceptance: \`~/.gstack/projects/anbangr-gstack/2026-05-21-autonomy-audit.md\` must exist
Out of scope: none

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| \`src/audit.ts\` | create | 5 | audit writer |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });

  it("T7: returns zero for inbox/ paths even when missing", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Inbox path

Origin trace: test
Acceptance: \`inbox/living-plan/future-plan.md\` must exist, 0 path-missing violations
Out of scope: none

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| \`src/inbox.ts\` | create | 5 | inbox writer |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T8 — bounded retry compatibility
  // ─────────────────────────────────────────────────────────────────────────
  it("T8: validator returns exit code 2 on new violations so the synthesizer wrapper retries", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Unused import retry signal

Origin trace: test
Acceptance: passes validation

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { unused } from "./nowhere";
const x = 1;
\`\`\`
`,
    );
    const r = runValidator(plan);
    // Exit code must be 2 (structural violation) — same contract as the
    // existing Origin-trace / Acceptance gate — so the shell wrapper in
    // build/SKILL.md.tmpl enters the bounded-retry branch instead of
    // treating this as a fatal IO error (exit 1).
    expect(r.status).toBe(2);
  });

  it("T8: the synthesizer wrapper bounds retries at 3 attempts", () => {
    const tmpl = fs.readFileSync(TEMPLATE, "utf8");
    // The shell wrapper must contain the bounded-retry guard.
    expect(tmpl).toMatch(/while true; do/);
    expect(tmpl).toMatch(/_spawn_synthesizer "\$_SYNTH_PROMPT_PATH"/);
    expect(tmpl).toMatch(/"\$_SYNTH_ROUND"\s+-ge\s+3/);
    expect(tmpl).toMatch(/_SYNTH_ROUND=\$\(\(_SYNTH_ROUND\s*\+\s*1\)\)/);
    expect(tmpl).toMatch(
      /_SYNTH_PROMPT_PATH="\$BUILD_TMP_DIR\/build-synthesis-revision-input\.md"/,
    );
  });

  it("T8: on persistent failure the wrapper halts instead of looping forever", () => {
    const tmpl = fs.readFileSync(TEMPLATE, "utf8");
    expect(tmpl).toMatch(
      /PLAN_SYNTHESIS_INVALID.*structural gate failed after 2 retries/,
    );
    expect(tmpl).toMatch(/exit 1/);
  });

  it("T8: revision prompt includes static-check violations, not only structural fields", () => {
    const tmpl = fs.readFileSync(TEMPLATE, "utf8");
    expect(tmpl).toMatch(/staticViolations/);
    expect(tmpl).toMatch(/Imported identifiers are used in the same phase/);
    expect(tmpl).toMatch(
      /Acceptance file paths exist, are exempt, or are planned/,
    );
    expect(tmpl).toMatch(/Quoted file:line snippets still match/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T9 — feature heading shape: dash form must be flagged with an
  //      actionable diagnostic, not a phantom missing-fields row.
  //      Regression for the silent-failure mode where LLM synthesizer
  //      drift to `## Feature N - name` (dash) was reported as missing
  //      Origin trace / Acceptance on a phantom feature-0 block.
  // ─────────────────────────────────────────────────────────────────────────
  it("T9: ASCII-dash heading form emits feature-heading-shape diagnostic", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1 - Some Name
Origin trace: test
Acceptance: passes validation

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    // The actionable diagnostic names the real defect (output is
    // JSON-escaped, so colons inside the message string are escaped):
    expect(r.stderr).toMatch(/feature-heading-shape/);
    expect(r.stderr).toMatch(/lack the required.*separator/);
    expect(r.stderr).toMatch(/## Feature 1 - Some Name/);
    // The phantom missing-fields row must NOT be emitted in this case:
    expect(r.stderr).not.toMatch(/"featureNumber":0,"featureName":""/);
  });

  it("T9-em-dash: em-dash heading form also flagged", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1 — Some Name
Origin trace: test
Acceptance: passes

### Phase 1: Implementation
- [ ] **Implementation**: code
- [ ] **Review**: review
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/feature-heading-shape/);
  });

  it("T9-empty: truly empty plan (no ## Feature N headings) still emits the legacy missing-fields row", () => {
    // This case has no `## Feature N` headings at all, so heading-shape
    // detection has nothing to flag. The legacy phantom row remains the
    // right diagnostic shape here.
    const plan = tmpPlan(
      dir,
      `# Just a header

Some prose without any feature blocks.

## Random Other Heading
not a feature heading
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/"featureNumber":0,"featureName":""/);
    expect(r.stderr).not.toMatch(/feature-heading-shape/);
  });

  it("T9-template: SKILL.md.tmpl tells the synthesizer to verify heading shape", () => {
    // Pins the self-check addition so a template rewrite can't silently
    // drop the new HEADING SHAPE guidance.
    const tmpl = fs.readFileSync(TEMPLATE, "utf8");
    expect(tmpl).toMatch(/HEADING SHAPE/);
    expect(tmpl).toMatch(/`## Feature 1 - Foo`.*REJECTED/);
    expect(tmpl).toMatch(/`## Feature 1 — Foo`.*REJECTED/);
  });

  it("T9-mixed: mixed valid+drifted headings are flagged (H1 regression)", () => {
    // Adversarial-review-caught bypass: extractFeatureBlocks silently
    // drops drifted headings when sibling headings are valid. Before
    // the fix, this exited 0 and the second feature's phases vanished
    // from the build run. The heading-shape diagnostic now runs
    // unconditionally and fires on the drifted heading.
    const plan = tmpPlan(
      dir,
      `## Feature 1: Good
Origin trace: x
Acceptance: y

### Phase 1: Impl
- [ ] **Implementation**: code
- [ ] **Review**: review

## Feature 2 - Hidden bad
Origin trace: x
Acceptance: y

### Phase 1: Impl
- [ ] **Implementation**: code
- [ ] **Review**: review
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/feature-heading-shape/);
    expect(r.stderr).toMatch(/Hidden bad/);
  });

  it("T9-fence: fenced code-block examples do NOT false-positive (M2 regression)", () => {
    // Plan authors can document the heading format inside code fences
    // without tripping the diagnostic. The fence-tracking loop in
    // findMisshapenFeatureHeadings skips lines between ``` markers.
    const plan = tmpPlan(
      dir,
      `# Test Plan

This plan documents the canonical heading format inline.

\`\`\`markdown
Wrong forms (DON'T do this):
## Feature 1 - bad
## Feature 2 — bad
\`\`\`

(no real features in this plan)
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    // Fence content didn't trigger the heading-shape diagnostic:
    expect(r.stderr).not.toMatch(/feature-heading-shape/);
    // Legacy phantom-row still emits for the no-feature case:
    expect(r.stderr).toMatch(/"featureNumber":0,"featureName":""/);
  });

  it("T9-length: very long drifted heading is truncated in the diagnostic (M1 regression)", () => {
    // Unbounded reflection of plan-controlled text into the revision
    // prompt is both a context-cost issue and a weak prompt-injection
    // vector. Examples are capped at 120 chars with a clear suffix.
    const longTail = "a".repeat(500);
    const plan = tmpPlan(dir, `## Feature 1 - ${longTail}\n`);
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/feature-heading-shape/);
    expect(r.stderr).toMatch(/\.\.\. \(truncated\)/);
    // The reflected example should NOT contain the full 500-a tail:
    expect(r.stderr).not.toMatch(/a{200}/);
  });

  it("T9-generated: generated build/SKILL.md ALSO contains HEADING SHAPE guidance (F3)", () => {
    // The template is the source of truth, but build/SKILL.md is what
    // ships to the LLM at runtime. A gen-skill-docs regression that
    // drops sections would otherwise be undetectable from T9-template
    // alone.
    const generated = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "SKILL.md"),
      "utf8",
    );
    expect(generated).toMatch(/HEADING SHAPE/);
    expect(generated).toMatch(/`## Feature 1 - Foo`.*REJECTED/);
  });

  it("T9-nested-fence: 4-backtick fence with embedded 3-backtick stays closed (N1 regression)", () => {
    // CommonMark fences: an opening run of N chars can only be closed
    // by a bare run of >= N of the same char. Without length-aware
    // tracking, the inner 3-backtick line would close the outer 4-tick
    // fence and silently unmask later "## Feature" lines as scannable.
    const plan = tmpPlan(
      dir,
      "# Plan\n\n" +
        "Documentation:\n\n" +
        "````markdown\n" +
        "Example of WRONG heading:\n" +
        "```\n" +
        "## Feature 1 - inside-nested-fence\n" +
        "```\n" +
        "````\n\n" +
        "## Feature 2 - real-outside-fence\n",
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/feature-heading-shape/);
    // Real heading flagged:
    expect(r.stderr).toMatch(/real-outside-fence/);
    // Heading inside the nested fence NOT flagged:
    expect(r.stderr).not.toMatch(/inside-nested-fence/);
  });

  it("T9-tilde-fence: tilde-fenced examples are also skipped (N2 regression)", () => {
    // CommonMark allows ~~~ fences alongside backticks. Plan authors
    // may use them to nest backtick examples without escaping.
    const plan = tmpPlan(
      dir,
      "# Plan\n\n" +
        "Example:\n\n" +
        "~~~markdown\n" +
        "## Feature 1 - tilde-fenced-example\n" +
        "~~~\n\n" +
        "(no real features)\n",
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    // Tilde-fenced content does NOT trigger the diagnostic:
    expect(r.stderr).not.toMatch(/feature-heading-shape/);
    // Legacy phantom-row emits since plan has no real features:
    expect(r.stderr).toMatch(/"featureNumber":0,"featureName":""/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T6 — FeatureBlock flags populated for new fields
  // ─────────────────────────────────────────────────────────────────────────
  it("T6: extractFeatureBlocks populates hasOutOfScope/hasVerificationSpec/hasFileReferenceTable/hasQuantifiedAcceptance", async () => {
    const { extractFeatureBlocks } = await import("../skill-fault-detector");
    const plan = `## Feature 1: Complete feature

Origin trace: source plan §1
Acceptance: 1. response time under 50ms (quantified)
Out of scope: nothing

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action |
|---|---|
| \`src/foo.ts\` | create |

### Verification Spec
Smoke: \`bun test\`
`;
    const blocks = extractFeatureBlocks(plan);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hasOutOfScope).toBe(true);
    expect(blocks[0].hasVerificationSpec).toBe(true);
    expect(blocks[0].hasFileReferenceTable).toBe(true);
    expect(blocks[0].hasQuantifiedAcceptance).toBe(true);
  });

  it("T6-negative: extractFeatureBlocks reports false for missing fields", async () => {
    const { extractFeatureBlocks } = await import("../skill-fault-detector");
    const plan = `## Feature 1: Minimal feature

Origin trace: source plan §1
Acceptance: feature works

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review
`;
    const blocks = extractFeatureBlocks(plan);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hasOutOfScope).toBe(false);
    expect(blocks[0].hasVerificationSpec).toBe(false);
    expect(blocks[0].hasFileReferenceTable).toBe(false);
    expect(blocks[0].hasQuantifiedAcceptance).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T7 — Out of scope: required per feature block
  // ─────────────────────────────────────────────────────────────────────────
  it("T7: returns non-zero when a feature block is missing Out of scope:", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Missing out-of-scope

Origin trace: test
Acceptance: 1. response time under 50ms

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action |
|---|---|
| \`src/foo.ts\` | create |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/out-of-scope/i);
  });

  it("T7-positive: accepts plans with Out of scope: line-anchored at column 0", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Complete feature

Origin trace: test
Acceptance: 1. response time under 50ms
Out of scope: nothing

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action |
|---|---|
| \`src/foo.ts\` | create |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T8 — Verification Spec subsection required per feature block
  // ─────────────────────────────────────────────────────────────────────────
  it("T8: returns non-zero when a feature block is missing ### Verification Spec", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: No verification spec

Origin trace: test
Acceptance: 1. response time under 50ms
Out of scope: nothing

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action |
|---|---|
| \`src/foo.ts\` | create |
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/verification spec/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T9 — File Reference Table required per feature block
  // ─────────────────────────────────────────────────────────────────────────
  it("T9: returns non-zero when a feature block is missing ### File Reference Table", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: No file reference table

Origin trace: test
Acceptance: 1. response time under 50ms
Out of scope: nothing

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/file reference table/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T10 — Quantified acceptance required per feature block
  // ─────────────────────────────────────────────────────────────────────────
  it("T10: returns non-zero when no acceptance criterion contains a number", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Vague acceptance

Origin trace: test
Acceptance: feature works correctly and handles edge cases
Out of scope: nothing

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action |
|---|---|
| \`src/foo.ts\` | create |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/quantified/i);
  });

  it("T10-positive: accepts a quantified acceptance line", () => {
    const plan = tmpPlan(
      dir,
      `## Feature 1: Quantified acceptance

Origin trace: test
Acceptance: 1. response p95 under 100ms on 10K-row table
Out of scope: nothing

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action |
|---|---|
| \`src/foo.ts\` | create |

### Verification Spec
Smoke: \`bun test\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
  });
});
