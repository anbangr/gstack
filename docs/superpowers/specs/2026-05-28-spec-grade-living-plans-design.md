# Spec-Grade Living Plans for /build

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — pending implementation plan
**Skills touched:** `/build` (primary), `/spec` (one mechanical refactor)
**Related design:** `2026-05-19-build-plan-review-convergence-design.md` (planReviewer loop being replaced)

## Problem

Subagents dispatched by `/build` (test-writer, primary-impl, test-fixer, featureReview/featureVerifier) drift from the living plan in four observed ways:

1. **Invented files/APIs.** Implementation subagent creates schemas, endpoints, or files that don't match what the plan specified — fills in gaps with its own choices instead of asking.
2. **Missed existing code.** Living plan doesn't cite the actual existing files/functions to modify, so the subagent re-discovers (and sometimes misses) what already exists.
3. **Vague test specs.** Test-writer interprets the `#### Test Spec` table loosely — writes weaker assertions, skips edge cases listed, or picks the wrong test file.
4. **Subjective acceptance criteria.** Acceptance lines say "feature works" or "tests pass" but lack concrete numbers (latency, count, schema match) the subagent could verify against.

Additionally, the **feature-completion verification step is unstable**: `featureReview` and `featureVerifier` both invent what to verify at runtime, sometimes pick different probes on retry, and produce free-text "verification inconclusive" outputs that don't drive actionable test-fixer follow-ups.

## Approach

Raise the quality bar of the living plan to match `/spec`-grade content, by:

1. Generating a per-feature **enriched spec** before synthesizing the living plan, codebase-grounded with file:line citations and concrete schemas.
2. Gating each enriched spec with a **codex 0-10 quality score** (mirroring `/spec` Phase 4.5) and conditionally interrogating the user only on critical ambiguities.
3. Requiring a **Verification Spec** section in each enriched spec — pre-designed smoke commands and acceptance probes that the feature-completion verifier runs deterministically, replacing the current invent-at-runtime behavior.
4. Sharing the artifact format with `/spec` so each skill can consume the other's output. `/build` skips its per-feature spec drafting when the source plan already references spec archives; `/build`-generated specs can be promoted to GitHub issues with one command.

The synthesis work moves from a configured `planSynthesizer` subagent into the **parent `/build` orchestrator** by default. The parent has direct tool access (Read, Grep, Bash) to ground specs in real codebase evidence and can run `AskUserQuestion` natively when interrogation is needed.

## Design

### Pipeline

```text
                  Source plan candidates from inbox/
                  + any referenced spec archives
                                   │
                                   ▼
                  Phase 0: Feature Outline
                    Parent extracts feature list +
                    detects which features already have
                    a spec archive (shared format)
                                   │
                  ┌────────────────┴────────────────┐
                  ▼                                 ▼
        Feature HAS spec:                 Feature LACKS spec:
        skip Phase A,                     run Phase A
        go straight to B                  (draft + codex gate
                                           via shared lib +
                                           optional interrogation)
                  │                                 │
                  └────────────────┬────────────────┘
                                   ▼
                  Phase B: Living Plan Expansion
                    Parent reads ALL specs (existing +
                    newly generated), expands into TDD
                    phases with Verification Spec
                    verbatim
                                   ▼
                  Phase C: Structural validator (3-round retry)
                                   ▼
                  User confirms → gstack-build launch
                  → per-feature: featureVerifier runs
                    Verification Spec deterministically
```

### Shared artifact format

