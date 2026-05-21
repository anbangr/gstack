# Fix Plan: drain-faults --queue self-enqueue

**Filed:** 2026-05-20
**Origin trace:** `inbox/2026-05-19-halt-MANUAL_RECOVERY_INVOKED:all:276ba8b1.md` (auto-filed by codex investigator on 2026-05-19, severity HIGH, outcome `root-cause-identified`).
**Severity:** MEDIUM. Not a data-loss bug — just wasted codex spend per invocation, plus accumulating noise in the analytics + processed/ archive.
**Estimated effort:** ~25 lines source + ~70 lines test + ~30 lines migration. ~25 min CC time.
**Final architecture (2026-05-20 after eng-review + codex outside voice):** HaltEvent `investigate: false` property. NO kind split — `MANUAL_RECOVERY_INVOKED` stays one kind; the `investigate` flag is the discriminator that decides dispatch-vs-audit per event. Migration is `/gstack-upgrade`-only (no cli startup hook).

## Context

PR 5 added `gstack-build drain-faults --queue` (cli.ts:9333) so the operator could manually drain the halt-events queue. PR 2 added a `MANUAL_RECOVERY_INVOKED` emit at every recovery entry point (drain-faults, mark-shipped, --mark-phase-committed) for observability. The two changes collided: when `drain-faults --queue` runs, the emit writes a halt event into `~/.gstack/skill-faults/pending-investigations/`, which `drainFaultsFromHaltEventsQueue` then picks up. The recovery sink enqueues itself for recovery.

Yesterday's PR-5 verification run proved the bug end-to-end: one queued event, sitting under `drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json`, that I drained via codex (~$0.30) to produce the inbox report this plan addresses. The faultId is deterministic (`MANUAL_RECOVERY_INVOKED:all:276ba8b1`), so the file doesn't infinite-grow the queue, but every future `drain-faults --queue` invocation re-enqueues the same event and pays codex again unless a learned-pattern short-circuits it (currently nothing does).

Bug surface verified single-site: cli.ts:9333-9358 only. `mark-shipped` (9362), `--mark-phase-committed` (9659), and the auto-drain hook (9206) do **not** have this loop. Eng review picked investigator Option 2 (the `investigate: false` flag) over the original narrow gate because:

- A property on the event is more honest than a per-caller conditional — the producer says "this is audit, not for investigation," and every consumer (queue drain, manifest drain, analytics, future readers) respects the same flag without coordinating.
- It future-proofs against the next recovery sink that gets queue-consumer semantics added later (we already know auto-drain bypasses cli today, but PR 6 could grow that surface).
- Codex outside-voice critique was sharp but landed on a narrower form of this: keep MANUAL_RECOVERY_INVOKED as one kind, drop the kind split and the cli startup migration hook, but accept the flag as the dispatch property. That is the final architecture.

## Root cause (verified against code, not just the inbox report)

`runDrainFaultsMode` (cli.ts:7894-7916) has two paths gated on `args.drainFaultsQueueMode`:

- **Queue mode (`--queue` set):** calls `drainFaultsFromHaltEventsQueue` which consumes `pending-investigations/`.
- **Manifest mode (no `--queue`):** calls legacy `drainFaults` which consumes a log file.

