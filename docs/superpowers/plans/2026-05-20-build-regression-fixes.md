# Build Regression Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three build-orchestrator regressions: split non-code phases, parent-workspace hygiene false attribution, and missing `GSTACK_HOME` isolation in orchestrator tests.

**Architecture:** Keep the parser strict and add a narrow diagnostic for adjacent split non-code gate pairs. Refresh parent-workspace hygiene snapshots immediately before each subagent role invocation so only role-window mutations are attributed to that role. Broaden the test isolation lint to recognize the shared helper from nested test directories, then use that helper in the two offending files.

**Tech Stack:** Bun test runner, TypeScript, Node `fs/path`, existing gstack build orchestrator modules.

---

### Task 1: Add Split Non-Code Phase Diagnostics

**Files:**
- Modify: `build/orchestrator/parser.ts`
- Modify: `build/orchestrator/__tests__/parser.test.ts`

- [ ] **Step 1: Add failing parser tests for split non-code phases**

Add these tests inside `describe("parsePlan — phase kinds", () => { ... })` in `build/orchestrator/__tests__/parser.test.ts`, after the existing `structural-mirroring flat-task format` test:

```ts
  it("warns when adjacent writing phases split Draft and Review gates", () => {
    const md = `## Feature 1: Paper

### Phase 1 [writing]: Draft paper
- [ ] **Draft**: write the paper

### Phase 2 [writing]: Review paper
- [ ] **Review**: review the paper
`;
    const { phases, warnings, droppedPhasesCount } = parsePlan(md);
    expect(phases).toHaveLength(0);
    expect(droppedPhasesCount).toBe(2);
    expect(warnings.join("\n")).toContain(
      'Phases 1 ("Draft paper") and 2 ("Review paper") look like a split writing phase',
    );
    expect(warnings.join("\n")).toContain(
      "merge them into one [writing] phase containing both **Draft** and **Review** checkboxes",
    );
  });

  it("does not emit split-phase guidance for unrelated dropped non-code phases", () => {
    const md = `## Feature 1: Paper

### Phase 1 [writing]: Draft paper
- [ ] **Draft**: write the paper

### Phase 2 [research]: Review prior work
- [ ] **Review**: review the notes
`;
    const { warnings } = parsePlan(md);
    expect(warnings.join("\n")).not.toContain("look like a split");
  });
```

- [ ] **Step 2: Run tests to verify the new diagnostic is missing**

Run:

```bash
bun test build/orchestrator/__tests__/parser.test.ts --test-name-pattern "split"
```

Expected: the first new test fails because the warnings do not yet include `look like a split writing phase`.

- [ ] **Step 3: Add dropped-phase candidate tracking**

In `build/orchestrator/parser.ts`, add these definitions below `export interface ParseOpts`:

```ts
interface DroppedPhaseCandidate {
  featureIndex: number;
  number: string;
  name: string;
  kind: PhaseKind;
  hasImplementation: boolean;
  hasReview: boolean;
}

const IMPL_MARKER_BY_KIND: Record<PhaseKind, string> = {
  code: "**Implementation**",
  writing: "**Draft**",
  experiment: "**Execute**",
  research: "**Explore**",
  manual: "**Action Required**",
};

const REVIEW_MARKER_BY_KIND: Record<PhaseKind, string> = {
  code: "**Review**",
  writing: "**Review**",
  experiment: "**Review**",
  research: "**Review**",
  manual: "**Verify Completion**",
};

function appendSplitNonCodePhaseWarnings(
  dropped: DroppedPhaseCandidate[],
  warnings: string[],
): void {
  for (let i = 0; i < dropped.length - 1; i++) {
    const first = dropped[i];
    const second = dropped[i + 1];
    if (first.kind === "code") continue;
    if (first.featureIndex !== second.featureIndex) continue;
    if (first.kind !== second.kind) continue;
    if (!first.hasImplementation || first.hasReview) continue;
    if (second.hasImplementation || !second.hasReview) continue;

    warnings.push(
      `Phases ${first.number} ("${first.name}") and ${second.number} ("${second.name}") look like a split ${first.kind} phase; merge them into one [${first.kind}] phase containing both ${IMPL_MARKER_BY_KIND[first.kind]} and ${REVIEW_MARKER_BY_KIND[first.kind]} checkboxes.`,
    );
  }
}
```

- [ ] **Step 4: Record dropped candidates and append the diagnostic**

Inside `parsePlan`, after `let droppedPhasesCount = 0;`, add:

```ts
  const droppedCandidates: DroppedPhaseCandidate[] = [];
```

In the `finalize` function, replace the current dropped-phase branch:

```ts
    } else {
      droppedPhasesCount++;
    }
```

with:

```ts
    } else {
      droppedPhasesCount++;
      const feature = ensureFeature();
      droppedCandidates.push({
        featureIndex: feature.index,
        number: p.number!,
        name: p.name!,
        kind: p.kind ?? "code",
        hasImplementation: p.implementationCheckboxLine != null,
        hasReview: p.reviewCheckboxLine != null,
      });
    }
```

Near the end of `parsePlan`, immediately after `finalize(lines.length);`, add:

```ts
  appendSplitNonCodePhaseWarnings(droppedCandidates, warnings);
```

- [ ] **Step 5: Run parser tests**

Run:

```bash
bun test build/orchestrator/__tests__/parser.test.ts
```

Expected: all parser tests pass, including the new split-phase tests.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add build/orchestrator/parser.ts build/orchestrator/__tests__/parser.test.ts
git commit -m "fix(build): warn on split non-code phases"
```

Expected: commit succeeds.

### Task 2: Document and Pin Non-Code Phase Shape in Prompts

**Files:**
- Modify: `build/orchestrator/README.md`
- Modify: `build/orchestrator/plan-reviewer.ts`
- Modify: `build/orchestrator/__tests__/plan-review-prompts.test.ts`

- [ ] **Step 1: Add failing prompt tests**

In `build/orchestrator/__tests__/plan-review-prompts.test.ts`, add this test inside `describe("SYNTH_REVISION_PROMPT (synthesizer)", () => { ... })`, before the snapshot test:

```ts
  it("preserves the one-phase two-gate contract for non-code phases", () => {
    expect(SYNTH_REVISION_PROMPT).toContain("Do NOT split a non-code phase");
    expect(SYNTH_REVISION_PROMPT).toContain("[writing]");
    expect(SYNTH_REVISION_PROMPT).toContain("**Draft**");
    expect(SYNTH_REVISION_PROMPT).toContain("**Review**");
    expect(SYNTH_REVISION_PROMPT).toContain("one phase");
  });
```

- [ ] **Step 2: Run prompt tests to verify failure**

Run:

```bash
bun test build/orchestrator/__tests__/plan-review-prompts.test.ts
```

Expected: the new prompt test fails because `SYNTH_REVISION_PROMPT` does not yet include the non-code phase contract.

- [ ] **Step 3: Update the synthesizer prompt**

In `build/orchestrator/plan-reviewer.ts`, add this paragraph to `SYNTH_REVISION_PROMPT` after the paragraph ending `Do not re-resolve already-resolved items.`:

```ts

Phase shape contract:
- Do NOT split a non-code phase into separate draft/action and review phases.
- Each executable phase must contain both required checkboxes for its kind.
- For [writing], one phase contains both `- [ ] **Draft**: ...` and `- [ ] **Review**: ...`.
- For [experiment], one phase contains both `- [ ] **Execute**: ...` and `- [ ] **Review**: ...`.
- For [research], one phase contains both `- [ ] **Explore**: ...` and `- [ ] **Review**: ...`.
- For [manual], one phase contains both `- [ ] **Action Required**: ...` and `- [ ] **Verify Completion**: ...`.
```

- [ ] **Step 4: Document the non-code examples**

In `build/orchestrator/README.md`, after the legacy phase format example and before the paragraph beginning `Feature and phase numbers can be`, add:

```md
**Non-code phase kinds** use the same one-phase/two-gate rule. Do not split
draft/action work and review into separate phases. One executable phase must
contain both required checkboxes for its kind:

```markdown
### Phase 2.1 [writing]: Draft and review the paper

- [ ] **Draft**: Write the paper section.
- [ ] **Review**: Review the section for accuracy and clarity.

### Phase 2.2 [experiment]: Run and review the ablation

- [ ] **Execute**: Run the ablation command and capture results.
- [ ] **Review**: Check result integrity and summarize findings.

### Phase 2.3 [research]: Explore and review prior work

- [ ] **Explore**: Collect relevant sources and notes.
- [ ] **Review**: Verify claims against the collected sources.

### Phase 2.4 [manual]: Complete and verify external setup

- [ ] **Action Required**: Complete the external setup step.
- [ ] **Verify Completion**: Confirm the setup is complete.
```
```

- [ ] **Step 5: Update prompt snapshots**

Run:

```bash
bun test build/orchestrator/__tests__/plan-review-prompts.test.ts --update-snapshots
```

Expected: tests pass and `build/orchestrator/__tests__/__snapshots__/plan-review-prompts.test.ts.snap` updates.

- [ ] **Step 6: Run docs/prompt focused tests**

Run:

```bash
bun test build/orchestrator/__tests__/plan-review-prompts.test.ts
```

Expected: all prompt tests pass.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add build/orchestrator/README.md build/orchestrator/plan-reviewer.ts build/orchestrator/__tests__/plan-review-prompts.test.ts build/orchestrator/__tests__/__snapshots__/plan-review-prompts.test.ts.snap
git commit -m "docs(build): specify non-code phase gate shape"
```

