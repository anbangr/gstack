/**
 * Regression tests for the sibling-repo hygiene baseline added to
 * `validatePostAgentHygiene` + `applyMutableAgentHygiene`.
 *
 * Bug ref: inbox/BUGREPORT-allow-workspace-root-skips-worktree-and-blinds-hygiene.md
 *
 * Pinned invariants:
 *   1. `findGstackMirrorSibling` returns the sibling mirror path when the
 *      plan lives in `<basename>-gstack/` and the project root is a
 *      same-parent sibling.
 *   2. `findGstackMirrorSibling` returns null when the plan lives inside
 *      the project root (no sibling-shaped split).
 *   3. `findGstackMirrorSibling` returns null when the plan's git root is
 *      not a `*-gstack` directory.
 *   4. `captureSiblingRepoBaselines` records HEAD shas for each repo.
 *   5. The hygiene gate ACCEPTS a no-commit-in-cwd run when a sibling's
 *      HEAD has advanced past its baseline (the deliverable landed in
 *      the mirror, not the project root — e.g. `[research]` /
 *      `[writing]` phases per the `feedback_gstack_outputs_mirror.md`
 *      convention).
 *   6. The hygiene gate STILL FAILS when neither the cwd nor any sibling
 *      has a new commit (the implementor truly did nothing).
 *   7. The dirty-tree check stays strict: sibling commits do NOT excuse
 *      a dirty working tree in the cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyMutableAgentHygiene,
  captureGitSnapshot,
  captureSiblingRepoBaselines,
  findGstackMirrorSibling,
} from "../cli";
import type { SubAgentResult } from "../sub-agents";

let tmpDir: string;
let workspaceRoot: string;
let projectRoot: string;
let mirrorRoot: string;
let scratchDir: string;
let outputFilePath: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-hygiene-sibling-"));
  // Two sibling repos under one workspace, mirroring the agnt2-workspace
  // layout (and netx/mitosis/agentcity/etc.).
  workspaceRoot = path.join(tmpDir, "myproj-workspace");
  projectRoot = path.join(workspaceRoot, "myproj-prototype");
  mirrorRoot = path.join(workspaceRoot, "myproj-gstack");
  // Scratch (output/log) lives OUTSIDE both repos so the hygiene gate
  // doesn't see the agent's output file as an untracked entry and add a
  // spurious dirty-tree error.
  scratchDir = path.join(tmpDir, "scratch");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(mirrorRoot, { recursive: true });
  fs.mkdirSync(mirrorRoot + "/inbox", { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  outputFilePath = path.join(scratchDir, "output.md");
  logPath = path.join(scratchDir, "agent.log");
  initRepo(projectRoot);
  initRepo(mirrorRoot);
  commit(projectRoot, "seed.txt", "seed\n", "chore: seed");
  commit(mirrorRoot, "inbox/plan.md", "# plan\n", "chore: seed plan");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function initRepo(repo: string): void {
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

function commit(
  repo: string,
  file: string,
  content: string,
  message: string,
): void {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  expect(spawnSync("git", ["add", file], { cwd: repo }).status).toBe(0);
  expect(
    spawnSync("git", ["commit", "-m", message], { cwd: repo }).status,
  ).toBe(0);
}

function mockResult(): SubAgentResult {
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

describe("findGstackMirrorSibling", () => {
  it("returns the sibling mirror path for the canonical workspace layout", () => {
    const planFile = path.join(mirrorRoot, "inbox/plan.md");
    const result = findGstackMirrorSibling(projectRoot, planFile);
    expect(result).toBe(fs.realpathSync(mirrorRoot));
  });

  it("returns null when the plan lives INSIDE the project root", () => {
    // Plan committed inside the prototype repo, not in the sibling.
    commit(projectRoot, "PLAN.md", "# in-prototype plan\n", "docs: plan");
    const planFile = path.join(projectRoot, "PLAN.md");
    const result = findGstackMirrorSibling(projectRoot, planFile);
    expect(result).toBeNull();
  });

  it("returns null when the plan's git root is NOT a *-gstack directory", () => {
    // Make a third repo that is a sibling but not gstack-shaped.
    const otherSibling = path.join(workspaceRoot, "myproj-docs");
    fs.mkdirSync(otherSibling, { recursive: true });
    initRepo(otherSibling);
    commit(otherSibling, "plan.md", "# docs plan\n", "docs: plan");
    const planFile = path.join(otherSibling, "plan.md");
    const result = findGstackMirrorSibling(projectRoot, planFile);
    expect(result).toBeNull();
  });

  it("returns null when the mirror is not actually a sibling (different parent)", () => {
    // Set up a *-gstack repo somewhere else, not under workspaceRoot.
    const detached = path.join(tmpDir, "elsewhere", "stray-gstack");
    fs.mkdirSync(detached, { recursive: true });
    initRepo(detached);
    commit(detached, "plan.md", "# stray\n", "chore: stray");
    const planFile = path.join(detached, "plan.md");
    const result = findGstackMirrorSibling(projectRoot, planFile);
    expect(result).toBeNull();
  });
});

describe("captureSiblingRepoBaselines", () => {
  it("records each repo's HEAD sha", () => {
    const baselines = captureSiblingRepoBaselines([mirrorRoot]);
    expect(baselines.size).toBe(1);
    const head = baselines.get(mirrorRoot);
    expect(typeof head).toBe("string");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records null for an unreadable repo path (graceful degrade)", () => {
    const baselines = captureSiblingRepoBaselines([
      mirrorRoot,
      path.join(tmpDir, "does-not-exist"),
    ]);
    expect(baselines.size).toBe(2);
    expect(baselines.get(mirrorRoot)).toMatch(/^[0-9a-f]{40}$/);
    expect(baselines.get(path.join(tmpDir, "does-not-exist"))).toBeNull();
  });
});

describe("applyMutableAgentHygiene — sibling-repo baselines", () => {
  it("ACCEPTS a no-commit run in the cwd when a sibling has a new commit", async () => {
    const before = captureGitSnapshot(projectRoot);
    const siblingBaselines = captureSiblingRepoBaselines([mirrorRoot]);
    // Simulate the implementor writing AND committing the deliverable
    // in the gstack mirror sibling — exactly the F8.1 case from the bug
    // report (kimi wrote agnt2-gstack/implemented/AGNT2-CERT-ROTATION-DESIGN.md
    // and committed there).
    commit(
      mirrorRoot,
      "implemented/DESIGN.md",
      "# design\n",
      "docs(phase-x): design doc",
    );
    fs.writeFileSync(
      outputFilePath,
      "wrote and committed myproj-gstack/implemented/DESIGN.md\n",
    );
    const inputResult = mockResult();
    const out = await applyMutableAgentHygiene({
      result: inputResult,
      before,
      cwd: projectRoot,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      siblingRepoBaselines: siblingBaselines,
    });
    expect(out.exitCode).toBe(0);
    expect(out).toBe(inputResult);
  });

  it("STILL FAILS when neither the cwd nor any sibling has a new commit", async () => {
    const before = captureGitSnapshot(projectRoot);
    const siblingBaselines = captureSiblingRepoBaselines([mirrorRoot]);
    // Implementor did nothing — no new commit anywhere.
    fs.writeFileSync(outputFilePath, "(empty)\n");
    const out = await applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: projectRoot,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      siblingRepoBaselines: siblingBaselines,
    });
    expect(out.exitCode).not.toBe(0);
    // The hygieneFailureResult wraps a message containing the no-commit suffix.
    expect((out.stderr || "") + (out.stdout || "")).toContain(
      "did not create a new commit",
    );
  });

  it("STILL FAILS when a sibling commits but the cwd is dirty (sibling does NOT excuse dirty tree)", async () => {
    const before = captureGitSnapshot(projectRoot);
    const siblingBaselines = captureSiblingRepoBaselines([mirrorRoot]);
    // Sibling gets a commit (deliverable landed there) but the agent
    // also left a stray uncommitted change in the project root.
    commit(
      mirrorRoot,
      "implemented/DESIGN.md",
      "# design\n",
      "docs(phase-x): design doc",
    );
    fs.writeFileSync(
      path.join(projectRoot, "stray.txt"),
      "uncommitted scratch\n",
    );
    fs.writeFileSync(
      outputFilePath,
      "committed to mirror; project root has stray.txt\n",
    );
    const out = await applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: projectRoot,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      siblingRepoBaselines: siblingBaselines,
    });
    expect(out.exitCode).not.toBe(0);
    expect((out.stderr || "") + (out.stdout || "")).toContain(
      "left the working tree dirty",
    );
  });

  it("default behaviour (no siblingRepoBaselines passed) is unchanged — no-commit run fails", async () => {
    const before = captureGitSnapshot(projectRoot);
    // Even if a sibling commit exists, we don't tell the gate about it.
    commit(
      mirrorRoot,
      "implemented/DESIGN.md",
      "# design\n",
      "docs(phase-x): design doc",
    );
    fs.writeFileSync(outputFilePath, "wrote to mirror\n");
    const out = await applyMutableAgentHygiene({
      result: mockResult(),
      before,
      cwd: projectRoot,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      // siblingRepoBaselines intentionally omitted.
    });
    expect(out.exitCode).not.toBe(0);
    expect((out.stderr || "") + (out.stdout || "")).toContain(
      "did not create a new commit",
    );
  });

  it("ACCEPTS when project root committed AND siblings unchanged (regression: don't break the happy path)", async () => {
    const before = captureGitSnapshot(projectRoot);
    const siblingBaselines = captureSiblingRepoBaselines([mirrorRoot]);
    // Normal `[code]` phase: deliverable + commit in the project root.
    commit(projectRoot, "src/feature.ts", "export const x = 1;\n", "feat: x");
    fs.writeFileSync(outputFilePath, "added src/feature.ts\n");
    const inputResult = mockResult();
    const out = await applyMutableAgentHygiene({
      result: inputResult,
      before,
      cwd: projectRoot,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      siblingRepoBaselines: siblingBaselines,
    });
    expect(out.exitCode).toBe(0);
    expect(out).toBe(inputResult);
  });
});
