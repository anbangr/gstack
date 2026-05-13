# Design: Worktree path substitution for gstack-build experiment phases

**Date:** 2026-05-13
**Status:** Approved
**Branch:** feat/multi-host-upgrade-sync

---

## Problem

`gstack-build` creates an isolated git worktree at `~/.gstack/build-worktrees/<repo>/<run-id>/` and launches sub-agents with `--work-dir` pointing there. Plans are authored against the base project root (e.g., `/Users/anbang/Documents/Antigravity/agnt2-workspace/agnt2-paper`). When a plan's phase body contains absolute paths to the base repo, the agent follows them literally: it writes files to the base repo and commits there, not in the worktree.

The post-agent hygiene check compares the worktree HEAD before and after the agent run. It sees no new commit in the worktree and fails:

> "Gemini hygiene failed: primary implementor did not create a new commit"

This caused the `agnt2-paper` build run `agnt2-non-blocking-e8-e9-e11-paper-evidence-20260513` to record phase 1 as `"failed"` even though the Kimi agent ran successfully and committed to the base repo branch `paper/latest-prototype-sync`.

There is also a secondary bug: three duplicate `export function buildKindInstructions` declarations exist in `cli.ts`, causing a SyntaxError under Node.js and silent dead-code under Bun.

---

## Root cause

`buildGeminiPromptBody()` and the other four prompt-builder functions in `build/orchestrator/cli.ts` embed `phase.body.trim()` verbatim. The orchestrator knows `baseProjectRoot` (the original checkout) and `cwd` (the worktree path), but never uses this knowledge to rewrite paths in the phase body before dispatch.

---

## Scope

Two bugs, one PR:

1. **Missing path substitution** — phase body sent verbatim to agents contains base-repo absolute paths.
2. **Duplicate function declarations** — three `export function buildKindInstructions` at lines 2622, 2698, 2820.

Out of scope: patching the stuck `agnt2-paper` build state (handled separately / manually).

---

## Design

### Fix 1: `resolvePhaseBody` helper

Add a module-private helper in `build/orchestrator/cli.ts`:

```typescript
function resolvePhaseBody(
  body: string,
  baseProjectRoot: string | undefined,
  worktreePath: string,
): string {
  if (!baseProjectRoot || baseProjectRoot === worktreePath) return body;
  // Replace with trailing slash first to avoid partial matches on the bare path.
  return body
    .replaceAll(baseProjectRoot + "/", worktreePath + "/")
    .replaceAll(baseProjectRoot, worktreePath);
}
```

**Threading strategy:** At the six call sites in the main orchestration loop, create a resolved copy of the phase before passing it to any prompt builder:

```typescript
const resolvedPhase = {
  ...phase,
  body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd),
};
```

The prompt-builder functions remain unchanged (pure text templaters). The substitution is applied once per call site, before the phase reaches any builder.

**Call sites:**

| Function                                | Location               | Notes                             |
| --------------------------------------- | ---------------------- | --------------------------------- |
| `buildGeminiPromptBody(phase, ...)`     | ~line 4556             | Primary/secondary implementor     |
| `buildGeminiPromptBody(phase, ...)`     | ~line 4656             | Primary-impl re-run with feedback |
| `buildCodexReviewBody(phase, ...)`      | ~line 4754             | Codex review gate                 |
| `buildGeminiTestSpecPrompt(phase, ...)` | call site in TDD path  | Test spec writer                  |
| `buildDualImplPromptBody({phase, ...})` | ~line 5106             | Dual-impl tournament              |
| `buildJudgePrompt({phase, ...})`        | call site in dual-impl | Judge/comparison                  |

`extractCoverageTarget(phase.body)` (lines 3077, 4899) parses for a coverage percentage and produces no agent-facing text — no substitution needed there.

**When `baseProjectRoot` is unset or equal to `cwd`:** The helper returns the body unchanged. Non-worktree builds (base == worktree) are unaffected.

### Fix 2: Deduplicate `buildKindInstructions`

Three `export function buildKindInstructions` declarations exist:

| Definition | Lines     | Content                                                                         |
| ---------- | --------- | ------------------------------------------------------------------------------- |
| 1 (delete) | 2622–2697 | Older, less complete wording                                                    |
| 2 (keep)   | 2698–2756 | Best wording: experiment variance, incremental progress, numbered `shared` tail |
| 3 (delete) | 2820–2897 | Identical to definition 1; dead code                                            |

Also delete the orphaned JSDoc comment block between definitions 1 and 2 (describes definition 2 but is structurally detached from it).

After cleanup, Node.js can import the file without a SyntaxError.

---

## Files changed

| File                                       | Change                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `build/orchestrator/cli.ts`                | Add `resolvePhaseBody()` helper; apply at 6 call sites; delete 2 duplicate `buildKindInstructions` definitions and orphaned JSDoc |
| `build/orchestrator/__tests__/cli.test.ts` | Add 3 unit tests (see Verification)                                                                                               |

---

## Verification

1. **`bun test`** — free test suite passes (skill validation, gen-skill-docs).

2. **Unit tests** in `build/orchestrator/__tests__/cli.test.ts`:
   - `resolvePhaseBody(body, base, worktree)` where `base !== worktree` → all occurrences of `base` and `base/` in body are replaced with `worktree` and `worktree/`
   - `resolvePhaseBody(body, base, base)` → body returned unchanged
   - `resolvePhaseBody(body, undefined, worktree)` → body returned unchanged

3. **No duplicate declarations:**

   ```bash
   grep -c "^export function buildKindInstructions" build/orchestrator/cli.ts
   # Expected: 1
   ```

4. **Node.js import sanity** (after fix):

   ```bash
   node --input-type=module -e "
     import('/Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/cli.ts')
       .then(() => console.log('OK'))
       .catch(e => { console.error(e.message); process.exit(1); })
   "
   # Expected: OK (or a runtime error unrelated to duplicate declarations)
   ```

5. **Manual smoke** (optional): restart the `agnt2-paper` build run from phase 1, confirm the hygiene check passes and the worktree HEAD advances.
