# Spec-Grade Living Plans — Increment 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the living plan's content quality bar by adding four new validator checks and updating the synthesizer prompt to require the new sections inline. No per-feature spec generation yet — that lands in Increment 2.

**Architecture:** Extend `build/orchestrator/validate-living-plan.ts` with four additive checks (out-of-scope field, verification spec section, file reference table, quantified acceptance). Extend `extractFeatureBlocks` in `build/orchestrator/skill-fault-detector.ts` to populate four new boolean flags so both the validator and skill-fault-detector see them. Update `build/SKILL.md.tmpl` synthesizer prompt to require the new sections and extend the structural self-check. Document the shared archive format at `docs/spec-archive-format.md` so Increment 2's per-feature spec gen and `/spec`'s archive emission converge on one schema.

**Tech Stack:** TypeScript / Bun; `bun test`; markdown templates rendered via `bun run gen:skill-docs`.

---

## Scope and out-of-scope

**In scope (Increment 1):**

- New validator checks for sections that must appear WITHIN the living plan
- Synthesizer prompt update so the living plan output includes those sections
- Shared archive format doc (referenced by Increments 2-4)

**Out of scope (defer to Increments 2-4):**

- Per-feature spec archives at `~/.gstack/projects/<slug>/specs/` (Increment 2)
- Codex 0-10 quality gate dispatch (Increment 2)
- User interrogation flow when score <7 (Increment 2)
- `Spec source:` line-anchored field + cross-file preservation checks (Increment 2)
- `featureVerifier` consolidation (Increment 3)
- Cross-skill spec archive detection and `spec-to-issue` CLI (Increment 4)

## File structure

```text
docs/
  spec-archive-format.md                              # NEW — shared schema reference

build/
  SKILL.md.tmpl                                       # MODIFY — synthesizer prompt + self-check
  SKILL.md                                            # REGENERATE — derived from .tmpl
  orchestrator/
    skill-fault-detector.ts                           # MODIFY — extend FeatureBlock + extractor
    validate-living-plan.ts                           # MODIFY — add 4 new checks
    __tests__/
      living-plan-static-checks.test.ts               # MODIFY — add 4 new test groups
```

`build/SKILL.md.tmpl` is the source of truth; `build/SKILL.md` is generated. Always edit `.tmpl` and regenerate.

---

## Task 1: Document the shared spec archive format

**Files:**

- Create: `docs/spec-archive-format.md`

This is reference documentation that Increments 2-4 will point at. Writing it first locks the schema before any code consumes it.

- [ ] **Step 1: Create the documentation file**

Create `docs/spec-archive-format.md` with this exact content:

````markdown
# Spec Archive Format (v1)

Shared markdown schema written by `/spec` and (starting Increment 2) `/build`.
Both skills produce and consume this format so per-feature specs can flow between them.

**Path convention:** `~/.gstack/projects/<slug>/specs/<timestamp>-<pid>-<slug>.md`

## Frontmatter

```yaml
---
spec_id: <feature-or-issue-slug> # required; lowercase a-z0-9-, max 60 chars
spec_archive_format_version: 1 # required; integer schema version
spec_filed_via: /spec | /build | hybrid # required; which skill emitted this
spec_issue_number: <N> | null # required; GitHub issue number or null
spec_filed_at: <ISO 8601 UTC> # required; timestamp at write
spec_quality_score: <0-10> # required for /build-emitted; optional for /spec
spec_quality_gate_rounds: <N> # required for /build-emitted; optional for /spec
feature_number: <N> # /build-emitted only (feature index in source plan)
source_plan: <absolute path> # /build-emitted only
origin_trace: <source plan refs> # /build-emitted only
target_repo: <repo slug> # /build-emitted only
kind: code | writing | experiment | research | manual # required
---
```

## Body sections — required for `kind: code`

| Section                | Heading                     | Required content                                                               |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Context                | `## Context`                | 2-4 sentences: what exists today, why insufficient, why now                    |
| Verified Current State | `## Verified Current State` | File:line citations table; greenfield features state "No existing code"        |
| Proposed Change        | `## Proposed Change`        | What changes; signatures and shapes as actual code (not pseudocode)            |
| Schemas / Interfaces   | `### Schemas / Interfaces`  | TypeScript / SQL / JSON code blocks; required when feature changes data shapes |
| File Reference Table   | `### File Reference Table`  | Every file to create or modify (File, Action, Lines, Why columns)              |
| Acceptance Criteria    | `## Acceptance Criteria`    | Numbered list; at least one quantified criterion (numeric)                     |
| Test Spec              | `## Test Spec`              | Coverage target + ID/Scenario/Given/When/Then table + edge cases               |
| Verification Spec      | `## Verification Spec`      | Smoke commands + acceptance probes table + verification artifacts              |
| Out of Scope           | `## Out of Scope`           | Explicit non-goals (may be `none` but field must exist)                        |
| Rollback               | `## Rollback`               | How to undo if shipped broken                                                  |

