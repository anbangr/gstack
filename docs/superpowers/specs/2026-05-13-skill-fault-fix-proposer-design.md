# Skill Fault Fix Proposer

**Date:** 2026-05-13
**Status:** Approved — ready for implementation planning

---

## Problem

The skill fault detector (`skill-fault-detector.ts`) identifies build failures and the
learning pipeline (`Step M3.6`) proposes detection patterns. But once a fault category
accumulates investigation reports, there is no mechanism to turn that evidence into a
proposed fix for the skill itself. Humans must read investigation reports and implement
fixes manually with no AI synthesis or diff.

---

## Goal

Give a human a single command that reads all investigation reports for a fault category,
synthesizes the root cause across builds, and produces a fix proposal — advisory prose
for complex changes, ready-to-apply diffs for low-risk changes.

---

## Architecture

### Command Surface

```
gstack skill:propose-fix <CATEGORY>   — one category
gstack skill:propose-fix --all        — all categories with reports but no proposal yet
```

**New file:** `bin/gstack-skill-propose-fix` (bash, ~100 lines).
No changes to `SKILL.md.tmpl`. Standalone CLI, uses same `gstack-config` provider
detection already used by the M3.5 investigator.

### State Machine (per category)

```
investigation reports exist
        ↓
[ gstack skill:propose-fix ]
        ↓
~/.gstack/skill-faults/fix-proposals/<CAT>-<ts>.md   (proposal written)
        ↓
human reviews, edits, applies
        ↓
touch fix-proposals/<CAT>-<ts>.md.applied             (marks done)
```

### "Not yet fixed" Detection

Mirrors the `.pattern-extracted` marker pattern from M3.6:

| State             | Condition                                      |
| ----------------- | ---------------------------------------------- |
| `—` (no proposal) | no `fix-proposals/<CAT>-*.md` file exists      |
| `proposed`        | fix proposal file exists, no `.applied` marker |
| `applied`         | `.applied` marker present                      |

`--all` finds every category with investigation reports that has no corresponding
`fix-proposals/<CATEGORY>-*.md` file, then spawns fix-proposer agents in parallel
(background, one per category). Prints output paths as each completes.

### Input to Fix-Proposer Agent

The agent prompt includes (all content pasted inline — no file paths):

1. All investigation report contents for the category (capped at 5 most recent)
2. Relevant source file contents:
   - `build/SKILL.md.tmpl` (full)
   - Specific `.ts` files implicated in the reports (extracted from report text)
3. Risk tiering rubric (verbatim — see below)
4. Category name, fault description, and `hitCount` from `learned-patterns.json`
   (if it is a learned fault)
5. Instruction: write output to the given path; never propose changes outside
   the listed source files; produce diffs only for LOW RISK changes

---

## Fix Proposal File Format

**Path:** `~/.gstack/skill-faults/fix-proposals/<CATEGORY>-<ts>.md`

The file has five sections:

**Header metadata**

```
# Fix Proposal: TEST_FIXER_LOOP
Generated: 2026-05-13T14:22:00Z
Evidence: 3 investigation reports
  - skill-fault-abc123-TEST_FIXER_LOOP.md
  - skill-fault-def456-TEST_FIXER_LOOP.md
  - skill-fault-ghi789-TEST_FIXER_LOOP.md
Fault type: static
```

**Root Cause Analysis** — synthesized across all reports; the systematic failure mode, not a per-build narrative.

**Recommended Fix: Summary** — one paragraph: what to change and why.

**Per-file sections** — one section per affected file, tagged with risk level:

- `[LOW RISK — patch provided]`: includes `**What:**`, `**Why:**`, and a ready-to-apply diff block
- `[HIGH RISK — advisory only]`: includes `**What:**`, `**Why:**`, and `**To implement:**` prose; no diff

**Apply Instructions**

```
1. Review each diff above
2. Apply low-risk patches: copy manually or git apply
3. Run bun test to verify
4. touch fix-proposals/TEST_FIXER_LOOP-<ts>.md.applied when done
```

---

## Risk Tiering Rubric

The agent classifies every proposed change before deciding whether to produce a diff:

| Change type                                                    | Risk | Output        |
| -------------------------------------------------------------- | ---- | ------------- |
| `SKILL.md.tmpl` — adds content only (new guard, check, step)   | LOW  | diff produced |
| `SKILL.md.tmpl` — modifies or removes existing steps           | HIGH | advisory only |
| `.ts` — adds null check or constant, ≤10 lines                 | LOW  | diff produced |
| `.ts` — touches algorithm logic, error handling, or sequencing | HIGH | advisory only |
| Any change >20 lines or touching multiple call sites           | HIGH | advisory only |

---

## Updates to `gstack skill:learned-faults`

The existing table gains one new column and an updated footer:

```

CATEGORY SEV HITS FIX LEARNED SOURCE
──────────────────── ────── ──── ───────── ─────────────────── ──────────────
TEST_FIXER_LOOP HIGH 5 applied 2026-05-01 14:22 investigator:…
MISSING_ENV_VAR HIGH 3 proposed 2026-05-03 09:11 investigator:…
PLAN_REVIEW_STALEMATE CRITICAL 1 — 2026-05-12 18:44 investigator:…

```

**FIX column values:**

- `—` no proposal yet
- `proposed` fix proposal file exists, no `.applied` marker
- `applied` `.applied` marker present

**Footer:**

```

3 patterns. Run 'gstack skill:propose-fix --all' to generate fix proposals for unfixed categories.

```

---

## Critical Files

| File                              | Change                          |
| --------------------------------- | ------------------------------- |
| `bin/gstack-skill-propose-fix`    | New bash script (~100 lines)    |
| `bin/gstack-skill-learned-faults` | Add `FIX` column; update footer |

No changes to `SKILL.md.tmpl`, `skill-fault-detector.ts`, or `monitor.ts`.

---

## Not in Scope

- Auto-applying patches without human review (requires explicit `.applied` marker)
- Scheduling fix proposals automatically (manual trigger only — `propose-fix` or `--all`)
- Fix proposals for faults with fewer than 1 investigation report
- Patch application via a `gstack skill:apply-fix` command (file has instructions; human applies)
- Confidence scoring or ranking of proposals

```

```
