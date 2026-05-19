# gstack-build Orchestrator State Machine

Specification for the runtime state that `gstack-build` mutates as a
plan executes. Future debuggers should be able to read this doc, open
a state file (`~/.gstack/build-state/<slug>.json`), and decide whether
the state is internally consistent without re-reading source code.

This doc is enforced by `build/orchestrator/__tests__/docs-state-machine.test.ts`:
every `PhaseStatus` and `FeatureStatus` union member must be named in
the headings or tables below. If the union grows without a
corresponding doc update, that test fails.

> **Scope:** the orchestrator-only state. Plan-parser data structures
> (`Phase`, `Feature`) are described in `build/orchestrator/types.ts`
> JSDoc and not duplicated here.

---

## 1. PhaseStatus state machine

Each phase passes through a status sequence driven by the orchestrator's
main loop. `decideNextAction(phaseState)` (`phase-runner.ts:166`) reads
the status and emits one of: `RUN_<sub-agent>`, `MARK_<X>_DONE`, `WAIT`,
or `FAIL`. The CLI loop then executes the action and `applyResult`
transitions the status.

### 1.1 Canonical happy path (TDD code phase)

```
pending
  └─ RUN_TEST_SPEC          → test_spec_running
                                └─ MARK_TEST_SPEC_DONE → test_spec_done
                                                            └─ RUN_TESTS_INITIAL → tests_red
                                                                                       └─ RUN_PRIMARY_IMPL → gemini_running
                                                                                                                └─ MARK_IMPL_DONE → impl_done
                                                                                                                                       └─ RUN_TESTS_AFTER_IMPL → tests_green (or test_fix_running)
                                                                                                                                                                   └─ RUN_REVIEW_GATES → codex_running
                                                                                                                                                                                          └─ MARK_REVIEW_CLEAN → review_clean
                                                                                                                                                                                                                   └─ MARK_COMMITTED → committed
```

### 1.2 Dual-implementor branch (`--dual-impl`)

```
tests_red
  └─ RUN_DUAL_IMPL → dual_impl_running
                       └─ MARK_DUAL_IMPL_DONE → dual_impl_done
                                                  └─ RUN_DUAL_TESTS → dual_tests_running
                                                                        └─ MARK_DUAL_JUDGE_PENDING → dual_judge_pending
                                                                                                       └─ RUN_DUAL_JUDGE → dual_judge_running
                                                                                                                             └─ MARK_DUAL_WINNER_PENDING → dual_winner_pending
                                                                                                                                                            └─ MERGE_WINNER → tests_green (rejoins canonical path)
```

### 1.3 Failure edges

Any status can transition to `failed` when:

- A sub-agent returns non-zero exit code AND the orchestrator decides
  not to retry (cap exceeded, hygiene-gate fail with no recovery path).
