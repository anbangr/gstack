# Explicit Plan Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fuzzy hardcoded-directory plan search in the shared `/ship` + `/review` plan-completion audit with explicit/structured discovery (explicit arg → conversation context → `spec_branch` exact binding → the deterministic `gstack-build plan-status` resolver → STOP), so the wrong plan can never be silently selected.

**Architecture:** Plan discovery for the skill audits lives in ONE shared resolver, `generatePlanFileDiscovery()` in `scripts/resolvers/review.ts`, which `gen-skill-docs` fans into `/ship` (Step 8) and `/review` (completion audit) via the `PLAN_COMPLETION_AUDIT_SHIP/REVIEW` placeholders. We rewrite that one function. We do NOT touch the build orchestrator's `plan-selection.ts` — it is already deterministic and we reuse it via its `gstack-build plan-status --json` CLI surface. Fork-local skill work: bump `/ship` + `/review` skill frontmatter, never top-level `VERSION`.

**Tech Stack:** TypeScript resolver returning a bash+markdown string; Bun test runner; `bun run gen:skill-docs` regenerates SKILL.md files.

---

### Task 1: Make the resolver testable and write the failing test

**Files:**

- Modify: `scripts/resolvers/review.ts:737` (change `function` → `export function`)
- Test: `test/plan-discovery-resolver.test.ts` (create)

- [ ] **Step 1: Export the resolver so a unit test can import it**

In `scripts/resolvers/review.ts`, change line 737 from:

```typescript
function generatePlanFileDiscovery(): string {
```

to:

```typescript
export function generatePlanFileDiscovery(): string {
```

(The call site at line 777, `sections.push(generatePlanFileDiscovery());`, is unaffected.)

- [ ] **Step 2: Write the failing test**

Create `test/plan-discovery-resolver.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { generatePlanFileDiscovery } from "../scripts/resolvers/review";

describe("generatePlanFileDiscovery — explicit/structured, no fuzzy search", () => {
  const block = generatePlanFileDiscovery();

  it("keeps explicit + conversation-context as the top signals", () => {
    expect(block).toContain("--plan");
    expect(block.toLowerCase()).toContain("conversation");
  });

  it("uses the structured spec_branch exact-match binding", () => {
    expect(block).toContain("^spec_branch: $BRANCH$");
    expect(block).toContain("projects/$SLUG/specs");
  });

  it("delegates /build living plans to the deterministic resolver", () => {
    expect(block).toContain("gstack-build plan-status");
  });

  it("STOPS instead of fuzzy-guessing — no content-grep / mtime / extra dirs", () => {
    // The whole point: these fuzzy patterns must be GONE.
    expect(block).not.toContain('grep -l "$REPO"');
    expect(block).not.toContain("-mmin -1440");
    expect(block).not.toContain(".codex/plans");
    expect(block).not.toContain(".claude/plans");
    // And it must surface ambiguity / absence explicitly.
    expect(block).toContain("NO_PLAN_FILE");
    expect(block).toContain("PLAN_AMBIGUOUS");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/plan-discovery-resolver.test.ts`
Expected: FAIL — the current block still contains `grep -l "$REPO"`, `-mmin -1440`, `.codex/plans`, `.claude/plans`, and lacks `--plan` / `spec_branch` / `gstack-build plan-status` / `PLAN_AMBIGUOUS`.

- [ ] **Step 4: Commit the failing test + export**

