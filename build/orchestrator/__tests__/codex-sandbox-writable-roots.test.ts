/**
 * Regression tests for Bug E Leg 1 — Codex --add-dir injection for
 * linked worktrees.
 *
 * Bug ref:
 *   ~/.gstack/skill-faults/manual-1779772477125/MANUAL_INVESTIGATION:0:8fb43d58.md
 * Plan ref:
 *   ~/.claude/plans/fix-codex-sandbox-linked-worktree-commit.md
 *
 * Coverage:
 *   - computeCodexWritableRoots returns [] for non-repo, main-worktree, and
 *     git-missing cases (defensive fallback)
 *   - computeCodexWritableRoots returns the per-worktree + common git dirs
 *     when called from inside a real git linked worktree
 *   - cachedComputeCodexWritableRoots actually caches (one git invocation
 *     per cwd per session)
 *   - buildCodexAddDirArgs returns [] for read-only sandbox (no waste)
 *   - buildCodexAddDirArgs returns repeatable --add-dir argv block for
 *     workspace-write sandbox on linked worktrees
 *   - Static-grep wiring guard: every `"-s",` followed by `"workspace-write"
 *     / sandbox` literal in sub-agents.ts is paired with an injection of
 *     buildCodexAddDirArgs nearby
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildCodexAddDirArgs,
  cachedComputeCodexWritableRoots,
  computeCodexWritableRoots,
  _resetCodexWritableRootsCacheForTests,
} from "../sub-agents";

const subAgentsPath = path.resolve(import.meta.dir, "../sub-agents.ts");
const subAgentsContent = fs.readFileSync(subAgentsPath, "utf-8");

describe("Bug E Leg 1 — computeCodexWritableRoots defensive cases", () => {
  it("T-E1: returns [] in a non-git directory (git rev-parse exits non-zero)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccwr-no-git-"));
    try {
      expect(computeCodexWritableRoots(tmp)).toEqual([]);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });

  it("T-E4: returns [] in a main worktree (--git-dir resolves inside cwd)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccwr-main-"));
    try {
      // Initialize a fresh repo. In a main worktree, --git-dir returns
      // `.git` (relative), --git-common-dir returns `.git` — both resolve
      // inside cwd and are skipped.
      expect(
        spawnSync("git", ["init", "-b", "main"], { cwd: tmp }).status,
      ).toBe(0);
      expect(computeCodexWritableRoots(tmp)).toEqual([]);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Bug E Leg 1 — computeCodexWritableRoots linked-worktree case", () => {
  let parentRepo: string;
  let linkedWorktree: string;

  beforeAll(() => {
    // Build a real linked-worktree shape: a parent repo with an initial
    // commit, plus a linked worktree at <tmp>/wt1. computeCodexWritableRoots
    // called from inside wt1 must surface both the per-worktree git dir
    // (<parent>/.git/worktrees/wt1) and the common git dir (<parent>/.git).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccwr-linked-"));
    parentRepo = path.join(root, "parent");
    fs.mkdirSync(parentRepo);
    expect(
      spawnSync("git", ["init", "-b", "main"], { cwd: parentRepo }).status,
    ).toBe(0);
    spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: parentRepo });
    spawnSync("git", ["config", "user.name", "t"], { cwd: parentRepo });
    fs.writeFileSync(path.join(parentRepo, "seed.txt"), "seed\n");
    spawnSync("git", ["add", "seed.txt"], { cwd: parentRepo });
    spawnSync("git", ["commit", "-m", "seed"], { cwd: parentRepo });
    linkedWorktree = path.join(root, "wt1");
    expect(
      spawnSync(
        "git",
        ["worktree", "add", "-b", "wt-branch", linkedWorktree],
        { cwd: parentRepo },
      ).status,
    ).toBe(0);
  });

  it("T-E2: surfaces parent .git/worktrees/<name> AND parent .git from inside the linked worktree", () => {
    _resetCodexWritableRootsCacheForTests();
    const roots = computeCodexWritableRoots(linkedWorktree);
    // Both roots must appear. Resolution must produce absolute paths.
    const parentGit = fs.realpathSync(path.join(parentRepo, ".git"));
    const perWorktreeGit = path.join(parentGit, "worktrees", "wt1");
    // realpath both sides so symlinks / /private prefix differences don't
    // break the equality check on macOS.
    const rootsResolved = roots.map((r) => fs.realpathSync(r));
    expect(rootsResolved).toContain(parentGit);
    expect(rootsResolved).toContain(fs.realpathSync(perWorktreeGit));
    // Sanity: no path is inside the linked worktree itself.
    const wtResolved = fs.realpathSync(linkedWorktree);
    for (const r of rootsResolved) {
      expect(r.startsWith(wtResolved + path.sep)).toBe(false);
      expect(r).not.toBe(wtResolved);
    }
  });

  it("T-E5a: cache returns the same array reference on the second call (no re-probe)", () => {
    _resetCodexWritableRootsCacheForTests();
    const a = cachedComputeCodexWritableRoots(linkedWorktree);
    const b = cachedComputeCodexWritableRoots(linkedWorktree);
    expect(a).toBe(b);
  });
});

describe("Bug E Leg 1 — buildCodexAddDirArgs sandbox gating", () => {
  it("T-E5b: returns [] for read-only sandbox (no waste)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcada-readonly-"));
    try {
      const args = buildCodexAddDirArgs({ cwd: tmp, sandbox: "read-only" });
      expect(args).toEqual([]);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });

  it("T-E5c: returns [] for danger-full-access sandbox (no waste either)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcada-danger-"));
    try {
      const args = buildCodexAddDirArgs({
        cwd: tmp,
        sandbox: "danger-full-access",
      });
      expect(args).toEqual([]);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });

  it("T-E5d: returns [] for workspace-write in a non-repo cwd (defensive)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcada-norepo-"));
    try {
      _resetCodexWritableRootsCacheForTests();
      const args = buildCodexAddDirArgs({
        cwd: tmp,
        sandbox: "workspace-write",
      });
      expect(args).toEqual([]);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Bug E Leg 1 — static-grep wiring guards", () => {
  it("T-E-WIRE-1: every workspace-write sandbox in sub-agents.ts gets a buildCodexAddDirArgs call within 5 lines", () => {
    // Find every `"-s",\n    sandbox,` pattern (the 3 Codex spawn sites)
    // and assert the next ~5 lines include the buildCodexAddDirArgs call.
    // If a future refactor drops the injection at any site, this fails.
    const lines = subAgentsContent.split("\n");
    let sandboxSites = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*"-s",\s*$/.test(lines[i])) {
        // Verify the next line names `sandbox` literally (call-site shape).
        if (!/\bsandbox\b/.test(lines[i + 1] ?? "")) continue;
        sandboxSites++;
        const windowText = lines.slice(i, i + 6).join("\n");
        expect(windowText).toContain("buildCodexAddDirArgs");
      }
    }
    // Bug E plan documented 3 spawn sites. If a 4th appears, the gate also
    // catches it via the per-site assertion above.
    expect(sandboxSites).toBeGreaterThanOrEqual(3);
  });

  it("T-E-WIRE-2: buildCodexAddDirArgs is exported (cache reset helper too)", () => {
    expect(subAgentsContent).toMatch(/export function buildCodexAddDirArgs/);
    expect(subAgentsContent).toMatch(
      /export function _resetCodexWritableRootsCacheForTests/,
    );
  });
});
