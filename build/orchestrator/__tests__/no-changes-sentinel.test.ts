/**
 * Regression tests for the NO_CHANGES_NEEDED sentinel honored by
 * applyMutableAgentHygiene's allowNoChangesSentinel opt.
 *
 * Plan ref: ~/.claude/plans/soft-skipping-swing.md
 *
 * Pinned invariants:
 *   1. With the opt set AND the sentinel in the output summary AND the only
 *      hygiene error being "did not create a new commit", the gate returns
 *      success unmodified.
 *   2. Without the opt, the same input still fails the no-commit check.
 *   3. With the opt set BUT the working tree dirty, the dirty-tree check
 *      still fails the gate — sentinel does not unlock dirty-tree forgiveness.
 *   4. With the opt set but the output file MISSING the sentinel, the gate
 *      still fails the no-commit check.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { applyMutableAgentHygiene, captureGitSnapshot } from "../cli";
import type { SubAgentResult } from "../sub-agents";

let tmpDir: string;
let repo: string;
let scratchDir: string;
let outputFilePath: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-noop-sentinel-"));
  // Repo and scratch (output/log) live side-by-side, never nested, so the
  // hygiene gate doesn't see the agent's output file as an untracked entry
  // and add a spurious dirty-tree error.
  repo = path.join(tmpDir, "repo");
  scratchDir = path.join(tmpDir, "scratch");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  outputFilePath = path.join(scratchDir, "output.md");
  logPath = path.join(scratchDir, "agent.log");
  initRepo();
  // One initial commit so HEAD exists.
  commit("seed.txt", "seed\n", "chore: seed");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function initRepo(): void {
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
}

function commit(file: string, content: string, message: string): void {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  expect(spawnSync("git", ["add", file], { cwd: repo }).status).toBe(0);
  expect(
    spawnSync("git", ["commit", "-m", message], { cwd: repo }).status,
  ).toBe(0);
}

function mockResult(): SubAgentResult {
  // Write the log file so logPath references a real path (mirrors what the
  // real agent path does). Content is irrelevant for these tests; the
  // hygiene gate never inspects it for sentinel logic.
  fs.writeFileSync(logPath, "agent finished cleanly\n");
  return {
    stdout: "agent finished cleanly\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    logPath,
    durationMs: 1000,
    retries: 0,
  };
}

describe("applyMutableAgentHygiene — NO_CHANGES_NEEDED sentinel", () => {
  it("returns success unmodified when sentinel is present and the only error is the no-commit one", () => {
    const before = captureGitSnapshot(repo);
    // Agent reports NO_CHANGES_NEEDED, makes no commit, leaves tree clean.
    fs.writeFileSync(
      outputFilePath,
      "NO_CHANGES_NEEDED\n\nThe reviewer's finding about the empty-input branch is already covered in commit abc123 from the prior pass.\n",
    );
    const inputResult = mockResult();
    const out = applyMutableAgentHygiene({
      result: inputResult,
      before,
      cwd: repo,
      label: "primary implementor rerun",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      allowNoChangesSentinel: true,
    });
    expect(out.exitCode).toBe(0);
    // Returned unmodified (same reference / same exitCode), not a
    // hygieneFailureResult.
    expect(out).toBe(inputResult);
  });

  it("still fails when the opt is NOT set, even if the sentinel is present", () => {
    const before = captureGitSnapshot(repo);
    fs.writeFileSync(outputFilePath, "NO_CHANGES_NEEDED\n\nAlready in HEAD.\n");
    const out = applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: repo,
      label: "primary implementor rerun",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      // allowNoChangesSentinel intentionally omitted.
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).toContain("did not create a new commit");
  });

  it("still fails the dirty-tree check when the working tree has uncommitted changes, even with the sentinel set", () => {
    const before = captureGitSnapshot(repo);
    // Agent claims NO_CHANGES_NEEDED but actually mutated a tracked file.
    fs.writeFileSync(path.join(repo, "seed.txt"), "tampered\n");
    fs.writeFileSync(
      outputFilePath,
      "NO_CHANGES_NEEDED\n\nLying about a clean tree.\n",
    );
    const out = applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: repo,
      label: "primary implementor rerun",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      allowNoChangesSentinel: true,
    });
    expect(out.exitCode).not.toBe(0);
    // Dirty-tree error must still appear.
    expect(out.stdout).toContain("left the working tree dirty");
  });

  it("still fails when the opt is set but the output file does not contain the sentinel", () => {
    const before = captureGitSnapshot(repo);
    fs.writeFileSync(
      outputFilePath,
      "I looked at the reviewer's findings but did not make any changes because I forgot.\n",
    );
    const out = applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: repo,
      label: "primary implementor rerun",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      allowNoChangesSentinel: true,
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).toContain("did not create a new commit");
  });

  it("requires the sentinel on its own line — substring match inside prose does not unlock the gate", () => {
    const before = captureGitSnapshot(repo);
    // The agent mentioned the sentinel in prose but didn't put it on its own
    // line. Our regex `/^NO_CHANGES_NEEDED\b/m` requires line-start anchor,
    // so this should still fail.
    fs.writeFileSync(
      outputFilePath,
      "I considered emitting NO_CHANGES_NEEDED but then decided to bail.\n",
    );
    const out = applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: repo,
      label: "primary implementor rerun",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      allowNoChangesSentinel: true,
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).toContain("did not create a new commit");
  });
});