Expected: commit succeeds.

### Task 3: Refresh Parent Workspace Hygiene Snapshots Per Role

**Files:**
- Modify: `build/orchestrator/cli.ts`
- Modify: `build/orchestrator/__tests__/cli.test.ts`

- [ ] **Step 1: Add focused helper tests for parent snapshot timing**

In `build/orchestrator/__tests__/cli.test.ts`, add this test after `detects parent workspace root HEAD and status changes`:

```ts
  it("allows parent workspace changes that happened before the role snapshot", () => {
    const workspace = path.join(tmpDir!, "parent-window");
    fs.mkdirSync(workspace, { recursive: true });
    git(["init", "--initial-branch=main"], workspace);
    git(["config", "user.email", "test@test.com"], workspace);
    git(["config", "user.name", "Test User"], workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root init"], workspace);

    fs.writeFileSync(path.join(workspace, "README.md"), "root changed\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "orchestrator-owned parent move"], workspace);

    const beforeRole = captureGitSnapshot(workspace);
    const verdict = validateParentWorkspaceUnchanged({
      before: beforeRole,
      workspaceRoot: workspace,
      label: "primary implementor",
    });

    expect(verdict).toEqual({ ok: true, errors: [] });
  });
```

This test documents the intended snapshot-window behavior. It passes against the helper today, but the production call sites still need to capture `beforeRole` at the right time.

- [ ] **Step 2: Add a small parent snapshot refresher**

In `build/orchestrator/cli.ts`, below `parentWorkspaceSnapshot`, add:

```ts
function refreshParentWorkspaceSnapshot(parentWorkspace: {
  workspaceRoot: string | null;
  snapshot: GitSnapshot | null;
}): {
  workspaceRoot: string | null;
  snapshot: GitSnapshot | null;
} {
  if (!parentWorkspace.workspaceRoot) {
    return { workspaceRoot: null, snapshot: null };
  }
  return {
    workspaceRoot: parentWorkspace.workspaceRoot,
    snapshot: captureGitSnapshot(parentWorkspace.workspaceRoot),
  };
}
```

- [ ] **Step 3: Refresh snapshots at mutable-role call sites**

In `runPhase`, for `RUN_GEMINI`, add this immediately before the first `runRoleTask` or dry-run mock result is created:

```ts
      const parentBeforeRole = refreshParentWorkspaceSnapshot(parentWorkspace);
```

Then change the `applyMutableAgentHygiene` call in that block from:

```ts
        parentWorkspace,
```

to:

```ts
        parentWorkspace: parentBeforeRole,
```

Repeat the same pattern in the `RUN_GEMINI_FROM_REVIEW` block:

```ts
      const parentBeforeRole = refreshParentWorkspaceSnapshot(parentWorkspace);
```

and pass `parentWorkspace: parentBeforeRole` into that block's `applyMutableAgentHygiene` call.

- [ ] **Step 4: Refresh snapshots inside `runCodexReview` gate call sites**

In `runCodexReview`, inside the `for (const { name, role } of plan.gates)` loop, capture a role-window parent snapshot immediately after the existing child-repo snapshot:

```ts
    const parentBeforeGate = refreshParentWorkspaceSnapshot(opts.parentWorkspace);
```

Change the first `applyGateHygiene` call in that loop from:

```ts
      parentWorkspace: opts.parentWorkspace,
```

to:

```ts
      parentWorkspace: parentBeforeGate,
```

For the sandbox retry path in the same loop, capture a second parent snapshot immediately before `runGate(name, role, { sandbox: "danger-full-access", suffix: "sandbox-retry" })`:

```ts
      const parentBeforeRetryGate = refreshParentWorkspaceSnapshot(opts.parentWorkspace);
```

Change the retry `applyGateHygiene` call from:

```ts
        parentWorkspace: opts.parentWorkspace,
```

to:

```ts
        parentWorkspace: parentBeforeRetryGate,
```

- [ ] **Step 5: Run focused hygiene tests**

Run:

```bash
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "hygiene|workspace root|parent workspace"
```

