/**
 * Regression tests for blind-execution detection + path-preserving discard.
 *
 * Plan ref: inbox/build-implementor-hygiene-hardening-20260517.md Feature 4
 * (D2 marker table + D6 path-preserving discard).
 *
 * Round-1 D1 used `git reset --hard + git clean -fd` which destroyed
 * pre-existing user dirty + untracked work. Round-2 D6 restores path-by-path
 * from `before.workTreeContents` (captured with `captureContents: true`).
 *
 * gpt-5.5 plan-review regressions explicitly pinned:
 *   - CRITICAL #2 (T4.1.10, T4.1.11): pre-existing dirty + untracked survive
 *   - IMPORTANT #4 (T4.1.13): call-site wires probe BEFORE recovery
 *   - IMPORTANT #6 (T4.1.14): probe runs on nonzero exit too
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  detectBlindExecution,
  discardBlindExecutionChanges,
  captureGitSnapshot,
  applyMutableAgentHygiene,
  type GitSnapshot,
} from "../cli";

let savedHome: string | undefined;
let tmpHome: string;
let logsDir: string;

beforeEach(() => {
  // Override $HOME so discardBlindExecutionChanges' worktree-root guard
  // resolves under the tempdir rather than the real ~/.gstack/.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-blind-exec-"));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
  logsDir = path.join(tmpHome, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
});

afterEach(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

function buildWorktreeRoot(slug: string): string {
  return path.join(tmpHome, ".gstack", "build-worktrees", "gstack", slug);
}

function initRepoAt(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  expect(spawnSync("git", ["init", "-b", "main"], { cwd: repoPath }).status).toBe(
    0,
  );
  expect(
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoPath,
    }).status,
  ).toBe(0);
  expect(
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoPath })
      .status,
  ).toBe(0);
}

function commit(
  cwd: string,
  file: string,
  content: string,
  message = "init",
): void {
  const abs = path.join(cwd, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  expect(spawnSync("git", ["add", file], { cwd }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-m", message], { cwd }).status).toBe(0);
}

function writeFixtureLog(content: string): string {
  const p = path.join(logsDir, `log-${Date.now()}-${Math.random()}.log`);
  fs.writeFileSync(p, content);
  return p;
}

describe("detectBlindExecution", () => {
  it("T4.1.1: detects Gemini `Path not in workspace:` marker", () => {
    const log = writeFixtureLog(
      "some stuff\nError: Path not in workspace: /foo/bar\n",
    );
    const r = detectBlindExecution(log);
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("Path not in workspace:");
    expect(r.agent).toBe("gemini");
  });

  it("T4.1.2: detects Gemini `resolves outside the allowed workspace directories:` marker", () => {
    const log = writeFixtureLog(
      "the path resolves outside the allowed workspace directories: /home/x\n",
    );
    const r = detectBlindExecution(log);
    expect(r.ok).toBe(false);
    expect(r.agent).toBe("gemini");
  });

  it("T4.1.3: detects speculative Kimi marker (pattern speculative; refine on first real failure)", () => {
    const log = writeFixtureLog("kimi error: workspace path not allowed: /x\n");
    const r = detectBlindExecution(log);
    expect(r.ok).toBe(false);
    expect(r.agent).toBe("kimi");
  });

  it("T4.1.4: detects speculative Codex marker (pattern speculative)", () => {
    const log = writeFixtureLog("codex: workspace-write violation: /x\n");
    const r = detectBlindExecution(log);
    expect(r.ok).toBe(false);
    expect(r.agent).toBe("codex");
  });

  it("T4.1.5: clean log returns ok", () => {
    const log = writeFixtureLog("everything is fine\n");
    expect(detectBlindExecution(log)).toEqual({ ok: true });
  });

  it("T4.1.6: missing log returns ok (probe does not escalate on missing logs)", () => {
    expect(detectBlindExecution("/tmp/does-not-exist-xyz.log")).toEqual({
      ok: true,
    });
  });
});

describe("discardBlindExecutionChanges", () => {
  it("T4.1.7: happy path — agent-only changes reverted, HEAD intact", () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "tracked.txt", "ORIGINAL\n");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
    }).stdout.trim();

    const before = captureGitSnapshot(wt, { captureContents: true });

    // Simulate agent: modify a tracked file + create an untracked file
    fs.writeFileSync(path.join(wt, "tracked.txt"), "AGENT-MOD\n");
    fs.writeFileSync(path.join(wt, "agent-new.txt"), "agent created\n");

    const r = discardBlindExecutionChanges(wt, before);
    expect(r.ok).toBe(true);
    expect(r.restored).toContain("tracked.txt");
    expect(r.deleted).toContain("agent-new.txt");

    // tracked.txt is back to HEAD content
    expect(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8")).toBe(
      "ORIGINAL\n",
    );
    // agent-new.txt is gone
    expect(fs.existsSync(path.join(wt, "agent-new.txt"))).toBe(false);
    // HEAD unchanged
    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
    }).stdout.trim();
    expect(headAfter).toBe(headBefore);
  });

  it("T4.1.8: null-head guard refuses to discard", () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);

    const before: GitSnapshot = {
      head: null,
      status: [],
      workTreeHashes: new Map(),
      workTreeContents: new Map(),
    };
    const r = discardBlindExecutionChanges(wt, before);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("head");
  });

  it("T4.1.9: cwd-outside-worktree guard refuses to discard", () => {
    const before: GitSnapshot = {
      head: "abc123",
      status: [],
      workTreeHashes: new Map(),
      workTreeContents: new Map(),
    };
    const r = discardBlindExecutionChanges("/tmp/outside-worktree", before);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });

  // gpt-5.5 CRITICAL #2 regression — pre-existing dirty tracked file survives.
  it("T4.1.10: pre-existing dirty TRACKED file survives discard (CRITICAL #2 regression)", () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "foo.ts", "USER-V1\n");
    commit(wt, "agent.ts", "AGENT-V1\n");

    // User dirties foo.ts BEFORE agent runs
    fs.writeFileSync(path.join(wt, "foo.ts"), "USER-DIRTY\n");

    const before = captureGitSnapshot(wt, { captureContents: true });
    expect(before.workTreeContents?.get("foo.ts")?.toString()).toBe(
      "USER-DIRTY\n",
    );

    // Agent modifies agent.ts (different file)
    fs.writeFileSync(path.join(wt, "agent.ts"), "AGENT-V2-BAD\n");

    const r = discardBlindExecutionChanges(wt, before);
    expect(r.ok).toBe(true);

    // foo.ts content preserved as user had it
    expect(fs.readFileSync(path.join(wt, "foo.ts"), "utf8")).toBe(
      "USER-DIRTY\n",
    );
    // agent.ts reverted to HEAD
    expect(fs.readFileSync(path.join(wt, "agent.ts"), "utf8")).toBe(
      "AGENT-V1\n",
    );
    // restored mentions agent.ts but NOT foo.ts
    expect(r.restored).toContain("agent.ts");
    expect(r.restored).not.toContain("foo.ts");
  });

  // gpt-5.5 CRITICAL #2 regression — pre-existing untracked file survives.
  it("T4.1.11: pre-existing UNTRACKED file survives discard", () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "tracked.txt", "tracked\n");

    // User has notes.txt as untracked BEFORE agent
    fs.writeFileSync(path.join(wt, "notes.txt"), "USER-NOTES\n");
    const before = captureGitSnapshot(wt, { captureContents: true });
    expect(before.workTreeContents?.get("notes.txt")?.toString()).toBe(
      "USER-NOTES\n",
    );

    // Agent creates a different untracked file
    fs.writeFileSync(path.join(wt, "agent-tmp.txt"), "AGENT-TMP\n");

    const r = discardBlindExecutionChanges(wt, before);
    expect(r.ok).toBe(true);

    // notes.txt preserved
    expect(fs.readFileSync(path.join(wt, "notes.txt"), "utf8")).toBe(
      "USER-NOTES\n",
    );
    // agent-tmp.txt deleted
    expect(fs.existsSync(path.join(wt, "agent-tmp.txt"))).toBe(false);
    expect(r.deleted).toContain("agent-tmp.txt");
    expect(r.deleted).not.toContain("notes.txt");
  });

  it("T4.1.12: fails closed without workTreeContents", () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "x.txt", "x\n");
    const before = captureGitSnapshot(wt); // NO captureContents
    expect(before.workTreeContents).toBeUndefined();

    const r = discardBlindExecutionChanges(wt, before);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("workTreeContents");
  });
});

describe("applyMutableAgentHygiene wire-in (D6 call-site integration)", () => {
  // gpt-5.5 IMPORTANT #4 regression: probe runs BEFORE recovery.
  it("T4.1.13: blind probe fires before recoverMutableAgentCommit on exitCode 0", async () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "foo.ts", "ORIGINAL\n");
    const before = captureGitSnapshot(wt, { captureContents: true });
    const headBefore = before.head!;

    // Simulate agent: modified file + sandbox-violation log
    fs.writeFileSync(path.join(wt, "foo.ts"), "BLIND-AGENT-MOD\n");
    const log = writeFixtureLog(
      "Error executing tool read_file: Path not in workspace: /x/y\n",
    );

    const result = await applyMutableAgentHygiene({
      result: {
        bin: "gemini",
        argv: [],
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: log,
      } as any,
      before,
      cwd: wt,
      label: "test-blind-probe-success-exit",
      requireNewCommit: true,
    });

    // Result is a hygiene failure mentioning blind execution
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toContain("blind execution");

    // recoverMutableAgentCommit did NOT create a new commit (HEAD unchanged)
    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
    }).stdout.trim();
    expect(headAfter).toBe(headBefore);

    // foo.ts content RESTORED to pre-agent state (D6 restore ran)
    expect(fs.readFileSync(path.join(wt, "foo.ts"), "utf8")).toBe("ORIGINAL\n");
  });

  // gpt-5.5 IMPORTANT #6 regression: probe runs even on nonzero exit.
  it("T4.1.14: blind probe fires on exitCode 1 (nonzero exit) too", async () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "foo.ts", "ORIGINAL\n");
    const before = captureGitSnapshot(wt, { captureContents: true });

    fs.writeFileSync(path.join(wt, "foo.ts"), "BLIND-AGENT-MOD\n");
    const log = writeFixtureLog(
      "Error: Path not in workspace: /something\n",
    );

    const result = await applyMutableAgentHygiene({
      result: {
        bin: "gemini",
        argv: [],
        stdout: "",
        stderr: "",
        exitCode: 1, // nonzero — old code path returned early without probe
        timedOut: false,
        logPath: log,
      } as any,
      before,
      cwd: wt,
      label: "test-blind-probe-nonzero-exit",
      requireNewCommit: true,
    });

    // Result is hygiene failure — probe fired despite nonzero exit
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toContain("blind execution");

    // foo.ts content restored
    expect(fs.readFileSync(path.join(wt, "foo.ts"), "utf8")).toBe("ORIGINAL\n");
  });

  it("T4.1.15: clean log + zero exit → unchanged path (no spurious blind detection)", async () => {
    const slug = `slug-${Date.now()}`;
    const wt = buildWorktreeRoot(slug);
    initRepoAt(wt);
    commit(wt, "foo.ts", "x\n");
    const before = captureGitSnapshot(wt, { captureContents: true });

    // Clean tree, clean log, exit 0 — no blind, no recovery work
    const log = writeFixtureLog("agent ran fine\n");
    const result = await applyMutableAgentHygiene({
      result: {
        bin: "gemini",
        argv: [],
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: log,
      } as any,
      before,
      cwd: wt,
      label: "test-clean",
      requireNewCommit: false,
    });

    expect(result.exitCode).toBe(0);
  });
});