## Body sections — lighter form for non-code `kind`

| Section             | Heading                  | Required content                                            |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| Context             | `## Context`             | Same as code                                                |
| Proposed Change     | `## Proposed Change`     | Artifact to produce; audience; claims; inputs               |
| Acceptance Criteria | `## Acceptance Criteria` | Observable criteria (artifact exists, word count, etc.)     |
| Verification Spec   | `## Verification Spec`   | Verification artifacts list + single-sentence pass criteria |
| Out of Scope        | `## Out of Scope`        | Same as code                                                |

## Sentinel (end of file)

```html
<!-- gstack-spec-complete
ts: <ISO 8601 UTC>
quality_score: <N>
gate_rounds: <N>
interrogation: yes | no | skipped
filed_via: /spec | /build | hybrid
-->
```

## Versioning

`spec_archive_format_version: 1` is the current schema. Breaking changes bump the integer.
Consumers must reject archives with a higher version than they understand.
````

- [ ] **Step 2: Commit**

```bash
git add docs/spec-archive-format.md
git commit -m "docs: add shared spec archive format reference (v1)"
```

---

## Task 2: Extend `FeatureBlock` to capture 4 new flags

**Files:**

- Modify: `build/orchestrator/skill-fault-detector.ts` (FeatureBlock interface + extractFeatureBlocks parser)
- Test: `build/orchestrator/__tests__/living-plan-static-checks.test.ts` (add new tests at end of file)

Goal: extend the FeatureBlock shape so both the validator and skill-fault-detector see four new boolean flags. The parser populates them by inspecting the block header (for `Out of scope:`) and body (for the three section headings).

- [ ] **Step 1: Read the current FeatureBlock interface and extractor**

Run: `grep -n -A 30 'export interface FeatureBlock' build/orchestrator/skill-fault-detector.ts`

Note the existing fields (`number`, `name`, `header`, `body`, `hasOriginTrace`, `hasAcceptance`).

- [ ] **Step 2: Write failing test for the new flags**

Add to `build/orchestrator/__tests__/living-plan-static-checks.test.ts` (at end of the `describe` block, before the closing `});`):

```typescript
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
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T6`
Expected: FAIL with `hasOutOfScope` (and the other three) being `undefined`, not `true`/`false`.

- [ ] **Step 4: Extend the FeatureBlock interface**

In `build/orchestrator/skill-fault-detector.ts`, find the `export interface FeatureBlock` block and add four new fields at the end (right after `hasAcceptance: boolean`):

```typescript
hasOutOfScope: boolean;
hasVerificationSpec: boolean;
hasFileReferenceTable: boolean;
hasQuantifiedAcceptance: boolean;
```

- [ ] **Step 5: Extend the `extractFeatureBlocks` parser**

In the same file, find the loop that builds each FeatureBlock. After the existing `hasOriginTrace` and `hasAcceptance` detection (which use line-anchored regex on the header), add:

```typescript
const hasOutOfScope = /^Out of scope:/m.test(header);
const hasVerificationSpec =
  /^###\s+Verification Spec\s*$/m.test(body) ||
  /^##\s+Verification Spec\s*$/m.test(body);
const hasFileReferenceTable =
  /^###\s+File Reference Table\s*$/m.test(body) ||
  /^##\s+File Reference Table\s*$/m.test(body);

// Quantified acceptance: any numbered acceptance line that contains a number.
// We look at lines following `Acceptance:` until the next blank line or section.
let hasQuantifiedAcceptance = false;
const acceptanceMatch = header.match(
  /^Acceptance:([\s\S]*?)(?:\n\n|\n##|\n###|$)/m,
);
if (acceptanceMatch) {
  // A quantified criterion contains a digit followed by a unit-like token
  // (ms, s, %, MB, count, rows, status code, etc.) OR a bare numeric threshold.
  hasQuantifiedAcceptance = /\d/.test(acceptanceMatch[1]);
}
```

