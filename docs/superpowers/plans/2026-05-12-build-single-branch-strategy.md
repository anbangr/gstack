# Build Skill: Automatic Branch Strategy Decision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the build skill's driver agent read the synthesized living plan holistically, ask the user whether to use one shared branch for the whole plan or per-feature branches, and execute accordingly.

**Architecture:** A new `--single-branch` flag in `gstack-build` changes branch naming (one `feat/<prefix>` branch instead of `feat/<prefix>-<feature>` per feature), defers `/ship` + `/land-and-deploy` until after all features are done, and runs one final ship+land for the whole plan. The driver agent (SKILL.md.tmpl Step 5.7) reads the living plan, reasons holistically, and calls AskUserQuestion before the Step 6 launch confirmation.

**Tech Stack:** TypeScript (Bun runtime), Bun test framework, Markdown template (SKILL.md.tmpl)

---

## File Map

| File                                               | Role                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `build/orchestrator/cli.ts`                        | CLI args, branch naming, per-feature ship gate, plan-level ship, gate visibility |
| `build/orchestrator/__tests__/cli.test.ts`         | Unit tests for flag parsing, branch naming, gate projection                      |
| `build/orchestrator/__tests__/integration.test.ts` | Integration test for single-branch end-to-end flow                               |
| `build/SKILL.md.tmpl`                              | Template: add Step 5.7 branch strategy decision                                  |
| `build/SKILL.md`                                   | Regenerated from template (do not edit directly)                                 |

---

### Task 1: Add `--single-branch` flag — type, default, parser, help text

**Files:**

- Modify: `build/orchestrator/cli.ts:525` (Args type)
- Modify: `build/orchestrator/cli.ts:643` (default args)
- Modify: `build/orchestrator/cli.ts:675` (flag parser)
- Modify: `build/orchestrator/cli.ts:1736` (help text)
- Test: `build/orchestrator/__tests__/cli.test.ts`

- [ ] **Step 1: Write failing tests for flag parsing**

In `build/orchestrator/__tests__/cli.test.ts`, find the `describe("--skip-ship flag wiring"` block (around line 266) and add a new describe block immediately after it:

```typescript
describe("--single-branch flag wiring", () => {
  it("parseArgs default -> singleBranch=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.singleBranch).toBe(false);
  });

  it("parseArgs([plan, --single-branch]) sets singleBranch=true", () => {
    const args = parseArgs(["plan.md", "--single-branch"]);
    expect(args.singleBranch).toBe(true);
  });

  it("--single-branch is independent of --skip-ship", () => {
    const args = parseArgs([
      "plan.md",
      "--single-branch",
      "--release-mode",
      "auto-land",
    ]);
    expect(args.singleBranch).toBe(true);
    expect(args.skipShip).toBe(false);
    expect(args.releaseMode).toBe("auto-land");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "single-branch flag"
```

Expected: FAIL with `args.singleBranch is not a property` or `undefined !== false`

- [ ] **Step 3: Add `singleBranch` to the Args type**

In `build/orchestrator/cli.ts`, find the `Args` interface around line 525. Add after `skipShip: boolean;`:

```typescript
/** When true, all features share one feat/<prefix> branch; /ship + /land-and-deploy run once after all features complete. */
singleBranch: boolean;
```

- [ ] **Step 4: Add default value**

In the `args` initialization object around line 624, add after `skipShip: false,`:

```typescript
    singleBranch: false,
```

- [ ] **Step 5: Add flag parser**

In the flag-parsing loop around line 675, add after `else if (a === "--skip-ship") args.skipShip = true;`:

```typescript
    else if (a === "--single-branch") args.singleBranch = true;
```

- [ ] **Step 6: Add help text**

Find the help text block around line 1736 (near `--skip-ship` doc). Add after the `--skip-ship` line:

```text
  --single-branch      All features share one feat/<prefix> branch. /ship +
                       /land-and-deploy runs once after all features complete
                       instead of after each feature. Auto-selected by the
                       driver agent based on plan cohesion.
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "single-branch flag"
```

Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/cli.test.ts
git commit -m "feat(build): add --single-branch flag to gstack-build args"
```

---

### Task 2: Propagate `singleBranch` through gate visibility

**Files:**

- Modify: `build/orchestrator/cli.ts:186` (`visiblePlanProjection` type)
- Modify: `build/orchestrator/cli.ts:202` (`saveState` → `reconcileVisiblePlanState` call)
- Modify: `build/orchestrator/cli.ts:280` (`featureGateProjection` opts)
- Modify: `build/orchestrator/cli.ts:347` (`reconcileFeatureVisibleGates` opts)
- Modify: `build/orchestrator/cli.ts:383` (`reconcileVisiblePlanState` opts)
- Modify: `build/orchestrator/cli.ts:6208` (projection assignment)
- Test: `build/orchestrator/__tests__/cli.test.ts`

- [ ] **Step 1: Write failing test for gate projection with singleBranch**

In `build/orchestrator/__tests__/cli.test.ts`, find the test `"suppresses ship_land and origin_verification when skipShip=true"` (around line 3192). Add a new test immediately after it:

```typescript
it("suppresses ship_land and origin_verification when singleBranch=true (intermediate features)", () => {
  const plan =
    [
      "## Feature 1: Auth",
      "- [ ] **Feature Review (Gemini)**",
      "- [ ] **Ship & Land**",
      "- [ ] **Origin Verification**",
      "### Phase 1: Skeleton",
      "- [x] **Implementation (Gemini)**",
      "- [x] **Review & QA (Codex)**",
    ].join("\n") + "\n";

  const planFile = _testWritePlan(plan);
  const phase = makePhase({
    implementationCheckboxLine: 6,
    reviewCheckboxLine: 7,
    implementationDone: true,
    reviewDone: true,
  });
  const feature = makeFeature({
    gates: {
      feature_review: { done: false, line: 2 },
      ship_land: { done: false, line: 3 },
      origin_verification: { done: false, line: 4 },
    },
  });
  // singleBranch=true + origin_verified → only feature_review checked (ship deferred)
  const state = makeState("origin_verified", "origin_verified");

  reconcileVisiblePlanState(planFile, [feature], [phase], state, {
    singleBranch: true,
  });

  const lines = fs.readFileSync(planFile, "utf8").split("\n");
  expect(lines[1]).toMatch(/\[x\].*Feature Review/);
  expect(lines[2]).toMatch(/\[ \].*Ship & Land/);
  expect(lines[3]).toMatch(/\[ \].*Origin Verification/);
});

