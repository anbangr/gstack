# Skill Faults Fix Plan — Build Orchestrator Hardening (REVISED)

**Date:** 2026-05-19
**Investigator:** Claude Opus 4.7 (re-investigation after finding the original plan had stale premises)
**Branch:** `worktree-skill-faults-fix-2026-05-19` (commits `381cf844`, `bfdd569e`)
**Faults covered:**

1. `skill-fault-agnt2-prototype-deferred-code-only-20260518-104300-c4ecd19e5932-PREMATURE_COMPLETION.md`
2. `skill-fault-mitosis-control-plane-impl-plan-anbang-20260518-154933-bee3aea0-PREMATURE_COMPLETION.md`
3. `skill-fault-mitosis-prototype-socc26-v022a-schema-v3_1-behavior-subtree-20260518-165328-642f6305-PREMATURE_COMPLETION.md`
4. `skill-fault-discovery-mitosis-prototype-socc26-v022a-schema-v3_1-behavior-subtree-20260518-165328-642f6305-20260518T105055.md`

---

## Context

Four skill-fault reports filed over ~10 hours on 2026-05-18 all tagged PREMATURE_COMPLETION or new `TEST_WRITER_OVER_IMPLEMENTATION`. The original draft of this plan (written before reading the actual orchestrator code) proposed six fixes. Re-investigation against the shipped code revealed:

- **All four faults were detected BEFORE PR #41 squash-merged** (2026-05-18T13:37:19Z UTC vs. last fault detection 12:26:41Z UTC).
- **PR #41 was already a deliberate four-failures response to a different mitosis-oasis batch the same day.** It shipped most of what the original draft proposed, but better (auto-split mixed test+prod diffs into two legibly-named commits, producer-side layer-purity rule in synthesizer prompt).
- **The original draft's Fix 1 premise was factually wrong.** The fault reports asserted "checkboxes are written incrementally per sub-step." There are only 5 checkbox-flip call sites in cli.ts and **all are gated** — there is no incremental flip mechanism in shipped code. A previous investigation got the mechanism wrong; this plan caught it on re-read.

What was *actually* missing from the orchestrator: two narrow but real gaps.

---

## What's already done (PR #41 and predecessors, do NOT re-implement)

| Concern from the fault reports | Already shipped |
|---|---|
| QA agent leaves mixed test+prod dirty tree → manual recovery required | `maybeAutoCommitTestOnlyDirty` auto-splits into two commits (`cli.ts:4513` + commit message helpers `cli.ts:4698-4705`). Knobs: `GSTACK_QA_NO_AUTO_COMMIT`, `GSTACK_QA_NO_AUTO_SPLIT`. Shipped in PR #41 commit `66556fbc`. |
| Test-writer over-implementation; QA scope creep | Producer-side layer-purity rule added to synthesizer prompt (`SKILL.md.tmpl:448`): Review & QA roles in `[code]` phases must limit diffs to test paths; real bugs become follow-up `[code]` phases. Shipped in PR #41 commit on `build/SKILL.md.tmpl`. |
| Python project with `package.json` runs `npx vitest` against pytest suite | (a) `c82eb27f` subdir-aware framework detection — JS subdir beats weak pytest signals only; explicit `pytest.ini` at cwd still wins. (b) `90d61c37` reads `gstack.testCmd` from CLAUDE.md as Priority 0 — project owns its config per CLAUDE.md's platform-agnostic rule. Together they cover the v3.1 fault's vitest-on-Python case without orchestrator hardcoding. |
| `--mark-phase-committed` triggered premature ship in multi-branch mode | PR #41 Failure 4: new `--ship-on-plan-complete` flag (option C in branch-strategy AskUserQuestion) + `--skip-ship` documented as the inhibitor on a single feature. |
| State.phases corruption after FEATURE_NEEDS_PHASES path → silent slot mis-attribution | PR #42 (`reconcileStatePhasesAfterReparse`) + PR #44 (resume-time `arePhasesAligned` guard with fail-closed remediation). Adversarial hardening: duplicate-phase-number detection on both parser and state sides. |
| Branch name truncation losing hash suffix | PR #41 commit on `safeBranchPart` — switched to head(60) + tail(8) preservation. |

The fault reports' summaries are valuable *as artifacts of the historical failure modes*, but several of their proposed fixes were already in flight or shipped. **Reading the actual code beats reading second-hand investigations.**