One markdown schema, written by both `/spec` and `/build`, located at `~/.gstack/projects/<slug>/specs/<timestamp>-<pid>-<slug>.md` (reuses `/spec`'s existing archive path).

**Frontmatter:**

```yaml
---
spec_id: <feature-or-issue-slug>
spec_archive_format_version: 1
spec_filed_via: /spec | /build | hybrid
spec_issue_number: <N> | null
spec_filed_at: <ISO 8601 UTC timestamp>
spec_quality_score: <0-10>
spec_quality_gate_rounds: <N>
feature_number: <N> # /build-emitted only
source_plan: <absolute path> # /build-emitted only
origin_trace: <source plan refs> # /build-emitted only
target_repo: <repo slug> # /build-emitted only
kind: code | writing | experiment | research | manual
---
```

**Body sections (required for `kind: code`):**

| Section                | Content                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context                | 2-4 sentences: what exists today, why insufficient, why now.                                                                                                         |
| Verified Current State | File:line citations of existing code this feature touches. Table form. Greenfield features state "No existing code".                                                 |
| Proposed Change        | What changes. Function signatures, schemas, API shapes as actual code (not pseudocode).                                                                              |
| Schemas / Interfaces   | TypeScript interfaces, SQL DDL, JSON shapes, etc., as code blocks.                                                                                                   |
| File Reference Table   | Every file to create/modify, with line ranges where the target is known, action (create/modify/delete), and why.                                                     |
| Acceptance Criteria    | Numbered, pass/fail, MUST include at least one quantified criterion.                                                                                                 |
| Test Spec              | `**Coverage target: ≥80%**` + scenario table (ID/Scenario/Given/When/Then) with concrete inputs + edge cases list + optional `<!-- testCmd: -->` for polyglot repos. |
| Verification Spec      | Smoke run (ordered commands) + acceptance probes table (one row per AC) + optional manual verification + verification artifacts list.                                |
| Out of Scope           | Explicit non-goals to prevent scope creep.                                                                                                                           |
| Rollback               | How to undo this feature if it ships broken.                                                                                                                         |

**Body sections (lighter form for non-code kinds):**

| Section             | Content                                                          |
| ------------------- | ---------------------------------------------------------------- |
| Context             | Same as code.                                                    |
| Proposed Change     | What artifact to produce, audience, claims, inputs.              |
| Acceptance Criteria | Observable success criteria (artifact exists, word count, etc.). |
| Verification Spec   | Verification artifacts list + single-sentence pass criteria.     |
| Out of Scope        | Same as code.                                                    |

**Sentinel** at end of file:

```html
<!-- gstack-spec-complete
ts: <ISO>
quality_score: <N>
gate_rounds: <N>
interrogation: yes|no
filed_via: /spec | /build | hybrid
-->
```

### Codex quality gate rubric (shared library)

`bin/codex-spec-gate.ts` is the shared dispatcher. Both `/spec` Phase 4.5 and `/build` Phase A call it with the same rubric.

**Rubric (0-10 weighted score):**

| Dimension                                                                                                          | Weight |
| ------------------------------------------------------------------------------------------------------------------ | ------ |
| File references concrete (file:line where applicable, full paths always)                                           | 2      |
| Schemas/interfaces are actual code, not pseudocode                                                                 | 2      |
| At least one acceptance criterion is quantified with numbers                                                       | 2      |
| Test spec rows have concrete inputs/outputs (not "valid data")                                                     | 2      |
| Verification Spec is concrete (real commands, expected outputs, fixture IDs) and covers EVERY acceptance criterion | 2      |
| Out of Scope is present and meaningful (not "n/a")                                                                 | 1      |
| Verified Current State is grounded in real file:line citations (skipped for greenfield)                            | 1      |

**Maximum: 12 → normalize to 0-10.** Pass threshold: ≥7.

**Fail-closed redaction** (inherited from `/spec` Phase 4.5): scan for secret patterns (AWS keys, GitHub tokens, Anthropic/OpenAI keys, `.env`-style, private key blocks) before dispatch. On match, BLOCK dispatch and surface to user.

**Lighter rubric for non-code features** (no codex call, 3 deterministic checks):

1. Is the artifact path explicit?
2. Are success criteria observable?
3. Are audience/inputs/required-actions named?

Pass = all 3 yes. Fail = batched into a single user notification (no per-feature interrogation).

### Phase A interrogation flow

When codex returns <7 for a feature:

1. Parent extracts the specific dimensions that scored low.
2. AskUserQuestion surfaces 1-3 critical ambiguities (e.g., "Feature 3 ('Order Expiry') scored 5/10. Schemas missing — what's the shape of `OrderExpiryCheck`? Acceptance criterion 1 says 'fast' — what's the target latency?").
3. User can answer all, some, or none (skip = ship the spec at current score, log as `interrogation: skipped`).
4. Parent edits the spec inline with the user's answers, re-dispatches the codex gate.
5. Max 3 rounds. After round 3, surface remaining objections and ask: ship-as-is, edit-manually, or cancel-build.

**Interrogation budget per build:** at most 3 features get full interactive interrogation rounds. Features 4+ with <7 scores are batched into a single end-of-Phase-A "review and confirm" AskUserQuestion with all ambiguities listed together. User can accept-all-as-is, edit-and-rescore-all, or split-plan.

### Phase B expansion rules

Parent reads all enriched specs (existing + newly generated) and writes the living plan feature-by-feature, appending to disk as each feature is expanded.

**Preservation rules:**

1. **Verbatim copy of evidence.** File reference tables, schemas, and quantified acceptance criteria are copied INTO the living plan's per-phase bodies verbatim. No "rephrasing".
2. **One feature spec → one feature block.** Each `## Feature N:` block carries a line-anchored `Spec source: <absolute path>` field alongside `Origin trace:` and `Acceptance:`.
3. **Phase breakdown derives from the spec.** Files to create/modify in the spec map to TDD phases using existing rules (registry additions + orchestrator wiring in same phase, etc.). Test Spec rows from the spec land in the matching code phase's `#### Test Spec` section.
4. **Out of Scope preserved.** Spec's Out of Scope list becomes a line-anchored `Out of scope:` field at the feature-block level.
5. **Verification Spec preserved verbatim.** The full Verification Spec block from the enriched spec is copied into the feature block as a `### Verification Spec` subsection.

**Per-feature append-to-disk:** parent writes each completed feature block to the living plan file before starting the next feature. Spec content is discharged from parent context after each feature.

### Phase C: validator extensions

`validate-living-plan.ts` gains these checks (additive to the existing 5 defect classes):

| Check                           | Description                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Spec source:` line-anchored    | Every `## Feature N:` block has a `Spec source:` line at column 0 pointing at an existing file with a valid `<!-- gstack-spec-complete -->` sentinel.                                                                                                             |
| `Out of scope:` line-anchored   | Every feature block has an `Out of scope:` field (may be `none`).                                                                                                                                                                                                 |
| `### Verification Spec` present | Every code feature block has a `### Verification Spec` subsection.                                                                                                                                                                                                |
| Spec section preservation       | For each `Spec source:` path, read the spec, extract file reference table rows + schema blocks + quantified acceptance items. Each item must appear in the living plan's matching feature block (verbatim match for code blocks; substring match for table rows). |
| Test Spec row preservation      | Each row from the spec's Test Spec table appears in some phase's `#### Test Spec` section in the living plan.                                                                                                                                                     |
| Verification Spec preservation  | Smoke commands + acceptance probes copied verbatim from the spec; each acceptance probe row references an Acceptance Criterion that exists in the same feature block.                                                                                             |

**Retry policy unchanged:** 3 rounds, each with a violation report fed back to the parent for selective rewriting.

### Role wiring changes (`configure.cm`)

| Role                                | Action                                    | Notes                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planSynthesizer`                   | **Optional delegate**                     | Default: parent orchestrator does the work inline. Setting the field delegates specific drafting calls to that role (power-user opt-in).                                |
| `planReviewer`                      | **REMOVED**                               | Replaced by `specQualityGate`.                                                                                                                                          |
| `specQualityGate`                   | **NEW**: codex gpt-5.5 high               | Per-feature spec scoring via shared `bin/codex-spec-gate.ts`.                                                                                                           |
| `featureReview`                     | **REMOVED**                               | Absorbed by `featureVerifier`.                                                                                                                                          |
| `featureVerifier`                   | **Promoted to sole owner**                | Reads Verification Spec from living plan, runs it deterministically, produces structured pass/fail report. Optional free-text `notes` for advisory subjective feedback. |
| `limits.featureReviewMaxIterations` | **RENAME** → `featureVerifyMaxIterations` | Same value: 3.                                                                                                                                                          |
| `timeoutsMs.featureReview`          | **RENAME** → `featureVerify`              | Same value: 1200000.                                                                                                                                                    |

### `featureVerifier` output format

Parsed by `phase-runner.ts`:

```json
{
  "feature": "N — <name>",
  "smoke_run": [
    { "cmd": "<command>", "exit": 0, "status": "pass" }
  ],
  "acceptance_probes": [
    { "ac": 1, "cmd": "...", "expected": "...", "actual": "...", "status": "pass" }
  ],
  "verification_artifacts": [
    { "path": "<path>", "check": "<description>", "status": "pass" }
  ],
  "overall": "pass" | "fail",
  "halt_at": "<section>[index]" | null,
  "notes": "<optional advisory text>"
}
```

On probe failure → test-fixer subagent dispatched with the structured `{ac, cmd, expected, actual, halt_at}` payload. 3 fix iterations cap (`featureVerifyMaxIterations`). After cap, surface to user with structured failure record.

### `/spec` ↔ `/build` integration

**One mechanical refactor in `/spec`:** codex Phase 4.5 dispatch moves to `bin/codex-spec-gate.ts`. No behavior change to `/spec`'s 5 interactive phases, GitHub issue filing, or archive shape.

**`/build` plan discovery learns to read spec archives.** Two detection modes:

1. **Explicit reference** (preferred): source plan frontmatter has `spec_archives: [absolute-path-1, absolute-path-2, ...]`. Each path must exist, must end with a valid `<!-- gstack-spec-complete -->` sentinel, and is assigned to the feature whose `spec_id` matches the archive frontmatter's `spec_id` field.
2. **Auto-match by `spec_id` slug** (fallback): for any feature in Phase 0's outline whose computed slug (lowercase title with non-alphanumerics replaced by `-`, truncated to 60 chars) exactly matches the `spec_id` of an archive in `~/.gstack/projects/<slug>/specs/` written within the last 30 days, the archive is assigned to that feature. Exact string match only — no fuzzy matching.

When detection succeeds, `/build` skips Phase A drafting for that feature and treats the archive as if Phase A had just produced it. Detection failures or sentinel-missing archives fall through to normal Phase A drafting; a one-line notice is printed (`Spec archive at <path> ignored: <reason>`).

**One-command promotion:** `gstack-build spec-to-issue <archive-path>` reads any `/build`-emitted spec and runs `gh issue create --body-file <path>` with the right title, prepending a stable header note (`Promoted from /build-generated spec at <archive-path>`). Updates the archive's frontmatter to set `spec_issue_number`.

## Increments

Four shippable units, each independently mergeable.

### Increment 1: Validator + shared format + content shape

- Define shared artifact format (frontmatter + body sections + sentinel)
- Extend `validate-living-plan.ts`: `Spec source:`, `Out of scope:`, `Verification Spec` checks, spec-section preservation checks
- Update synthesizer prompt in `build/SKILL.md.tmpl` to require new sections in the living plan (Phase A not introduced yet — synthesizer produces spec-grade content inline at the higher bar)

**Risk:** Low. No new subagents, no role changes. Validator retries already exist.

**User-visible win:** Living plans get richer content immediately.

### Increment 2: Per-feature spec gen + codex gate + planReviewer removal

- Add Phase 0 (outline) and Phase A (per-feature spec drafting + codex gate + interrogation) to the parent orchestrator in `build/SKILL.md.tmpl`
- Add `specQualityGate` role to `configure.cm`
- Extract codex gate into shared `bin/codex-spec-gate.ts`
- **Sibling refactor in `/spec`:** `/spec` Phase 4.5 calls the shared library instead of inlining the dispatch (no `/spec` behavior change)
- Remove `planReviewer` from `configure.cm` (keep orchestrator code paths behind `--legacy-plan-review` opt-in flag for one release cycle)
- Sentinel-based compaction recovery in parent
- AskUserQuestion interrogation in parent when score <7; interrogation budget cap

**Risk:** Medium. Parent context budget needs monitoring. Codex gate threshold (7) may need tuning after observing real data.

**User-visible win:** Specs codebase-grounded, quality gate fires pre-launch. ~5-15 min added to time-to-launch per build; user interrogation when source plans are vague.

### Increment 3: featureVerifier consolidation

- Remove `featureReview` from `configure.cm`
- Rename `featureReviewMaxIterations` → `featureVerifyMaxIterations`
- Rename `timeoutsMs.featureReview` → `featureVerify`
- Rewrite `feature-verifier.ts` to read the Verification Spec from the living plan and execute it deterministically
- Update `phase-runner.ts` to parse the structured `{smoke_run, acceptance_probes, ...}` output
- Update test-fixer dispatch to pass the structured failure record
- One-time migration script in `gstack-upgrade/migrations/` for users on custom `configure.cm`

**Risk:** Medium. Existing builds in flight need to handle the role rename gracefully (migration script + back-compat in `role-config.ts` for one release).

**User-visible win:** Feature-completion verification stable; test-fixer gets actionable failures; ~40% wall-clock saving on the gate.

### Increment 4: Cross-skill integration (additive)

- `/build` plan discovery reads spec archives (skip Phase A on covered features)
- `gstack-build spec-to-issue <path>` promotion command
- Documentation updates: `/spec` and `/build` docs both describe the shared format

**Risk:** Low. Purely additive. No removal of existing behavior.

**User-visible win:** Pre-spec'd work isn't re-paid for; `/build` specs can graduate to issues with one command.

## Risks and mitigations

| Risk                                                                  | Likelihood | Mitigation                                                                                                                                                                                |
| --------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent context bloats past usable size on big plans                   | Medium     | Per-feature loop discharges specs to disk immediately; Phase B reads back feature-by-feature. Budget guard: halt at >150K tokens before Phase B with "split the source plan" instruction. |
| Codex quality gate becomes a noise generator                          | Medium     | Track score distribution in `~/.gstack/analytics/spec-quality.jsonl`. If median <7 on well-formed plans, adjust weights or threshold.                                                     |
| User-interrogation fatigue (many <7 features)                         | Medium     | Cap interrogation at 3 features per build; batch remaining into single end-of-Phase-A confirmation.                                                                                       |
| Verification Spec commands can't run (missing tool, port conflict)    | Medium     | `featureVerifier` HALTs with exact command and stderr (no soft-fail). Codex gate flags smoke commands referencing binaries not in PATH (best-effort static check).                        |
| Compaction mid-Phase-A loses context                                  | Low        | Sentinel-based recovery; Phase A is idempotent per feature.                                                                                                                               |
| Removing `planReviewer` regresses quality dimension codex gate misses | Low-Medium | `--legacy-plan-review` opt-in flag in Increment 2; remove code in a later release if no regressions surface.                                                                              |
| `featureVerifier` consolidation loses subjective UX feedback          | Low        | Optional `notes` field carries subjective concerns as advisory text. Dedicated `subjectiveReview` role is a future follow-up if users miss it.                                            |
| Cost increase                                                         | Medium     | Increment 2 adds N codex calls per build (~$0.10/call). Document in CHANGELOG; add `--skip-spec-gate` opt-out for users with high-quality source plans.                                   |
| Existing builds mid-flight when Increment 3 lands                     | Medium     | Migration script + 1-release back-compat in `role-config.ts` accepting old field names.                                                                                                   |

## Non-goals

1. **Only one mechanical refactor in `/spec`**: codex Phase 4.5 dispatch moves to shared library. `/spec`'s user-visible behavior (5 interactive phases, GitHub issue filing, archive shape) is unchanged. No new `/spec` flags, no `--for-build` mode, no batch mode.
2. **Not filing GitHub issues from `/build`.** Per-feature specs land locally with `spec_issue_number: null`. Promotion to issue is one-command via `gstack-build spec-to-issue`.
3. **Not rewriting the synthesizer into a CLI.** Synthesis stays in the parent orchestrator. `planSynthesizer` config delegate stays as a power-user opt-in.
4. **Not adding interactive interrogation to non-code features.** Non-code features get the 3-check lighter rubric, single batched notification on fail.
5. **Not changing the existing 5 structural defect classes.** Imports/fields/paths/multi-arm/stale-quotes checks stay as-is; new checks are additive.
6. **Not changing branch strategy decision logic** (Step 5.7).
7. **Not changing Resume Mode's `gstack-build plan-status --resume` flow.** Per-feature sentinels are internal Phase A optimization; they don't surface as resume candidates.
8. **Not building a dashboard for spec quality scores.** Scores written to `~/.gstack/analytics/spec-quality.jsonl` for `/retro` to pick up.
9. **Not breaking `--dry-run` / `--parallel-phases N`.** Spec generation runs before them. `--dry-run` after spec generation prints the living plan and exits.
10. **Not adding a `subjectiveReview` role.** `featureVerifier`'s `notes` field carries subjective concerns.

## Follow-ups (out of scope for this work)

- `/spec` quality score trending in `/retro`
- Per-feature spec versioning (re-running `/build` on the same source plan overwrites specs today)
- Cross-skill cache: `/build` looks up existing `/spec` archives for files it's about to spec (bounded value; high invalidation risk)
- Subjective-review role
- Spec content reuse across builds beyond the Increment 4 detection