Then add those four fields to the FeatureBlock object literal being pushed:

```typescript
blocks.push({
  number,
  name,
  header,
  body,
  hasOriginTrace,
  hasAcceptance,
  hasOutOfScope,
  hasVerificationSpec,
  hasFileReferenceTable,
  hasQuantifiedAcceptance,
});
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T6`
Expected: PASS (both T6 and T6-negative).

- [ ] **Step 7: Run the full validator test file to confirm no regressions**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts`
Expected: all tests pass (existing T1-T5 plus new T6).

- [ ] **Step 8: Commit**

```bash
git add build/orchestrator/skill-fault-detector.ts build/orchestrator/__tests__/living-plan-static-checks.test.ts
git commit -m "feat(build/orchestrator): extend FeatureBlock with hasOutOfScope, hasVerificationSpec, hasFileReferenceTable, hasQuantifiedAcceptance flags"
```

---

## Task 3: Validator check — `Out of scope:` line-anchored per feature block

**Files:**

- Modify: `build/orchestrator/validate-living-plan.ts` (add check + emit violation)
- Test: `build/orchestrator/__tests__/living-plan-static-checks.test.ts` (add T7 test group)

- [ ] **Step 1: Write the failing test**

Add to `build/orchestrator/__tests__/living-plan-static-checks.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T7`
Expected: T7 FAIL (validator returns 0 instead of non-zero). T7-positive will likely fail too (missing other checks may also need additions, but they should pass once we land Tasks 3-6 together; for now, treat T7-positive as a smoke check that this plan can pass once everything is in).

- [ ] **Step 3: Add the check to `validate-living-plan.ts`**

In `build/orchestrator/validate-living-plan.ts`, inside the `validate()` function, locate the line `staticViolations.push(...checkStaleQuotes(content));` (the LAST static-check call before the `return` statement). Insert this new block immediately after it:

```typescript
// Increment 1 spec-grade checks: out-of-scope, verification spec,
// file reference table, quantified acceptance must be present per feature.
// Tasks 4, 5, and 6 will each append another `if` to this same loop.
for (const block of blocks) {
  if (!block.hasOutOfScope) {
    staticViolations.push({
      rule: "missing-out-of-scope",
      message: `Feature ${block.number} (${block.name}): missing "Out of scope:" line-anchored field. Add a line starting at column 0 like "Out of scope: none" or "Out of scope: vendor billing integration".`,
    });
  }
}
```

Keep this as a single per-block loop rather than introducing a separate loop per check — Tasks 4, 5, 6 add their `if`s inside this same loop body.

- [ ] **Step 4: Run the test to verify T7 passes**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T7`
Expected: T7 PASS. T7-positive may still fail until Tasks 4-6 add the other three checks; that's expected.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/validate-living-plan.ts build/orchestrator/__tests__/living-plan-static-checks.test.ts
git commit -m "feat(build/orchestrator): validator rejects feature blocks missing Out of scope: field"
```

---

## Task 4: Validator check — `### Verification Spec` subsection per feature block

**Files:**

- Modify: `build/orchestrator/validate-living-plan.ts`
- Test: `build/orchestrator/__tests__/living-plan-static-checks.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the test file:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T8`
Expected: FAIL.

- [ ] **Step 3: Add the check to `validate-living-plan.ts`**

Append to the same Increment 1 block (after the `hasOutOfScope` check):

```typescript
if (!block.hasVerificationSpec) {
  staticViolations.push({
    rule: "missing-verification-spec",
    message: `Feature ${block.number} (${block.name}): missing "### Verification Spec" subsection. Add an H3 heading "### Verification Spec" with smoke commands + acceptance probes table (for code features) or verification artifacts + pass criteria (for non-code features). See docs/spec-archive-format.md for the exact shape.`,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/validate-living-plan.ts build/orchestrator/__tests__/living-plan-static-checks.test.ts
git commit -m "feat(build/orchestrator): validator rejects feature blocks missing ### Verification Spec subsection"
```

---

## Task 5: Validator check — `### File Reference Table` per feature block

**Files:**

- Modify: `build/orchestrator/validate-living-plan.ts`
- Test: `build/orchestrator/__tests__/living-plan-static-checks.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T9`
Expected: FAIL.

- [ ] **Step 3: Add the check**

Append to the same Increment 1 block:

```typescript
if (!block.hasFileReferenceTable) {
  staticViolations.push({
    rule: "missing-file-reference-table",
    message: `Feature ${block.number} (${block.name}): missing "### File Reference Table" subsection. Add an H3 heading with a markdown table listing every file the feature creates or modifies (columns: File, Action, Lines, Why). See docs/spec-archive-format.md for the exact shape.`,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T9`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/validate-living-plan.ts build/orchestrator/__tests__/living-plan-static-checks.test.ts
git commit -m "feat(build/orchestrator): validator rejects feature blocks missing ### File Reference Table subsection"
```

---

## Task 6: Validator check — quantified acceptance criterion

**Files:**

- Modify: `build/orchestrator/validate-living-plan.ts`
- Test: `build/orchestrator/__tests__/living-plan-static-checks.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run the tests to verify T10 fails**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T10`
Expected: T10 FAIL (validator returns 0). T10-positive should already PASS once Tasks 3-5 have shipped (it has all required sections + a number in acceptance).

- [ ] **Step 3: Add the check**

Append to the same Increment 1 block:

```typescript
if (!block.hasQuantifiedAcceptance) {
  staticViolations.push({
    rule: "missing-quantified-acceptance",
    message: `Feature ${block.number} (${block.name}): at least one acceptance criterion must contain a number (e.g. "p95 under 100ms", "0 failing tests", "HTTP 410 for all 4 roles"). Subjective phrases like "feature works" or "handles edge cases" do not count. See docs/spec-archive-format.md.`,
  });
}
```

- [ ] **Step 4: Run the tests to verify T10 passes**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T10`
Expected: T10 PASS, T10-positive PASS.

- [ ] **Step 5: Run T7-positive to confirm the full positive case now passes**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts --grep T7-positive`
Expected: T7-positive PASS (this plan has all four new required fields).

- [ ] **Step 6: Run the full validator test suite to confirm no regressions**

Run: `bun test build/orchestrator/__tests__/living-plan-static-checks.test.ts`
Expected: all tests pass (T1-T5 existing + T6 + T7 + T8 + T9 + T10).

- [ ] **Step 7: Commit**

```bash
git add build/orchestrator/validate-living-plan.ts build/orchestrator/__tests__/living-plan-static-checks.test.ts
git commit -m "feat(build/orchestrator): validator requires at least one quantified acceptance criterion per feature"
```

---

## Task 7: Update synthesizer prompt in `build/SKILL.md.tmpl`

**Files:**

- Modify: `build/SKILL.md.tmpl`

The synthesizer's prompt (defined inside Step 5 "Synthesize living plan(s)") must instruct the synthesizer to produce the four new required sections per feature. Otherwise the validator will reject every newly synthesized plan and trigger a 3-round retry storm on first run.

- [ ] **Step 1: Locate the synthesis prompt section**

Run: `grep -n 'Each living plan MUST include' build/SKILL.md.tmpl`

Note the line number. This is where the per-feature requirements list starts.

- [ ] **Step 2: Read the surrounding lines to understand the existing format**

Run: `sed -n '410,470p' build/SKILL.md.tmpl` (adjust line range based on Step 1's result).

- [ ] **Step 3: Add new required sections to the synthesizer prompt**

Find the existing list of requirements under "Each living plan MUST include:". After the existing bullet about `Acceptance:` (line-anchored requirement), add three new bullets:

```markdown
- Every `## Feature N:` block MUST also include a line-anchored `Out of scope:`
  field at column 0 listing explicit non-goals (write `Out of scope: none` only
  when literally nothing was scoped out).
- Every `## Feature N:` block MUST include a `### File Reference Table`
  subsection with columns `File | Action | Lines (if modify) | Why` listing
  every file the feature creates or modifies.
- Every `## Feature N:` block MUST include a `### Verification Spec`
  subsection. For `code` features: smoke run (ordered commands) + acceptance
  probes table (one row per acceptance criterion, columns
  `AC# | Probe command | Expected output | If fails`) + optional verification
  artifacts list. For non-code features (`writing`/`experiment`/`research`/`manual`):
  verification artifacts list + single-sentence pass criteria.
- The `Acceptance:` field MUST include at least one quantified criterion
  containing a number (e.g. "p95 under 100ms", "0 failing tests",
  "HTTP 410 for all 4 roles"). Subjective phrases like "feature works"
  or "handles edge cases" are REJECTED by the validator.