- The hygiene gate fails (`applyMutableAgentHygiene` or
  `applyGateHygiene`) and the dirty tree is NOT test-only
  (see §6 — Bug 5 carve-out doesn't apply).
- Manual intervention sets `state.failedAtPhase`.

`failed` is **recoverable**, not terminal. The intended exit paths are:

1. `--mark-phase-committed <feat>.<phase>` (the "I fixed it manually" exit)
2. `--no-resume` (drop the state file, restart fresh)
3. Direct JSON edit (NOT recommended — easy to miss invariants; see §5)

### 1.4 PhaseStatus exhaustive list

| Status                | Set by                                     | Meaning                                                           |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `pending`             | initial / `resetPhaseStateForRedo`         | Untouched.                                                        |
| `test_spec_running`   | sub-agent dispatch                         | Test-writer is in flight.                                         |
| `test_spec_done`      | `applyResult`                              | Test spec written, not yet run.                                   |
| `tests_red`           | `applyResult` after `RUN_TESTS_INITIAL`    | Tests fail (intentional — red gate).                              |
| `gemini_running`      | sub-agent dispatch                         | Primary implementor is in flight.                                 |
| `impl_done`           | `applyResult`                              | Implementation committed, tests not yet run.                      |
| `test_fix_running`    | sub-agent dispatch                         | Test fixer is in flight after impl broke a test.                  |
| `tests_green`         | `applyResult` after `RUN_TESTS_AFTER_IMPL` | Tests pass.                                                       |
| `codex_running`       | sub-agent dispatch                         | Review/QA gate is in flight.                                      |
| `review_clean`        | `applyResult`                              | All review gates passed.                                          |
| `committed`           | `markCommitted` (`phase-runner.ts:818`)    | Phase shipped. Sets `committedAt`, deletes `error`.               |
| `failed`              | hygiene gate / fail decision               | See §1.3.                                                         |
| `dual_impl_running`   | dual-impl dispatch                         | Primary + secondary implementors in flight in isolated worktrees. |
| `dual_impl_done`      | dual-impl applyResult                      | Both implementors done, ready for test run.                       |
| `dual_tests_running`  | dual-impl test dispatch                    | Tests in flight in both worktrees.                                |
| `dual_judge_pending`  | dual-impl tests applyResult                | Tests done, judge has not yet started.                            |
| `dual_judge_running`  | judge dispatch                             | Judge sub-agent in flight.                                        |
| `dual_winner_pending` | judge applyResult                          | Judge picked a winner; merge to feature branch pending.           |

---

## 2. FeatureStatus state machine

Features advance only when ALL their phases reach `committed`. The
feature loop in `cli.ts` then runs the per-feature review pass, ships,
and lands. Each transition is gated by the previous step succeeding.

```
pending → running → phases_done → feature_review_pending → feature_review_running
                                                                                 │
                          ┌──────────────────────────────────────────────────────┤
                          ▼                          ▼                           ▼
                   feature_redo_pending      feature_blocked              (review PASS)
                          │                          │                           │
                          ▼                          ▼                           ▼
                       running                  paused/failed                shipping
                                                                                 │
                                                                                 ▼
                                                                          release_queued
                                                                                 │
                                                                                 ▼
                                                                              landed
                                                                                 │
                                                                                 ▼
                                                                       origin_verifying
                                                                                 │
                                                                                 ▼
                                                                       origin_verified
                                                                                 │
                                                                                 ▼
                                                                            committed
```

### 2.1 FeatureStatus exhaustive list

| Status                   | Set by                             | Meaning                                                                              |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `pending`                | initial                            | Feature hasn't been touched.                                                         |
| `running`                | main loop on first phase action    | At least one phase is in flight or done.                                             |
| `phases_done`            | main loop after last phase commits | All phases committed; feature review hasn't started.                                 |
| `feature_review_pending` | main loop                          | Feature review queued.                                                               |
| `feature_review_running` | feature review dispatch            | Feature reviewer in flight.                                                          |
| `feature_redo_pending`   | FEATURE_REDO verdict               | Reviewer asked to redo named phases; reset queued.                                   |
| `feature_blocked`        | FEATURE_BLOCKED verdict            | Reviewer blocked the feature; manual recovery needed.                                |
| `paused`                 | hygiene / manual intervention      | Operator halted progress; feature owns this state.                                   |
| `failed`                 | non-recoverable error path         | Feature itself failed (vs a single phase). Treated as no-opinion by projection (§4). |
| `shipping`               | main loop after review PASS        | /ship workflow in progress.                                                          |
| `release_queued`         | main loop after ship               | PR queued for release daemon.                                                        |
| `landed`                 | release daemon                     | PR merged, deploy not yet verified.                                                  |
| `origin_verifying`       | release daemon                     | Post-deploy canary running.                                                          |
| `origin_verified`        | release daemon                     | Canary passed.                                                                       |
| `committed`              | release daemon final               | Feature fully shipped and verified.                                                  |

---

## 3. State file invariants

For any well-formed `BuildState` JSON:

**Inv A — Single failure focus:**
`state.failedAtPhase === N` implies `state.phases[N].status === "failed"`.
Hand-edits that set one without the other are violations and will
confuse `decideNextAction` on the next resume.

**Inv B — Failure reason pairing:**
`state.failedAtPhase` is set ⟹ `state.failureReason` is set.
The reason is shown in error messages; missing it makes triage harder
but is not fatal.

**Inv C — currentPhaseIndex monotonicity:**
`state.currentPhaseIndex` always points to the first phase whose
`status !== "committed"`. Skipping a non-committed phase via a manual
edit causes the orchestrator to lose work.

**Inv D — markCommitted atomicity:**
A phase with `status === "committed"` MUST have `committedAt` set AND
MUST NOT have an `error` field. `markCommitted` (`phase-runner.ts:818`)
enforces both unconditionally. Hand-editing `status` to `committed`
without clearing `error` is the classic recovery-scenario violation
(see §5).

**Inv E — Feature-phase status correspondence:**
A feature whose phases are all `committed` should be at minimum
`phases_done` (and typically further along — shipping, landed, etc).
A feature in `paused`/`failed` typically has at least one phase that
also failed, but the orchestrator does NOT enforce this — manual
recovery can leave a feature paused with all phases committed.

---

## 4. Projection contract (Bug 1)

`phaseGateProjection(status)` and `featureGateProjection(status)`
(`cli.ts:262, 323`) tell the plan-file reconciler which visible
checkboxes should be `[x]` for the given status. The contract:

| Return value             | Reconciler interpretation                        |
| ------------------------ | ------------------------------------------------ |
| `{ gateKey: true, ... }` | Set those gates `[x]`, set unlisted gates `[ ]`. |
| `{}` (empty object)      | No gates are done — `[ ]` for everything.        |
| `undefined`              | **No opinion. Leave the plan untouched.**        |

`undefined` is the recovery-friendly sentinel. It applies to:

- `failed` (both phase and feature) — user is in mid-recovery, don't
  erase their hand-edits.
- The exhaustive `default` arm — unknown future statuses default to
  no-op rather than blast.

`{}` and `undefined` are NOT interchangeable. The Bug 1 fix made them
distinct precisely because the prior `{}` for `failed` caused the
reconciler to un-check every `[x]` on every `saveState` tick.

---

## 5. Reconciler contract (Bug 2 + defense)

`reconcilePhaseVisibleGates` and `reconcileFeatureVisibleGates`
(`cli.ts:374, 410`) run on every `saveState` call. They:

1. Skip the entire pass when the projection returns `undefined` (Bug 1
   handler).
2. For each gate the projection mentions: if the plan disagrees with
   the desired state AND moving toward the desired state is an
   `[x]`-flip (never a `[x]→[ ]` flip), call `setCheckboxState` to
   update the plan.
3. NEVER call `setCheckboxState` with `checked: false` when the plan
   currently shows `[x]`. This is the Bug 2 defense — the reconciler
   is monotonically advancing only. Explicit recovery scripts that
   need to un-check must call `setCheckboxState` directly.

**Implication:** the reconciler can only ever advance the plan view
forward (`[ ] → [x]`). State-machine retries that legitimately reset
a gate from done to not-done will NOT propagate to the visible plan;
recovery scripts must un-check explicitly. This is a deliberate
trade-off — the cost of stale plan view is much lower than the cost
of erasing the user's mid-recovery edits.

---

## 6. Hygiene gate contract (Bug 5)

Two flavors:

**Immutable gate hygiene** (`applyGateHygiene`, `cli.ts:3950`) —
for review / qa / reviewSecondary roles that shouldn't leave commits:

- Standard: dirty tree ⟹ `# Post-agent hygiene failure`, gate fails.
- **Bug 5 carve-out:** when ALL dirty paths match a test-path glob
  AND the only hygiene problem is the dirty tree (no parent-workspace
  mutation, no other validator errors), auto-commit with attribution:
  `chore(qa): expand coverage via <label> (auto-committed)`. The
  hygiene check then sees a clean tree and the gate passes.
- Source-code changes (anything NOT matching the test globs) still
  fail the gate — they need human review.
- Backout: `GSTACK_QA_NO_AUTO_COMMIT=1` reverts to pre-fix behavior.

**Mutable agent hygiene** (`applyMutableAgentHygiene`, `cli.ts:3895`) —
for implementor / test-fixer roles that DO leave commits:

- `requireNewCommit: true` ⟹ HEAD must have advanced; if not, attempt
  `recoverMutableAgentCommit` to stage the agent's uncommitted changes
  as a new commit (sandboxed agents sometimes write files but can't
  commit). If recovery fails, hygiene fails.
- Dirty-tree check applies after recovery.

Default test-path globs (cli.ts:`DEFAULT_QA_TEST_PATH_GLOBS`):
`**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/spec/**`,
`**/specs/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`,
`**/*_spec.*`, `spec/**`. Per-project override at
`~/.gstack/projects/{slug}/config.yaml` key `qa_test_path_globs`
(not wired in v1; defaults handle every observed case).

---

## 6.5. Phase-array reconciler (FEATURE_NEEDS_PHASES path)

When the feature reviewer returns `FEATURE_NEEDS_PHASES`, the
plan-mutator appends new `Phase N.review-K` headings under the named
feature via `appendFeaturePhases`. The insertion happens before the
next `## Feature N+1:` heading, mid-array — NOT at the end of the
plan for any non-last feature.

The orchestrator then re-parses the plan and must merge the new
parser output into `state.phases` without dropping runtime state for
shifted downstream phases. `reconcileStatePhasesAfterReparse`
(`state.ts:292`) is the canonical merge:

1. Index existing `state.phases` by `PhaseState.number` (unique within
   a plan — the parser rejects duplicate phase headings).
2. Walk `reparsed.phases` in order. For each phase:
   - If a `PhaseState` exists for that number: keep it (preserves
     `status`, `gemini`/`codex` iteration counts, `committedAt`,
     `error`, etc.), re-key its `index` to the new array position.
   - If no `PhaseState` exists: append a fresh `{status: "pending"}`
     entry. Collect its number into `addedNumbers` for the caller.
3. If any state-tracked phase number is NOT present in
   `reparsed.phases`: **fail closed**. The plan was edited
   out-of-band and continuing would silently lose runtime state. The
   caller (`cli.ts` `FEATURE_NEEDS_PHASES` branch) catches the throw,
   pauses the feature with a `BLOCKED-feature-N.md` recovery report,
   and exits 1.
4. Rebuild every `featureState.phaseIndexes` from the re-parsed
   `Feature.phaseIndexes` (the parser already produced the correct
   new positions).
5. Re-chase `state.currentPhaseIndex` by snapshotting its phase
   number before mutating `state.phases`, then looking that number up
   in the rebuilt array.

**Why "join by number" instead of "slice the tail":** the previous
strategy was `reparsed.phases.slice(oldPhaseCount)` and assumed new
phases land at the end of the array. For any non-last feature the
slice returned the shifted-out downstream phase instead of the new
review phase, the new review phase silently aliased an existing
`PhaseState` slot, and the inner phase loop fell through to
`phases_done` without executing the new work. The feature-review
loop then re-issued `FEATURE_NEEDS_PHASES` until
`--feature-review-max-iter` was hit. See CHANGELOG v1.40.2.0.

**Asymmetry with feature drops:** the helper fails closed on dropped
*phases* (data loss is severe) but silently empties
`featureState.phaseIndexes` when the matching `Feature` is missing
from `reparsedFeatures`. A future PR may tighten this when the
`FEATURE_REDO` path lands.

**Upstream collision prevention (v1.40.4.0):** the
`FEATURE_NEEDS_PHASES` prompt now lists every phase number already in
use under the feature inline (`K MUST NOT collide with phase numbers
already in use under this feature: \`1\`, \`1.review-1\`, ...`). Without
this feedback loop, the reviewer model picked `K` blind across review
cycles, occasionally re-emitting an existing `Phase N.review-K` heading
that the v1.40.3.0 reconciler dedup would then reject. Better to
prevent the collision at prompt-build time than to recover from it at
the reconciler. See `buildPhaseNumberHistory` in
`build/orchestrator/feature-review.ts`.

---

## 7. Lock + active-run record lifecycle

**Lock file:** `~/.gstack/build-state/<slug>.lock` (created via
`acquireLock`, `state.ts:382`). One lock per slug. Auto-clears when
the registered PID is dead (`cleanupDeadLock` called from
`acquireLock`). Manual cleanup is almost never needed; if you DO need
to clean a stale lock, `--stop-run` is the safe way (Bug 6).

**Active-run record:** `~/.gstack/build-state/active-runs/<runId>.json`.
States:

- `running` — orchestrator is alive AND owns the lock.
- `paused` — orchestrator received SIGTERM/SIGINT, cleaned up
  gracefully, exited 130. Re-launch with `--resume <runId>` to continue.
- `completed` — orchestrator finished a feature/build successfully.
- `failed` — orchestrator hit a non-recoverable error path.

**Crash recovery:** if the orchestrator dies without writing the
final record state (kill -9, OOM, power loss), the next
`gstack-build` invocation's `sweepOrphans` (`active-runs.ts`) detects
the dead PID and migrates the record to `failed`. The lock is
auto-cleared on the next `acquireLock` retry.

---

## 8. markPhaseCommittedAfterManualRecovery invariants

This is the **only sanctioned exit from `failed`**. It atomically
performs the following mutations (`cli.ts:4263+`):

| Field                      | Mutation                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| `state.phases[N]`          | `markCommitted(phaseState)` → status="committed", committedAt set, error deleted |
| `state.currentPhaseIndex`  | Advanced to first non-committed phase via `findNextPhaseIndex`                   |
| `state.failedAtPhase`      | Deleted if it equaled `phase.index`                                              |
| `state.failureReason`      | Deleted if `clearsBuildFailure` was true                                         |
| `state.features[F].status` | Flipped from `paused`/`failed` → `running` if `clearsBuildFailure`               |
| `state.features[F].error`  | Deleted if `clearsBuildFailure`                                                  |
| Plan checkboxes            | `flipTestSpecCheckbox` + `flipPhaseCheckboxes` to `[x]`                          |

**Bug 3:** the `phaseNumber` arg accepts BOTH `<phase>` (dot-numbered
plans, where `phase.number = "2.1"`) AND `<feature>.<phase>` (per-feature
plans, where `phase.number = "1"` under feature `2`). The lookup at
`resolvePhaseByMarkArg` tries the feature-relative split first, then
falls back to direct match.

**Bug 4:** when `dryRun: true`, ALL of the above mutations are skipped.
The function still returns `ok: true` so callers can render a preview
message. No state.json write, no plan file write.

---

## 9. Glossary of source pointers

For each contract above, the canonical implementation lives at:

- `phaseGateProjection`: `cli.ts:262`
- `featureGateProjection`: `cli.ts:323`
- `reconcilePhaseVisibleGates`: `cli.ts:374`
- `reconcileFeatureVisibleGates`: `cli.ts:410`
- `reconcileVisiblePlanState` (entry point): `cli.ts:439`
- `reconcileStatePhasesAfterReparse`: `state.ts:292`
- `markPhaseCommittedAfterManualRecovery`: `cli.ts:4304`
- `resolvePhaseByMarkArg`: `cli.ts:4281`
- `applyGateHygiene`: `cli.ts:3950`
- `applyMutableAgentHygiene`: `cli.ts:3895`
- `maybeAutoCommitTestOnlyDirty`: `cli.ts:3910`
- `validatePostAgentHygiene`: `cli.ts:1501`
- `runStopRun`: `cli.ts:7649`
- `markCommitted`: `phase-runner.ts:818`
- `decideNextAction`: `phase-runner.ts:166`
- `acquireLock`: `state.ts:382`
- `isPidAlive`: `active-runs.ts:51`
- `PhaseStatus` / `FeatureStatus` types: `types.ts:32, 53`
