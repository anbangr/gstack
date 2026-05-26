/**
 * Regression tests for the test-writer role-drift structural fix.
 *
 * Bug ref: ~/.claude/skills/gstack/inbox/BUGREPORT-2026-05-26-test-writer-role-drift-structural-fix.md
 * Plan ref: ~/.claude/plans/fix-test-writer-role-drift-structural.md
 *
 * Three legs of the fix, three test groups:
 *
 *   Leg 2 (recovery refusal):
 *     T-A: recoverMutableAgentCommit with roleId: "test-writer" + summary
 *          listing only production-code paths → refused
 *     T-B: same but with mixed test + non-test → also refused (strict)
 *     T-C: test-paths-only summary → accepted (happy path)
 *     T-D: roleId: "primary-impl" with non-test paths → accepted
 *          (role-scoped — test-writer rule doesn't apply to other roles)
 *
 *   Leg 3 (post-commit detection — static-grep wiring check):
 *     T-E: RUN_GEMINI_TEST_SPEC dispatch block contains the
 *          TEST_WRITER_NO_TEST_FILES_COMMITTED error path
 *
 *   Leg 1 (prompt hardening):
 *     T-F: buildGeminiTestSpecPrompt output contains the role boundary
 *          block + the allowed-paths list
 *
 *   Static-grep wiring (cross-leg):
 *     T-G: every applyMutableAgentHygiene call site in cli.ts passes a
 *          roleId field
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildGeminiTestSpecPrompt,
  captureGitSnapshot,
  recoverMutableAgentCommit,
} from "../cli";
import type { Phase } from "../types";

let tmpDir: string;
let repo: string;
let outputFilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-writer-drift-"));
  repo = path.join(tmpDir, "myproj");
  fs.mkdirSync(repo, { recursive: true });
  initRepo(repo);
  // Seed the repo with both a production-code file and a test directory
  // so the recovery function has paths to potentially stage.
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "__tests__"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "postgres-idempotency.ts"),
    "export const original = 1;\n",
  );
  fs.writeFileSync(
    path.join(repo, "__tests__", ".gitkeep"),
    "",
  );
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync(
    "git",
    ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-m", "seed"],
    { cwd: repo },
  );
  outputFilePath = path.join(tmpDir, "output.md");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function initRepo(dir: string): void {
  expect(spawnSync("git", ["init", "-b", "main"], { cwd: dir }).status).toBe(0);
  expect(
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
    }).status,
  ).toBe(0);
  expect(
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir }).status,
  ).toBe(0);
}

function dirtyMutate(file: string, content: string): void {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeSummary(files: string[]): void {
  // Format matches what extractSummaryFilePaths in cli.ts will pick up:
  // bullets with backtick-quoted paths under a "Files changed" section.
  fs.writeFileSync(
    outputFilePath,
    [
      "## Implementation summary",
      "",
      "### Files changed",
      ...files.map((f) => `- \`${f}\``),
      "",
      "### What was implemented",
      "- (test stub)",
      "",
    ].join("\n"),
  );
}

describe("Leg 2: recoverMutableAgentCommit refuses non-test files for test-writer", () => {
  it("T-A: refuses when summary lists only production-code paths", async () => {
    dirtyMutate("src/postgres-idempotency.ts", "export const drifted = 2;\n");
    writeSummary(["src/postgres-idempotency.ts"]);
    const before = captureGitSnapshot(repo);

    const result = await recoverMutableAgentCommit({
      cwd: repo,
      before,
      outputFilePath,
      label: "test-writer",
      roleId: "test-writer",
    });

    expect(result.recovered).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("test-writer recovery REFUSED");
    expect(result.errors[0]).toContain("src/postgres-idempotency.ts");
    expect(result.errors[0]).toContain("role drift");
    expect(result.errors[0]).toContain("--mark-phase-committed");
    // Tree should still be dirty (the refusal leaves the working tree
    // alone so the operator can inspect what the agent produced).
    const after = captureGitSnapshot(repo);
    expect(after.head).toBe(before.head);
    expect(after.status.length).toBeGreaterThan(0);
  });

  it("T-B: refuses strict on mixed test + non-test paths", async () => {
    dirtyMutate("src/postgres-idempotency.ts", "export const drifted = 2;\n");
    dirtyMutate(
      "__tests__/postgres-idempotency.test.ts",
      "import { test, expect } from 'bun:test'; test('x', () => expect(1).toBe(1));\n",
    );
    writeSummary([
      "src/postgres-idempotency.ts",
      "__tests__/postgres-idempotency.test.ts",
    ]);
    const before = captureGitSnapshot(repo);

    const result = await recoverMutableAgentCommit({
      cwd: repo,
      before,
      outputFilePath,
      label: "test-writer",
      roleId: "test-writer",
    });

    expect(result.recovered).toBe(false);
    expect(result.errors[0]).toContain("test-writer recovery REFUSED");
    expect(result.errors[0]).toContain("src/postgres-idempotency.ts");
  });

  it("T-C: accepts test-paths-only summary (happy path)", async () => {
    dirtyMutate(
      "__tests__/postgres-idempotency.test.ts",
      "import { test, expect } from 'bun:test'; test('x', () => expect(1).toBe(1));\n",
    );
    writeSummary(["__tests__/postgres-idempotency.test.ts"]);
    const before = captureGitSnapshot(repo);

    const result = await recoverMutableAgentCommit({
      cwd: repo,
      before,
      outputFilePath,
      label: "test-writer",
      roleId: "test-writer",
    });

    expect(result.recovered).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.commit).toBeDefined();
    const after = captureGitSnapshot(repo);
    expect(after.head).not.toBe(before.head);
  });

  it("T-D: roleId: primary-impl accepts non-test paths (role-scoped)", async () => {
    dirtyMutate("src/postgres-idempotency.ts", "export const updated = 2;\n");
    writeSummary(["src/postgres-idempotency.ts"]);
    const before = captureGitSnapshot(repo);

    const result = await recoverMutableAgentCommit({
      cwd: repo,
      before,
      outputFilePath,
      label: "primary implementor",
      roleId: "primary-impl",
    });

    // primary-impl is expected to write production code; the test-writer
    // refusal rule MUST NOT fire here. Pins that the leg 2 check is
    // strictly role-scoped.
    expect(result.recovered).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("T-D-2: no roleId passed (backwards compat) accepts non-test paths", async () => {
    // Pre-leg-1 callers may not have been updated to pass roleId.
    // The refusal MUST NOT fire when roleId is undefined.
    dirtyMutate("src/postgres-idempotency.ts", "export const updated = 2;\n");
    writeSummary(["src/postgres-idempotency.ts"]);
    const before = captureGitSnapshot(repo);

    const result = await recoverMutableAgentCommit({
      cwd: repo,
      before,
      outputFilePath,
      label: "some-other-agent",
      // roleId intentionally omitted
    });

    expect(result.recovered).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("Leg 3: post-commit detection (static-grep wiring)", () => {
  it("T-E: RUN_GEMINI_TEST_SPEC dispatch contains TEST_WRITER_NO_TEST_FILES_COMMITTED detection", () => {
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const content = fs.readFileSync(cliPath, "utf-8");

    // Locate the RUN_GEMINI_TEST_SPEC handler.
    const blockStart = content.indexOf(
      'action.type === "RUN_GEMINI_TEST_SPEC"',
    );
    expect(blockStart).toBeGreaterThan(0);

    // Locate the next action handler (VERIFY_RED) as the upper bound.
    const blockEnd = content.indexOf(
      'action.type === "VERIFY_RED"',
      blockStart,
    );
    expect(blockEnd).toBeGreaterThan(blockStart);

    const block = content.slice(blockStart, blockEnd);
    expect(block).toContain("TEST_WRITER_NO_TEST_FILES_COMMITTED");
    expect(block).toContain("role drift");
    expect(block).toContain("--mark-phase-committed");
    expect(block).toContain("git reset --hard HEAD~1");
    // The new logic must distinguish "no commit" (touched.length === 0 AND
    // allCommitted.length === 0 → silent skip) from "commit but all non-test"
    // (allCommitted.length > 0 AND touched.length === 0 → fail phase).
    expect(block).toMatch(/allCommitted\.length\s*>\s*0/);
  });
});

describe("Leg 1: prompt hardening", () => {
  it("T-F: buildGeminiTestSpecPrompt prepends the role-boundary block", () => {
    const phase: Phase = {
      index: 0,
      number: "1.2",
      name: "Add idempotency replay test for postgres-idempotency.ts",
      body: "Test that PostgresIdempotency.beginRequest is idempotent under concurrent calls.",
      testSpecDone: false,
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 5,
      reviewCheckboxLine: 6,
      implementationDone: false,
      reviewDone: false,
      dualImpl: false,
      kind: "code",
    };

    const prompt = buildGeminiTestSpecPrompt(phase, "/tmp/plan.md");

    // The role-boundary block MUST appear before the phase description so
    // it's the first instruction the agent reads.
    const boundaryIdx = prompt.indexOf("CRITICAL — role boundary");
    const phaseDescIdx = prompt.indexOf(
      "## Phase description (verbatim from the plan)",
    );
    expect(boundaryIdx).toBeGreaterThan(0);
    expect(phaseDescIdx).toBeGreaterThan(boundaryIdx);

    // The block lists the same allowed paths the recovery refusal + post-
    // commit detection enforce.
    expect(prompt).toContain("__tests__/");
    expect(prompt).toContain("test/");
    expect(prompt).toContain("spec/");
    expect(prompt).toContain("*.test.*");
    expect(prompt).toContain("*.spec.*");

    // The block reframes "implement X" → "implement the failing tests for X".
    expect(prompt).toMatch(/implement.*failing tests/i);
  });
});

describe("Cross-leg: static-grep wiring for roleId at every call site", () => {
  it("T-G: every applyMutableAgentHygiene call site passes a roleId field", () => {
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const content = fs.readFileSync(cliPath, "utf-8");

    // Find every applyMutableAgentHygiene({ call (not the function
    // declaration). The declaration starts with `export async function`,
    // while call sites start with the function name in expression position.
    const callPattern = /applyMutableAgentHygiene\(\{([^}]+?)\}\)/gs;
    const matches = [...content.matchAll(callPattern)];

    // 6 known call sites: feature-review, primary-impl, primary-impl-rerun,
    // test-writer, test-fixer, merge-fixer. If a new call site is added,
    // this test will pass once it gets a roleId, fail otherwise.
    expect(matches.length).toBeGreaterThanOrEqual(6);

    for (const m of matches) {
      const callBody = m[1];
      // The match excludes the wrapping {}, just the field list. Each call
      // body must contain a roleId: assignment.
      expect(callBody).toMatch(/\broleId:\s*"/);
    }
  });
});