```bash
git add scripts/resolvers/review.ts test/plan-discovery-resolver.test.ts
git commit -m "test(resolvers): pin explicit/structured plan discovery (red)

Export generatePlanFileDiscovery and assert the target shape: explicit arg +
conversation + spec_branch exact binding + plan-status resolver, with NO fuzzy
content-grep/mtime fallback. Fails against the current fuzzy block.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Rewrite `generatePlanFileDiscovery()` to explicit/structured discovery

**Files:**

- Modify: `scripts/resolvers/review.ts:737-766` (replace the whole function body)

- [ ] **Step 1: Replace the function body**

Replace lines 737-766 (the current `generatePlanFileDiscovery` function, from `export function generatePlanFileDiscovery(): string {` through its closing `}`) with:

```typescript
export function generatePlanFileDiscovery(): string {
  return `### Plan File Discovery

A plan is located by EXPLICIT signal or STRUCTURED binding — never by fuzzy
content search. Resolve in this order; first hit wins. NEVER fall back to
scanning directories by recency or grepping for the branch/repo name.

1. **Explicit (highest priority):** If this skill was invoked with a plan path
   (e.g. \`--plan <path>\`) or the user named a plan file in their message, use
   that path verbatim. If the path does not exist, STOP and tell the user the
   path is missing — do not guess an alternative.

2. **Conversation context:** If the host agent's system messages reference an
   active plan file (plan mode includes the path), use it directly.

3. **Structured binding (no fuzzy match):** Resolve the branch's bound plan via
   the \`spec_branch\` frontmatter that \`/spec\` writes, then the deterministic
   build resolver for \`/build\` living plans:

\`\`\`bash
eval "$(~/.claude/skills/gstack/bin/gstack-paths 2>/dev/null)" 2>/dev/null || true
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
PLAN=""
# (a) Exact branch->plan binding: spec_branch frontmatter (written by /spec).
SPEC_DIR="\${GSTACK_STATE_ROOT:-$HOME/.gstack}/projects/\${SLUG:-unknown}/specs"
if [ -d "$SPEC_DIR" ]; then
  MATCHES=$(grep -l "^spec_branch: $BRANCH$" "$SPEC_DIR"/*.md 2>/dev/null || true)
  N=$(printf '%s' "$MATCHES" | grep -c . 2>/dev/null || echo 0)
  if [ "$N" = "1" ]; then PLAN="$MATCHES"; fi
  if [ "$N" -gt 1 ] 2>/dev/null; then
    echo "PLAN_AMBIGUOUS: $N specs bound to branch '$BRANCH':"; printf '%s\\n' "$MATCHES"
  fi
fi
# (b) /build living plan: ask the deterministic resolver (knows inbox/living-plan
#     + run claims). Only when a gstack repo is known and the CLI is available.
if [ -z "$PLAN" ] && [ -n "\${GSTACK_REPO:-}" ] && command -v gstack-build >/dev/null 2>&1; then
  SEL=$(gstack-build plan-status --gstack-repo "$GSTACK_REPO" --resume-only --json 2>/dev/null || echo '{}')
  case "$(echo "$SEL" | jq -r '.result // "none"' 2>/dev/null)" in
    selected) PLAN=$(echo "$SEL" | jq -r '.selected.livingPlanPath // .selected.path // empty' 2>/dev/null) ;;
    ambiguous|blocked) echo "PLAN_AMBIGUOUS: gstack-build plan-status is ambiguous/blocked — run: gstack-build plan-status --gstack-repo \\"$GSTACK_REPO\\"" ;;
  esac
fi
[ -n "$PLAN" ] && echo "PLAN_FILE: $PLAN" || echo "NO_PLAN_FILE"
\`\`\`

4. **Do NOT guess.** If the block prints \`NO_PLAN_FILE\` or \`PLAN_AMBIGUOUS\`,
   stop the fuzzy instinct: there is no reliable plan binding. For an audit
   (e.g. /ship Step 8, /review completion), skip with "No plan file detected —
   skipping the completion audit." For a workflow that requires a plan, ask the
   user to pass \`--plan <path>\` or to run from plan mode.

**Validation:** Once a path is chosen by ANY step above, read its first 20 lines
to confirm it is a real plan (has phase/feature headings or checkbox items). If
unreadable, treat as \`NO_PLAN_FILE\` — never substitute a different file.`;
}
```

- [ ] **Step 2: Run the unit test to verify it passes**

Run: `bun test test/plan-discovery-resolver.test.ts`
Expected: PASS (4 tests). The block now contains `--plan`, `conversation`, `^spec_branch: $BRANCH$`, `projects/$SLUG/specs`, `gstack-build plan-status`, `NO_PLAN_FILE`, `PLAN_AMBIGUOUS`, and none of the fuzzy patterns.

- [ ] **Step 3: Commit the rewrite**

```bash
git add scripts/resolvers/review.ts
git commit -m "feat(resolvers): explicit/structured plan discovery (green)

Rewrite generatePlanFileDiscovery: explicit arg -> conversation -> spec_branch
exact binding -> gstack-build plan-status resolver -> STOP. Delete the 4-dir
content-grep + mtime-recency fallback that silently picked the wrong plan.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Bump `/ship` + `/review` skill frontmatter (fork rule)

**Files:**

- Modify: `ship/SKILL.md.tmpl` (frontmatter `version:` line)
- Modify: `review/SKILL.md.tmpl` (frontmatter `version:` line)

- [ ] **Step 1: Read both current frontmatter versions**

Run: `awk '/^version:/{print FILENAME": "$0; exit}' ship/SKILL.md.tmpl; awk '/^version:/{print FILENAME": "$0; exit}' review/SKILL.md.tmpl`
Expected: prints the current `version: X.Y.Z` for each. Record them.

- [ ] **Step 2: Bump each by one patch level**

Edit `ship/SKILL.md.tmpl`: change its `version: X.Y.Z` to `version: X.Y.(Z+1)`.
Edit `review/SKILL.md.tmpl`: change its `version: A.B.C` to `version: A.B.(C+1)`.