```

- [ ] **Step 4: Add the new fields to the STRUCTURAL SELF-CHECK section**

Run: `grep -n 'REQUIRED FIELDS' build/SKILL.md.tmpl`

Find the self-check section that lists the required line-anchored conditions. After the existing `Acceptance:` requirement, add:

```markdown
- a line that STARTS with `Out of scope:` exists.
- a `### File Reference Table` subsection exists in the body (between the
  feature heading and the next `## ` heading).
- a `### Verification Spec` subsection exists in the body.
- the `Acceptance:` field contains at least one digit (quantified criterion).
```

- [ ] **Step 5: Update the "Common defects to avoid" list**

Run: `grep -n 'Common defects to avoid' build/SKILL.md.tmpl`

Find the numbered list of defects. After defect 5 (stale file:line quotes), add four new defects:

```markdown
6.  **Missing `Out of scope:` field** — every feature block MUST have a
    line-anchored `Out of scope:` field at column 0. The validator rule
    `missing-out-of-scope` rejects plans where any block lacks it.
7.  **Missing `### File Reference Table`** — every feature block MUST list
    its file changes in a `### File Reference Table` subsection. The
    validator rule `missing-file-reference-table` rejects plans without it.
8.  **Missing `### Verification Spec`** — every feature block MUST include
    smoke commands + acceptance probes (code) or artifacts + pass criteria
    (non-code) in a `### Verification Spec` subsection. The validator rule
    `missing-verification-spec` rejects plans without it.
9.  **Vague acceptance criteria** — the `Acceptance:` field MUST include at
    least one number. The validator rule `missing-quantified-acceptance`
    rejects plans where acceptance is purely qualitative.
```

- [ ] **Step 6: Regenerate `build/SKILL.md` from the template**

Run: `bun run gen:skill-docs`
Expected: completes without errors; `build/SKILL.md` is updated to reflect the .tmpl changes.

- [ ] **Step 7: Verify gen-skill-docs sanity tests still pass**

Run: `bun test test/gen-skill-docs.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add build/SKILL.md.tmpl build/SKILL.md
git commit -m "feat(build): synthesizer prompt requires Out of scope, File Reference Table, Verification Spec, quantified acceptance per feature"
```

---

## Task 8: Bump skill version (CHANGELOG optional)

**Files:**

- Modify: `build/SKILL.md.tmpl` (frontmatter `version:` field)
- Regenerate: `build/SKILL.md`
- Optionally modify: `CHANGELOG.md`

Per the CLAUDE.md fork-versioning rule, this repo (`anbangr/gstack`, a personal fork of upstream) does NOT bump the top-level `VERSION` file for fork-specific skill work. The only required version change is the skill's frontmatter `version:` field. A CHANGELOG entry is optional — fork-internal skill changes typically skip CHANGELOG; only do this step if you want a user-visible record OR if the user explicitly requests it.

- [ ] **Step 1: Bump the skill version frontmatter**

In `build/SKILL.md.tmpl`, find the YAML frontmatter at the top:

```yaml
version: 1.30.0
```

Bump to `1.31.0` (minor bump — new required sections in synthesizer output is a substantial behavior change for the skill).

- [ ] **Step 2: Regenerate `build/SKILL.md` to reflect the version bump**

Run: `bun run gen:skill-docs`
Expected: completes without errors; `build/SKILL.md` reflects the new version.

- [ ] **Step 3 (OPTIONAL): Add a CHANGELOG entry**

Skip this step unless you want a user-visible CHANGELOG entry for this fork-internal change. If you do want one:

1. Run `head -80 CHANGELOG.md` to see the current entry style and choose a heading convention that matches (e.g., `## [build skill 1.31.0]`, `## [Unreleased]`, or whatever the most recent entries use).
2. Add an entry at the top of the file describing what shipped — see the design doc at `docs/superpowers/specs/2026-05-28-spec-grade-living-plans-design.md` for the user-visible deltas to summarize.
3. Verify reverse chronological order with `grep "^## \[" CHANGELOG.md | head -10`.

- [ ] **Step 4: Commit**

If Step 3 was skipped:

```bash
git add build/SKILL.md.tmpl build/SKILL.md
git commit -m "chore(build): bump skill to 1.31.0 for Increment 1 (spec-grade living plans)"
```

If Step 3 was performed:

```bash
git add build/SKILL.md.tmpl build/SKILL.md CHANGELOG.md
git commit -m "chore(build): bump skill to 1.31.0 + CHANGELOG entry for Increment 1"
```

---

## Task 9: Full test pass and skill validation

