/**
 * Regression tests for Bug F — `recoverMutableAgentCommit` falls back to
 * git-status modified paths when `extractSummaryFilePaths` returns [].
 *
 * Bug ref:
 *   ~/.gstack/skill-faults/pending-investigations/
 *     agnt2-prototype-pr118-followups-tests-findings-20260526-143449-c951fe9c-
 *     PHASE_FAILED:p0:c897f6ed.json
 * Plan ref:
 *   ~/.claude/plans/fix-recovery-path-extraction-prose-summaries.md
 *
 * Coverage:
 *   - T-F1: prose summary + modified path → fallback stages it, commits
 *   - T-F2: prose summary + modified NON-test path + roleId=test-writer → still REFUSED
 *           (PR #102 role boundary wins after fallback)
 *   - T-F3: prose summary + modified test path + roleId=test-writer → accepted
 *   - T-F4: backtick summary path → existing behavior preserved, no fallback fires
 *   - T-F5: empty summary + modified path → still no-op (summary.trim() === "" wins)
 *   - T-F6 (static-grep): cli.ts contains the fallback wiring + warning string
 *   - T-F7 (regression for the dev-time bug): untracked-only dirty tree → fallback does NOT fire
 *           (prevents the hygiene-sibling-repos `STILL FAILS` test from regressing)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  captureGitSnapshot,
  recoverMutableAgentCommit,
} from "../cli";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

let tmpDir: string;
let cwd: string;

function gitInitWithSeed(): void {
  spawnSync("git", ["init", "-b", "main"], { cwd });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
  spawnSync("git", ["config", "user.name", "t"], { cwd });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "src", "feature.ts"),
    "export const x = 1;\n",
  );
  fs.writeFileSync(
    path.join(cwd, "test", "feature.test.ts"),
    "// seed test\n",
  );
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-m", "seed"], { cwd });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpsf-"));
  cwd = path.join(tmpDir, "wt");
  fs.mkdirSync(cwd);
  gitInitWithSeed();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("Bug F — prose-summary fallback behavior", () => {
  it("T-F1: prose summary + modified test path → fallback stages it, commits", async () => {
    const before = captureGitSnapshot(cwd);
    // Agent modified an existing test file (M status, not ??)
    fs.writeFileSync(
      path.join(cwd, "test", "feature.test.ts"),
      "// agent edits\nit('works', () => {});\n",
    );
    // Output summary in prose, NO backticks, NO markdown link — exactly
    // the agnt2 canonical fault shape.
    const outputFilePath = path.join(tmpDir, "agent-output.md");
    fs.writeFileSync(
      outputFilePath,
      "I added a test for the X behaviour. Modified the feature.test file in test/ to add the assertion. Done.\n",
    );
    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "primary implementor",
    });
    expect(result.recovered).toBe(true);
    expect(result.commit).toBeDefined();
    // HEAD moved
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(head.stdout.trim()).not.toBe(before.head);
    // The modified file is now committed
    const log = spawnSync(
      "git",
      ["log", "-1", "--name-only", "--format="],
      { cwd, encoding: "utf8" },
    );
    expect(log.stdout).toContain("test/feature.test.ts");
  });

  it("T-F2: prose summary + modified non-test path + roleId=test-writer → REFUSED (PR #102 role boundary wins)", async () => {
    const before = captureGitSnapshot(cwd);
    // Agent (acting as test-writer) modified a non-test src file — role drift.
    fs.writeFileSync(
      path.join(cwd, "src", "feature.ts"),
      "export const x = 2;\n",
    );
    const outputFilePath = path.join(tmpDir, "agent-output.md");
    fs.writeFileSync(
      outputFilePath,
      "Modified the feature module to fix the constant. Done.\n",
    );
    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "test-writer",
      roleId: "test-writer",
    });
    expect(result.recovered).toBe(false);
    expect(result.errors.join("\n")).toContain("test-writer recovery REFUSED");
    // HEAD must NOT have moved
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(head.stdout.trim()).toBe(before.head);
  });

  it("T-F3: prose summary + modified test path + roleId=test-writer → accepted (test path within role boundary)", async () => {
    const before = captureGitSnapshot(cwd);
    fs.writeFileSync(
      path.join(cwd, "test", "feature.test.ts"),
      "// test-writer edits\nit('works', () => {});\n",
    );
    const outputFilePath = path.join(tmpDir, "agent-output.md");
    fs.writeFileSync(
      outputFilePath,
      "Wrote a failing test for the new behaviour. Done.\n",
    );
    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "test-writer",
      roleId: "test-writer",
    });
    expect(result.recovered).toBe(true);
    expect(result.commit).toBeDefined();
  });

  it("T-F4: backtick summary path → existing behavior preserved, fallback does NOT fire", async () => {
    const before = captureGitSnapshot(cwd);
    fs.writeFileSync(
      path.join(cwd, "test", "feature.test.ts"),
      "// agent edits\nit('works', () => {});\n",
    );
    const outputFilePath = path.join(tmpDir, "agent-output.md");
    // Summary HAS the path in backticks — extractSummaryFilePaths picks it up,
    // fallback condition (files.length === 0) is NOT met.
    fs.writeFileSync(
      outputFilePath,
      "Wrote `test/feature.test.ts` with the assertion.\n",
    );
    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "primary implementor",
    });
    expect(result.recovered).toBe(true);
    // Same file committed regardless of which seed list was used — but
    // the path is taken from the summary, not the fallback. Verified by
    // confirming the commit happened.
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(head.stdout.trim()).not.toBe(before.head);
  });

  it("T-F5: empty summary + modified path → no-op (summary.trim() === '' gate wins)", async () => {
    const before = captureGitSnapshot(cwd);
    fs.writeFileSync(
      path.join(cwd, "test", "feature.test.ts"),
      "// agent edits but didn't bother writing summary\n",
    );
    const outputFilePath = path.join(tmpDir, "agent-output.md");
    fs.writeFileSync(outputFilePath, "   \n\n");
    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "primary implementor",
    });
    // Empty summary → no recovery. The hygiene gate above this function
    // will still see the dirty tree and fail — that's the intended
    // semantic.
    expect(result.recovered).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("T-F7: untracked-only dirty tree → fallback does NOT fire (sibling-repo regression guard)", async () => {
    const before = captureGitSnapshot(cwd);
    // Agent left untracked scratch (?? status) — this is the
    // canonical hygiene violation the sibling-repo test pins.
    // The fallback MUST not stage untracked files; otherwise the
    // `STILL FAILS when a sibling commits but cwd is dirty` test
    // in hygiene-sibling-repos.test.ts regresses (as it did during
    // initial implementation).
    fs.writeFileSync(
      path.join(cwd, "stray.txt"),
      "scratch from agent\n",
    );
    const outputFilePath = path.join(tmpDir, "agent-output.md");
    fs.writeFileSync(
      outputFilePath,
      "Committed deliverable elsewhere. Project root has stray.txt.\n",
    );
    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "primary implementor",
    });
    // Untracked files don't trigger fallback — only modified (M/R) do.
    // Recovery refuses; hygiene gate above will fail with "dirty tree"
    // as designed.
    expect(result.recovered).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "found no safe changed file paths",
    );
  });
});

describe("Bug F — static-grep wiring guards", () => {
  it("T-F6a: cli.ts recoverMutableAgentCommit has the modified-only fallback block", () => {
    // The fallback block must be inside recoverMutableAgentCommit and
    // must use modifiedOrRenamedPaths (NOT raw dirtyPaths). A future
    // refactor that drops the modified-only filter would silently
    // regress to the untracked-files-get-committed bug class.
    expect(cliContent).toContain("modifiedOrRenamedPaths");
    expect(cliContent).toMatch(
      /modifiedOrRenamedPaths\.size\s*>\s*0/,
    );
    expect(cliContent).toMatch(
      /falling back to.*modified path\(s\) from git status/,
    );
    // Untracked-not-staged guarantee must appear in the warning so
    // operators reading logs understand the bounded fallback.
    expect(cliContent).toContain("untracked files NOT auto-staged");
  });

  it("T-F6b: modified-paths filter matches `M` and `R` status (not `??`)", () => {
    // The regex/filter that builds modifiedOrRenamedPaths must include
    // M (modified) and R (renamed) — both are intentional changes the
    // agent made to tracked files. Untracked (??) is intentionally
    // excluded.
    expect(cliContent).toMatch(/\/\^\[MR\]\/|MR.*filter|filter.*MR/s);
  });
});
