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
Acceptance: passes validation

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { spawn } from "bun";
spawn(["echo", "hi"]);
\`\`\`
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
Acceptance: passes validation

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { FailureRender } from "./halt-event-helpers";
function wrap(r: FailureRender): string { return r.kind; }
\`\`\`
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
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
Acceptance: \`build/orchestrator/__tests__/future-helper.test.ts\` must exist

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review

Add \`build/orchestrator/__tests__/future-helper.test.ts\`.
`,
    );
    const r = runValidator(plan);
    expect(r.status).toBe(0);
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
Acceptance: Everything is wired end-to-end

### Phase 1: Good phase
- [ ] **Implementation**: write code
- [ ] **Review**: review

\`\`\`typescript
import { foo } from "./bar";
foo();
\`\`\`

Verify \`build/orchestrator/validate-living-plan.ts\` exists.
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

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review
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
Acceptance: \`inbox/living-plan/future-plan.md\` must exist

### Phase 1: Implementation
- [ ] **Implementation**: write code
- [ ] **Review**: review
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
    expect(tmpl).toMatch(/"\$_SYNTH_ROUND"\s+-ge\s+3/);
    expect(tmpl).toMatch(/_SYNTH_ROUND=\$\(\(_SYNTH_ROUND\s*\+\s*1\)\)/);
  });

  it("T8: on persistent failure the wrapper halts instead of looping forever", () => {
    const tmpl = fs.readFileSync(TEMPLATE, "utf8");
    expect(tmpl).toMatch(
      /PLAN_SYNTHESIS_INVALID.*structural gate failed after 2 retries/,
    );
    expect(tmpl).toMatch(/exit 1/);
  });
});
