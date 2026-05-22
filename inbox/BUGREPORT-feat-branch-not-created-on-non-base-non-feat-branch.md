# Bug: orchestrator skips per-feature `feat/` branch creation when launched on a non-`main`, non-`feat/*` branch

**Severity:** MEDIUM-HIGH — silent. Phase commits land on the user's
working branch instead of the per-feature `feat/<plan>-<N>-<slug>`
branch the orchestrator normally creates. The default ship + land
pipeline can't find a per-feature branch to push, and the user's
working branch gets polluted with build commits.

**gstack version:** v1.43.0.0 (still present; this is Fix A from the
companion report
`BUGREPORT-allow-workspace-root-skips-worktree-and-blinds-hygiene.md`).
**Discovered:** 2026-05-22, during F8-F10 of the post-Phase 3.2
hardening plan. Bug B (hygiene gate blind to sibling repos) is
addressed by PR #90 on anbangr/gstack. This bug A is separate.

## Symptom

Run gstack-build while the user happens to be checked out on a branch
that is neither `main` (the local base) nor a `feat/*` branch — e.g.
`chore/phase3.2-postgres-gke-deploy`, `release/v0.9.x`, `hotfix/...`,
or any other team-branch convention.

The orchestrator advances to Feature N. In the state JSON:

```json
"features": [
  {"n": "8", "status": "...", "branch": "chore/phase3.2-postgres-gke-deploy"}
]
```

The branch field reuses **the user's current working branch**. The
phase loop then runs all primary-impl + review work on top of that
branch. Every commit lands there. Ship + land subsequent steps try to
push a per-feature branch that doesn't exist.

## Root cause

File: `build/orchestrator/cli.ts`, around line 3464–3470 (numbering
pre-PR #90; the function is the per-feature branch checkout helper):

```typescript
const existing = currentBranch(args.cwd);
const base = localBaseBranch(args.cwd);
const onBase = existing === base || existing === "";
const createFeatureBranch = onBase || existing.startsWith("feat/");
const branch = createFeatureBranch
  ? ownedFeatureBranch(args.state, args.feature, {
      singleBranch: args.singleBranch,
    })
  : existing;
```

The gate to create a new `feat/` branch is:

- the user is on the base branch (typically `main`), OR
- the user is already on a `feat/*` branch (resume case).

Any other working branch — and there are many legitimate ones —
silently disables per-feature branch creation. The orchestrator picks
`existing` and runs all phase work on top of it.

## Why this matters in workspace-root builds

This bug interacts with the workspace-root scenario from the companion
report. When a user runs gstack-build on a workspace-root project
(child of a workspace dir) and they happen to have the project repo
checked out on a non-`main`/non-`feat/` branch (very common during
active development — release branches, chore/refactor branches, etc.),
the orchestrator runs ALL phase commits on top of that branch.

This is a footgun even in the non-workspace case: any user with a
non-main working branch gets their branch polluted with phase commits.

## Smallest viable fix

Make `feat/` branch creation **default-on** regardless of the user's
current branch. The orchestrator already has logic to derive a clean
`feat/<plan-slug>-<feature-number>-<feature-name>` via
`ownedFeatureBranch`; the only condition that should disable it is the
explicit `--single-branch` flag (where the user opts into a single
shared branch for all features) or the resume case (where the saved
`feature.branch` already exists and we just check it out).

Concretely:

```typescript
const existing = currentBranch(args.cwd);
const base = localBaseBranch(args.cwd);
// Always create a per-feature branch unless --single-branch reuses
// the parent or we're resuming an in-progress branch.
const resumeExistingFeat = existing.startsWith("feat/");
const createFeatureBranch = !resumeExistingFeat || ...;
const branch = createFeatureBranch
  ? ownedFeatureBranch(args.state, args.feature, {
      singleBranch: args.singleBranch,
    })
  : existing;
```

The `git checkout -b <branch> origin/<base>` line below this block
already creates from `origin/<base>` (not the user's working tree), so
the new `feat/` branch isn't polluted by whatever the user had checked
out — that's the right base for the new branch.

Open question: when the user has uncommitted work on their working
branch and we create + checkout a new `feat/` branch, that's a context
switch the user didn't ask for. Options:

1. **Refuse** when the working tree is dirty (unless `--skip-clean-check`
   is set). The existing `--skip-clean-check` is documented as a power
   user opt-in.
2. **Stash** automatically and warn loudly.
3. **Use git worktree** to create the new `feat/` branch in a SEPARATE
   working tree, leaving the user's main worktree untouched. This is
   the architecturally cleanest fix and also addresses the "phase work
   pollutes user's working branch" concern entirely. It's a bigger
   change — every `applyMutableAgentHygiene` call site already takes a
   `cwd` parameter, so threading a per-feature worktree path through
   is mechanical but touches ~10 call sites.

Recommend option 3 long-term, option 1 short-term.

## Repro

1. Check out any non-`main`, non-`feat/*` branch in a project gstack-build will operate on:

   ```bash
   cd ~/Documents/Antigravity/agnt2-workspace/agnt2-prototype
   git checkout chore/phase3.2-postgres-gke-deploy
   ```

2. Launch gstack-build on any multi-feature plan:

   ```bash
   gstack-build inbox/your-plan.md --project-root . --skip-clean-check
   ```

3. After plan-synth, inspect the state JSON:

   ```bash
   jq '.features[].branch' ~/.gstack/build-state/build-<slug>.json
   ```

   Expected: `feat/<slug>-1-...`, `feat/<slug>-2-...`, etc.
   Actual: `chore/phase3.2-postgres-gke-deploy` for the active feature.

## Workaround until fix lands

`git checkout main` (or any `feat/*` branch) before launching
gstack-build. Confirm the orchestrator's startup log shows a `feat/`
branch in the "using <branch>" line for each feature.

## Suggested test

`build/orchestrator/__tests__/feature-branch-creation.test.ts`:

```typescript
it("creates a per-feature feat/ branch even when user is on a chore/ branch", () => {
  // Set up a temp repo on `chore/something`.
  // Run the feature-branch-resolution helper directly (extracted from
  // cli.ts:3460-3470).
  // Assert the returned branch starts with `feat/`.
});

it("creates a per-feature feat/ branch when user is on a release/ branch", () => {
  // Same shape with `release/v1.2.3`.
});
```

## Priority

After Fix B (PR #90) lands, this bug is the next blocker for using
gstack-build in real day-to-day team workflows where users routinely
have non-main, non-feat working branches.
