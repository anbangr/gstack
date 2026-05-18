# Plan: Fault Detector + Synthesizer Hardening (post-drain-faults investigations)

> **plan-eng-review status (2026-05-17):** Approved with 4 decisions applied — see "Eng Review Decisions" below. Scope challenge passed (6 files, ~405 lines, under the 8-file complexity threshold; no design doc needed).

## Context

The drain-faults subcommand shipped in commit `aca5354a` (2026-05-17) is now producing real-world investigation reports automatically. In its first day live, it surfaced three distinct issues across 4 build runs:

1. **Synthesizer mid-write race** — `PLAN_SYNTHESIS_INVALID` fires on plans that are still being written by the synthesizer. The detector sees an incomplete plan; by the time anyone reads the report, the plan is valid. Stale telemetry, no real fault. Reproduced in [agnt2-prototype-postfraud](inbox/skill-faults/skill-fault-agnt2-prototype-postfraud-20260517-131407-4d8e6b21-PLAN_SYNTHESIS_INVALID.md) and [agnt2-paper-postfraud](inbox/skill-faults/skill-fault-agnt2-paper-postfraud-20260517-131407-7a3f1c92-PLAN_SYNTHESIS_INVALID.md).

2. **Synthesizer run-on Acceptance prose** — the `planSynthesizer` role (claude-opus-4-7, reasoning: xhigh) occasionally writes `Origin trace: ... (suffix). Acceptance: ...` as flowing prose instead of breaking `Acceptance:` onto its own line. Detector correctly rejects, build correctly halts. Manual intervention required. Observed in [mitosis Feature 5](inbox/skill-faults/skill-fault-mitosis-control-plane-images-page-qa-fixes-20260517-142632-8526ede7-PLAN_SYNTHESIS_INVALID.md).

3. **Detector block extraction is too loose** — current logic splits on `(?=^## )/m` and filters by `/^## Feature\b/`. The agnt2-paper investigation recommended anchoring on full markdown structure: feature blocks should be `^## Feature N:` and the right-boundary should be the next heading of the same or higher level, not the next substring match. Tightens correctness AND closes a class of false positives where a `## Features overview` summary section is misread.

What's already done (commit `aca5354a` 2026-05-17, do NOT redo):
- `PREMATURE_COMPLETION` detector tightened to fire only on terminal-failed states (commit `be10ed92`). 3 regression tests pass.
- drain-faults subcommand with library + CLI + monitor inline call. 31 test cases. The user has 4 real-world drain reports today proving it works.

Intended outcome: the fault detector's PLAN_SYNTHESIS_INVALID firing rate drops to near-zero for healthy builds, AND the synthesizer pipeline catches its own malformed output before the runner sees it. Both classes of pain (false positives that cost an agent's investigation cycle, and genuine defects that halt the build mid-feature) close.

## Eng Review Decisions (applied 2026-05-17)

The plan-eng-review surfaced four design choices. Each is locked here:

- **D1 — Sentinel write: hybrid (synth writes + shell soft-fault).** Synthesizer writes the sentinel inside the file *after* its own self-check passes. The shell wrapper around Step 5 logs a soft fault (LOW severity diagnostic, not a halt) if the subagent exits 0 but no sentinel appears in the file after 5s. Preserves Fix #2's independent signal: a synthesizer that legitimately failed self-check does NOT get a sentinel; the soft-fault catches the "model forgot the instruction" regression class.

- **D2 — `extractFeatureBlocks` shape: structured `{number, name, header, body, hasOriginTrace, hasAcceptance}`.** Helper returns parsed objects, not raw strings. Detector calls `helper(plan).forEach(b => check(b))`; `validate-living-plan.ts` consumes the same shape. Drift between detector and validator becomes structurally impossible because there's one parser.