(Use the actual numbers from Step 1. These are the two skills whose generated
plan-discovery behavior changed. Do NOT touch top-level `VERSION` or `package.json`
— the fork versioning rule forbids it for fork-local skill work.)

- [ ] **Step 3: Commit the version bumps**

```bash
git add ship/SKILL.md.tmpl review/SKILL.md.tmpl
git commit -m "chore(build): bump ship + review skill frontmatter for plan-discovery change

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Regenerate SKILLs and verify the full suite

**Files:**

- Generated (do not hand-edit): `ship/SKILL.md`, `review/SKILL.md`, and any other regenerated SKILL.md
- Verify: `test/gen-skill-docs.test.ts`, `test/plan-discovery-resolver.test.ts`

- [ ] **Step 1: Regenerate skill docs**

Run: `bun run gen:skill-docs`
Expected: regenerates SKILL.md files; prints the generation summary with no errors. `ship/SKILL.md` and `review/SKILL.md` now embed the new Plan File Discovery block.

- [ ] **Step 2: Confirm the new block landed and the fuzzy block is gone**

Run: `grep -c "gstack-build plan-status" ship/SKILL.md review/SKILL.md; grep -c -- "-mmin -1440" ship/SKILL.md review/SKILL.md`
Expected: first grep ≥ 1 for each file; second grep = 0 for each file.

- [ ] **Step 3: Run the gen-skill-docs quality tests**

Run: `bun test test/gen-skill-docs.test.ts test/gen-skill-docs-idempotency.test.ts test/resolver-entry.test.ts test/plan-discovery-resolver.test.ts`
Expected: all PASS. If gen-skill-docs-idempotency fails, it means generation isn't deterministic — re-run `bun run gen:skill-docs` once more and re-test (idempotency check requires a settled second pass).

- [ ] **Step 4: Run the free test suite**

Run: `bun test`
Expected: the pre-existing/env-flaky failures from this repo (section-manifest `" 2"` junk, brain-cache timeouts, ios-qa device tests, resolve-user-slug, parity ship-drift) may still fail — those are unrelated to this change. There must be NO new failure that references `plan-discovery`, `review.ts`, `ship`, or `review`. If a NEW failure appears in those areas, fix it before continuing.

- [ ] **Step 5: Commit the regenerated docs**

```bash
git add ship/SKILL.md review/SKILL.md
# Stage any OTHER regenerated SKILL.md the generator touched, by explicit name only.
# NEVER `git add -A` (the repo has tracked binaries + " 2" junk files).
git status --short | grep 'SKILL.md$'   # review the list, then add each by name
git commit -m "chore(build): regenerate ship + review SKILL.md (explicit plan discovery)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

- Delete 4-dir content-grep + mtime fallback → Task 2 (removes the body; Task 1 test asserts absence of `grep -l "$REPO"`, `-mmin -1440`, `.codex/plans`, `.claude/plans`). ✓
- Explicit arg → Task 2 step 1 (the `--plan` instruction). ✓
- Conversation context kept → Task 2 step 1 (signal 2). ✓
- `spec_branch` exact binding → Task 2 (`grep -l "^spec_branch: $BRANCH$"`). ✓
- `gstack-build plan-status` resolver → Task 2 (conditional (b) block). ✓
- STOP on none/multiple → Task 2 (`NO_PLAN_FILE` / `PLAN_AMBIGUOUS`, signal 4). ✓
- Regenerate all SKILLs → Task 4. ✓
- Fork-local versioning (skill frontmatter, not VERSION) → Task 3. ✓
- Tests pass → Task 4 steps 3-4. ✓
- `--plan` arg surface: handled as a PROSE instruction in the resolver (signal 1) — the agent reads the user's args/message; no separate arg-parser is added to ship/review, keeping the change to one resolver. This is the lighter, sufficient form of "explicit." ✓

**Placeholder scan:** No TBD/TODO; every code/step has concrete content and exact commands. The only runtime-variable substitutions (`X.Y.Z` in Task 3) are explicitly "use the number from Step 1" because the live versions must be read at execution time. ✓

**Type/identifier consistency:** Test asserts `^spec_branch: $BRANCH$`, `projects/$SLUG/specs`, `gstack-build plan-status`, `NO_PLAN_FILE`, `PLAN_AMBIGUOUS` — all present verbatim in the Task 2 block. Negative assertions (`grep -l "$REPO"`, `-mmin -1440`, `.codex/plans`, `.claude/plans`) are all absent from the Task 2 block. Consistent. ✓

**Out of scope (noted, not done):** Skills that may carry their OWN duplicated fuzzy plan-discovery prose in their `.tmpl` (not via the `PLAN_COMPLETION_AUDIT_*` resolver) are not touched here — the resolver feeds only `/ship` + `/review`. If a later audit finds duplicated blocks elsewhere, that is a follow-up plan.