- [ ] **Step 1: Run the full free test suite**

Run: `bun test`
Expected: all tests pass. This includes skill validation, gen-skill-docs quality checks, browse integration tests, plus our new validator tests.

If any test fails:

- Read the failing output carefully.
- If the failure is in a test file you touched (`living-plan-static-checks.test.ts`), fix the issue inline and re-run.
- If it's in an unrelated test, check whether the failure is pre-existing on `main` (run `git stash && bun test <file> && git stash pop`). If pre-existing, note in the PR; if not pre-existing, your change caused it — investigate.

- [ ] **Step 2: Run the skill health dashboard**

Run: `bun run skill:check`
Expected: build skill shows green; no token-ceiling warnings unless the template grew past ~40K tokens (the four new bullets in the synthesis prompt should add only ~500 tokens, well within budget).

- [ ] **Step 3: Run the slop-scan to confirm no new sloppy patterns**

Run: `bun run slop:diff`
Expected: no new findings beyond baseline.

- [ ] **Step 4: Sanity-test the validator on a synthetic full plan**

Create a temp test plan covering all required sections and run the validator:

```bash
cat > /tmp/test-plan-increment-1.md <<'EOF'
## Feature 1: Order Expiry

Origin trace: source plan §4.2
Acceptance: 1. Orders older than 30 days return HTTP 410; 2. query p95 under 100ms
Out of scope: vendor billing integration

### Phase 1.1: Build it
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: code it
- [ ] **Review**: review

### File Reference Table
| File | Action | Lines | Why |
|---|---|---|---|
| `src/order.ts` | modify | 42-65 | Add expiry check |
| `test/order-expiry.test.ts` | create | — | Unit tests |

### Verification Spec
Smoke run:
1. `bun run build` — exit 0
2. `bun test test/order-expiry/` — exit 0

| AC# | Probe | Expected | If fails |
|---|---|---|---|
| 1 | `curl -i localhost:3000/orders/expired-id` | HTTP/1.1 410 | broken |
| 2 | `bun run scripts/bench.ts` | `p95 < 100ms` | broken |
EOF

bun run build/orchestrator/validate-living-plan.ts /tmp/test-plan-increment-1.md
echo "exit: $?"
```

Expected: exit 0 (plan passes all checks).

Then test a deliberately bad plan:

```bash
cat > /tmp/test-plan-bad.md <<'EOF'
## Feature 1: Vague feature

Origin trace: source plan §4.2
Acceptance: feature works correctly

### Phase 1.1: Build it
- [ ] **Implementation**: code it
EOF

bun run build/orchestrator/validate-living-plan.ts /tmp/test-plan-bad.md
echo "exit: $?"
```

Expected: exit 2; stderr contains all four new violation rules
(`missing-out-of-scope`, `missing-verification-spec`,
`missing-file-reference-table`, `missing-quantified-acceptance`).

- [ ] **Step 5: Clean up the sanity-test temp files**

Run: `rm -f /tmp/test-plan-increment-1.md /tmp/test-plan-bad.md`

- [ ] **Step 6: Confirm no uncommitted changes remain**

Run: `git status`
Expected: clean working tree (or only the pre-existing modified files noted at session start, none of which this work touches: `build/SKILL.md`, `build/configure.cm`, `gstack-upgrade/SKILL.md`, `plan-api-review/SKILL.md`, `plan-arch-review/SKILL.md`, `plan-domain-review/SKILL.md`, `plan-modernization-review/SKILL.md`, `scripts/proactive-suggestions.json`).

Increment 1 is now complete and ready to ship via `/ship`.

---

## What comes next

After Increment 1 lands and we observe at least 3 live builds with the new validator, the next plans are:

- **Increment 2 plan**: Per-feature spec generation in parent orchestrator + shared codex gate library + `planReviewer` removal + sentinel-based compaction recovery + AskUserQuestion interrogation flow. Will introduce `Spec source:` field and cross-file preservation checks (which extend this Increment's validator).
- **Increment 3 plan**: `featureVerifier` absorbs `featureReview`; `configure.cm` migration; `feature-verifier.ts` rewritten to run pre-designed Verification Spec deterministically.
- **Increment 4 plan**: `/build` plan discovery reads spec archives (skip Phase A on covered features); `gstack-build spec-to-issue <path>` promotion command.

Each future plan should be written via `/superpowers:writing-plans` against the same design spec, scoped to its specific Increment.
