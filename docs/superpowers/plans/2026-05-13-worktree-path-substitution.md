# Worktree Path Substitution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `gstack-build` so that phase bodies containing absolute paths to the base project root are rewritten to the worktree path before being sent to any sub-agent, preventing hygiene failures caused by agents committing to the base repo instead of the worktree.

**Architecture:** Add a module-private `resolvePhaseBody()` helper in `build/orchestrator/cli.ts` that replaces occurrences of `baseProjectRoot` with the worktree path in a phase body string. Apply it at each of the 6 call sites that write phase bodies into agent prompts. Separately, collapse the 3 duplicate `export function buildKindInstructions` declarations to the best-worded one (definition 2 at line 2698).

**Tech Stack:** TypeScript, Bun test runner (`bun:test`).

---

## File map

| File                                       | Action                                                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build/orchestrator/cli.ts`                | Add `resolvePhaseBody()` before `buildGeminiPromptBody`; apply at 6 call sites; delete definitions 1 and 3 of `buildKindInstructions` and the orphaned JSDoc between them              |
| `build/orchestrator/__tests__/cli.test.ts` | Add `resolvePhaseBody` to the import list; add a `describe("resolvePhaseBody")` block with 3 tests; update 1 existing `buildKindInstructions` test that asserts definition-1/3 wording |

---

## Task 1: Delete duplicate `buildKindInstructions` definitions 1 and 3

**Files:**

- Modify: `build/orchestrator/cli.ts`

The file currently has three `export function buildKindInstructions` declarations. Definition 2 (lines 2698–2756) is the canonical one with the best wording. Definitions 1 and 3 must be deleted, along with the orphaned JSDoc between them.

- [ ] **Step 1: Locate definition 1 boundaries**

Open `build/orchestrator/cli.ts`. Definition 1 starts at the line:

```
export function buildKindInstructions(phase: Phase): string[] {
  const sharedTail = [
```

(search from line 2600 onward — it's the FIRST occurrence). It ends just before the two JSDoc comment blocks that start with:

```
/**
 * Build the Gemini prompt body that gets WRITTEN TO A FILE before invocation.
```

- [ ] **Step 2: Delete definition 1 and both orphaned JSDoc blocks**

In `build/orchestrator/cli.ts`, delete from the first `export function buildKindInstructions` (definition 1, ~line 2622) through the end of the second JSDoc block, which ends just before the second `export function buildKindInstructions` line (~line 2698).

The exact block to delete (confirmed by reading the file) is:

```
export function buildKindInstructions(phase: Phase): string[] {
  const sharedTail = [
    `Do NOT run /review, /qa, /ship, or any orchestration skill — those are downstream of you.`,
    `Do NOT update the plan file's checkboxes — the orchestrator handles that.`,
    `Reference existing code by file path — your --yolo file tools work, you don't need code inlined.`,
    REPO_BOUNDARY_INSTRUCTIONS[0],
    REPO_BOUNDARY_INSTRUCTIONS[1],
  ];
  let kindInstructions: string[];
  switch (phase.kind) {
    case "writing":
      kindInstructions = [
        `Produce the written deliverable described in the phase. Quality bar: a reader unfamiliar with the project understands it after one read. No placeholder content.`,
        `Commit the completed artifact to the file path(s) named in the phase body.`,
        `Do NOT write or run tests — this is a writing phase, not a code phase.`,
      ];
      break;
    case "experiment":
      kindInstructions = [
        `Execute the experiment as described. Run the named scripts/commands literally.`,
        `Commit raw results to the named output path(s). Verify output files exist and are non-empty before committing.`,
        `Do NOT summarize or interpret results in this step — that belongs in Review & QA.`,
        `Do NOT write or run tests — this is an experiment phase, not a code phase.`,
      ];
      break;
    case "research":
      kindInstructions = [
        `Produce the synthesis artifact described. Cite primary sources.`,
        `Commit the artifact to the named output path(s). No speculation without explicitly labeling it as such.`,
        `Do NOT write or run tests — this is a research phase, not a code phase.`,
      ];
      break;
    case "manual":
      kindInstructions = [
        `This phase requires a human action outside the AI agent's scope. Ask the user to complete the action named in the phase description, then wait for their confirmation.`,
        `Once the user confirms the action is done, commit a record of completion to the named path (if specified) and return.`,
        `Do NOT attempt to automate the manual action — it is intentionally a human gate.`,
      ];
      break;
    default: // "code"
      kindInstructions = [
        `Make all failing tests pass with minimal correct code. Do NOT change test assertions.`,
        `Also complete every non-code deliverable in the phase description: if it says "run X and produce Y" or "record Z to <path>", actually execute that script/command and commit the output files. Writing the code that could produce Y is not the same as producing Y.`,
        `If there are no existing failing tests, implement the work described above.`,
        `If the project uses GitHub Actions, ensure your changes pass them.`,
        `Commit your changes to the current branch with a clear conventional-commit message.`,
        `Fail forward: if a test fails, fix it before returning. Only return when the code is done and all artifacts are committed.`,
      ];
      break;
  }
  const allLines =
    phase.kind === "code"
      ? [...kindInstructions, ...sharedTail]
      : [
          ...kindInstructions,
          `Commit your changes to the current branch with a clear conventional-commit message.`,
          ...sharedTail,
        ];
  return allLines.map((line, i) => `${i + 1}. ${line}`);
}

/**
 * Build the Gemini prompt body that gets WRITTEN TO A FILE before invocation.
 * The orchestrator never inlines this content into the CLI call — runGemini's
 * shell-prompt is just a short "read $input, write $output" instruction. This
 * is the universal file-path I/O rule (see feedback_llm_file_io.md memory).
 */
/**
 * Returns numbered instruction lines for the implementation subagent, tailored
 * to the phase kind. These replace the one-size-fits-all TDD instructions for
 * non-code phases.
 *
 * All kinds share: Commit, Do NOT run /review, Do NOT update the plan file.
 * Code phases add: Make all failing tests pass, Fail forward.
 * Non-code phases substitute kind-specific quality bars.
 */
```

Replace this entire block with nothing (delete it). Definition 2 (`export function buildKindInstructions(phase: Phase): string[] { const shared = [`) now becomes the only declaration.

- [ ] **Step 3: Locate definition 3 boundaries**

After the `buildGeminiPromptBody` function body, search for the SECOND (now last) occurrence of:

```
export function buildKindInstructions(phase: Phase): string[] {
  const sharedTail = [
```

Definition 3 starts there and ends just before:

```
/**
 * Build the review-gate context body that gets written to a file.
```

- [ ] **Step 4: Delete definition 3**

Delete definition 3 — from `export function buildKindInstructions(phase: Phase): string[] {` (the one with `const sharedTail`) through its closing `}`, ending just before the `/** Build the review-gate context body...` JSDoc.

After this step, `grep -c "^export function buildKindInstructions" build/orchestrator/cli.ts` returns `1`.

- [ ] **Step 5: Run the existing tests**

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack
bun test build/orchestrator/__tests__/cli.test.ts 2>&1 | tail -30
```

Expected: most `buildKindInstructions` tests pass. One test — `"experiment phase: contains 'Commit raw results'"` — will now fail because definition 2 uses `"Commit raw results to the repository"` (not `"Commit raw results to the named output path(s)"`). Note which tests fail.

- [ ] **Step 6: Fix the one affected test**

In `build/orchestrator/__tests__/cli.test.ts`, find the test:

```typescript
it("experiment phase: contains 'Commit raw results'", () => {
  const result = joinInstructions(
    buildKindInstructions(makePhaseWithKind("experiment")),
  );
  expect(result).toContain("Commit raw results");
});
```

The assertion `toContain("Commit raw results")` still passes — both definitions use "Commit raw results". But verify that `toContain("to the named output path")` is NOT in the test (definition 2 says "to the repository", not "to the named output path"). If any test checks for the old wording, update it to the definition-2 wording.

Also check: definition 2 has `"record progress incrementally"` for experiment. If no test covers this new wording, leave it for Task 3.

- [ ] **Step 7: Run tests again to confirm clean**

```bash
bun test build/orchestrator/__tests__/cli.test.ts 2>&1 | grep -E "PASS|FAIL|error"
```

Expected: all `buildKindInstructions` tests pass.

- [ ] **Step 8: Commit**

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/cli.test.ts
git commit -m "fix(build): collapse three duplicate buildKindInstructions to single canonical definition"
```

---

## Task 2: Add `resolvePhaseBody` helper function

**Files:**

- Modify: `build/orchestrator/cli.ts`

- [ ] **Step 1: Find the insertion point**

In `build/orchestrator/cli.ts`, locate the line that starts `export function buildKindInstructions` (the surviving definition 2, now the only one). Insert the new helper immediately BEFORE that line, with one blank line of separation.

- [ ] **Step 2: Insert `resolvePhaseBody`**

Add the following function at that location:

```typescript
/**
 * Rewrites absolute paths to the base project root in a phase body so that
 * sub-agents working inside a git worktree reference the worktree path
 * instead of the base checkout. No-op when baseProjectRoot is unset or
 * equal to worktreePath.
 */
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

- [ ] **Step 3: Export `resolvePhaseBody` for testing**

Change `function resolvePhaseBody` to `export function resolvePhaseBody` so the test file can import it.

- [ ] **Step 4: Verify the file compiles**

```bash
bun run build/orchestrator/cli.ts --help 2>&1 | head -3
```

Expected: prints the `gstack-build` usage header (no syntax errors).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "feat(build): add resolvePhaseBody helper for worktree path substitution"
```

---

## Task 3: Write tests for `resolvePhaseBody`

**Files:**

- Modify: `build/orchestrator/__tests__/cli.test.ts`

- [ ] **Step 1: Add `resolvePhaseBody` to the import**

In `build/orchestrator/__tests__/cli.test.ts`, find the import block from `"../cli"`:

```typescript
import {
  buildGeminiTestSpecPrompt,
  ...
  buildKindInstructions,
  extractCoverageTarget,
  HELP_TEXT,
} from "../cli";
```

Add `resolvePhaseBody` to this import list (alphabetical order is not required; add after `buildKindInstructions`):

```typescript
import {
  buildGeminiTestSpecPrompt,
  ...
  buildKindInstructions,
  resolvePhaseBody,
  extractCoverageTarget,
  HELP_TEXT,
} from "../cli";
```

- [ ] **Step 2: Add `resolvePhaseBody` test block**

After the `describe("buildKindInstructions", ...)` block (search for `describe("findOpenPRForBranch"` and insert before it), add:

```typescript
// ---------------------------------------------------------------------------
// resolvePhaseBody tests
// ---------------------------------------------------------------------------

describe("resolvePhaseBody", () => {
  const base =
    "/Users/anbang/Documents/Antigravity/agnt2-workspace/agnt2-paper";
  const worktree =
    "/Users/anbang/.gstack/build-worktrees/agnt2-paper/run-id-abc123";

  it("replaces base project root with worktree path in body", () => {
    const body = [
      "- `cd /Users/anbang/Documents/Antigravity/agnt2-workspace/agnt2-prototype`",
      `- Stage outputs into ${base}/experiments/E8-integrated-layer-core/`,
      `- Commit in ${base}.`,
    ].join("\n");

    const result = resolvePhaseBody(body, base, worktree);

    expect(result).toContain(
      `${worktree}/experiments/E8-integrated-layer-core/`,
    );
    expect(result).toContain(`Commit in ${worktree}.`);
    expect(result).not.toContain(base);
    // Paths in other repos (agnt2-prototype) are untouched.
    expect(result).toContain(
      "/Users/anbang/Documents/Antigravity/agnt2-workspace/agnt2-prototype",
    );
  });

  it("returns body unchanged when baseProjectRoot equals worktreePath", () => {
    const body = `Stage outputs into ${base}/experiments/`;
    const result = resolvePhaseBody(body, base, base);
    expect(result).toBe(body);
  });

  it("returns body unchanged when baseProjectRoot is undefined", () => {
    const body = `Stage outputs into ${base}/experiments/`;
    const result = resolvePhaseBody(body, undefined, worktree);
    expect(result).toBe(body);
  });
});
```

- [ ] **Step 3: Run the new tests**

```bash
bun test build/orchestrator/__tests__/cli.test.ts --testNamePattern "resolvePhaseBody" 2>&1
```

Expected: 3 tests pass.

- [ ] **Step 4: Run the full test file**

```bash
bun test build/orchestrator/__tests__/cli.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/__tests__/cli.test.ts
git commit -m "test(build): add resolvePhaseBody unit tests"
```

---

## Task 4: Apply `resolvePhaseBody` at the 6 call sites

**Files:**

- Modify: `build/orchestrator/cli.ts`

There are 6 places in the orchestration loop that build an agent prompt from `phase`. Each needs a resolved copy of the phase. The pattern is always:

```typescript
// BEFORE
buildXxxPromptBody(phase, ...)
// AFTER
buildXxxPromptBody({ ...phase, body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd) }, ...)
```

For the dual-impl candidate call site, use `candidateState.worktreePath` instead of `cwd`.

- [ ] **Step 1: Call site 1 — `buildGeminiPromptBody` (primary-impl run)**

Search for the first `buildGeminiPromptBody(phase, state.planFile, state.branch)` call (inside `fs.writeFileSync(..., buildGeminiPromptBody(...))`). It is in the `RUN_GEMINI` action branch.

Change:

```typescript
fs.writeFileSync(
  inputFilePath,
  buildGeminiPromptBody(phase, state.planFile, state.branch),
);
```

To:

```typescript
fs.writeFileSync(
  inputFilePath,
  buildGeminiPromptBody(
    { ...phase, body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd) },
    state.planFile,
    state.branch,
  ),
);
```

- [ ] **Step 2: Call site 2 — `buildGeminiPromptBody` (primary-impl re-run with review feedback)**

Search for `buildGeminiPromptBody(\n            phase,\n            state.planFile,\n            state.branch,\n            reviewContent,` (the 4-argument call).

Change:

```typescript
buildGeminiPromptBody(
  phase,
  state.planFile,
  state.branch,
  reviewContent,
),
```

To:

```typescript
buildGeminiPromptBody(
  { ...phase, body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd) },
  state.planFile,
  state.branch,
  reviewContent,
),
```

- [ ] **Step 3: Call site 3 — `buildCodexReviewBody`**

Search for `buildCodexReviewBody(\n            phase,` inside the `CODEX_REVIEW` / review-gate action branch.

Change:

```typescript
buildCodexReviewBody(
  phase,
  state.planFile,
  state.branch,
  action.iteration,
  geminiOutputExists ? geminiOutputPath : null,
  phaseState.dualImpl?.judgeHardeningNotes,
  phaseState.originIssueLogPath,
),
```

To:

```typescript
buildCodexReviewBody(
  { ...phase, body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd) },
  state.planFile,
  state.branch,
  action.iteration,
  geminiOutputExists ? geminiOutputPath : null,
  phaseState.dualImpl?.judgeHardeningNotes,
  phaseState.originIssueLogPath,
),
```

- [ ] **Step 4: Call site 4 — `buildGeminiTestSpecPrompt`**

Search for `buildGeminiTestSpecPrompt(phase, state.planFile)` inside the test-writer action branch.

Change:

```typescript
buildGeminiTestSpecPrompt(phase, state.planFile),
```

To:

```typescript
buildGeminiTestSpecPrompt(
  { ...phase, body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd) },
  state.planFile,
),
```

- [ ] **Step 5: Call site 5 — `buildDualImplPromptBody` (per-candidate)**

Inside `const runCandidate = async (candidate: DualImplCandidateKey) => {`, find the `buildDualImplPromptBody` call. Here `candidateState.worktreePath` is the sub-worktree for this candidate — use it instead of `cwd`.

Change:

```typescript
fs.writeFileSync(
  inputPath,
  buildDualImplPromptBody({
    phase,
    planFile: state.planFile,
    candidate,
    opponent,
  }),
);
```

To:

```typescript
fs.writeFileSync(
  inputPath,
  buildDualImplPromptBody({
    phase: {
      ...phase,
      body: resolvePhaseBody(
        phase.body,
        args.baseProjectRoot,
        candidateState.worktreePath,
      ),
    },
    planFile: state.planFile,
    candidate,
    opponent,
  }),
);
```

- [ ] **Step 6: Call site 6 — `buildJudgePrompt`**

Search for `buildJudgePrompt({` in the dual-impl judge action branch. The call currently looks like:

```typescript
fs.writeFileSync(
  inputPath,
  buildJudgePrompt({
    phase,
    candidates: {
      primary: { ... },
      secondary: { ... },
    },
  }),
);
```

Change only the `phase` property — leave `candidates` and everything inside it exactly as-is:

```typescript
fs.writeFileSync(
  inputPath,
  buildJudgePrompt({
    phase: { ...phase, body: resolvePhaseBody(phase.body, args.baseProjectRoot, cwd) },
    candidates: {
      primary: { ... },   // unchanged
      secondary: { ... }, // unchanged
    },
  }),
);
```

- [ ] **Step 7: Verify the file compiles**

```bash
bun run build/orchestrator/cli.ts --help 2>&1 | head -3
```

Expected: usage header, no errors.

- [ ] **Step 8: Run the full test suite**

```bash
bun test build/orchestrator/__tests__/cli.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "fix(build): apply resolvePhaseBody at all 6 agent prompt call sites"
```

---

## Task 5: Run the full free test suite and verify Node.js import

**Files:** none modified

- [ ] **Step 1: Run free test suite**

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack
bun test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 2: Confirm single `buildKindInstructions` declaration**

```bash
grep -c "^export function buildKindInstructions" build/orchestrator/cli.ts
```

Expected output: `1`

- [ ] **Step 3: Confirm Node.js no longer throws SyntaxError**

```bash
node --input-type=module -e "
  import { createRequire } from 'module';
  const require = createRequire(import.meta.url);
  try {
    // Attempt ESM dynamic import to trigger duplicate-export detection
    import('/Users/anbang/Documents/Antigravity/claude-workspace/gstack/build/orchestrator/cli.ts')
      .then(() => console.log('OK'))
      .catch(e => { if (e.message.includes('already been declared')) { process.exit(1); } console.log('OK (non-duplicate error)'); });
  } catch(e) { console.log('OK'); }
" 2>&1
```

Expected: `OK` or `OK (non-duplicate error)` — the `SyntaxError: Identifier 'buildKindInstructions' has already been declared` error is gone.

- [ ] **Step 4: Final commit if any files were missed**

If any uncommitted changes remain:

```bash
git status
git add <any remaining files>
git commit -m "chore(build): worktree path substitution — final cleanup"
```
