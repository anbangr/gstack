# Fix plan — build orchestrator suite reds (merged)

**Date:** 2026-05-29
**Owner:** Anbang
**Branch (applied fixes):** `fix/orchestrator-ci-gate-and-bugj-test`
**Status:** crash fix + gate wiring + T-J4 + A5 LANDED; **10 genuine per-test reds remain (A1–A4, A6–A11).**

> Merged from two parallel-session plans: the `/build investigate` plan
> ("build-suite-unmasked-failures", deep Group-A root causes) and the
> `/investigate` plan ("orchestrator-gate-pre-existing-reds", crash/gate
> reconciliation + commits). Discrepancies between them are reconciled below.

## Background — one root cause unmasked a backlog

`build/configure.cm` is `DEFAULT_BUILD_CONFIG_FILE`, loaded at module load by
`BUILD_DEFAULTS = loadBuildDefaults()`. It drifted behind the build CLI
(Increments 2–4); the loader now requires three keys it was missing:

- `roles.specQualityGate` (added by `268af346`)
- `limits.featureVerifyMaxIterations`
- `timeoutsMs.featureVerify`

Commit `a176e16d` ("restore prior role customizations") restored an **older
stashed** `configure.cm` from before the upgrade, dropping those keys. Migration
backfill is deliberately skipped for the in-tree default (`isLoadingDefault`), so
the loader threw `configure.cm:roles.specQualityGate must be an object`
(`build-config.ts:272`) — crashing **every** `gstack-build` invocation including
`--help`, and killing the whole `build/orchestrator/__tests__` suite at import.

The crash hid a backlog of reds. With it fixed, the suite (164 files, 2593 tests)
runs and surfaces them.

## What is LANDED (do not redo)

| Item | Commit / state | Notes |
|------|----------------|-------|
| Crash fix: restore 3 keys in `configure.cm` + `.template` + `role-config` guard test | `eb81cdd3` (committed) | guard = "default config and template self-contain every loader-required key"; red→green |
| Bug J **T-J4** comment-aware (Bug L doc comment at `cli.ts:2788` quoted the banned string) | `353944a9` (committed) | bans the string only in EMITTED code, allows it in comments |
| **test:build-skill** wired + `MODULE_TEST_OWNERS` += `spec-archive-discovery.ts` | `9c1b64b0` (committed) | `package.json:42`; `build-skill-gate.yml:66` now runs the suite |
| **A5** gemini: T-D2a rewritten to a "no role routes to gemini-\*" tripwire; decision = keep gemini dropped | applied in working tree (UNCOMMITTED) | `gemini-model-probe.test.ts` 11/11 |

**Reconciliation of the two source plans (these were race artifacts):**
On committed HEAD, `test:build-skill` and the `spec-archive-discovery` matrix
entry were genuinely ABSENT (`git show HEAD:package.json` had no script;
coverage-matrix failed in isolation with `Received: ""`). The "build-suite"
plan observed them present and called them "never missing" / "Group B isolation
flakiness" — but it was reading the working tree *after* the parallel session's
`9c1b64b0`. Confirmed by the post-fix full run: coverage-matrix, T-J4, Bug D,
and same-basename all pass in the **full ordered run** (not just isolation), so
there is **no separate cwd-pollution issue** — those four are resolved, not
flaky.

## Post-fix ground truth

`bun test build/orchestrator/__tests__/` → **2581 pass / 2 skip / 10 fail** (175s).
The 10 fails are all genuine per-test reds below. None is a live `/build`
runtime bug — they are test/source mismatches unmasked by the crash fix.

Cause classes: (a) build-CLI Increments 2–4; (b) `a176e16d` provider flip;
(c) genuine logic bug unrelated to config; (d) stale/brittle test anchor.

---

## OPEN — genuine per-test reds (10)

