/**
 * Tests for resolveGitDir helper.
 * Uses real git init / worktree add in tmpdirs — must fail before implementation.
 *
 * Coverage target: >= 80%
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveGitDir } from "../resolve-git-dir";

let tmpDir: string;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-resolve-git-dir-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveGitDir", () => {
  // T1: Regular repo — .git is a directory
  test("returns absolute path to .git for a regular repo", async () => {
    const repo = path.join(tmpDir, "regular-repo");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "--initial-branch=main"], repo);

    const result = await resolveGitDir(repo);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.join(repo, ".git"));
    expect(fs.statSync(result).isDirectory()).toBe(true);
  });

  // T2: Worktree — .git is a file containing gitdir: ...
  test("returns absolute path to the real gitdir for a worktree", async () => {
    const mainRepo = path.join(tmpDir, "main-repo");
    const worktreePath = path.join(tmpDir, "worktree-dir");
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    git(["init", "--initial-branch=main"], mainRepo);
    git(["config", "user.email", "t@t.com"], mainRepo);
    git(["config", "user.name", "Test"], mainRepo);
    fs.writeFileSync(path.join(mainRepo, "file.txt"), "hello");
    git(["add", "."], mainRepo);
    git(["commit", "-m", "init"], mainRepo);

    git(["worktree", "add", worktreePath], mainRepo);

    // The worktree's .git should be a file, not a directory
    const gitFile = path.join(worktreePath, ".git");
    expect(fs.statSync(gitFile).isFile()).toBe(true);

    const result = await resolveGitDir(worktreePath);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).not.toBe(gitFile);
    // Should point into main repo's .git/worktrees/...
    expect(result.startsWith(path.join(mainRepo, ".git"))).toBe(true);
    expect(fs.existsSync(result)).toBe(true);
  });

  // T3: Not a git repo
  test("rejects with a clear error when cwd is not a git repo", async () => {
    const notARepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });

    await expect(resolveGitDir(notARepo)).rejects.toThrow();
    await expect(resolveGitDir(notARepo)).rejects.toThrow(/not a git repo|git|rev-parse/i);
  });

  // T4: Index.lock cleanup in worktree targets real gitdir
  test("index.lock path derived from resolveGitDir targets real gitdir in worktree", async () => {
    const mainRepo = path.join(tmpDir, "main-repo");
    const worktreePath = path.join(tmpDir, "worktree-dir");
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    git(["init", "--initial-branch=main"], mainRepo);
    git(["config", "user.email", "t@t.com"], mainRepo);
    git(["config", "user.name", "Test"], mainRepo);
    fs.writeFileSync(path.join(mainRepo, "file.txt"), "hello");
    git(["add", "."], mainRepo);
    git(["commit", "-m", "init"], mainRepo);

    git(["worktree", "add", worktreePath], mainRepo);

    const gitDir = await resolveGitDir(worktreePath);
    const lockPath = path.join(gitDir, "index.lock");

    // The lock path must live in the real gitdir, not the worktree's .git file
    expect(lockPath.startsWith(path.join(mainRepo, ".git"))).toBe(true);
    expect(lockPath).not.toBe(path.join(worktreePath, ".git", "index.lock"));

    // Verify we can create and remove a lock file at that path
    fs.writeFileSync(lockPath, "pid: 12345");
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // Edge: worktree whose linked main repo has been moved on disk
  test("surfaces a diagnostic error when worktree gitdir link is broken", async () => {
    const mainRepo = path.join(tmpDir, "main-repo");
    const worktreePath = path.join(tmpDir, "worktree-dir");
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    git(["init", "--initial-branch=main"], mainRepo);
    git(["config", "user.email", "t@t.com"], mainRepo);
    git(["config", "user.name", "Test"], mainRepo);
    fs.writeFileSync(path.join(mainRepo, "file.txt"), "hello");
    git(["add", "."], mainRepo);
    git(["commit", "-m", "init"], mainRepo);

    git(["worktree", "add", worktreePath], mainRepo);

    // Break the link by moving the main repo
    const movedRepo = path.join(tmpDir, "moved-repo");
    fs.renameSync(mainRepo, movedRepo);

    // git rev-parse should now fail because the gitdir path in .git file is stale
    await expect(resolveGitDir(worktreePath)).rejects.toThrow();
    // Error should contain useful diagnostic (cwd or gitdir path)
    await expect(resolveGitDir(worktreePath)).rejects.toThrow(/git|gitdir|rev-parse|not a git repo/i);
  });

  // Edge: bare repo — .git is the cwd itself
  test("returns cwd for a bare repo (rev-parse --git-dir returns '.')", async () => {
    const bareRepo = path.join(tmpDir, "bare-repo");
    fs.mkdirSync(bareRepo, { recursive: true });

    git(["init", "--bare", "--initial-branch=main"], bareRepo);

    const result = await resolveGitDir(bareRepo);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(bareRepo);
  });

  // Edge: cwd is a subdirectory inside the worktree
  test("resolves correctly when cwd is a subdirectory inside a worktree", async () => {
    const mainRepo = path.join(tmpDir, "main-repo");
    const worktreePath = path.join(tmpDir, "worktree-dir");
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    git(["init", "--initial-branch=main"], mainRepo);
    git(["config", "user.email", "t@t.com"], mainRepo);
    git(["config", "user.name", "Test"], mainRepo);
    fs.writeFileSync(path.join(mainRepo, "file.txt"), "hello");
    git(["add", "."], mainRepo);
    git(["commit", "-m", "init"], mainRepo);

    git(["worktree", "add", worktreePath], mainRepo);

    const subdir = path.join(worktreePath, "src", "deep");
    fs.mkdirSync(subdir, { recursive: true });

    const result = await resolveGitDir(subdir);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.startsWith(path.join(mainRepo, ".git"))).toBe(true);
    expect(fs.existsSync(result)).toBe(true);
  });

  // Edge: cwd is a subdirectory inside a regular repo
  test("resolves correctly when cwd is a subdirectory inside a regular repo", async () => {
    const repo = path.join(tmpDir, "regular-repo");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "--initial-branch=main"], repo);

    const subdir = path.join(repo, "packages", "a");
    fs.mkdirSync(subdir, { recursive: true });

    const result = await resolveGitDir(subdir);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.join(repo, ".git"));
  });

  // Additional: idempotency / caching hint (called twice with same cwd)
  test("returns the same absolute path on repeated calls for the same cwd", async () => {
    const repo = path.join(tmpDir, "regular-repo");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "--initial-branch=main"], repo);

    const r1 = await resolveGitDir(repo);
    const r2 = await resolveGitDir(repo);
    expect(r1).toBe(r2);
  });
});