- **D3 — Self-check enforcement: shell-side grep gate + bounded retry.** After the synthesizer subagent exits, the shell wrapper runs `bun run build/orchestrator/validate-living-plan.ts <plan>` which calls `extractFeatureBlocks` and exits 0/2. On violation (exit 2), the shell respawns the synthesizer with the violation JSON quoted in the revision prompt (mirrors Step 5.5's `planReviewer` revision pattern). Bounded to 2 rounds; on round 3, emit CRITICAL `PLAN_SYNTHESIS_INVALID` fault and halt the build for human review.

- **D4 — Sentinel format: rich, multi-line.** Mirror the existing `<!-- gstack-plan-review reviewed: ... -->` block convention from [plan-reviewer.ts:144-157](build/orchestrator/plan-reviewer.ts). Shape:
  ```
  <!-- gstack-synthesis-complete
  ts: 2026-05-17T07:42:00Z
  provider: claude
  model: claude-opus-4-7
  reasoning: xhigh
  round: 1
  self_check: passed
  -->
  ```
  Shell appends this from `configure.cm` fields after a passing validator gate. Detector parses lazily: only the `<!-- gstack-synthesis-complete` prefix is required to trigger the gate; unknown fields ignored.

## Architectural decisions (unchanged from initial draft)

- **Sentinel-based race fix, not delay-based**: a 30s post-mtime grace period in the detector would also fix the race, but it's a heuristic and adds latency. The sentinel is explicit, race-free, and contributors don't have to remember a timing constant.
- **Detector regex tightening is non-breaking**: existing valid plans (synthesized correctly) still pass. Only ambiguous/malformed ones get caught.

## Changes

### Fix #1 — Synthesis-complete sentinel (race fix, issue 1)

Three places, per D1 + D4:

**(a) [build/SKILL.md.tmpl](build/SKILL.md.tmpl)** — `planSynthesizer` subagent prompt (inside `build-synthesis-input.md`, around lines 412-490): extend the prompt with a final-action instruction. The subagent MUST run its own structural self-check, then append the rich sentinel as the LAST action of writing the living plan.

**(b) [build/SKILL.md.tmpl](build/SKILL.md.tmpl)** — shell wrapper around Step 5 (lines 659-685): after the subagent exits with code 0, the shell runs `validate-living-plan.ts` against the living plan path. If the validator passes AND no sentinel is present in the file, the shell appends the rich sentinel itself (safety net). If the validator FAILS, see Fix #2 below.

**(c) [build/orchestrator/skill-fault-detector.ts](build/orchestrator/skill-fault-detector.ts)** — in `detectSkillFaults()`, gate the `PLAN_SYNTHESIS_INVALID` check on the presence of `<!-- gstack-synthesis-complete` in the plan. If the file exists but the sentinel is absent, emit NOTHING (not even an analytics event) — treat as "synthesis-in-progress." When the sentinel appears, run the existing structural checks normally (now via `extractFeatureBlocks`).

This is the single most impactful change: removes the entire false-positive class observed in 2/3 of today's investigations.

### Fix #2 — Shell-side structural gate + bounded retry (formatting fix, issue 2)

Per D3:

**(a) [build/orchestrator/validate-living-plan.ts](build/orchestrator/validate-living-plan.ts)** (NEW, ~60 lines) — a small CLI that reads a plan path, calls `extractFeatureBlocks` from `skill-fault-detector.ts`, and exits 0 if every feature has `Origin trace:` AND `Acceptance:` line-anchored in its `header` slice. Exits 2 with a JSON violation report to stderr otherwise. Exit code 2 mirrors how `plan-reviewer` already signals CRITICAL.

**(b) [build/SKILL.md.tmpl](build/SKILL.md.tmpl)** — shell wrapper after the synthesizer dispatch case statement (after line 685):
1. Run `bun run build/orchestrator/validate-living-plan.ts <plan-path>` on every plan in the manifest.
2. Exit 0: proceed to manifest extraction (current Step 5 continuation).
3. Exit 2: parse the violation JSON, build a revision prompt that quotes the violations, re-spawn the synthesizer with the revision prompt. Bounded to 2 retry rounds (tracked via `_SYNTH_ROUND`).
4. Round 3 still fails: write a synthetic `SKILL_FAULT_DETECTED` event (category `PLAN_SYNTHESIS_INVALID`, severity CRITICAL, evidence includes violation JSON), then exit the build with code 1 for human review.

**(c) [build/SKILL.md.tmpl](build/SKILL.md.tmpl)** — synthesizer prompt also documents the structural rule (defense-in-depth: the prompt asks the model to self-check, the shell verifies). Same pattern as Step 5.5.

### Fix #3 — Heading-anchored block extraction helper (anchor fix, issue 3)

Per D2:

**[build/orchestrator/skill-fault-detector.ts](build/orchestrator/skill-fault-detector.ts)** — extract a new exported helper:

```ts
export interface FeatureBlock {
  number: number;          // parsed from "## Feature N:"
  name: string;            // text after the colon
  header: string;          // from heading line to (next ### Phase OR next ## heading), exclusive
  body: string;            // remainder until next ## heading
  hasOriginTrace: boolean; // /^Origin trace:/m on header
  hasAcceptance: boolean;  // /^Acceptance:/m on header
}

export function extractFeatureBlocks(planContent: string): FeatureBlock[];
```

Implementation rules:
1. Split on `^## ` headings.
2. Filter to sections whose heading line matches `^## Feature (\d+):` (exact format — NOT bare `Feature ` substring).
3. For each match, header = content from heading line to the FIRST of: `^### Phase` OR `^## ` (next H2). Body = everything after header.
4. Run the line-anchored regexes against `header` only.

The existing PLAN_SYNTHESIS_INVALID branch (lines 338-364) collapses to:
```ts
for (const block of extractFeatureBlocks(planContent)) {
  if (!block.hasOriginTrace || !block.hasAcceptance) {
    faults.push({ category: "PLAN_SYNTHESIS_INVALID", ... });
  }
}
```

### Test coverage

[test/skill-fault-detector.test.ts](test/skill-fault-detector.test.ts) — extend with these cases:

1. **Sentinel gate (Fix #1c)**: plan without sentinel + missing Acceptance → NO fault. Plan with sentinel + valid structure → no fault. Plan with sentinel + missing Origin trace → fault as today.
2. **Sentinel gate edge cases**: rich sentinel with extra unknown fields → still triggers gate (only the `<!-- gstack-synthesis-complete` prefix is required). Sentinel inside a fenced code block is intentionally NOT excluded — keeps the check cheap and matches markdown semantics.
3. **`extractFeatureBlocks` direct tests (Fix #3)**: plan with `## Features overview` summary section followed by `## Feature 1:`, `## Feature 2:` → helper returns 2 blocks (not 3). Each has correct `number`, `name`, `header`, `body`, `hasOriginTrace`, `hasAcceptance`.
4. **`extractFeatureBlocks` real-world shape (Fix #3)**: feature heading `## Feature 5: F5 — Tag validation (P1, parallel with F4)` (parens, em dash, hyphens) → block correctly extracted, `name` parsed.
5. **Run-on prose regression (Fix #2 + #3)**: plan with `Origin trace: ... (cite). Acceptance: ...` run-on prose on one line → helper sees `hasAcceptance: false` (line-anchored regex doesn't match), detector emits fault, description names the affected feature.

[test/skill-fault-detector.test.ts](test/skill-fault-detector.test.ts) — also add **validate-living-plan.ts integration tests** (~6 cases): exit 0 on valid plan; exit 2 with JSON violations on missing Acceptance; exit 2 on missing Origin; correct stderr JSON shape; nonexistent path → exit 1 with stderr message; empty plan → exit 2 with "no Feature blocks found".

[test/gen-skill-docs.test.ts](test/gen-skill-docs.test.ts) — extend to verify the synthesizer prompt contains: (a) sentinel-write instruction with the rich format, (b) self-check structural rule (the `Origin trace:` / `Acceptance:` line-anchored requirement spelled out), and (c) the shell wrapper invokes `validate-living-plan.ts` after every synthesizer dispatch case.

## Critical Files

| File | Purpose | Diff |
|---|---|---|
| [build/SKILL.md.tmpl](build/SKILL.md.tmpl) | Synthesizer prompt (sentinel + self-check spec) + shell wrapper (validate + bounded retry + safety-net sentinel append) | ~80 lines |
| [build/orchestrator/skill-fault-detector.ts](build/orchestrator/skill-fault-detector.ts) | `extractFeatureBlocks` helper exported + sentinel gate on PLAN_SYNTHESIS_INVALID branch | ~60 lines |
| [build/orchestrator/validate-living-plan.ts](build/orchestrator/validate-living-plan.ts) | NEW CLI: structural validator, exit codes 0/1/2 | ~60 lines |
| [test/skill-fault-detector.test.ts](test/skill-fault-detector.test.ts) | 5 new detector cases + 6 validator integration cases | ~180 lines |
| [test/gen-skill-docs.test.ts](test/gen-skill-docs.test.ts) | Synthesizer template assertions (3 checks) | ~25 lines |
| [build/SKILL.md](build/SKILL.md) | Regenerated from tmpl | auto |

Total: ~405 lines, 6 files. Under the 8-file complexity threshold. Marginally bigger than the initial ~215 line draft because D3 (shell gate) and D2 (structured helper) deliberately expanded scope to close defect classes structurally instead of probabilistically.

## Reused functions / patterns

- `extractFeatureBlocks` exported from [build/orchestrator/skill-fault-detector.ts](build/orchestrator/skill-fault-detector.ts) — single source of truth, consumed by detector AND validate-living-plan.ts.
- Sentinel HTML-comment convention: matches the existing `<!-- gstack-plan-review reviewed: ... -->` block written by [build/orchestrator/plan-reviewer.ts:144-157](build/orchestrator/plan-reviewer.ts). The synthesis-complete sentinel reuses the exact same multi-line shape with `key: value` fields and `-->` terminator.
- Bounded-retry pattern: mirrors Step 5.5 (`planReviewer` round 1/2/3 escalation) at [build/SKILL.md.tmpl:711-729](build/SKILL.md.tmpl). Same `_ROUND` shell var pattern; same "round 3 → halt for human" terminal escalation.
- Synthetic SKILL_FAULT_DETECTED event writes via `writeFaultEvent` already exported from [build/orchestrator/skill-fault-detector.ts](build/orchestrator/skill-fault-detector.ts).
- Test isolation: existing `useIsolatedGstackHome()` pattern from [test/helpers/test-home.ts](test/helpers/test-home.ts).

## NOT in scope

- **Migrating M3.5 logic fully out of the skill template into the CLI**. drain-faults already moved a slice; the rest is a separate plan.
- **Further PREMATURE_COMPLETION detector changes**: commit `be10ed92` tightened it to terminal-failed states.
- **`SKILL_FAULT_RESOLVED` events when faults clear**: Fix #1's sentinel addresses the synthesis case specifically. The generic resolved-event design is a separate, bigger conversation.
- **Investigator timeout configurability** beyond the existing `--investigator-timeout-ms` flag.
- **drain-faults expansion** (e.g. running on a cron). Today's deployment is working.
- **Backfilling sentinels to historical plans**: not needed; the gate is "no sentinel → no fault" so old plans without sentinels just don't get checked (matches today's effective behavior, minus the false positives).

## Failure modes

- **Synthesizer never writes sentinel even after passing self-check (model regression)**: caught by D1's shell safety net — shell appends sentinel when validator passes AND sentinel is absent. Soft fault logs the prompt-instruction regression for retro.
- **Synthesizer writes malformed sentinel (extra whitespace, typo in keys)**: detector gate uses substring `<!-- gstack-synthesis-complete` only; field parsing is lazy. Won't cause silent breakage.
- **Bounded retry burns budget on a truly malformed source plan**: capped at 2 retries × ~30-60s × opus-xhigh cost. Round 3 halts for human review — same pattern as plan-reviewer.
- **`validate-living-plan.ts` itself has a bug and rejects valid plans**: the same parser runs in the detector, so the detector's existing test corpus is the regression guard. If validate-living-plan rejects a plan the detector wouldn't fault, that's a bug in `extractFeatureBlocks` and breaks BOTH places' tests simultaneously — caught at unit-test time.
- **`## Features overview` summary list still trips the helper**: explicit test case (test #3 above) — helper filter is `^## Feature (\d+):` exact format, NOT bare `Feature `, so summary lists never match.

## Parallelization

Three lanes:

- **Lane A** ([build/SKILL.md.tmpl](build/SKILL.md.tmpl)): Fix #1 prompt edit + Fix #2 shell gate edit. Single file. Regen `build/SKILL.md` here. Touches NO TypeScript.
- **Lane B** ([build/orchestrator/skill-fault-detector.ts](build/orchestrator/skill-fault-detector.ts) + [build/orchestrator/validate-living-plan.ts](build/orchestrator/validate-living-plan.ts) + [test/skill-fault-detector.test.ts](test/skill-fault-detector.test.ts)): `extractFeatureBlocks` helper + sentinel gate + NEW validator CLI + all unit tests. Touches NO template.
- **Lane C** ([test/gen-skill-docs.test.ts](test/gen-skill-docs.test.ts)): synthesizer-template assertions. **Depends on Lane A** (assertions check the regenerated content); Lane B is independent.

Recommended execution: A and B in parallel (no file overlap, no semantic dependency). C waits for A's regen to land.

## Verification

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack

# Unit tests
bun test test/skill-fault-detector.test.ts            # expect: existing 72 + 11 new = 83+
bun test test/gen-skill-docs.test.ts                   # expect: existing + 3 new synthesizer-template checks
bun test                                                # full suite: 0 fail, 0 leak

# CLI smoke
echo -e "# fake plan\n## Feature 1: X\nOrigin trace: y\nAcceptance: z\n### Phase 1\n" > /tmp/valid.md
bun run build/orchestrator/validate-living-plan.ts /tmp/valid.md   # expect: exit 0

echo -e "# fake plan\n## Feature 1: X\nOrigin trace: y. Acceptance: z\n### Phase 1\n" > /tmp/runon.md
bun run build/orchestrator/validate-living-plan.ts /tmp/runon.md   # expect: exit 2 + JSON violation on stderr

# End-to-end: simulate a synthesizer mid-write
# 1. Write a partial plan (no sentinel, missing Acceptance on Feature 1).
# 2. Run detectSkillFaults() → expect 0 faults (gated by missing sentinel).
# 3. Append `<!-- gstack-synthesis-complete\nts: ...\n-->` to the plan.
# 4. Re-run detectSkillFaults() → expect 1 PLAN_SYNTHESIS_INVALID fault.

# End-to-end: regression on the mitosis Feature 5 shape
# 1. Write a plan with run-on `Origin trace: ... (...). Acceptance: ...` prose.
# 2. Run validate-living-plan.ts → expect exit 2 (the shell would retry; tests verify exit code + JSON).
# 3. Reformat Acceptance to its own line → validate-living-plan.ts → exit 0.
```

The real-world regression input is on disk already: the [mitosis-control-plane-images-page-qa-fixes plan](inbox/skill-faults/skill-fault-mitosis-control-plane-images-page-qa-fixes-20260517-142632-8526ede7-PLAN_SYNTHESIS_INVALID.md). After all fixes ship, a `/build` on a re-creation of that exact malformed input should be caught by the shell gate (round 1 retry) or recovered (round 2 success) — and never reach the runner.

## Notes

- **VERSION bump**: PATCH (~405 lines, no new user-facing surface; detector, validator, synthesizer wrapper are contributor-internal).
- **CHANGELOG entry** (For contributors section): "Fault detector now gates `PLAN_SYNTHESIS_INVALID` on a synthesis-complete sentinel — eliminates the transient false-positive class observed during synthesizer races. Synthesizer pipeline now structurally validates living plans before the runner sees them, with bounded retry."
- **Auto-checkpoint hook is active**: bisect into 4 commits matching the lanes:
  1. (Lane B part 1) `extractFeatureBlocks` helper + detector refactor + tests
  2. (Lane B part 2) `validate-living-plan.ts` CLI + tests
  3. (Lane A) synthesizer prompt + shell gate + regen `build/SKILL.md`
  4. (Lane C) `gen-skill-docs` template assertions
- Today's 3 drain-faults reports stay on disk as historical evidence. Future drain-faults runs dedup against them (idempotent).

## Implementation Tasks

- [ ] **T1 (P1, human: ~45min / CC: ~15min)** — detector — Extract `extractFeatureBlocks(planContent): FeatureBlock[]` helper, refactor PLAN_SYNTHESIS_INVALID branch to use it
  - Surfaced by: agnt2-paper-postfraud investigation §"Systemic fix required (validator)"; D2 decision
  - Files: `build/orchestrator/skill-fault-detector.ts`
  - Verify: existing 72 tests still pass; helper exported for cross-module use; structured `{number, name, header, body, hasOriginTrace, hasAcceptance}` shape

- [ ] **T2 (P1, human: ~30min / CC: ~10min)** — detector — Add sentinel gate to PLAN_SYNTHESIS_INVALID check (substring match on `<!-- gstack-synthesis-complete`)
  - Surfaced by: agnt2-prototype-postfraud + agnt2-paper-postfraud investigations; D1 decision
  - Files: `build/orchestrator/skill-fault-detector.ts`
  - Verify: plan without sentinel + missing Acceptance → no fault. With sentinel → fault as today.

- [ ] **T3 (P1, human: ~1h / CC: ~20min)** — validator — Write `validate-living-plan.ts` CLI that consumes `extractFeatureBlocks` and exits 0/1/2 with JSON violations on stderr
  - Surfaced by: D3 decision (shell-side grep gate over prompt-only self-check)
  - Files: `build/orchestrator/validate-living-plan.ts` (NEW)
  - Verify: exit 0 on valid plan; exit 2 with `{violations: [{featureNumber, missing: ["acceptance"|"originTrace"]}]}` on missing fields; exit 1 on nonexistent path; 6 integration tests pass

- [ ] **T4 (P1, human: ~1.5h / CC: ~25min)** — synthesizer — Update Step 5 in `build/SKILL.md.tmpl`: prompt edit (self-check spec + rich sentinel write) + shell wrapper (validate + bounded retry + safety-net sentinel append)
  - Surfaced by: mitosis Feature 5 investigation §"Structural (synthesizer + detector)"; D1 + D3 + D4 decisions
  - Files: `build/SKILL.md.tmpl` + regenerated `build/SKILL.md`
  - Verify: `grep "gstack-synthesis-complete" build/SKILL.md` shows multiple hits (prompt + shell wrapper); `grep "validate-living-plan" build/SKILL.md` shows hits in Step 5 wrapper; gen-skill-docs.test.ts assertions pass

- [ ] **T5 (P1, human: ~2h / CC: ~25min)** — tests — Detector: 5 new cases (sentinel gate happy/sad, `extractFeatureBlocks` direct tests covering `## Features overview` + real-world heading + run-on prose). Validator: 6 integration cases. Synthesizer template: 3 assertions.
  - Surfaced by: IRON RULE — every fix needs regression test; D2/D3/D4 decisions need coverage
  - Files: `test/skill-fault-detector.test.ts`, `test/gen-skill-docs.test.ts`
  - Verify: 83+ tests pass in skill-fault-detector.test.ts; trip-tests for sentinel-missing and run-on-prose both fire correctly

- [ ] **T6 (P2, human: ~5min / CC: ~2min)** — copy approved plan to `inbox/skill-fault-detector-hardening-20260517.md` so `/build` can pick it up
  - Surfaced by: user request "save to inbox"
  - Files: `inbox/skill-fault-detector-hardening-20260517.md` (new copy of this plan)
  - Verify: `ls inbox/skill-fault-detector-hardening-*.md` shows the file

## Review Log

| Round | Reviewer | Verdict | Decisions |
|---|---|---|---|
| 1 | plan-eng-review (claude opus-4-7) | APPROVE WITH DECISIONS | D1 hybrid sentinel, D2 structured helper, D3 shell grep gate + bounded retry, D4 rich sentinel format |

Plan ready for implementation. T6 (copy to inbox) runs at approval time; T1–T5 execute via `/build` or manual lanes A/B/C.