Expected: all matching tests pass.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/cli.test.ts
git commit -m "fix(build): scope parent hygiene to role window"
```

Expected: commit succeeds.

### Task 4: Fix GSTACK_HOME Test Isolation

**Files:**
- Modify: `test/test-isolation-lint.test.ts`
- Modify: `build/orchestrator/__tests__/halt-events-e2e.test.ts`
- Modify: `build/orchestrator/__tests__/skill-fault-detector.test.ts`

- [ ] **Step 1: Add lint unit coverage for nested helper imports**

In `test/test-isolation-lint.test.ts`, add this test inside the existing `describe("test isolation lint", () => { ... })`, before the corpus-scanning test:

```ts
  test("recognizes useIsolatedGstackHome imported from nested test directories", () => {
    const src = [
      'import { describe } from "bun:test";',
      'import { useIsolatedGstackHome } from "../../../test/helpers/test-home";',
      'import { detectSkillFaults } from "../skill-fault-detector";',
      'describe("nested", () => {',
      '  useIsolatedGstackHome("nested-");',
      '  test("case", () => detectSkillFaults({} as any));',
      '});',
    ].join("\n");

    expect(fileIsolatesGstackHome(src)).toBe(true);
  });
```

- [ ] **Step 2: Run lint test to verify failure**

Run:

```bash
bun test test/test-isolation-lint.test.ts --test-name-pattern "nested test directories"
```

Expected: the new test fails because the import matcher only accepts `./helpers/test-home`.

- [ ] **Step 3: Broaden the helper import matcher**

In `fileIsolatesGstackHome`, replace the current `importsHelper` regex assignment with:

```ts
  const importsHelper =
    /import\s*\{[^}]*\buseIsolatedGstackHome\b[^}]*\}\s*from\s*["'](?:\.\/helpers\/test-home|(?:\.\.\/)+test\/helpers\/test-home)["']/.test(
      src,
    );
```

Keep the existing `callsHelper` check unchanged.

- [ ] **Step 4: Isolate `halt-events-e2e.test.ts`**

In `build/orchestrator/__tests__/halt-events-e2e.test.ts`, add this import:

```ts
import { useIsolatedGstackHome } from "../../../test/helpers/test-home";
```

Inside `describe("halt-events e2e: polis HAND_MERGED_FEATURE regression", () => {`, before `let tmp: string;`, add:

```ts
  useIsolatedGstackHome("halt-events-e2e-");
```

- [ ] **Step 5: Isolate `skill-fault-detector.test.ts`**

In `build/orchestrator/__tests__/skill-fault-detector.test.ts`, add this import:

```ts
import { useIsolatedGstackHome } from "../../../test/helpers/test-home";
```

Inside `describe("state_jsonpath learned pattern", () => {`, before the first `test(...)`, add:

```ts
  useIsolatedGstackHome("skill-fault-detector-");
```

Inside `describe("HAND_MERGED_FEATURE detector", () => {`, before the first `test(...)`, add the same line:

```ts
  useIsolatedGstackHome("skill-fault-detector-");
```

- [ ] **Step 6: Run isolation tests**

Run:

```bash
bun test build/orchestrator/__tests__/halt-events-e2e.test.ts build/orchestrator/__tests__/skill-fault-detector.test.ts test/test-isolation-lint.test.ts
```

Expected: all three test files pass; `test-isolation-lint` reports no offenders.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add test/test-isolation-lint.test.ts build/orchestrator/__tests__/halt-events-e2e.test.ts build/orchestrator/__tests__/skill-fault-detector.test.ts
git commit -m "test(build): isolate fault detector GSTACK_HOME writes"
```

Expected: commit succeeds.

### Task 5: Final Verification

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run targeted regression suites**

Run:

```bash
bun test \
  build/orchestrator/__tests__/parser.test.ts \
  build/orchestrator/__tests__/plan-review-prompts.test.ts \
  build/orchestrator/__tests__/cli.test.ts \
  build/orchestrator/__tests__/halt-events-e2e.test.ts \
  build/orchestrator/__tests__/skill-fault-detector.test.ts \
  test/test-isolation-lint.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run the audit-skip regression suites from the current branch plan**

Run:

```bash
bun test \
  build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts \
  build/orchestrator/__tests__/manual-recovery-emit-site.test.ts \
  test/gstack-upgrade-migration-v1_40_5_0.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 3: Run the full suite**

Run:

```bash
bun test
```

Expected: full suite passes. If a failure remains, classify it with exact file/test name and confirm whether it is caused by the current task diff before changing code.

- [ ] **Step 4: Inspect final git state**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: only intentional tracked changes are committed. Pre-existing untracked `.claude/` and `inbox/2026-05-20-current-branch-drain-faults-audit-skip-plan.md` may remain untracked.
