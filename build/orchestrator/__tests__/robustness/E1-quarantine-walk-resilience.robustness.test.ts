/**
 * E1 — quarantine-walk-resilience (build-robustness suite)
 *
 * Group E (git / quarantine / worktree), tier: smoke. Intended mode: RED.
 *
 * THE GAP (confirmed by reading the production code 2026-06-03, cli.ts:4673-4686):
 *   `quarantineMalformedRefs(cwd)` enumerates loose refs by walking the
 *   filesystem under `refs/heads` / `refs/remotes`. The walk does:
 *       for (const entry of fs.readdirSync(absDir)) {
 *         const st = fs.statSync(absPath);   // <- UNGUARDED
 *         if (st.isDirectory()) walk(...) else refs.push(...);
 *       }
 *   `fs.statSync` follows symlinks. A dangling-symlink ref (a loose ref that is
 *   a symlink whose target no longer exists) makes `statSync` throw ENOENT, and
 *   that throw propagates straight out of the pre-fetch quarantine. Because
 *   quarantine runs at the very top of `syncLandedBase` /
 *   `syncFeatureBranchWithBase` (cli.ts:4794, 4825) — i.e. on every fetch
 *   preflight of a multi-hour autonomous build — a single recoverable FS
 *   condition (a dangling ref) crashes the entire run instead of degrading to a
 *   normal `{ok:false}` error result.
 *
 *   Empirically reproduced in the audit: with a dangling symlink under
 *   `.git/refs/heads/feat/`, BOTH `quarantineMalformedRefs(cwd)` and
 *   `syncLandedBase(cwd)` throw ENOENT today (uncaught).
 *
 * WHAT THIS FILE PINS (the DESIRED, currently-failing invariant):
 *   1. `quarantineMalformedRefs(cwd)` does NOT throw on a dangling/unstattable
 *      ref entry — it skips that entry and continues (skip-and-continue),
 *      returning a normal `{ quarantined: number }` result.
 *   2. `syncLandedBase(cwd)` on a no-origin repo returns a normal
 *      `{ ok: false }` error result, NOT a process-killing throw — even when a
 *      dangling ref is present (the same FS condition that crashes the walk).
 *
 * Both invariants live in a single `describe.skip("[RED] ...")` block: the fix
 * PR wraps the `statSync` (and/or `readdirSync`) in skip-on-ENOENT handling and
 * removes `.skip`. The skipped body asserts the DESIRED behavior; it fails
 * today only because the walk throws — the imports and setup load cleanly.
 *
 * Imports only symbols that exist today (`quarantineMalformedRefs`,
 * `syncLandedBase` — both verified exported from ../../cli). No real LLM, no
 * network. Uses a real short-lived local `git` (init + one commit) only, the
 * same idiom as ../quarantine-malformed-refs.test.ts. The dangling symlink is
 * created with `fs.symlinkSync` and points at a guaranteed-missing target, so
 * no real long-lived process and nothing outside the temp dir is touched.
 * See ./README.md for the PIN/RED protocol.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { mkTmp } from "./helpers";
import * as cli from "../../cli";

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  }
}

describe("[RED→FIXED] E1 quarantine-walk-resilience", () => {
  let tmpDir: string;
  // Env this spec reads: the quarantine kill switch. If a developer has it set
  // to "1" ambiently the walk is never reached and the RED invariant would be
  // masked, so save+restore it and force it OFF inside the block.
  let savedDisable: string | undefined;

  beforeEach(() => {
    savedDisable = process.env.GSTACK_DISABLE_REF_QUARANTINE;
    delete process.env.GSTACK_DISABLE_REF_QUARANTINE;

    // Real temp git repo: git init + one commit. No origin remote is added,
    // so syncLandedBase's `git fetch origin` is expected to fail -> {ok:false}.
    tmpDir = mkTmp("gstack-robustness-e1-");
    git(["init", "--initial-branch=main"], tmpDir);
    git(["config", "user.email", "t@t.com"], tmpDir);
    git(["config", "user.name", "Test"], tmpDir);
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    git(["add", "."], tmpDir);
    git(["commit", "-m", "init"], tmpDir);

    // A dangling-symlink ref: a loose ref under refs/heads/feat/ whose symlink
    // target does not exist, so fs.statSync (which follows symlinks) throws
    // ENOENT during the quarantine walk.
    const featDir = path.join(tmpDir, ".git", "refs", "heads", "feat");
    fs.mkdirSync(featDir, { recursive: true });
    fs.symlinkSync("/nonexistent-target", path.join(featDir, "dangling"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedDisable === undefined) {
      delete process.env.GSTACK_DISABLE_REF_QUARANTINE;
    } else {
      process.env.GSTACK_DISABLE_REF_QUARANTINE = savedDisable;
    }
  });

  it("quarantineMalformedRefs skips a dangling ref instead of throwing", () => {
    // DESIRED: skip-and-continue. The walk must tolerate an unstattable
    // (dangling-symlink) entry and return a normal result rather than letting
    // ENOENT propagate out of the pre-fetch quarantine.
    let threw = false;
    let result: { quarantined: number; skipped?: boolean } | undefined;
    try {
      result = cli.quarantineMalformedRefs(tmpDir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(typeof result!.quarantined).toBe("number");
  });

  it("syncLandedBase returns {ok:false} on a no-origin repo, not a throw", () => {
    // DESIRED: the dangling ref must degrade the fetch preflight to a normal
    // error result. syncLandedBase calls quarantineMalformedRefs first (which
    // must not throw), then `git fetch origin` which fails on this no-origin
    // repo, yielding {ok:false}. Today the unguarded statSync inside the
    // quarantine throws ENOENT before fetch is ever reached.
    let threw = false;
    let result:
      | { ok: boolean; branch?: string; error?: string; haltKind?: string }
      | undefined;
    try {
      result = cli.syncLandedBase(tmpDir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
  });
});