### A1+A2. `replay-known-halts.test.ts` — Kimi stall + auth attribution lost — class (c)
- Root cause: `phase-runner.ts:723` builds the test-spec-writer error via
  `geminiExitError("test-spec writer", result)`. That helper (`phase-runner.ts:119`)
  only special-cases hygiene stdout; for a stall (`exitCode null`, `stallKilled`)
  or `auth_required` kill it returns the generic `"<role> exited null; see <log>"`,
  so `next.error` no longer contains `"stalled"` / `"authentication required"`.
  Regressed by Bug I commit `703c9cd3` (#107) swapping the call from
  `renderRoleStepFailureMessage` to `geminiExitError`.
- Fix (source): in `geminiExitError`, after the hygiene check, fall through to
  `renderRoleStepFailure(prefix, result)` for `stall`/`auth_required`/`timed_out`/
  `signal_killed` and return its summary before the final `exited N` line. Do NOT
  revert the call site — `test-spec-writer-hygiene-error-attribution.test.ts`
  (T-I3) static-greps for the literal `geminiExitError("test-spec writer", result)`.
  One helper fix resolves both.
- Effort: ~15 min CC.

### A3. `skill-md.test.ts` — "do not hardcode default model names" — class (c) [VERIFIED]
- Root cause: `cli.ts:9045` comment contains `codex/gpt-5.5`; the forbidden-model
  regex `/gpt-\d/` matches inside comments. From PR #106 (`3a0d30df`).
- Fix (source): edit the comment to drop the model name (e.g. "a codex
  test-writer"). One-word deletion. `SKILL.md` / `SKILL.md.tmpl` are clean.
- Effort: ~2 min CC.

### A4. `plan-review-resynth-resolved.test.ts` — T11 critical_exit_pending — class (d)
- Root cause: test greps for the literal `status: "critical_exit_pending"`, which
  refactor `dcd3d7b2` (#101) replaced with a `stalemateStatus` variable
  (`cli.ts:12989`). Source behavior is correct (still persists
  `loopResult.finalVerdict`, still no `faultId`); only the brittle anchor is stale.
- Fix (test): change the anchor to `status: stalemateStatus` (or the bare
  `"critical_exit_pending"` substring); keep the window + `faultId` assertions.
- Effort: ~10 min CC.

### A6. `no-bare-spawn.test.ts` — child_process import invariant — class (c) [VERIFIED]
- Root cause: `sub-agents.ts:26` imports `spawn`/`spawnSync` directly from
  `node:child_process`, bypassing `child-registry` (Decision 3C: all spawns route
  through the registry so signal handlers reap detached children). Call sites: 469,
  548, 3493. Re-introduced by #103 (`4811c5c4`).
- Fix (source): drop the bare import; switch the three sites to `registeredSpawn` /
  `registeredSpawnSync` (already imported lines 22–25). Verify signatures cover the
  async-spawn (469) and sync git-probe (548/3493) cases.
- Effort: ~15 min CC.

### A7. `no-changes-sentinel.test.ts` — NO_CHANGES_NEEDED dirty-tree gate — class (c)
- Root cause: with `requireNewCommit: true`, `recoverMutableAgentCommit`
  (`cli.ts:~3234`, "Bug F" fallback from #105 `7658f3e1`) auto-stages and commits a
  tampered tracked file when the summary has no backticked paths, moving HEAD and
  cleaning the tree, so the gate wrongly returns exitCode 0.
- Fix (source): guard the tracked-changes fallback to skip when the summary is the
  `NO_CHANGES_NEEDED` sentinel (e.g. `&& !/^NO_CHANGES_NEEDED\b/m.test(summary)`).
  An agent declaring "no changes" must not have host-side recovery commit changes
  it never named.
- Effort: ~15 min CC.

### A8. `cli.test.ts` — ship failureReason Location B — class (b)
- Root cause: `a176e16d` flipped `ship.backupProvider` gemini→codex/gpt-5.5
  (`configure.cm:86`). The test stubs `KIMI_BIN` + `GEMINI_BIN` but not `CODEX_BIN`,
  so the backup path runs the real `codex` binary under ship's 30-min window,
  exceeds the test's 30s child timeout, and returns status 130 instead of 1.
  Proven: stubbing `CODEX_BIN` to a fast `exit 1` makes it pass in 1.71s.
- Fix (test): add a `fakeCodex` (`#!/bin/sh\nexit 1`) and pass `CODEX_BIN` in the
  Location B `extraEnv`. Audit sibling Location C/D ship tests for the same gap.
- Effort: ~15 min CC (+10 if auditing all Location tests).

### A9+A10+A11. `integration/loop-*.test.ts` — converge / bail / synth-disputes — class (a)
- Shared root cause: all three call `runPlanReviewLoop()` without
  `legacyPlanReview: true`. Commit `e33d2c40` (Increment 2) added an early return
  when the flag is absent (`plan-review-loop.ts:727`), so the loop body never runs
  and `result.outcome` is `undefined`. The unit test `plan-reviewer-loop.test.ts`
  got the flag at all 10 call sites; these 3 integration tests were missed.
- Fix (test): add `legacyPlanReview: true,` to each `runPlanReviewLoop({...})` input
  (loop-converge-bundle-1 ~line 95, loop-bail-no-progress ~line 93,
  loop-synth-disputes ~line 85). Do NOT weaken the source guard — the opt-in
  default is deliberate.
- Effort: ~5 min CC for all three.

---

## A5 (gemini) — RESOLVED, decision recorded
`a176e16d` dropped gemini from default role assignments "per prior tuning."
**Decision: keep gemini dropped.** T-D2a rewritten from "requires gemini-2.5-flash"
into a tripwire: `not.toContain("gemini-3.5-flash")` + `not.toMatch(/"model":\s*"gemini-/)`
(no role routes to any gemini model). The `"gemini"` timeoutsMs key is a provider
budget, not a model, so it stays. Backup-providers test (already codex) is
consistent. Currently UNCOMMITTED in the working tree — commit alongside the rest.
(Rejected path, for the record: restore gemini-2.5-flash + revert backup edit.)

## Group B — was a race artifact, now CLOSED
The "build-suite" plan listed B1 (coverage-matrix module-ownership), B2
(coverage-matrix test:build-skill), B3 (T-J4), B4 (same-basename timeout) as
"pass standalone, fail only in the full ordered run → isolation/timing." Post-fix
full run shows all four GREEN. B1/B2/B3 were real HEAD reds fixed by `9c1b64b0`
and `353944a9`; B4 did not recur. No separate cwd-pollution fix is needed. If
B4 flakes again under load, add an explicit `}, 30_000)` timeout to the
same-basename test in `integration.test.ts:1282` (cheap insurance).

## Recommended order
1. Commit A5 (uncommitted) to the branch.
2. Trivial/low-risk: A3 (comment), A9–A11 (legacyPlanReview), A4 (anchor).
3. Real source/test fixes, each with a focused re-run: A1+A2 (geminiExitError
   helper), A6 (no-bare-spawn), A7 (NO_CHANGES_NEEDED guard), A8 (CODEX_BIN stub).
4. Re-run `bun run test:build-skill` → expect green, then `bun test`.

Total remaining: ~1.5–2 hrs CC. None blocks `/build` at runtime.

## Source map
| Area | File |
|------|------|
| A1/A2 | `phase-runner.ts` (`geminiExitError` ~119; sites 723, 843); `halt-event-helpers.ts` (`renderRoleStepFailure` ~376) |
| A3 | `cli.ts:9045` |
| A4 | `__tests__/plan-review-resynth-resolved.test.ts` (anchor); `cli.ts:12989` |
| A6 | `sub-agents.ts:26` (+ sites 469, 548, 3493); `child-registry.ts` |
| A7 | `cli.ts:~3234` (`recoverMutableAgentCommit`) |
| A8 | `__tests__/cli.test.ts:~5721` (Location B) |
| A9–A11 | `__tests__/integration/loop-{converge-bundle-1,bail-no-progress,synth-disputes}.test.ts`; guard `plan-review-loop.ts:727` |
| A5 | `configure.cm`; `__tests__/gemini-model-probe.test.ts:81` (DONE) |

## Note: original inbox item
`BUGREPORT-2026-05-27-...-d4b344.md` (Bug J) is ALREADY FIXED (PR #108, in HEAD,
regression test present). Marked resolved in place; can be archived.
