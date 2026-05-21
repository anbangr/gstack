# Fix Plan: Current branch missing drain-faults audit-skip fix

**Filed:** 2026-05-20
**Branch investigated:** `fix/release-daemon-multi-repo-discovery`
**Current HEAD during investigation:** `958a8f6e`
**Upstream checked:** `origin/main` at `c47d8778`
**Primary inbox fault:** `inbox/2026-05-20-fix-drain-faults-self-enqueue-plan.md`
**Related halt report:** `inbox/2026-05-19-halt-MANUAL_RECOVERY_INVOKED:all:276ba8b1.md`
**Status:** plan ready. No code changes made by this investigation.

## Investigation Summary

The fault is still live in this checkout, but not because the fix was never written. The fix exists on `origin/main` in commit `56665428` (`v1.40.5.0 fix(build/orchestrator): drain-faults --queue self-enqueue + codex-hardened audit short-circuit`), and that commit is an ancestor of `origin/main`.

The current branch does not contain that commit:

```text
current branch: fix/release-daemon-multi-repo-discovery
current HEAD:   958a8f6e
origin/main:    c47d8778
56665428 <= HEAD:        no
56665428 <= origin/main: yes
```

Root cause hypothesis: this is a stale-branch integration gap. The branch was merged with `origin/main` before PR #62 landed, then continued work without pulling that later fix. The local code still has the old manual-recovery emit and old queue consumer.

## Reproduction

I reproduced the core bug without modifying repo files by emitting a synthetic `MANUAL_RECOVERY_INVOKED` queue event with `investigate:false` into a temp `GSTACK_HOME`, then draining the queue with a mock investigator that throws if called.

Observed output:

```text
[drain-faults] mockInvestigator threw for MANUAL_RECOVERY_INVOKED:all:276ba8b1: DISPATCHED_AUDIT_EVENT
{
  "faultId": "MANUAL_RECOVERY_INVOKED:all:276ba8b1",
  "result": {
    "processed": 0,
    "skipped": 0,
    "shortCircuited": 0,
    "inboxFiled": 0,
    "proposalsAppended": 0,
    "failed": 1
  }
}
```

That proves the consumer-side audit skip is absent. Even if a row already carries `investigate:false`, this checkout still dispatches it to the investigator.

## Root Cause

Three pieces are missing in this checkout:

1. `build/orchestrator/halt-events.ts` has no `investigate?: boolean` field on `HaltEvent`, and `markInvestigated()` does not accept `"audit-skipped"`.
2. `build/orchestrator/cli.ts` still emits raw `MANUAL_RECOVERY_INVOKED` events in the drain-faults, mark-shipped, and mark-phase-committed paths instead of routing through `emitManualRecoveryInvoked()`.
3. `build/orchestrator/drain-faults.ts` still goes from learned-pattern short-circuit to dry-run/dispatch. There is no branch for `he.investigate === false && he.kind === "MANUAL_RECOVERY_INVOKED"`.

The existing fixed commit `56665428` contains exactly the missing pieces:

- `investigate?: boolean` on `HaltEvent`
- `emitManualRecoveryInvoked()` helper in `halt-event-helpers.ts`
- `investigate:false` queue-consumer short-circuit with `outcome:"audit-skipped"`
- regression tests in `drain-halt-events-audit-skip.test.ts`
- static emit-site coverage in `manual-recovery-emit-site.test.ts`
- migration `gstack-upgrade/migrations/v1.40.5.0.sh`
- migration tests in `test/gstack-upgrade-migration-v1_40_5_0.test.ts`

## What Already Exists

| Need | Existing implementation | Reuse decision |
|---|---|---|
| Audit-only manual-recovery events | `56665428` adds `HaltEvent.investigate?: boolean` and `emitManualRecoveryInvoked()` | Reuse by merging or cherry-picking. Do not reimplement. |
| Queue consumer skip | `56665428` adds a gated short-circuit for `MANUAL_RECOVERY_INVOKED` with `investigate:false` | Reuse. It already includes dry-run and corrupted-event hardening. |
| Legacy-row migration | `56665428` adds `gstack-upgrade/migrations/v1.40.5.0.sh` | Reuse. It migrates pending/processed JSON event bodies, which is enough to stop repeated dispatch. |
| Regression tests | `56665428` adds consumer, emit-site, and migration tests | Reuse and run them on this branch after integration. |
| Current branch merge pattern | This branch already has repeated `Merge remote-tracking branch 'origin/main'` commits | Prefer merge over rebase for consistency and lower risk to existing branch history. |

## Recommended Fix