---

## Gaps that were still real (this branch fixes them)

### Fix 1: Plan checkboxes follow state backward when phases rewind

**Commit:** `381cf844`

**Root cause:** `restartFeatureFromOriginIssues` (`cli.ts:3385-3431`) rewinds a `committed` phase back to `tests_green` to re-run review/QA after origin verification fails. The status rewind is intentional and load-bearing — the re-run is how origin-plan gaps get patched. But the plan markdown checkboxes (flipped by `markCommitted` via `flipPhaseCheckboxes`) were NOT un-flipped during the rewind. If the re-run subsequently fails (any of the 22 `phaseState.status = "failed"` sites fires), the phase ends up at `status=failed` with checkboxes still `[x][x][x]` — the exact PREMATURE_COMPLETION invariant the detector fires on at `skill-fault-detector.ts:429`.

**Mechanism the fault reports got wrong:** they claimed the checkbox-flip-per-sub-step mechanism. That mechanism does not exist in shipped code (5 flip sites total, all gated). The actual mechanism is the rewind-without-un-flip race.

**Fix:** New `unflipPhaseCheckboxes(planFile, phase)` helper in `plan-mutator.ts` — the symmetric counterpart of the existing `reconcilePhaseCheckboxes`. `restartFeatureFromOriginIssues` accepts optional `phases: Phase[]` and, when the rewound phase was `committed`, un-flips its checkboxes via the new helper. Both production call sites (`cli.ts:9875`, `cli.ts:10018`) pass `phases` (already in scope). Older callers that omit `phases` get pre-fix behavior — no breaking change.

**Tests:** 5 new `unflipPhaseCheckboxes` tests in `plan-mutator.test.ts` covering all-three-flip, skip-test-spec, idempotent, kind-specific markers (writing), and round-trip symmetry with `reconcilePhaseCheckboxes`. 2 new `restartFeatureFromOriginIssues` tests in `cli.test.ts` — one proves the un-flip fires on a real temp plan file when `phases` is passed AND non-rewound phases are NOT touched; the other proves omitting `phases` preserves pre-fix behavior.

**Verification:** All 52 `plan-mutator.test.ts` tests pass. All 4 `restartFeatureFromOriginIssues` tests pass.

---

### Fix 4: `--mark-phase-committed` dirty-tree guard

**Commit:** `bfdd569e`