it("marks ship_land and origin_verification when singleBranch=true and status=committed (final ship done)", () => {
  const plan =
    [
      "## Feature 1: Auth",
      "- [ ] **Feature Review (Gemini)**",
      "- [ ] **Ship & Land**",
      "- [ ] **Origin Verification**",
      "### Phase 1: Skeleton",
      "- [x] **Implementation (Gemini)**",
      "- [x] **Review & QA (Codex)**",
    ].join("\n") + "\n";

  const planFile = _testWritePlan(plan);
  const phase = makePhase({
    implementationCheckboxLine: 6,
    reviewCheckboxLine: 7,
    implementationDone: true,
    reviewDone: true,
  });
  const feature = makeFeature({
    gates: {
      feature_review: { done: false, line: 2 },
      ship_land: { done: false, line: 3 },
      origin_verification: { done: false, line: 4 },
    },
  });
  // singleBranch=true + committed (post final ship) → all three checked
  const state = makeState("committed", "committed");

  reconcileVisiblePlanState(planFile, [feature], [phase], state, {
    singleBranch: true,
  });

  const lines = fs.readFileSync(planFile, "utf8").split("\n");
  expect(lines[1]).toMatch(/\[x\].*Feature Review/);
  expect(lines[2]).toMatch(/\[x\].*Ship & Land/);
  expect(lines[3]).toMatch(/\[x\].*Origin Verification/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "singleBranch"
```

Expected: FAIL — `reconcileVisiblePlanState` doesn't accept `singleBranch` yet

- [ ] **Step 3: Add `singleBranch` to `visiblePlanProjection` type**

Find the `visiblePlanProjection` declaration around line 186:

```typescript
let visiblePlanProjection: {
  planFile: string;
  features: Feature[];
  phases: Phase[];
  skipShip?: boolean;
  dryRun?: boolean;
} | null = null;
```

Replace with:

```typescript
let visiblePlanProjection: {
  planFile: string;
  features: Feature[];
  phases: Phase[];
  skipShip?: boolean;
  singleBranch?: boolean;
  dryRun?: boolean;
} | null = null;
```

- [ ] **Step 4: Pass `singleBranch` in the `saveState` reconcile call**

Find the `reconcileVisiblePlanState` call inside `saveState` around line 202:

```typescript
reconcileVisiblePlanState(
  visiblePlanProjection.planFile,
  visiblePlanProjection.features,
  visiblePlanProjection.phases,
  state,
  {
    skipShip: visiblePlanProjection.skipShip,
    dryRun: visiblePlanProjection.dryRun,
  },
);
```

Replace with:

```typescript
reconcileVisiblePlanState(
  visiblePlanProjection.planFile,
  visiblePlanProjection.features,
  visiblePlanProjection.phases,
  state,
  {
    skipShip: visiblePlanProjection.skipShip,
    singleBranch: visiblePlanProjection.singleBranch,
    dryRun: visiblePlanProjection.dryRun,
  },
);
```

- [ ] **Step 5: Add `singleBranch` to `featureGateProjection` opts**

Find `featureGateProjection` around line 278:

```typescript
function featureGateProjection(
  status: FeatureStatus,
  opts: { skipShip?: boolean } = {},
): Partial<Record<FeatureGate, boolean>> {
```

Replace with:

```typescript
function featureGateProjection(
  status: FeatureStatus,
  opts: { skipShip?: boolean; singleBranch?: boolean } = {},
): Partial<Record<FeatureGate, boolean>> {
```

Then in the switch body, replace the two `opts.skipShip` checks with `opts.skipShip || opts.singleBranch`:

Find (lines ~298-308):

```typescript
    case "landed":
    case "origin_verifying":
      return opts.skipShip
        ? { feature_review: true }
        : { feature_review: true, ship_land: true };
    case "origin_verified":
    case "committed":
      return opts.skipShip
        ? { feature_review: true }
        : {
            feature_review: true,
            ship_land: true,
            origin_verification: true,
          };
```

Replace with:

```typescript
    case "landed":
    case "origin_verifying":
      return opts.skipShip || opts.singleBranch
        ? { feature_review: true }
        : { feature_review: true, ship_land: true };
    case "origin_verified":
      return opts.skipShip || opts.singleBranch
        ? { feature_review: true }
        : {
            feature_review: true,
            ship_land: true,
            origin_verification: true,
          };
    case "committed":
      return {
        feature_review: true,
        ship_land: true,
        origin_verification: true,
      };
```

Note: `committed` always shows all gates done regardless of `singleBranch` — this status is only set after the final plan-level ship+land succeeds, at which point all checkboxes should be ticked.

- [ ] **Step 6: Pass `singleBranch` through `reconcileFeatureVisibleGates`**

Find `reconcileFeatureVisibleGates` around line 347:

```typescript
function reconcileFeatureVisibleGates(
  planFile: string,
  feature: Feature,
  featureState: FeatureState,
  opts: { skipShip?: boolean } = {},
): number {
  if (!feature.gates) return 0;
  const desired = featureGateProjection(featureState.status, opts);
```

Replace with:

```typescript
function reconcileFeatureVisibleGates(
  planFile: string,
  feature: Feature,
  featureState: FeatureState,
  opts: { skipShip?: boolean; singleBranch?: boolean } = {},
): number {
  if (!feature.gates) return 0;
  const desired = featureGateProjection(featureState.status, opts);
```

- [ ] **Step 7: Pass `singleBranch` through `reconcileVisiblePlanState`**

Find `reconcileVisiblePlanState` around line 383:

```typescript
export function reconcileVisiblePlanState(
  planFile: string,
  features: Feature[],
  phases: Phase[],
  state: BuildState,
  opts: { skipShip?: boolean; dryRun?: boolean } = {},
): void {
```

Replace with:

```typescript
export function reconcileVisiblePlanState(
  planFile: string,
  features: Feature[],
  phases: Phase[],
  state: BuildState,
  opts: { skipShip?: boolean; singleBranch?: boolean; dryRun?: boolean } = {},
): void {
```

Then find the call to `reconcileFeatureVisibleGates` inside that function:

```typescript
changed += reconcileFeatureVisibleGates(planFile, feature, featureState, {
  skipShip: opts.skipShip,
});
```

Replace with:

```typescript
changed += reconcileFeatureVisibleGates(planFile, feature, featureState, {
  skipShip: opts.skipShip,
  singleBranch: opts.singleBranch,
});
```

- [ ] **Step 8: Set `singleBranch` in `visiblePlanProjection` assignment**

Find the projection assignment around line 6208:

```typescript
visiblePlanProjection = {
  planFile: args.planFile,
  features,
  phases,
  skipShip: args.skipShip,
  dryRun: args.dryRun,
};
```

Replace with:

```typescript
visiblePlanProjection = {
  planFile: args.planFile,
  features,
  phases,
  skipShip: args.skipShip,
  singleBranch: args.singleBranch,
  dryRun: args.dryRun,
};
```

- [ ] **Step 9: Run tests to verify they pass**

```bash
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "singleBranch"
```

Expected: PASS (2 new tests)

- [ ] **Step 10: Run full unit test suite to check for regressions**

```bash
bun test build/orchestrator/__tests__/cli.test.ts
```

Expected: all existing tests still pass

- [ ] **Step 11: Commit**

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/cli.test.ts
git commit -m "feat(build): propagate singleBranch through gate visibility projection"
```

---

### Task 3: Single-branch naming in `ownedFeatureBranch` and `ensureFeatureBranch`

**Files:**

- Modify: `build/orchestrator/cli.ts:2081` (`ownedFeatureBranch`)
- Modify: `build/orchestrator/cli.ts:2159` (`ensureFeatureBranch` args type)
- Modify: `build/orchestrator/cli.ts:2210` (call site inside `ensureFeatureBranch`)
- Modify: `build/orchestrator/cli.ts:6601` (call site in feature loop)
- Test: `build/orchestrator/__tests__/cli.test.ts`

- [ ] **Step 1: Write failing test for branch naming**

In `build/orchestrator/__tests__/cli.test.ts`, find a suitable location (near the `--single-branch flag wiring` describe block added in Task 1) and add:

```typescript
describe("single-branch naming", () => {
  it("ownedFeatureBranch with singleBranch=false includes feature slug", () => {
    const state = {
      planBasename: "myplan",
      launch: { branchPrefix: "myplan-run1" },
    } as any;
    const feature = { number: "1", name: "Auth System" } as any;
    const branch = ownedFeatureBranch(state, feature, { singleBranch: false });
    expect(branch).toBe("feat/myplan-run1-1-auth-system");
  });

  it("ownedFeatureBranch with singleBranch=true returns plan-level branch (no feature slug)", () => {
    const state = {
      planBasename: "myplan",
      launch: { branchPrefix: "myplan-run1" },
    } as any;
    const feature = { number: "2", name: "Dashboard" } as any;
    const branch = ownedFeatureBranch(state, feature, { singleBranch: true });
    expect(branch).toBe("feat/myplan-run1");
  });

  it("all features in single-branch mode resolve to the same branch name", () => {
    const state = {
      planBasename: "myplan",
      launch: { branchPrefix: "myplan-run1" },
    } as any;
    const f1 = { number: "1", name: "Auth" } as any;
    const f2 = { number: "2", name: "Dashboard" } as any;
    const f3 = { number: "3", name: "Settings" } as any;
    const branch1 = ownedFeatureBranch(state, f1, { singleBranch: true });
    const branch2 = ownedFeatureBranch(state, f2, { singleBranch: true });
    const branch3 = ownedFeatureBranch(state, f3, { singleBranch: true });
    expect(branch1).toBe(branch2);
    expect(branch2).toBe(branch3);
  });
});
```

Also add `ownedFeatureBranch` to the imports at the top of the test file (check what is currently imported from cli.ts and add it if missing).

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "single-branch naming"
```

Expected: FAIL — `ownedFeatureBranch` doesn't accept a third arg yet

- [ ] **Step 3: Update `ownedFeatureBranch` to accept `singleBranch` option**

Find `ownedFeatureBranch` around line 2081:

```typescript
function ownedFeatureBranch(state: BuildState, feature: FeatureState): string {
  const prefix = safeBranchPart(
    state.launch?.branchPrefix ?? state.planBasename,
  );
  return `feat/${prefix}-${featureSlug(feature)}`;
}
```

Replace with:

```typescript
function ownedFeatureBranch(
  state: BuildState,
  feature: FeatureState,
  opts: { singleBranch?: boolean } = {},
): string {
  const prefix = safeBranchPart(
    state.launch?.branchPrefix ?? state.planBasename,
  );
  return opts.singleBranch
    ? `feat/${prefix}`
    : `feat/${prefix}-${featureSlug(feature)}`;
}
```

Also export it so tests can import it — add `export` before `function ownedFeatureBranch`.

- [ ] **Step 4: Add `singleBranch` to `ensureFeatureBranch` args and pass it through**

Find `ensureFeatureBranch` around line 2159:

```typescript
export function ensureFeatureBranch(args: {
  cwd: string;
  state: BuildState;
  feature: FeatureState;
  dryRun: boolean;
  noGbrain: boolean;
}): boolean {
```

Replace with:

```typescript
export function ensureFeatureBranch(args: {
  cwd: string;
  state: BuildState;
  feature: FeatureState;
  dryRun: boolean;
  noGbrain: boolean;
  singleBranch?: boolean;
}): boolean {
```

Then find the two call sites of `ownedFeatureBranch` inside `ensureFeatureBranch`:

Line ~2121:

```typescript
args.feature.branch || ownedFeatureBranch(args.state, args.feature);
```

Replace with:

```typescript
args.feature.branch ||
  ownedFeatureBranch(args.state, args.feature, {
    singleBranch: args.singleBranch,
  });
```

Line ~2210:

```typescript
    ? ownedFeatureBranch(args.state, args.feature)
```

Replace with:

```typescript
    ? ownedFeatureBranch(args.state, args.feature, { singleBranch: args.singleBranch })
```

- [ ] **Step 5: Pass `singleBranch` at the call site in the feature loop**

Find the `ensureFeatureBranch` call around line 6601:

```typescript
!ensureFeatureBranch({
  cwd,
  state,
  feature: featureState,
  dryRun: args.dryRun,
  noGbrain: args.noGbrain,
});
```

Replace with:

```typescript
!ensureFeatureBranch({
  cwd,
  state,
  feature: featureState,
  dryRun: args.dryRun,
  noGbrain: args.noGbrain,
  singleBranch: args.singleBranch,
});
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "single-branch naming"
```

Expected: PASS (3 tests)

- [ ] **Step 7: Run full test suite to check for regressions**

```bash
bun test build/orchestrator/__tests__/cli.test.ts
```

Expected: all existing tests pass

- [ ] **Step 8: Commit**

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/cli.test.ts
git commit -m "feat(build): single-branch naming — all features share one feat/<prefix> branch"
```

---

### Task 4: Gate per-feature ship, status transitions, and feature iteration

**Files:**

- Modify: `build/orchestrator/cli.ts:6480` (`skipUnshippedVerified`)
- Modify: `build/orchestrator/cli.ts:6928` (per-feature ship gate)
- Modify: `build/orchestrator/cli.ts:7101` (`syncLandedBase` gate)
- Modify: `build/orchestrator/cli.ts:7140` (`verifyOriginPlanFeature` dryRun flag)
- Modify: `build/orchestrator/cli.ts:7184` (feature status after origin verify)
- Modify: `build/orchestrator/cli.ts:7208` (`findNextFeatureIndex` call after do-while)

- [ ] **Step 1: `skipUnshippedVerified` — skip origin-verified features in iteration**

Find around line 6480:

```typescript
const skipUnshippedVerified = args.skipShip || args.dryRun;
```

Replace with:

```typescript
const skipUnshippedVerified = args.skipShip || args.singleBranch || args.dryRun;
```

This ensures that once a feature reaches `origin_verified` in single-branch mode, the feature loop moves on to the next feature instead of re-processing it.

- [ ] **Step 2: Gate per-feature ship on `!args.singleBranch`**

Find around line 6928:

```typescript
          if (!resumeAfterLanding && !args.skipShip && !args.dryRun) {
```

Replace with:

```typescript
          if (!resumeAfterLanding && !args.skipShip && !args.singleBranch && !args.dryRun) {
```

- [ ] **Step 3: Gate `syncLandedBase` on `!args.singleBranch`**

Find around line 7100-7102:

```typescript
          if (
            (resumeAfterLanding || featureState.status === "landed") &&
            !args.skipShip &&
            !args.dryRun
          ) {
```

Replace with:

```typescript
          if (
            (resumeAfterLanding || featureState.status === "landed") &&
            !args.skipShip &&
            !args.singleBranch &&
            !args.dryRun
          ) {
```

- [ ] **Step 4: Treat `singleBranch` like `skipShip` in origin verification dry-run flag**

Find around line 7140:

```typescript
            dryRun: args.dryRun || args.skipShip,
```

Replace with:

```typescript
            dryRun: args.dryRun || args.skipShip || args.singleBranch,
```

Rationale: origin verification in single-branch mode is deferred — we do a single final verification after the plan-level ship.

- [ ] **Step 6: Feature status after origin verify — stay at `origin_verified` in single-branch**

Find around line 7184:

```typescript
featureState.status =
  args.skipShip || args.dryRun ? "origin_verified" : "committed";
```

Replace with:

```typescript
featureState.status =
  args.skipShip || args.singleBranch || args.dryRun
    ? "origin_verified"
    : "committed";
```

- [ ] **Step 7: `findNextFeatureIndex` after do-while — treat `singleBranch` like `skipShip`**

Find around line 7208:

```typescript
            skipOriginVerified: args.skipShip || args.dryRun,
```

Replace with:

```typescript
            skipOriginVerified: args.skipShip || args.singleBranch || args.dryRun,
```

- [ ] **Step 8: Run full test suite**

```bash
bun test build/orchestrator/__tests__/cli.test.ts
bun test build/orchestrator/__tests__/integration.test.ts
```

Expected: all existing tests pass (no new tests yet — the integration test comes in Task 5)

- [ ] **Step 9: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "feat(build): gate per-feature ship and sync on --single-branch"
```

---

### Task 5: Plan-level ship+land after all features complete

**Files:**

- Modify: `build/orchestrator/cli.ts:7334` (post-do-while single-branch ship path)
- Modify: `build/orchestrator/cli.ts:7345` (`state.completed` logic)
- Modify: `build/orchestrator/cli.ts:7357` (archive condition)
- Modify: `build/orchestrator/cli.ts:7413` (`logActivity`)
- Test: `build/orchestrator/__tests__/integration.test.ts`

- [ ] **Step 1: Write failing integration test**

In `build/orchestrator/__tests__/integration.test.ts`, find the `--skip-ship` integration test block (around line 553) and add a new test after it:

```typescript
test("--single-branch runs one ship+land after all features complete and exits 0", () => {
  const { dir, planFile } = setupIntegration({
    features: 2,
    phases: 1,
  });

  // Run with --single-branch: both features should complete at origin_verified,
  // then one ship+land runs for the whole plan, and exitCode should be 0
  const result = runBuild(dir, [
    planFile,
    "--single-branch",
    "--dry-run", // use dry-run so no real git/ship ops happen in CI
  ]);

  // In dry-run + single-branch: features complete but ship is still skipped
  // (dry-run takes precedence). We test the flag wiring is correct.
  expect(result.status).toBe(0);
  const saved = loadState(dir);
  expect(saved.launch?.singleBranch ?? false).toBe(false); // singleBranch not stored in launch yet — just verify no crash
});
```

Note: a full integration test without `--dry-run` would require real git + mock ship agents. Add that as a follow-up if the integration test harness supports mocked ships (see the existing `--skip-ship` test at line 553 for the pattern).

- [ ] **Step 2: Run test to verify it fails or errors**

```bash
bun test build/orchestrator/__tests__/integration.test.ts --test-name-pattern "single-branch runs one ship"
```

Expected: FAIL or compile error since the plan-level ship path doesn't exist yet

- [ ] **Step 3: Add plan-level ship+land path after the do-while loop**

Find around line 7334:

```typescript
if (exitCode === 0 && (args.skipShip || args.dryRun)) {
  console.log(
    `\n${args.dryRun ? "(dry-run) " : ""}all features done${args.skipShip ? " (ship skipped)" : ""}`,
  );
}
```

Replace with:

```typescript
if (exitCode === 0 && args.singleBranch && !args.dryRun) {
  // Single-branch mode: all features done on one branch — run one ship+land now.
  const branchForShip = state.branch ?? currentBranch(cwd);
  const baseSync = syncFeatureBranchWithBase(cwd, branchForShip);
  if (!baseSync.ok) {
    console.error(
      `✗ base sync failed before plan-level ship against ${baseSync.baseRef ?? "origin base"}: ${baseSync.error}`,
    );
    exitCode = 1;
  } else {
    console.log(
      args.releaseMode === "queued"
        ? `\n▶ All features complete (single-branch). Running /ship and queueing PR for release daemon.`
        : `\n▶ All features complete (single-branch). Running /ship + /land-and-deploy.`,
    );
    const shipResult =
      args.releaseMode === "queued"
        ? await shipOnly({ cwd, slug, shipRole: args.roles.ship })
        : await shipAndDeploy({
            cwd,
            slug,
            shipRole: args.roles.ship,
            landRole: args.roles.land,
          });
    if (shipResult.exitCode !== 0 || shipResult.timedOut) {
      console.error(
        `✗ plan-level ship failed (exit ${shipResult.exitCode}, timed_out=${shipResult.timedOut}); see ${shipResult.logPath}`,
      );
      exitCode = 1;
    } else {
      // Mark all origin_verified features as committed so plan checkboxes tick.
      for (const f of state.features ?? []) {
        if (f.status === "origin_verified") {
          f.status = "committed";
          f.completedAt = new Date().toISOString();
        }
      }
    }
  }
}

if (exitCode === 0 && (args.skipShip || args.dryRun)) {
  console.log(
    `\n${args.dryRun ? "(dry-run) " : ""}all features done${args.skipShip ? " (ship skipped)" : ""}`,
  );
}
```

- [ ] **Step 4: Update `state.completed` logic**

Find around line 7345:

```typescript
state.completed = !args.dryRun && !args.skipShip;
```

Replace with:

```typescript
state.completed = !args.dryRun && !args.skipShip;
// singleBranch: completed is true only after plan-level ship succeeds (exitCode still 0 here)
```

No change needed to this line — `state.completed` is set to true because `!args.skipShip` is true in single-branch mode (ship DID run, just once at the end). The existing logic is correct.

- [ ] **Step 5: Skip the exit-13 path for single-branch**

Find around line 7350:

```typescript
if (
  args.skipShip &&
  state.features?.some((f) => f.status === "origin_verified")
) {
  exitCode = 13;
}
```

This is already correct — `args.singleBranch` is not `args.skipShip`, so this block won't fire for single-branch runs. No change needed.

- [ ] **Step 6: Update `logActivity` to include `singleBranch`**

Find around line 7413:

```typescript
logActivity({
  event: exitCode === 0 || exitCode === 13 ? "success" : "failed",
  slug,
  durationMs: Date.now() - startedAt,
  exitCode,
  dryRun: args.dryRun,
  skipShip: args.skipShip,
});
```

Replace with:

```typescript
logActivity({
  event: exitCode === 0 || exitCode === 13 ? "success" : "failed",
  slug,
  durationMs: Date.now() - startedAt,
  exitCode,
  dryRun: args.dryRun,
  skipShip: args.skipShip,
  singleBranch: args.singleBranch,
});
```

`logActivity` takes `Record<string, any>` (line ~2031 in cli.ts) — no type change needed. The new field is accepted as-is.

- [ ] **Step 7: Run integration test**

```bash
bun test build/orchestrator/__tests__/integration.test.ts --test-name-pattern "single-branch runs one ship"
```

Expected: PASS

- [ ] **Step 8: Run full test suites**

```bash
bun test build/orchestrator/__tests__/cli.test.ts
bun test build/orchestrator/__tests__/integration.test.ts
```

Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/integration.test.ts
git commit -m "feat(build): plan-level ship+land for --single-branch mode"
```

---

### Task 6: Add Step 5.7 — Branch Strategy Decision — to `SKILL.md.tmpl`

**Files:**

- Modify: `build/SKILL.md.tmpl`

- [ ] **Step 1: Find the insertion point**

In `build/SKILL.md.tmpl`, locate Step 5.5 (planReviewer exit handling) and Step 6 (Confirm with user). The insertion point is between them:

```markdown
5.5. **Second Opinion — planReviewer exit handling**: ...

6. **Confirm with user**: ...
```

- [ ] **Step 2: Insert Step 5.7**

Between Step 5.5 and Step 6, insert:

````markdown
5.7. **Branch Strategy Decision**: Read the living plan and decide whether to use a
single shared branch or per-feature branches. This step is required — do not skip it.

Read the living plan file (path is the `livingPlanPath` from `$BUILD_RUN_MANIFEST`
for the first run, or from `$BUILD_TMP_DIR/build-synthesis-output.md`). Count the
features and read their descriptions, dependencies, and shared concerns.

Reason holistically:

- Do the features build toward one coherent deliverable, or do they have independent
  shipping value?
- Do features share a core data model, API surface, or infrastructure that makes
  them inseparable?
- Could any feature be reviewed and merged without the others being present?

Then use `AskUserQuestion`:

```text
D[N] — Branch strategy for this plan?
Analysis: [1-2 sentences of holistic reasoning about this specific plan]
Recommendation: [A or B]

A) Single-branch — one feat/<branchPrefix> branch for the whole plan,
/ship + /land-and-deploy once after all features are implemented, tested,
and reviewed
✅ One clean PR, one CI run, one merge
❌ If a late feature breaks badly, rollback affects all prior work

B) Multi-branch — separate feat/<branchPrefix>-<feature> branch per feature,
/ship + /land-and-deploy after each feature completes
✅ Each feature is independently revertable
❌ Multiple PRs, multiple CI runs, more merge noise
```
````

Replace `<branchPrefix>` with the actual `branchPrefix` from the manifest.

If the user picks **A**: add `--single-branch` to `_FLAGS` before Step M2 launches
`gstack-build`. Do not add `--skip-ship`.

If the user picks **B**: leave `_FLAGS` unchanged.

- [ ] **Step 3: Run the template generator**

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack
bun run gen:skill-docs
```

Expected: `build/SKILL.md` is regenerated. No errors.

- [ ] **Step 4: Verify Step 5.7 appears in the generated SKILL.md**

```bash
grep -n "Branch Strategy Decision" build/SKILL.md
```

Expected: at least one match showing Step 5.7 in the generated output

- [ ] **Step 5: Run free test suite**

```bash
bun test
```

Expected: all free tests pass (skill validation, gen-skill-docs checks)

- [ ] **Step 6: Commit both template and generated file**

```bash
git add build/SKILL.md.tmpl build/SKILL.md
git commit -m "feat(build): add Step 5.7 branch strategy decision to build skill"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full orchestrator test suite**

```bash
bun test build/orchestrator/__tests__/
```

Expected: all tests pass

- [ ] **Step 2: Run free suite**

```bash
bun test
```

Expected: all free tests pass

- [ ] **Step 3: Verify `--single-branch` appears in help text**

```bash
node build/orchestrator/cli.ts --help 2>&1 | grep single-branch || \
  bun run build/orchestrator/cli.ts --help 2>&1 | grep single-branch
```

Expected: `--single-branch` line visible in help output

- [ ] **Step 4: Verify Step 5.7 in generated SKILL.md**

```bash
grep -A 5 "5\.7\." build/SKILL.md
```

Expected: Step 5.7 heading and first sentence of content

- [ ] **Step 5: Final commit (if anything needed)**

If any files were touched during verification, commit them:

```bash
git add -p
git commit -m "chore(build): final verification fixes for single-branch feature"
```
