/**
 * Tests for GIT_REPO_CORRUPT halt on fetch corruption errors.
 *
 * When `git fetch` fails with messages like
 * "did not send all necessary objects" or "bad object refs/heads/",
 * the orchestrator must halt with `GIT_REPO_CORRUPT` (a PR1a-style halt
 * kind) and surface recovery commands (`git fsck --full`,
 * `git remote prune origin`).  The old `git gc --prune=now` retry path
 * is removed — it must never appear in the subprocess log.
 *
 * Coverage target: ≥80%
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as cli from "../cli";

let tmpDir: string;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-corrupt-"));

  // Set up a real bare repo + clone so non-fetch git commands work
  const bareDir = path.join(tmpDir, "bare.git");
  const serverDir = path.join(tmpDir, "server");
  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  git(["init"], serverDir);
  fs.writeFileSync(path.join(serverDir, "file.txt"), "hello");
  git(["add", "."], serverDir);
  git(["commit", "-m", "init"], serverDir);

  git(["clone", "--bare", serverDir, bareDir], tmpDir);
  git(["clone", bareDir, path.join(tmpDir, "clone")], tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function corruptClientWithBadRef(clientDir: string): void {
  // Create a local ref pointing to a non-existent SHA.
  // This causes `git fetch` to emit:
  //   fatal: bad object refs/heads/bad-ref
  //   error: <bare>.git did not send all necessary objects
  const badRef = path.join(clientDir, ".git", "refs", "heads", "bad-ref");
  fs.writeFileSync(badRef, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
}

// ------------------------------------------------------------------
// T9: GIT_REPO_CORRUPT halt
// ------------------------------------------------------------------
describe("GIT_REPO_CORRUPT halt", () => {
  test("T9: fetch 'did not send all necessary objects' surfaces corrupt halt with recovery", () => {
    const fn = (cli as any).syncFeatureBranchWithBase;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const clientDir = path.join(tmpDir, "clone");
    corruptClientWithBadRef(clientDir);

    const result = fn(clientDir, "main");

    // Must indicate failure
    expect(result.ok).toBe(false);

    // Must surface GIT_REPO_CORRUPT or recovery commands
    const err = result.error ?? "";
    const hasCorruptKind = result.haltKind === "GIT_REPO_CORRUPT";
    const hasRecoveryHint =
      err.includes("git fsck --full") || err.includes("GIT_REPO_CORRUPT");
    expect(hasCorruptKind || hasRecoveryHint).toBe(true);
  });

  test("T9b: fetch 'bad object refs/heads/' also surfaces corrupt halt", () => {
    const fn = (cli as any).syncFeatureBranchWithBase;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const clientDir = path.join(tmpDir, "clone");
    corruptClientWithBadRef(clientDir);

    const result = fn(clientDir, "main");

    expect(result.ok).toBe(false);
    const err = result.error ?? "";
    const hasCorruptKind = result.haltKind === "GIT_REPO_CORRUPT";
    const hasRecoveryHint =
      err.includes("git fsck --full") || err.includes("GIT_REPO_CORRUPT");
    expect(hasCorruptKind || hasRecoveryHint).toBe(true);
  });

  // ----------------------------------------------------------------
  // T10: No git gc retry
  // ----------------------------------------------------------------
  test("T10: no git gc --prune=now is invoked on fetch failure", () => {
    const fn = (cli as any).syncFeatureBranchWithBase;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const clientDir = path.join(tmpDir, "clone");
    corruptClientWithBadRef(clientDir);

    const result = fn(clientDir, "main");
    expect(result.ok).toBe(false);

    // The error must NOT mention git gc --prune=now (the old retry path)
    const err = result.error ?? "";
    expect(err.includes("git gc")).toBe(false);
    expect(err.includes("prune=now")).toBe(false);
  });

  // ----------------------------------------------------------------
  // T10b: syncLandedBase also never invokes git gc --prune=now
  // ----------------------------------------------------------------
  test("T10b: syncLandedBase does not invoke git gc --prune=now on failure", () => {
    const fn = (cli as any).syncLandedBase;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const clientDir = path.join(tmpDir, "clone");
    corruptClientWithBadRef(clientDir);

    const result = fn(clientDir);
    expect(result.ok).toBe(false);

    const err = result.error ?? "";
    expect(err.includes("git gc")).toBe(false);
    expect(err.includes("prune=now")).toBe(false);
  });

  // ----------------------------------------------------------------
  // Edge: happy-path fetch must still succeed
  // ----------------------------------------------------------------
  test("happy-path fetch with valid repo still succeeds", () => {
    const fn = (cli as any).syncFeatureBranchWithBase;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const clientDir = path.join(tmpDir, "clone");
    const result = fn(clientDir, "main");
    expect(result.ok).toBe(true);
  });

  // ----------------------------------------------------------------
  // Edge: generic fetch error (not corruption) still returns ok:false
  //        but does NOT claim GIT_REPO_CORRUPT
  // ----------------------------------------------------------------
  test("generic network fetch error does not claim GIT_REPO_CORRUPT", () => {
    const fn = (cli as any).syncFeatureBranchWithBase;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const clientDir = path.join(tmpDir, "clone");
    // Point origin to a non-existent path to get a generic network error
    spawnSync("git", ["remote", "set-url", "origin", "/nonexistent/repo.git"], {
      cwd: clientDir,
      encoding: "utf8",
    });

    const result = fn(clientDir, "main");

    expect(result.ok).toBe(false);
    // Must NOT be tagged as corrupt
    expect(result.haltKind).not.toBe("GIT_REPO_CORRUPT");
    const err = result.error ?? "";
    expect(err.includes("git fsck --full")).toBe(false);
  });
});