**Root cause:** `markPhaseCommittedAfterManualRecovery` (`cli.ts:5409`) flips checkboxes and writes `committed` state without any inspection of the worktree. Three of the four 2026-05-18 PREMATURE_COMPLETION faults were rescued by `--mark-phase-committed` AFTER an agent had left the worktree dirty (mitosis-prototype-v3.1 fault report's "Recovery Performed" section: "The worktree's dirty files were not committed as part of the recovery — the `--mark-phase-committed` flag updates state machine only"). The next phase then starts on an inconsistent tree.

This is orthogonal to PR #41's auto-split path: auto-split runs INSIDE the gate flow when the agent exits 0; `--mark-phase-committed` is the operator's emergency recovery tool used AFTER the gate has already failed. Until now it had no dirty-tree opinion at all.

**Fix:** Three new behaviors gated on the worktree state and two new mutually-exclusive flags:
- **Dirty + no flag** → refuse with exit 2, list dirty files, print recovery options.
- **`--commit-dirty`** → `git add .` + `git commit -m "fix(recovery): <phase> auto-commit..."` then mark. Pre-commit hooks still run (we do NOT pass `--no-verify`; if a hook fails, operator sees the hook output and can fall back to `--force-dirty`).
- **`--force-dirty`** → emit WARN listing dirty files, mark anyway, leave the dirty state on disk.
- The two flags are mutually exclusive.
- Clean tree → no-op (marks as before).
- `dryRun` → skips the guard entirely (preview must not inspect git).
- `cwd` omitted → skips the guard (preserves backwards compat for legacy callers / unit tests that exercise the state-only transition without a real git fixture).

**Tests:** 7 new tests in `markPhaseCommittedAfterManualRecovery > dirty-tree guard` describe block. Each test stands up a real git repo (`git init` + seed commit) so `captureGitSnapshot` has something real to inspect. Coverage: refuses without flag, `--force-dirty`, `--commit-dirty`, mutual exclusivity, clean tree no-op, cwd-omitted (legacy), dryRun-skips.

**Verification:** All 259 `cli.test.ts` tests pass. All 1362 orchestrator tests pass.

---

## What was descoped (and why)

| Original draft fix | Why dropped |
|---|---|
| Fix 2 (harness-side commit after GATE PASS) | Already done better: `maybeAutoCommitTestOnlyDirty` auto-split keeps prod commits separately legible in git log — superior to the draft's single-commit proposal. |
| Fix 3 (per-role `writeScope` sandbox argv) | Already done better: Phase A2 producer rule (synthesizer prompt) + Phase B auto-split safety net. Producer-side prompt enforcement + CLI safety net is more pragmatic than per-provider sandbox-argv translation across Claude/Codex/Gemini/Kimi. |
| Fix 5 (Python framework detection) | Already done better: `90d61c37` (`gstack.testCmd` Priority 0 — project owns its config per CLAUDE.md platform-agnostic rule) + `c82eb27f` (subdir-aware with explicit precedence). The v3.1 fault's vitest-on-Python case would now be fixed by `gstack.testCmd: pytest` in mitosis-prototype's CLAUDE.md — that's a project-config decision, not an orchestrator bug. |
| Fix 6 (Gemini smoke-test gate) | Speculative; `GEMINI_PROJECT_TEMP_DIR` slug handling isn't in gstack code. Likely upstream Gemini CLI. Documented here as a known issue rather than fixed. |

---

## What's still NOT addressed

- The fault reports themselves contain falsifiable factual errors about the orchestrator's behavior (the "incremental checkbox flip" mechanism doesn't exist in shipped code). Investigators reading the reports as ground truth will repeat the mistake. **Recommendation:** when faults are filed, the investigator should grep for the proposed mechanism in code before publishing. The investigation skill could enforce this with a step that requires citing `file:line` for any asserted mechanism.
- The Gemini slug-normalization issue (`v3_1` vs `v3-1`) from the discovery report is real but lives in the upstream Gemini CLI, not gstack. A workaround: the orchestrator could pre-flight the Gemini backup invocation with a sentinel file. Not implemented this branch.
- **Most of the 22 `phaseState.status = "failed"` sites in cli.ts have no guard against overwriting `committed`.** The `restartFeatureFromOriginIssues` path is the only confirmed committed→failed bridge, but other paths could exist in future code. A defensive `markFailed(phaseState)` helper that refuses to overwrite `committed` would prevent the entire class of regressions. Not implemented this branch — would be a meaningful follow-up.

---

## Verification (end-to-end)

After both fixes shipped to this branch:

1. **`bun test build/orchestrator/__tests__/plan-mutator.test.ts`** → 52 pass / 0 fail (5 new `unflipPhaseCheckboxes` tests included).
2. **`bun test build/orchestrator/__tests__/cli.test.ts`** → 259 pass / 0 fail (2 new `restartFeatureFromOriginIssues` un-flip tests + 7 new `markPhaseCommittedAfterManualRecovery > dirty-tree guard` tests included).
3. **`bun test build/orchestrator/__tests__/`** → 1362 pass / 0 fail across 56 files.
4. **`bun test`** (full free suite) → see commit `bfdd569e` validation log.

## Critical files touched

| File | Fixes |
|------|-------|
| `build/orchestrator/plan-mutator.ts` | Fix 1 (new `unflipPhaseCheckboxes` helper) |
| `build/orchestrator/cli.ts` | Fix 1 (call sites), Fix 4 (guard + flags + help text) |
| `build/orchestrator/__tests__/plan-mutator.test.ts` | Fix 1 tests |
| `build/orchestrator/__tests__/cli.test.ts` | Fix 1 + Fix 4 tests |

## Lessons from re-investigation

1. **The original plan was an Explore-agent-summarized analysis.** When I re-read the code directly, four of six proposed fixes turned out to be already shipped (most just 8 hours before I drafted the plan in PR #41). Direct reading beats agent summaries when the code is going to be touched.
2. **Fault reports are useful as failure-shape artifacts, NOT as code-truth.** This one had factually wrong mechanism claims. A future-Claude reading them should cross-check against current code before designing fixes.
3. **The plan asked good questions to the operator** — "phase-kind storage?" was answered by reading `types.ts:169` (it's already there). Open questions can be answered by reading code, not always by asking.
