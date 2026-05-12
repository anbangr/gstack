# Design: Build Skill — Automatic Branch Strategy Decision

**Date:** 2026-05-12
**Branch:** feat/living-plan-step-visibility
**Status:** Approved

## Problem

The `gstack-build` CLI currently creates a separate `feat/<prefix>-<feature>` branch
for every feature in a plan and runs `/ship` + `/land-and-deploy` after each feature
completes. For plans where features form one coherent deliverable, this produces
unnecessary noise: multiple PRs, multiple CI runs, multiple merges.

## Goal

Let the driver agent (the orchestrator Claude session) read the synthesized living
plan holistically and decide — and explicitly ask the user to confirm — whether to
use a single shared branch for the whole plan or per-feature branches.

## Design

### Step 5.7 — Branch Strategy Decision (new, in SKILL.md.tmpl)

Inserted between Step 5.5 (plan reviewer exit handling) and Step 6 (confirm with user),
after the living plan is fully synthesized.

The driver agent:

1. Reads the living plan file (path known from the synthesis summary in `build-synthesis-output.md`)
2. Reasons holistically: are features tightly coupled, do they form one coherent
   deliverable, or do they have independent shipping value?
3. Makes a recommendation (single-branch or multi-branch)
4. Calls `AskUserQuestion` with reasoning and two explicit options

If the user picks single-branch, `--single-branch` is added to `_FLAGS` before
Step M2 launches `gstack-build`. If multi-branch, `_FLAGS` is unchanged.

### AskUserQuestion format

```
D<N> — Branch strategy for this plan?
Analysis: <1-2 sentences of holistic reasoning>
Recommendation: A) single-branch

A) Single-branch — one `feat/<prefix>` branch for the whole plan, /ship +
   /land-and-deploy once after all features are implemented, tested, and reviewed
   ✅ One clean PR, one CI run, one merge
   ❌ If a late feature breaks badly, rollback affects all prior work

B) Multi-branch — separate `feat/<prefix>-<feature>` branch per feature, /ship +
   /land-and-deploy after each feature completes
   ✅ Each feature is independently revertable
   ❌ Multiple PRs, multiple CI runs, more merge noise
```

The agent's recommendation is driven by holistic reading of the plan — no fixed
thresholds. It reasons about coupling, shared data models, independent shipping
value, and plan coherence.

### CLI flag: `--single-branch` (new, in cli.ts)

| Behavior         | Current                               | With `--single-branch`                       |
| ---------------- | ------------------------------------- | -------------------------------------------- |
| Branch naming    | `feat/<prefix>-<feature>` per feature | `feat/<prefix>` shared across all features   |
| Per-feature ship | Runs after each feature               | Skipped (features stop at `origin_verified`) |
| Final ship+land  | N/A (done per-feature)                | Runs once after all features complete        |
| Exit code        | 0 when all shipped                    | 0 when plan-level ship+land succeeds         |

**Specific code changes in `cli.ts`:**

- `Args` type: add `singleBranch: boolean`
- Default: `singleBranch: false`
- Flag parsing: `--single-branch` sets `args.singleBranch = true`
- `ownedFeatureBranch()`: when `singleBranch`, return `feat/${prefix}` (no feature slug)
- Per-feature ship gate (line ~6928): add `!args.singleBranch` to condition
- `skipUnshippedVerified`: treat `singleBranch` like `skipShip` so feature iteration skips `origin_verified` features correctly
- `syncLandedBase` between features: add `!args.singleBranch` guard (no landing between features in this mode)
- Feature status after origin verify: `singleBranch` treated like `skipShip` → stays at `origin_verified` until final ship
- After do-while loop: when `singleBranch && exitCode === 0`, call `shipAndDeploy()` once, then `state.completed = true`
- `findNextFeatureIndex`: treat `singleBranch` like `skipShip` for `skipOriginVerified`
- Help text: document `--single-branch`
- `logActivity`: include `singleBranch` in the log

## What is NOT changing

- The living plan format (no new metadata)
- Worktree setup (same worktree path, same run ID)
- Review, QA, and test phases (unchanged)
- `--skip-ship` flag (unchanged — still exits 13, still leaves work unshipped)
- `--release-mode` (single-branch respects whichever mode is active)

## Files to change

| File                        | Change                                         |
| --------------------------- | ---------------------------------------------- |
| `build/SKILL.md.tmpl`       | Add Step 5.7 branch strategy decision          |
| `build/orchestrator/cli.ts` | Add `--single-branch` flag and execution logic |
| `build/SKILL.md`            | Regenerated from template                      |