Merge `origin/main` into `fix/release-daemon-multi-repo-discovery`, then verify the fault is closed.

Why merge instead of reimplement:

- The fix already exists and is tested.
- `git merge-tree HEAD origin/main` produced a clean merged tree hash, so no text conflicts are expected.
- This branch has already used merge commits from `origin/main`; continuing that style avoids history churn.
- Merging also pulls follow-up drain-faults and plan-review fixes from PR #63 and #64 that build on the same halt-events surface.

Fallback if the branch owner rejects a full main merge: cherry-pick `56665428` only, then manually inspect for conflicts with later `origin/main` halt-events work before shipping. This is the narrower diff, but it risks diverging from follow-up fixes that already landed.

## Data Flow After Fix

```text
manual recovery command
  |
  v
emitManualRecoveryInvoked()
  |
  | writes HaltEvent { kind: MANUAL_RECOVERY_INVOKED, investigate: false }
  v
pending-investigations/<run>-MANUAL_RECOVERY_INVOKED:all:<hash>.json
  |
  v
drainFaultsFromHaltEventsQueue()
  |
  +-- if kind == MANUAL_RECOVERY_INVOKED && investigate == false
  |     |
  |     +-- dry-run: count shortCircuited, write nothing
  |     |
  |     +-- real run: move file to processed/
  |                 append analytics outcome: audit-skipped
  |                 do NOT call investigator
  |
  +-- otherwise
        dispatch investigator as before
```

## Implementation Plan

### Phase 1: Preserve local worktree state

1. Inspect current dirty state:

   ```bash
   git status --short
   ```

2. Keep unrelated user files untouched. At investigation time, `.claude/` was untracked. Do not stage it unless the user explicitly asks.

3. If the merge would overwrite untracked files, stop and move only those conflicting files aside with user approval. Do not use `git reset --hard` or `git clean`.

### Phase 2: Integrate the existing fix

Preferred path:

```bash
git fetch origin
git merge --no-ff origin/main
```

Fallback path if branch policy forbids a full main merge:

```bash
git cherry-pick 56665428
```

If using the fallback, also compare against `origin/main` for later changes touching:

```text
build/orchestrator/halt-events.ts
build/orchestrator/drain-faults.ts
build/orchestrator/cli.ts
build/orchestrator/halt-event-helpers.ts
gstack-upgrade/migrations/
```

### Phase 3: Verify static invariants

Run:

```bash
rg -n "investigate\\?:|investigate: false|emitManualRecoveryInvoked|audit-skipped|v1\\.40\\.5\\.0" \
  build/orchestrator gstack-upgrade package.json VERSION CHANGELOG.md
```

Expected:

- `HaltEvent` exposes `investigate?: boolean`.
- `cli.ts` routes manual recovery events through `emitManualRecoveryInvoked()`.
- `cli.ts` has no raw `kind: "MANUAL_RECOVERY_INVOKED"` emit blocks.
- `drain-faults.ts` short-circuits only when both `kind === "MANUAL_RECOVERY_INVOKED"` and `investigate === false`.
- `gstack-upgrade/migrations/v1.40.5.0.sh` exists.

### Phase 4: Run focused tests

Run the tests that prove this exact fault is closed:

```bash
bun test \
  build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts \
  build/orchestrator/__tests__/manual-recovery-emit-site.test.ts \
  test/gstack-upgrade-migration-v1_40_5_0.test.ts
```

Then run nearby regression tests:

```bash
bun test \
  build/orchestrator/__tests__/drain-halt-events.test.ts \
  build/orchestrator/__tests__/auto-drain.test.ts \
  build/orchestrator/__tests__/wrap-console.test.ts
```

If the full `origin/main` merge is used, also run the tests for the additional mainline changes pulled in by #63 and #64:

```bash
bun test build/orchestrator/__tests__/plan-reviewer-loop.test.ts
bun test build/orchestrator/__tests__/drain-halt-events-resolved-pairing.test.ts
```

### Phase 5: Reproduce the original fault scenario

Re-run the temp-queue reproduction from this investigation. Expected result after the fix:

```text
mockInvestigator calls: 0
result.shortCircuited: 1
result.failed: 0
pending-investigations/: empty
processed/: contains drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json
analytics/skill-faults.jsonl: contains outcome "audit-skipped"
```

Then run a negative control with a real `PHASE_FAILED` row carrying a corrupted `investigate:false`. Expected: investigator still dispatches. This proves the flag cannot suppress real failures.

## Test Coverage Diagram

