import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stampRecoveryRef } from "../recovery-ref";

/**
 * RC2 safety-net regression tests. Proves stampRecoveryRef makes a
 * branch/commit-destroying op (branch -D / reset --hard) recoverable: the
 * preserved commit survives both the destructive op AND a subsequent
 * `git gc --prune=now`, recoverable by name. A control test proves the
 * harness actually prunes an UNSTAMPED commit, so the survival assertion is
 * not vacuous. A static tripwire pins the three wired sites.
 */

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr || r.stdout}`,
    );
  }
  return (r.stdout || "").trim();
}

function tryGit(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout || "").trim() };
}

describe("stampRecoveryRef — RC2 branch/commit safety net", () => {
  let tmpDir: string;
  let repo: string;
  let doomedSha: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-recovery-ref-"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.t"], repo);
    git(["config", "user.name", "t"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "base"], repo);
    // feat/doomed carries a commit that exists ONLY on this branch — the
    // reviewed-but-unlanded work the safety net must preserve.
    git(["checkout", "-b", "feat/doomed"], repo);
    fs.writeFileSync(path.join(repo, "reviewed.txt"), "reviewed work\n");
    git(["add", "reviewed.txt"], repo);
    git(["commit", "-m", "feat: reviewed work (only on feat/doomed)"], repo);
    doomedSha = git(["rev-parse", "feat/doomed"], repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps a force-deleted branch tip reachable after gc, recoverable by name", () => {
    // Mimic cleanupLocalMergedBranch: it checks out base before deleting.
    git(["checkout", "main"], repo);

    const res = stampRecoveryRef({
      cwd: repo,
      ref: "refs/heads/feat/doomed",
      reason: "unit test branch -D",
      warn: () => {},
    });
    expect(res.stamped).toBe(true);
    expect(res.sha).toBe(doomedSha);
    expect(res.recoveryRef).toBeDefined();
    expect(res.recoveryRef!.startsWith("refs/gstack-recovery/")).toBe(true);

    // Force-delete exactly like cli.ts cleanupLocalMergedBranch.
    git(["branch", "-D", "feat/doomed"], repo);

    // Survives the delete: the recovery ref still resolves to the tip.
    expect(
      git(["rev-parse", "--verify", `${res.recoveryRef}^{commit}`], repo),
    ).toBe(doomedSha);

    // Survives gc — the load-bearing assertion. Without the recovery ref the
    // commit would be unreachable after delete and pruned (see control below).
    git(["reflog", "expire", "--expire=now", "--all"], repo);
    git(["gc", "--prune=now"], repo);
    expect(
      git(["rev-parse", "--verify", `${res.recoveryRef}^{commit}`], repo),
    ).toBe(doomedSha);
    expect(git(["cat-file", "-t", doomedSha], repo)).toBe("commit");

    // The printed recover command actually works.
    git(["branch", "recovered", res.recoveryRef!], repo);
    expect(git(["rev-parse", "recovered"], repo)).toBe(doomedSha);
  });

  it("control: WITHOUT a recovery ref, a force-deleted branch tip IS pruned by gc", () => {
    // Proves the harness genuinely prunes unreachable commits, so the survival
    // assertion above is meaningful and not a no-op.
    git(["checkout", "main"], repo);
    git(["branch", "-D", "feat/doomed"], repo);
    git(["reflog", "expire", "--expire=now", "--all"], repo);
    git(["gc", "--prune=now"], repo);
    const r = tryGit(["cat-file", "-t", doomedSha], repo);
    expect(r.status).not.toBe(0); // commit is gone
  });

  it("is best-effort: returns stamped:false and never throws on an unresolvable ref", () => {
    let res: ReturnType<typeof stampRecoveryRef> | undefined;
    expect(() => {
      res = stampRecoveryRef({
        cwd: repo,
        ref: "refs/heads/does-not-exist",
        reason: "x",
        warn: () => {},
      });
    }).not.toThrow();
    expect(res!.stamped).toBe(false);
  });

  it("kill switch GSTACK_DISABLE_RECOVERY_REF=1 skips stamping entirely", () => {
    const prev = process.env.GSTACK_DISABLE_RECOVERY_REF;
    process.env.GSTACK_DISABLE_RECOVERY_REF = "1";
    try {
      const res = stampRecoveryRef({
        cwd: repo,
        ref: "refs/heads/feat/doomed",
        reason: "x",
        warn: () => {},
      });
      expect(res.skipped).toBe(true);
      expect(res.stamped).toBe(false);
      expect(git(["for-each-ref", "refs/gstack-recovery/"], repo)).toBe("");
    } finally {
      if (prev === undefined) delete process.env.GSTACK_DISABLE_RECOVERY_REF;
      else process.env.GSTACK_DISABLE_RECOVERY_REF = prev;
    }
  });

  it("an explicit sha stamps the PRE-op commit even when the ref later moves (reset --hard path)", () => {
    // Release-daemon captures HEAD before reset --hard and passes it as sha.
    const preReset = doomedSha; // HEAD is on feat/doomed
    const res = stampRecoveryRef({
      cwd: repo,
      ref: "HEAD",
      sha: preReset,
      reason: "reset --hard",
      warn: () => {},
    });
    expect(res.stamped).toBe(true);
    expect(res.sha).toBe(preReset);

    // Hard-reset feat/doomed back to main — drops the reviewed commit from HEAD.
    git(["reset", "--hard", "main"], repo);
    expect(git(["rev-parse", "HEAD"], repo)).not.toBe(preReset);

    // The recovery ref still points at the PRE-reset tip, not main.
    expect(
      git(["rev-parse", "--verify", `${res.recoveryRef}^{commit}`], repo),
    ).toBe(preReset);
  });

  it("emits one operator-visible recovery hint naming the ref and the recover command", () => {
    git(["checkout", "main"], repo);
    const lines: string[] = [];
    const res = stampRecoveryRef({
      cwd: repo,
      ref: "refs/heads/feat/doomed",
      reason: "unit test",
      warn: (m) => lines.push(m),
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[recovery]");
    expect(lines[0]).toContain(res.recoveryRef!);
    expect(lines[0]).toContain(`git branch <new-branch> ${res.recoveryRef}`);
  });

  it("never throws on null/undefined args (best-effort contract)", () => {
    // @ts-expect-error hostile input — the contract must hold regardless.
    expect(() => stampRecoveryRef(null)).not.toThrow();
    // @ts-expect-error hostile input
    expect(() => stampRecoveryRef(undefined)).not.toThrow();
    // @ts-expect-error hostile input
    expect(stampRecoveryRef(null).stamped).toBe(false);
  });

  it("never throws when warn is a non-function or itself throws (hostile logger)", () => {
    git(["checkout", "main"], repo);
    // A non-function warn must fall back to console.warn, not crash.
    expect(() =>
      stampRecoveryRef({
        cwd: repo,
        ref: "refs/heads/feat/doomed",
        reason: "x",
        warn: 123 as unknown as (m: string) => void,
      }),
    ).not.toThrow();

    // A throwing logger must be swallowed on BOTH the success line and the
    // debug-gated skip/catch paths. debug ON exercises every warn call site.
    const prev = process.env.GSTACK_BUILD_DEBUG;
    process.env.GSTACK_BUILD_DEBUG = "1";
    const thrower = (): void => {
      throw new Error("logger boom");
    };
    try {
      expect(() =>
        stampRecoveryRef({
          cwd: repo,
          ref: "refs/heads/feat/doomed",
          reason: "x",
          warn: thrower,
        }),
      ).not.toThrow();
      expect(() =>
        stampRecoveryRef({
          cwd: repo,
          ref: "refs/heads/does-not-exist",
          reason: "x",
          warn: thrower,
        }),
      ).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.GSTACK_BUILD_DEBUG;
      else process.env.GSTACK_BUILD_DEBUG = prev;
    }
  });

  it("ignores a non-40-hex args.sha and falls back to resolving the ref", () => {
    git(["checkout", "main"], repo);
    const res = stampRecoveryRef({
      cwd: repo,
      ref: "refs/heads/feat/doomed",
      sha: "not-a-real-sha", // garbage: must NOT be stamped verbatim
      reason: "x",
      warn: () => {},
    });
    expect(res.stamped).toBe(true);
    expect(res.sha).toBe(doomedSha); // resolved from the ref, not the bad sha
    expect(
      git(["rev-parse", "--verify", `${res.recoveryRef}^{commit}`], repo),
    ).toBe(doomedSha);
  });

  it("hardens pathological ref names so the composed ref always passes check-ref-format", () => {
    git(["checkout", "main"], repo);
    for (const hostile of [
      "refs/heads/feat/foo.lock",
      "refs/heads/a..b",
      "refs/heads/....",
      "@{",
    ]) {
      // Pass an explicit sha so resolution doesn't depend on the hostile ref
      // actually existing — we're exercising refNamePart, not rev-parse.
      const res = stampRecoveryRef({
        cwd: repo,
        ref: hostile,
        sha: doomedSha,
        reason: "x",
        warn: () => {},
      });
      expect(res.stamped).toBe(true);
      // git itself must accept the name we produced (throws here if not).
      expect(git(["check-ref-format", res.recoveryRef!], repo)).toBe("");
      expect(
        git(["rev-parse", "--verify", `${res.recoveryRef}^{commit}`], repo),
      ).toBe(doomedSha);
    }
  });

  it("returns stamped:false without throwing when update-ref fails (best-effort core)", () => {
    git(["checkout", "main"], repo);
    // Force a directory/file ref conflict: create refs/gstack-recovery AS A
    // REF so git cannot create any child ref beneath it. update-ref will fail.
    git(["update-ref", "refs/gstack-recovery", doomedSha], repo);
    let res: ReturnType<typeof stampRecoveryRef> | undefined;
    expect(() => {
      res = stampRecoveryRef({
        cwd: repo,
        ref: "refs/heads/feat/doomed",
        reason: "x",
        warn: () => {},
      });
    }).not.toThrow();
    expect(res!.stamped).toBe(false);
  });

  it("stamps distinct recovery refs for the same branch at different commits", () => {
    const res1 = stampRecoveryRef({
      cwd: repo,
      ref: "refs/heads/feat/doomed",
      reason: "x",
      warn: () => {},
    });
    // Advance feat/doomed by one commit, stamp again.
    fs.writeFileSync(path.join(repo, "more.txt"), "more\n");
    git(["add", "more.txt"], repo);
    git(["commit", "-m", "second reviewed commit"], repo);
    const sha2 = git(["rev-parse", "feat/doomed"], repo);
    const res2 = stampRecoveryRef({
      cwd: repo,
      ref: "refs/heads/feat/doomed",
      reason: "x",
      warn: () => {},
    });
    expect(res1.stamped).toBe(true);
    expect(res2.stamped).toBe(true);
    // The short SHA in the name keeps the two distinct, so neither overwrites
    // the other — both preserved commits stay recoverable.
    expect(res1.recoveryRef).not.toBe(res2.recoveryRef);
    expect(
      git(["rev-parse", "--verify", `${res1.recoveryRef}^{commit}`], repo),
    ).toBe(doomedSha);
    expect(
      git(["rev-parse", "--verify", `${res2.recoveryRef}^{commit}`], repo),
    ).toBe(sha2);
  });
});

describe("destructive-op sites are wired to stampRecoveryRef (static tripwire)", () => {
  const ORCH = path.resolve(import.meta.dir, "..");
  const cliSrc = fs.readFileSync(path.join(ORCH, "cli.ts"), "utf8");
  const daemonSrc = fs.readFileSync(
    path.join(ORCH, "release-daemon.ts"),
    "utf8",
  );

  /** Slice a named function's body up to the next top-level function decl. */
  function fnSlice(src: string, startNeedle: string): string {
    const start = src.indexOf(startNeedle);
    expect(start).toBeGreaterThan(-1);
    const after = start + startNeedle.length;
    const rel = src.slice(after).search(/\n(export )?(async )?function /);
    const end = rel === -1 ? src.length : after + rel;
    return src.slice(start, end);
  }

  it("cleanupLocalMergedBranch stamps before git branch -D", () => {
    const body = fnSlice(cliSrc, "function cleanupLocalMergedBranch(");
    const stamp = body.indexOf("stampRecoveryRef(");
    const del = body.indexOf('"branch", "-D"');
    expect(stamp).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(del);
  });

  it("ensureOriginRetryBranch stamps before the followup checkout -b", () => {
    const body = fnSlice(cliSrc, "function ensureOriginRetryBranch(");
    const stamp = body.indexOf("stampRecoveryRef(");
    const co = body.indexOf('"checkout", "-b", branch');
    expect(stamp).toBeGreaterThan(-1);
    expect(co).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(co);
  });

  it("release-daemon resetWorktree stamps before git reset --hard", () => {
    const start = daemonSrc.indexOf("const resetWorktree =");
    expect(start).toBeGreaterThan(-1);
    const body = daemonSrc.slice(start, start + 1200);
    const stamp = body.indexOf("stampRecoveryRef(");
    const reset = body.indexOf('"reset", "--hard"');
    expect(stamp).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(reset);
  });

  it("recovery-ref.ts routes spawnSync through ./child-registry (leaf, no cycle)", () => {
    const src = fs.readFileSync(path.join(ORCH, "recovery-ref.ts"), "utf8");
    expect(src).toContain('from "./child-registry"');
    expect(src).not.toContain('from "node:child_process"');
    expect(src).not.toContain('from "./cli"');
    expect(src).not.toContain('from "./release-daemon"');
  });
});
