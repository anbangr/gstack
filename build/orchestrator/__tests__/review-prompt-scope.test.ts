/**
 * Test specification for PR2 — Make the test-only diff constraint a prompt,
 * not a postcondition.
 *
 * Tests buildCodexReviewBody prompt snapshots, validatePostAgentHygiene
 * diagnostic, and the auto-split safety net.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildCodexReviewBody,
  validatePostAgentHygiene,
  captureGitSnapshot,
  maybeAutoCommitTestOnlyDirty,
} from "../cli";
import type { Phase } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const basePhase: Phase = {
  index: 0,
  number: "1.1",
  name: "Auth middleware",
  featureIndex: 0,
  featureNumber: "1",
  featureName: "Auth",
  body: "Write tests for the auth middleware.",
  testSpecDone: false,
  testSpecCheckboxLine: 5,
  implementationCheckboxLine: 6,
  reviewCheckboxLine: 7,
  implementationDone: false,
  reviewDone: false,
  dualImpl: false,
  kind: "code",
};

const codePhaseWithExtras: Phase = {
  ...basePhase,
  body: "Write tests for the auth middleware.\n\n<!-- testCmd: bun test -->",
};

const nonCodePhase: Phase = {
  ...basePhase,
  kind: "writing",
  body: "Draft the API design document.",
};

const nonCodePhaseWithExtras: Phase = {
  ...nonCodePhase,
  body: "Draft the API design document.\n\n<!-- audit-only -->",
};

// ---------------------------------------------------------------------------
// T1–T4: buildCodexReviewBody prompt snapshots for all four call shapes
// ---------------------------------------------------------------------------

describe("buildCodexReviewBody prompt scope constraint", () => {
  const newItem4 =
    "do NOT edit production source files (the post-agent hygiene gate will reject the phase if you do)";
  const newItem5 =
    "You may execute data-generation or corpus-driver scripts described in the phase";
  const diffScopeBlock = "DIFF SCOPE:";
  const legacyLine =
    "Fix bugs as you find them (workspace-write sandbox is enabled)";

  it("T1: code phase basic (codex review shape) contains constraint", () => {
    const body = buildCodexReviewBody(
      basePhase,
      "plan.md",
      "feat/test",
      1,
      null,
    );
    expect(body).toContain(newItem4);
    expect(body).toContain(newItem5);
    expect(body).toContain(diffScopeBlock);
    expect(body).toContain("test/**");
    expect(body).toContain("__tests__/**");
    expect(body).not.toContain(legacyLine);
  });

  it("T2: code phase with hardening notes (codex qa shape) contains constraint", () => {
    const body = buildCodexReviewBody(
      codePhaseWithExtras,
      "plan.md",
      "feat/test",
      2,
      null,
      "Some hardening note from judge",
    );
    expect(body).toContain(newItem4);
    expect(body).toContain(newItem5);
    expect(body).toContain(diffScopeBlock);
    expect(body).not.toContain(legacyLine);
    // hardening notes should still be present
    expect(body).toContain("Hardening notes from tournament judge");
  });

  it("T3: non-code phase basic (claude review shape) contains constraint", () => {
    const body = buildCodexReviewBody(
      nonCodePhase,
      "plan.md",
      "feat/test",
      1,
      null,
    );
    expect(body).toContain(newItem4);
    expect(body).toContain(newItem5);
    expect(body).toContain(diffScopeBlock);
    expect(body).not.toContain(legacyLine);
    // non-code rubric should still be present
    expect(body).toContain("deliverable completeness and artifact correctness");
  });

  it("T4: non-code phase with origin issues (claude qa shape) contains constraint", () => {
    const body = buildCodexReviewBody(
      nonCodePhaseWithExtras,
      "plan.md",
      "feat/test",
      2,
      "/tmp/gemini-out.md",
      undefined,
      "/tmp/origin-issues.md",
    );
    expect(body).toContain(newItem4);
    expect(body).toContain(newItem5);
    expect(body).toContain(diffScopeBlock);
    expect(body).not.toContain(legacyLine);
    // origin issues should still be present
    expect(body).toContain("Origin-plan verification issues");
    expect(body).toContain("/tmp/origin-issues.md");
  });

  it("edge: explicit [code] phase opt-out does not clobber constraint", () => {
    const explicitCodePhase: Phase = {
      ...basePhase,
      body: "[code] Explicitly marked code phase.",
    };
    const body = buildCodexReviewBody(
      explicitCodePhase,
      "plan.md",
      "feat/test",
      1,
      null,
    );
    // The constraint should still be present even for explicit [code] phases
    expect(body).toContain(newItem4);
    expect(body).toContain(diffScopeBlock);
  });

  it("edge: data-generation allowance permits data/ paths in DIFF SCOPE", () => {
    const body = buildCodexReviewBody(
      basePhase,
      "plan.md",
      "feat/test",
      1,
      null,
    );
    expect(body).toContain("committed data outputs from item 5");
  });
});

// ---------------------------------------------------------------------------
// T5–T6: validatePostAgentHygiene diagnostic
// ---------------------------------------------------------------------------

describe("validatePostAgentHygiene scope diagnostic", () => {
  let tmpDir: string;
  let repo: string;
  let promptWithConstraint: string;
  let promptWithoutConstraint: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-review-prompt-scope-"),
    );
    repo = tmpDir;
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);

    // Create mock prompt files
    promptWithConstraint = path.join(repo, "prompt-with-constraint.md");
    promptWithoutConstraint = path.join(repo, "prompt-without-constraint.md");
    fs.writeFileSync(
      promptWithConstraint,
      "# Review Gate\n\nDIFF SCOPE: file edits limited to test/**\n",
    );
    fs.writeFileSync(
      promptWithoutConstraint,
      "# Review Gate\n\nFix bugs as you find them.\n",
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function commit(file: string, content: string, message = "test commit"): void {
    const abs = path.join(repo, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    expect(spawnSync("git", ["add", file], { cwd: repo }).status).toBe(0);
    expect(
      spawnSync("git", ["commit", "-m", message], { cwd: repo }).status,
    ).toBe(0);
  }

  it("T5: hygiene diagnostic present when reviewer edits production path and prompt had constraint", () => {
    commit("src/foo.ts", "export const foo = 1;\n");
    const before = captureGitSnapshot(repo);

    // Agent edits a production file
    fs.writeFileSync(
      path.join(repo, "src/foo.ts"),
      "export const foo = 2;\n",
    );

    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "review",
      reviewGate: true,
      reviewGatePromptPath: promptWithConstraint,
    });

    expect(verdict.ok).toBe(false);
    const dirtyError = verdict.errors.find((e) =>
      e.includes("left the working tree dirty"),
    );
    expect(dirtyError).toBeDefined();
    expect(dirtyError).toContain(
      "the constraint was in the prompt; reviewer edited production paths anyway",
    );
  });

  it("T6: hygiene diagnostic absent when reviewer edits only test paths", () => {
    commit("src/foo.ts", "export const foo = 1;\n");
    const before = captureGitSnapshot(repo);

    // Agent edits only a test file
    fs.writeFileSync(
      path.join(repo, "src/foo.test.ts"),
      "test('foo', () => {});\n",
    );

    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "review",
      reviewGate: true,
      reviewGatePromptPath: promptWithConstraint,
    });

    // Should still be dirty (test files are still dirty)
    expect(verdict.ok).toBe(false);
    const dirtyError = verdict.errors.find((e) =>
      e.includes("left the working tree dirty"),
    );
    expect(dirtyError).toBeDefined();
    // But the diagnostic about editing production paths should NOT appear
    expect(dirtyError).not.toContain(
      "the constraint was in the prompt; reviewer edited production paths anyway",
    );
  });

  it("edge: reviewer respects prompt — no violation, no diagnostic", () => {
    commit("src/foo.ts", "export const foo = 1;\n");
    const before = captureGitSnapshot(repo);

    // Agent does nothing — respects the prompt
    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "review",
      reviewGate: true,
      reviewGatePromptPath: promptWithConstraint,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it("edge: data corpus commit permitted by item 5 does not trigger diagnostic", () => {
    commit("src/foo.ts", "export const foo = 1;\n");
    const before = captureGitSnapshot(repo);

    // Agent commits a generated data file (permitted by item 5)
    fs.mkdirSync(path.join(repo, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "data/corpus.json"),
      '[{"id": 1}]\n',
    );

    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "review",
      reviewGate: true,
      reviewGatePromptPath: promptWithConstraint,
    });

    // Should still be dirty (data files are not in test glob list)
    expect(verdict.ok).toBe(false);
    const dirtyError = verdict.errors.find((e) =>
      e.includes("left the working tree dirty"),
    );
    expect(dirtyError).toBeDefined();
    // The diagnostic should not appear for data files since item 5 permits them
    expect(dirtyError).not.toContain(
      "the constraint was in the prompt; reviewer edited production paths anyway",
    );
  });

  it("backward compat: no prompt path means no diagnostic even on production edits", () => {
    commit("src/foo.ts", "export const foo = 1;\n");
    const before = captureGitSnapshot(repo);

    fs.writeFileSync(
      path.join(repo, "src/foo.ts"),
      "export const foo = 2;\n",
    );

    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "review",
      reviewGate: true,
      // no reviewGatePromptPath — prior-version gate
    });

    expect(verdict.ok).toBe(false);
    const dirtyError = verdict.errors.find((e) =>
      e.includes("left the working tree dirty"),
    );
    expect(dirtyError).toBeDefined();
    // Diagnostic must NOT appear when prompt path is absent
    expect(dirtyError).not.toContain(
      "the constraint was in the prompt; reviewer edited production paths anyway",
    );
  });

  it("backward compat: prompt without DIFF SCOPE means no diagnostic", () => {
    commit("src/foo.ts", "export const foo = 1;\n");
    const before = captureGitSnapshot(repo);

    fs.writeFileSync(
      path.join(repo, "src/foo.ts"),
      "export const foo = 2;\n",
    );

    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "review",
      reviewGate: true,
      reviewGatePromptPath: promptWithoutConstraint,
    });

    expect(verdict.ok).toBe(false);
    const dirtyError = verdict.errors.find((e) =>
      e.includes("left the working tree dirty"),
    );
    expect(dirtyError).toBeDefined();
    // Diagnostic must NOT appear when prompt lacks DIFF SCOPE
    expect(dirtyError).not.toContain(
      "the constraint was in the prompt; reviewer edited production paths anyway",
    );
  });
});

// ---------------------------------------------------------------------------
// T7: Auto-split safety net unchanged
// ---------------------------------------------------------------------------

describe("maybeAutoCommitTestOnlyDirty safety net (T7)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-review-scope-autosplit-"),
    );
    expect(
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], {
        cwd: repoDir,
      }).status,
    ).toBe(0);

    // Seed a tracked file so HEAD exists
    fs.writeFileSync(path.join(repoDir, "README.md"), "# init\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  it("T7: misplaced test fixture in src/ proceeds as today (non-test paths)", () => {
    // A reviewer placed a plain fixture in src/ — this is NOT a test path
    // because it does not match **/*.test.* (no .test. suffix)
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src", "fixture.ts"),
      "// fixture\n",
    );

    const result = maybeAutoCommitTestOnlyDirty({
      cwd: repoDir,
      label: "review gate",
      dirtyLines: ["?? src/fixture.ts"],
    });

    // Should NOT auto-commit because src/fixture.ts is not in the test globs
    expect(result.committed).toBe(false);
    expect(result.reason).toContain("non-test paths present");
    expect(result.nonTestPaths).toContain("src/fixture.ts");
  });
});