```text
CODE PATHS                                                        TEST STATUS
[+] emitManualRecoveryInvoked()
  ├── [GAP before merge] sets kind MANUAL_RECOVERY_INVOKED
  ├── [GAP before merge] sets investigate:false
  └── [GAP before merge] preserves runId/stateSlug/message/pointers
      Covered by: manual-recovery-emit-site.test.ts after merge

[+] drainFaultsFromHaltEventsQueue()
  ├── [GAP before merge] audit event + real run
  │     └── moves to processed, appends audit-skipped, no investigator
  ├── [GAP before merge] audit event + dry-run
  │     └── no move, no analytics, shortCircuited increments
  ├── [GAP before merge] PHASE_FAILED + no flag
  │     └── dispatches normally
  ├── [GAP before merge] PHASE_FAILED + corrupted investigate:false
  │     └── still dispatches normally
  └── [GAP before merge] mixed queue
        └── audit skips, real fault dispatches
      Covered by: drain-halt-events-audit-skip.test.ts after merge

[+] gstack-upgrade/migrations/v1.40.5.0.sh
  ├── [GAP before merge] pending legacy manual recovery row
  ├── [GAP before merge] processed legacy manual recovery row
  ├── [GAP before merge] marker-file idempotency
  ├── [GAP before merge] malformed row does not lock out future retry
  ├── [GAP before merge] write failure prevents marker
  └── [GAP before merge] custom MANUAL_RECOVERY_INVOKED row not rewritten
      Covered by: test/gstack-upgrade-migration-v1_40_5_0.test.ts after merge

USER / OPERATOR FLOWS
[+] gstack-build drain-faults --queue
  ├── [GAP before merge] command emits audit row
  ├── [GAP before merge] queue drains audit row without codex spend
  └── [GAP before merge] no new inbox halt report for its own invocation

COVERAGE BEFORE MERGE: 0/new audit-skip paths tested in this branch
COVERAGE AFTER MERGE: all planned code paths covered by PR #62 tests
QUALITY TARGET: behavior + edge + error coverage for audit skip and migration
```

## Failure Modes

| Failure mode | Covered by plan? | Handling |
|---|---:|---|
| `investigate:false` accidentally suppresses a real `PHASE_FAILED` event | Yes | Test requires kind gate: only `MANUAL_RECOVERY_INVOKED` skips. |
| `--dry-run` mutates pending queue or analytics | Yes | Test requires dry-run to count intent only. |
| `markInvestigated()` fails but result still reports success | Yes | PR #62 hardening requires success before analytics and short-circuit count. |
| Migration writes marker after partial failure | Yes | Migration tests cover malformed rows, write failure, and partial rerun. |
| A future manual-recovery emit bypasses the helper | Partially | Static test rejects raw `kind: "MANUAL_RECOVERY_INVOKED"` in `cli.ts`. |
| Full `origin/main` merge pulls unrelated regressions into release-daemon branch | Partially | Focused tests plus relevant #63/#64 tests. Full branch test suite still recommended before ship. |

No critical silent failure remains if the recommended verification passes.

## Plan Engineering Review

### Step 0: Scope Challenge

1. Existing code already solves the core problem in commit `56665428`. Reimplementing it would create duplicate work and risk missing the codex-hardening details.
2. Minimum complete change is to integrate the existing fix. The smallest command-level change is `git merge --no-ff origin/main` because this branch already follows merge-from-main history.
3. Complexity check: a full `origin/main` merge touches more than 8 files, but the new work is not novel architecture. The complexity is pre-existing upstream commits. If branch blast radius is unacceptable, cherry-pick `56665428` as the fallback.
4. Search check: no external framework pattern introduced. This is a local event-dispatch contract.
5. `TODOS.md` has no blocking item for this fault. No new TODO is required; the plan contains the actionable work.
6. Completeness check: merge plus focused verification is the complete version. Cherry-pick-only is a shortcut that may miss follow-up fixes in #63/#64.
7. Distribution check: no new artifact type. Existing `gstack-upgrade` migration pipeline distributes the migration.

### Architecture Review

**Finding A1 (P1, confidence 9/10):** Full `origin/main` merge has broader blast radius than the single fault fix, but it is the least divergent path because this branch is already stale and the missing fix is upstream.

Decision recorded non-interactively because AskUserQuestion is unavailable in this session: prefer full `origin/main` merge. Use cherry-pick only if release-daemon branch policy forbids taking #63/#64 now.

### Code Quality Review

No new implementation is proposed. Reuse the upstream helper and queue-consumer shape from `56665428`.

Quality guardrails for implementation:

- Do not add a second manual-recovery helper.
- Do not add string-message filtering inside `drainFaultsFromHaltEventsQueue`.
- Keep `investigate:false` scoped by `kind === "MANUAL_RECOVERY_INVOKED"` so corrupted real faults still dispatch.
- Preserve dry-run as read-only.

### Test Review

The plan has complete focused coverage after integration:

- audit skip behavior
- non-audit dispatch behavior
- mixed queues
- corrupted `investigate:false` on real faults
- dry-run semantics
- helper emit-site static check
- migration idempotency and failure handling

Test gap to avoid: do not rely only on `rg` static checks. The temp-queue reproduction must be rerun after the merge because it proves the original runtime behavior changed.

### Performance Review

No performance concern. The new branch is a constant-time check per queued halt event before the expensive investigator dispatch. This reduces codex spend and wall time for audit rows.

### NOT in Scope

- Rewriting historical analytics JSONL rows: not needed to stop repeated investigator dispatch. Pending and processed JSON event bodies are the dispatch source.
- Renaming `MANUAL_RECOVERY_INVOKED`: kind changes would change `faultId` and force file renames.
- Adding startup migrations to every CLI command: unexpected state mutation during help/build/dry-run is worse than a `/gstack-upgrade` migration.
- Building a generic audit-event subsystem: one `investigate:false` discriminator solves the current class without new infrastructure.
- Archiving the inbox reports automatically: archive only after the branch actually contains and verifies the fix.

### Worktree Parallelization Strategy

Sequential implementation, no parallelization opportunity. The fix is an integration step followed by verification. Parallel worktrees would increase merge confusion without reducing risk.

### Implementation Tasks

- [ ] **T1 (P1, human: ~15min / CC: ~3min)** — branch integration — Merge `origin/main` into `fix/release-daemon-multi-repo-discovery`
  - Surfaced by: Investigation — `56665428` is upstream but not in current HEAD
  - Files: git integration across upstream changes
  - Verify: `git merge-base --is-ancestor 56665428 HEAD` exits 0

- [ ] **T2 (P1, human: ~20min / CC: ~5min)** — halt-events audit skip — Verify static invariants after merge
  - Surfaced by: Code Quality Review — avoid duplicate helpers and unsafe broad skips
  - Files: `build/orchestrator/halt-events.ts`, `build/orchestrator/halt-event-helpers.ts`, `build/orchestrator/cli.ts`, `build/orchestrator/drain-faults.ts`
  - Verify: `rg -n "investigate\\?:|investigate: false|emitManualRecoveryInvoked|audit-skipped" build/orchestrator`

- [ ] **T3 (P1, human: ~30min / CC: ~8min)** — tests — Run focused regression suite for the fault
  - Surfaced by: Test Review — runtime behavior must prove no investigator dispatch
  - Files: `build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts`, `build/orchestrator/__tests__/manual-recovery-emit-site.test.ts`, `test/gstack-upgrade-migration-v1_40_5_0.test.ts`
  - Verify: focused `bun test` commands in Phase 4 pass

- [ ] **T4 (P1, human: ~10min / CC: ~3min)** — reproduction — Re-run temp-queue reproduction and negative control
  - Surfaced by: Investigation — current branch dispatches the audit event today
  - Files: none
  - Verify: audit row returns `shortCircuited:1`, `failed:0`; corrupted `PHASE_FAILED` still dispatches

- [ ] **T5 (P2, human: ~20min / CC: ~5min)** — branch confidence — Run adjacent tests for #63/#64 if using full main merge
  - Surfaced by: Architecture Review — full merge has broader blast radius than cherry-pick
  - Files: `build/orchestrator/__tests__/plan-reviewer-loop.test.ts`, `build/orchestrator/__tests__/drain-halt-events-resolved-pairing.test.ts`
  - Verify: both tests pass, or failures are triaged as pre-existing/unrelated before ship

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Not needed for branch integration bug fix |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | not run | Existing upstream fix already includes codex-hardening notes |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAN_WITH_NOTE | 1 architecture tradeoff, 0 critical gaps; non-interactive because AskUserQuestion tool is unavailable |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not applicable | Backend/orchestrator-only change |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | Not needed for targeted fault closure |

- **UNRESOLVED:** 0 blocking decisions. The only tradeoff is merge `origin/main` versus cherry-pick `56665428`; recommendation is full merge, fallback is cherry-pick if branch policy requires it.
- **VERDICT:** ENG CLEARED_WITH_NOTE — ready to implement the integration plan. The note is that the formal interactive AskUserQuestion gate could not run in this Default-mode session.