The emit at cli.ts:9333 fires unconditionally before dispatch. In manifest mode the emit is harmless (queue consumer isn't running, auto-drain catches it later as audit signal). In queue mode it's a self-feed: emit writes file → sink reads file → codex investigates the sink invoking itself.

`computeFaultId()` in halt-events.ts hashes `event.kind` into the faultId — relevant because keeping a single kind avoids any need to rename existing files on disk. The migration only has to update the event body to add `investigate: false`; filenames stay stable.

## Acceptance criteria

1. All four MANUAL_RECOVERY_INVOKED emit sites (drain-faults --queue, drain-faults --manifest, mark-shipped, --mark-phase-committed) emit with `investigate: false`. These are audit signals, not investigation requests.
2. `drainFaultsFromHaltEventsQueue` short-circuits any HaltEvent with `investigate === false` — moves the file directly to `processed/` without dispatching codex. Records the short-circuit in `~/.gstack/analytics/skill-faults.jsonl` as `outcome: "audit-skipped"`.
3. The auto-drain hook (cli.ts:9206) inherits the same short-circuit behavior because it goes through `drainFaultsFromHaltEventsQueue`. No separate code path.
4. Legacy MANUAL_RECOVERY_INVOKED rows on disk (filed by PR 2 before this fix) get rewritten in-place during `/gstack-upgrade`: each event JSON gains `investigate: false` if its `runId === "drain-faults"` OR its message starts with `"drain-faults subcommand invoked"`, AND `mark-shipped subcommand invoked` AND `mark-phase-committed`. All four recovery sinks are audit. Atomic tmp+rename per file. Idempotent via marker `~/.gstack/skill-faults/.migrations/manual-recovery-audit-done`.
5. The investigator that drained yesterday's `drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json` event (now in `processed/`) gets migrated too — keeps audit trail consistent.
6. No regression in `build/orchestrator/__tests__/drain-faults.test.ts`, `drain-halt-events.test.ts`, `auto-drain.test.ts`, `wrap-console.test.ts`.

## Critical files

- `build/orchestrator/halt-events.ts` — add `investigate?: boolean` to `HaltEvent` interface. Default treated as `true` for back-compat (any legacy row without the flag still dispatches as before until migration runs).
- `build/orchestrator/drain-faults.ts` — `drainFaultsFromHaltEventsQueue` short-circuit branch for `investigate === false`. Records `outcome: "audit-skipped"` in analytics.
- `build/orchestrator/cli.ts` — four emit sites add `investigate: false` (no other change).
- `build/orchestrator/halt-event-helpers.ts` — if a `markRecoveryInvoked()` helper exists or should exist, route the four sites through it so the flag is set in one place.
- `gstack-upgrade/migrations/v1.40.5.0.sh` — NEW migration script. Rewrites pending-investigations/, processed/, analytics/skill-faults.jsonl rows. Idempotent. Marker-file gated.
- `build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts` — NEW regression test, ~70 lines.
- `gstack-upgrade/migrations/__tests__/v1.40.5.0.test.ts` — NEW migration test (fixtures for legacy rows + post-migration assertions).

## Phases

### Phase 1: schema + consumer gate

**Files:**

- Modify: `build/orchestrator/halt-events.ts` (add `investigate?: boolean` property).
- Modify: `build/orchestrator/drain-faults.ts` (short-circuit in `drainFaultsFromHaltEventsQueue`).

**TDD lifecycle (code phase):**

- [ ] **Test Specification (test-writer role)**: Write `build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts`. Tests MUST fail before implementation (Verify Red).

  #### Test Spec — Phase 1 (consumer gate)

  | ID  | Scenario                           | Given                                                                                                                                      | When                                  | Then                                                                                                                                                   |
  | --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | T1  | audit event skipped                | pending-investigations/ has one HaltEvent with `kind: MANUAL_RECOVERY_INVOKED`, `investigate: false`, mock codex would error if called     | call `drainFaultsFromHaltEventsQueue` | codex NOT called; file moved to `processed/`; analytics row appended with `outcome: "audit-skipped"`; result.shortCircuited === 1                      |
  | T2  | non-audit event dispatches         | pending-investigations/ has one HaltEvent with `kind: PHASE_FAILED` (no investigate flag set), mock codex returns `outcome: "self-healed"` | call `drainFaultsFromHaltEventsQueue` | codex IS called; file moved to `processed/`; analytics row appended with `outcome: "self-healed"`                                                      |
  | T3  | mixed queue                        | pending-investigations/ has one audit event + one investigation event                                                                      | call `drainFaultsFromHaltEventsQueue` | codex called exactly once (for the investigation event); both files moved to processed/; result reports `processed: 1, shortCircuited: 1`              |
  | T4  | legacy row without flag dispatches | pending-investigations/ has a MANUAL_RECOVERY_INVOKED event with NO `investigate` field                                                    | call `drainFaultsFromHaltEventsQueue` | codex IS called (back-compat: undefined flag means dispatch). This is the un-migrated state — migration in Phase 3 is what flips legacy rows to audit. |

- [ ] **Implementation (primary-impl role)**:
  1. `halt-events.ts`: add `investigate?: boolean` to `HaltEvent`. Update `loadPendingInvestigations` JSON.parse path — the field is just a passthrough, no validation needed (any value other than literal `false` defaults to dispatch behavior).
  2. `drain-faults.ts`: at the top of the per-event loop in `drainFaultsFromHaltEventsQueue`, check `if (event.investigate === false) { markInvestigated(faultId, "audit-skipped"); appendAnalyticsRow({ outcome: "audit-skipped", ... }); shortCircuited += 1; continue; }`. Return value gains `shortCircuited: number`.
  3. Add `shortCircuited` to the existing `DrainHaltEventsResult` type. Update auto-drain hook (cli.ts:9215) to treat `shortCircuited` as success (don't re-enqueue, don't escalate).

- [ ] **Review & QA**: Diff restricted to `halt-events.ts`, `drain-faults.ts`, the new test, and the result-type consumer (cli.ts:9215). `bun test build/orchestrator/__tests__/{drain-halt-events,auto-drain,wrap-console}*.test.ts` green.

### Phase 2: emit-site audit-flag wiring

**Files:**

- Modify: `build/orchestrator/cli.ts` — four emit sites (9333, 9361, 9658, plus the one at 7654 if it's also a recovery sink — verify with `rg`).
- Optional: `build/orchestrator/halt-event-helpers.ts` — add `emitManualRecoveryInvoked(opts)` that hard-codes `investigate: false` so the four call sites don't drift.

**TDD lifecycle (code phase):**

- [ ] **Test Specification**: Extend `drain-halt-events-audit-skip.test.ts` with end-to-end cases.

  #### Test Spec — Phase 2 (emit-site coverage)

  | ID  | Scenario                                                     | Given                                                                           | When                                                                      | Then                                                                                                                                                               |
  | --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | T5  | drain-faults --queue: no self-enqueue                        | empty pending-investigations/, mock codex would error if called                 | dispatch `runDrainFaultsMode` with `drainFaultsQueueMode: true`           | pending-investigations/ count is 0 after; codex NOT called; the audit event that gets emitted is short-circuited immediately into processed/; shortCircuited === 1 |
  | T6  | drain-faults --manifest: audit recorded but not investigated | empty pending-investigations/, dummy manifest, mock codex would error if called | dispatch with `drainFaultsQueueMode: false, monitorManifest: ".../dummy"` | one MANUAL_RECOVERY_INVOKED event filed with `investigate: false`; no investigation dispatched on next drain                                                       |
  | T7  | mark-shipped audit                                           | empty pending-investigations/                                                   | dispatch mark-shipped path                                                | one MANUAL_RECOVERY_INVOKED event filed with `investigate: false`; message starts with `"mark-shipped subcommand invoked"`                                         |
  | T8  | --mark-phase-committed audit                                 | mid-build state                                                                 | dispatch --mark-phase-committed path                                      | one event filed with `investigate: false`; message starts with `"mark-phase-committed"`                                                                            |

- [ ] **Implementation**: Add `investigate: false` to the four emit blocks. If using the helper approach, route all four through `emitManualRecoveryInvoked()` and pin its `investigate: false` in tests.

- [ ] **Review & QA**: `rg -n 'kind: "MANUAL_RECOVERY_INVOKED"' build/orchestrator/` must show all four sites either set `investigate: false` directly OR route through the helper. No emit site can leave the flag unset.

### Phase 3: legacy-row migration (gstack-upgrade only)

**Files:**

- New: `gstack-upgrade/migrations/v1.40.5.0.sh` (or whatever the next fork-version-bumped tag is).
- New: `gstack-upgrade/migrations/__tests__/v1.40.5.0.test.ts`.

**Migration contract:**

- Scan `~/.gstack/skill-faults/pending-investigations/*.json` and `~/.gstack/skill-faults/processed/*.json`. For each MANUAL_RECOVERY_INVOKED event, if it lacks `investigate` AND (runId === "drain-faults" OR message matches one of the four recovery invocations), rewrite the file body with `investigate: false`. Atomic tmp+rename per file. Filename unchanged (because kind unchanged, faultId stable).
- Scan `~/.gstack/analytics/skill-faults.jsonl`. For each row whose `kind === "MANUAL_RECOVERY_INVOKED"` AND lacks `investigate` field, append `investigate: false`. Atomic full-file rewrite (tmp + rename). Size-guarded: read-into-memory if file < 50MB, stream otherwise.
- Marker file: `~/.gstack/skill-faults/.migrations/manual-recovery-audit-done` (write the script version + timestamp). Migration skipped on next run if marker exists.
- Malformed/corrupt JSONL row: skip with one-line warn, continue. Do NOT abort whole migration on one bad row.
- Fresh install (no `~/.gstack/skill-faults/` dir): write marker file only. No-op otherwise.
- Mid-flight crash (Ctrl+C between two file rewrites): re-run resumes safely. Atomic tmp+rename per file means no half-written row is possible; the marker file is the only thing missing on partial-failure, and that just makes the next run a no-op for already-converted rows + an idempotent rewrite for the rest.

**TDD lifecycle:**

- [ ] **Test Specification**: `v1.40.5.0.test.ts` covers:

  #### Test Spec — Phase 3 (migration)

  | ID  | Scenario                                         | Given                                                                                                             | When                | Then                                                                                                                                                                  |
  | --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | T9  | legacy drain-faults row → audit                  | one MANUAL_RECOVERY_INVOKED row in pending-investigations/ with `runId: "drain-faults"`, no `investigate` field   | run migration       | same filename, body now has `investigate: false`; original fields preserved; marker file written                                                                      |
  | T10 | legacy mark-shipped row → audit                  | one MANUAL_RECOVERY_INVOKED row with message starting `"mark-shipped subcommand invoked"`, no `investigate` field | run migration       | body has `investigate: false`; marker file written                                                                                                                    |
  | T11 | analytics rewrite                                | `skill-faults.jsonl` with one row missing `investigate`                                                           | run migration       | row gains `investigate: false`; other rows untouched                                                                                                                  |
  | T12 | idempotent re-run                                | marker file exists                                                                                                | run migration       | no-op (no file rewrites); zero new disk activity                                                                                                                      |
  | T13 | malformed row skipped                            | one corrupt row in JSONL between two valid rows                                                                   | run migration       | valid rows migrated; corrupt row logged + skipped; marker still written                                                                                               |
  | T14 | fresh install                                    | `~/.gstack/skill-faults/` does not exist                                                                          | run migration       | marker file created at the expected path; no other state                                                                                                              |
  | T15 | mid-flight resume                                | migrate one file, kill before marker written, re-run                                                              | run migration twice | first run migrates file A, second run migrates files B+C and writes marker. File A is unchanged on second run because re-applying `investigate: false` is idempotent. |
  | T16 | non-recovery MANUAL_RECOVERY_INVOKED row skipped | unlikely-but-possible synthetic legacy row whose message doesn't match any of the four recovery patterns          | run migration       | row is NOT modified (defensive: only known recovery patterns get audit-flagged)                                                                                       |

- [ ] **Implementation**: bash script in `gstack-upgrade/migrations/v1.40.5.0.sh`. Use jq for JSON manipulation if available; falls back to a small bun script if jq is missing. Size guard on the analytics file uses `stat -f%z` (macOS) / `stat -c%s` (Linux).

- [ ] **Review & QA**: Migration test exercises all 8 scenarios. Manual end-to-end on yesterday's row:
  1. Note the path `~/.gstack/skill-faults/processed/drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json`.
  2. Read body before migration — confirm no `investigate` field.
  3. Run `/gstack-upgrade` (which runs `v1.40.5.0.sh` once).
  4. Re-read body — confirm `investigate: false` present, no other field changed.

### Phase 4: post-fix verification on real disk state

**Files:** none (read-only verification).

**TDD lifecycle:** N/A — verification phase.

- [ ] **Verify (manual)**: From a clean fork-copy install with PR 8 landed and migration run:
  1. `ls ~/.gstack/skill-faults/pending-investigations/` — confirm empty.
  2. `gstack-build drain-faults --queue --dry-run` — confirm `processed: 0, shortCircuited: 0, skipped: 0`. Zero new files.
  3. `gstack-build drain-faults --queue` (real run, not dry) — confirm one audit event filed and immediately short-circuited to processed/. shortCircuited === 1. Codex not called. Total operator-visible spend: $0.
  4. Run a build that genuinely halts with PHASE_FAILED. Run `gstack-build drain-faults --queue` — confirm PHASE_FAILED investigates normally, codex called once. Audit event from the drain-faults invocation itself short-circuits cleanly.

## Out of scope (intentional defer)

- **Kind split into MANUAL_RECOVERY_INVOKED_AUDIT / MANUAL_RECOVERY_INVOKED_TRIGGER.** Eng-review's initial expansion. Codex outside-voice flagged correctly: `computeFaultId()` hashes the kind, so a split forces file renames in the migration, AND `TRIGGER` would ship with zero emit sites (dead schema). Use the flag instead. Revisit only if a second recovery sink with queue-consumer semantics appears AND it needs a structurally different kind for analytics filtering.
- **cli-startup-hook migration trigger.** Codex critique landed: a build/help/dry-run command should not silently rewrite user state. Migration runs only at `/gstack-upgrade` time.
- **Consumer-side message-string filtering** (investigator's option 3). Brittle and becomes dead code once Phase 2 flips all four producers. Skip.
- **Backfill cleanup of yesterday's `processed/drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json`.** Migration in Phase 3 adds `investigate: false` to it so the audit trail is consistent, but the file stays in `processed/` as evidence the bug existed. No delete.
- **PR 8 versioning.** Fork versioning rule: this is a bug fix on PR 5-7. Bump `build/SKILL.md.tmpl` frontmatter version only if the SKILL.md.tmpl changes (it doesn't here). Top-level `VERSION` stays unchanged per fork rule (we don't bump VERSION for fork-local fixes). The migration script's name (`v1.40.5.0.sh`) is independent — it's the next-available migration tag in `gstack-upgrade/migrations/` and doesn't have to match the top-level VERSION.

## Estimated effort

| Stage                              | Human team  | CC + gstack |
| ---------------------------------- | ----------- | ----------- |
| Phase 1 (schema + consumer gate)   | ~1 hour     | ~10 min     |
| Phase 2 (4 emit sites + helper)    | ~30 min     | ~5 min      |
| Phase 3 (migration script + tests) | ~2 hours    | ~10 min     |
| Phase 4 (verification)             | ~15 min     | ~5 min      |
| Total                              | ~3.75 hours | ~30 min     |

Compression: ~7.5x.

## Verification end-to-end (post-implementation)

1. `bun test build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts` — T1-T8 pass.
2. `bun test gstack-upgrade/migrations/__tests__/v1.40.5.0.test.ts` — T9-T16 pass.
3. `bun test build/orchestrator/__tests__/drain-halt-events.test.ts` — existing tests still pass (back-compat: legacy rows without `investigate` flag still dispatch).
4. `bun test build/orchestrator/__tests__/drain-faults.test.ts` — existing legacy tests still pass.
5. `bun test build/orchestrator/__tests__/auto-drain.test.ts` — confirm auto-drain hook respects `shortCircuited` in result.
6. Manual: `gstack-build drain-faults --queue --dry-run` on empty queue — zero new pending files.
7. `rg -n 'MANUAL_RECOVERY_INVOKED' build/orchestrator/cli.ts` — confirm 4 emit sites still exist and each sets `investigate: false` (or routes through the helper).
8. `cat ~/.gstack/skill-faults/.migrations/manual-recovery-audit-done` — confirm marker present after `/gstack-upgrade`.

## What the codex investigator missed (vs what this plan adds)

The investigator nailed the root cause and proposed three fix options. This plan picks option 2 (the flag) for the reasons in the Context section, and adds what the investigator didn't:

- **Audit of the other 3 emit sites** to prove the bug is single-site (not a class) — done in Acceptance criteria #3 and reflected in the Phase 2 emit-site map.
- **Audit of the auto-drain hook** (PR 6) to prove it inherits the fix via `drainFaultsFromHaltEventsQueue`.
- **Migration for legacy rows** so previously-filed MANUAL_RECOVERY_INVOKED events stop costing codex spend on the first `drain-faults --queue` after the fix lands.
- **Investigator-side analytics record** (`outcome: "audit-skipped"`) so we have observability into how often the audit-skip fires per build — useful for catching a future regression that re-introduces an investigate-by-default emit site.

## Cross-model tension log (for retro / future reference)

- **Claude eng-review** initially expanded to: investigate:false flag + kind split (AUDIT/TRIGGER) + auto-startup migration. Effort estimate: ~80 lines source + ~120 lines test + ~45 min CC.
- **Codex outside voice** returned `VERDICT: scope-down` with 9 specific critiques. Key points: (1) kind split is schema churn without justification — `computeFaultId()` includes kind so the migration must rename files; (2) `TRIGGER` with zero emit sites is dead schema; (3) startup-hook migration is a bad side effect for unrelated build/help/dry-run commands; (4) migration is disproportionate for a $0.30 wasted call.
- **Final user decision** consolidates Claude's flag-based architecture with codex's scope-down on the kind split and the migration trigger. The middle path: flag yes, kind split no, migration only at `/gstack-upgrade`. Effort drops to ~125 lines total / ~30 min CC.
- This is the second documented instance of codex outside-voice catching a real overengineering pattern in a claude-eng review. Pattern to watch: when the review's per-finding gate produces 8+ sequential "yes expand" answers, the cumulative scope expansion is rarely re-evaluated holistically. Cross-model critique is the holistic re-evaluation.

## Implementation Tasks

| Phase | Owner role   | Task                                                                                                                                                                                        | Estimated CC time |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1     | test-writer  | Write `drain-halt-events-audit-skip.test.ts` covering T1-T4 (Red phase)                                                                                                                     | ~3 min            |
| 1     | primary-impl | Add `investigate?: boolean` to `HaltEvent`; add short-circuit branch in `drainFaultsFromHaltEventsQueue`; update `DrainHaltEventsResult` to include `shortCircuited`                        | ~4 min            |
| 1     | reviewer     | Verify diff restricted to `halt-events.ts`, `drain-faults.ts`, the result-type consumer at cli.ts:9215, and the new test file. Run drain-halt-events + auto-drain + wrap-console tests.     | ~3 min            |
| 2     | test-writer  | Extend test file with T5-T8 (emit-site E2E coverage)                                                                                                                                        | ~3 min            |
| 2     | primary-impl | Add `investigate: false` to four emit sites at cli.ts:9334, 9361, 9658, 7654. If helper approach: add `emitManualRecoveryInvoked()` in halt-event-helpers.ts and route all four through it. | ~2 min            |
| 3     | test-writer  | Write `gstack-upgrade/migrations/__tests__/v1.40.5.0.test.ts` covering T9-T16 (migration scenarios)                                                                                         | ~5 min            |
| 3     | primary-impl | Write `gstack-upgrade/migrations/v1.40.5.0.sh` — atomic tmp+rename per file, size-guarded analytics rewrite, marker-file idempotency                                                        | ~5 min            |
| 3     | reviewer     | Verify migration is idempotent + crash-safe via T12/T15. Manual run against the yesterday's `drain-faults-MANUAL_RECOVERY_INVOKED:all:276ba8b1.json` event.                                 | ~2 min            |
| 4     | qa           | Manual verification per Phase 4 checklist: empty queue, dry-run, real-run, mixed-with-PHASE_FAILED build                                                                                    | ~3 min            |

## GSTACK REVIEW REPORT

**Skill:** /plan-eng-review
**Date:** 2026-05-20
**Branch:** fix/release-daemon-multi-repo-discovery
**Reviewer model:** claude opus 4.7 (1M context)
**Outside voice:** codex gpt-5.5 (reasoning: high)

### Verdict

**Ship after Phase 1-3 land + Phase 4 manual verification.** Plan is implementation-ready. Architecture survived 9 sequential cross-model challenges and landed on a defensible middle path: flag-based dispatch property, no kind split, migration only at `/gstack-upgrade`. Estimated CC time ~30 min total.

### Review decisions made (during this skill invocation)

| # | Section | Decision |
| --- | --- | --- |
| D1 | architecture | HaltEvent `investigate: false` property over narrow per-call gate |
| D2 | code-quality (kind shape) | NO kind split — keep MANUAL_RECOVERY_INVOKED as one kind (codex critique held) |
| D3 | code-quality (helper) | Route four emit sites through `emitManualRecoveryInvoked()` helper for drift safety |
| D4 | code-quality (migration) | Migration rewrites event body only; filenames stable because kind unchanged |
| D5 | scope | Final scope: flag + consumer gate + 4 emit sites + /gstack-upgrade migration. ~125 lines total. |
| D6 | test (kind picks) | All four recovery sites flagged audit (investigate: false). TRIGGER schema dropped. |
| D7 | test (migration trigger) | `/gstack-upgrade` only. No cli startup hook. |
| D8 | performance (migration I/O) | Size-guarded: in-memory if <50MB, stream otherwise |
| D9 | failure mode (bypass risk) | Backward-compatible reader: rows without `investigate` field default to dispatch |
| D10 | outside voice | Codex consulted; VERDICT scope-down; ~6 of 9 critiques accepted into plan |

### Cross-model agreement / disagreement

| Topic | Claude eng-review | Codex outside voice | Final |
| --- | --- | --- | --- |
| Architecture (flag vs gate) | flag (option 2) | gate (option 1) | flag — Claude held |
| Kind split (AUDIT/TRIGGER) | yes | no — schema churn, dead TRIGGER | no — Codex held |
| Migration scope | full (3 sinks) | none | partial — body-only, /gstack-upgrade only |
| Migration trigger | cli startup hook | none | /gstack-upgrade only — Codex held |
| Effort estimate honesty | ~45 min CC | "fantasy" | ~30 min CC after scope-down |

Cross-model net: 3 wins for Claude (flag architecture, migration-exists, audit on all 4 sites), 3 wins for Codex (no kind split, no startup hook, scoped migration). Final plan is a synthesis, not a capitulation either direction.

### Risks / open questions (track post-ship)

1. **Helper drift.** If a future emit site for MANUAL_RECOVERY_INVOKED forgets to use `emitManualRecoveryInvoked()`, the flag is silently omitted. Mitigation: Phase 2 review-gate runs `rg -n 'kind: "MANUAL_RECOVERY_INVOKED"'` and fails if any raw site exists. Consider an ESLint/tsc-level guard later.
2. **Auto-drain depends on `shortCircuited` interpretation.** cli.ts:9215 currently checks `(processed === 0 && skipped === 0 && shortCircuited === 0)` as "nothing happened." After this change, `shortCircuited > 0` should be treated as success but not as "do more work." Phase 1 explicitly updates that consumer.
3. **Analytics consumer.** Anything that reads `~/.gstack/analytics/skill-faults.jsonl` and counts rows by outcome should know about `outcome: "audit-skipped"`. Verify no dashboards / queries hard-code the existing outcome enum.

### Files modified by this review

- `inbox/2026-05-20-fix-drain-faults-self-enqueue-plan.md` — full rewrite to reflect final architecture (this file).
- `~/.gstack/projects/anbangr-gstack/anbang-fix-release-daemon-multi-repo-discovery-eng-review-test-plan-20260520.md` — test plan artifact (created earlier in skill flow).

### Outside voice raw output

Saved at `/Users/anbang/.claude/projects/-Users-anbang-Documents-Antigravity-claude-workspace-gstack/c7baec1e-999d-4881-82eb-df4f463155ac/tool-results/bb6ckd63y.txt` (290KB; 9-point critique + VERDICT: scope-down).

### Ready to implement

Yes. Run `/build inbox/2026-05-20-fix-drain-faults-self-enqueue-plan.md` to execute Phases 1-4 sequentially via the orchestrator, or implement manually phase-by-phase. All 16 test specs (T1-T16) are concrete and ready for the test-writer role.
