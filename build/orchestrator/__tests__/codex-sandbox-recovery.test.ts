/**
 * Regression tests for Bug E Leg 2 — applyMutableAgentHygiene routes
 * sandbox-blocked commits through host-side recovery.
 *
 * Bug ref:
 *   ~/.gstack/skill-faults/manual-1779772477125/MANUAL_INVESTIGATION:0:8fb43d58.md
 * Plan ref:
 *   ~/.claude/plans/fix-codex-sandbox-linked-worktree-commit.md
 *
 * Coverage:
 *   - CODEX_SANDBOX_EPERM_RE matches the canonical signature shape
 *   - CODEX_SANDBOX_EPERM_RE does NOT match unrelated EPERMs or unrelated
 *     index.lock messages (low FP rate)
 *   - applyMutableAgentHygiene: non-zero exit + sandbox EPERM signal +
 *     dirty tree + summary listing changed files → recovery runs and
 *     commits (overrides the original early-return)
 *   - applyMutableAgentHygiene: non-zero exit WITHOUT the sandbox signal
 *     → original early-return semantics preserved (no regression)
 *   - Recovery-Reason trailer appears in the commit message when
 *     sandbox-blocked
 *   - Recovery-Reason trailer absent for normal recovery (no false attribution)
 *   - Static-grep wiring guards on the cli.ts hygiene + recovery code
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyMutableAgentHygiene,
  captureGitSnapshot,
  CODEX_SANDBOX_EPERM_RE,
} from "../cli";
import type { SubAgentResult } from "../sub-agents";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

describe("Bug E Leg 2 — CODEX_SANDBOX_EPERM_RE matcher", () => {
  it("T-E-RE-1: matches the canonical signature from the source fault report", () => {
    const canonical =
      "fatal: Unable to create '/Users/x/Documents/proj/.git/worktrees/run-name-20260526/index.lock': Operation not permitted";
    expect(CODEX_SANDBOX_EPERM_RE.test(canonical)).toBe(true);
  });

  it("T-E-RE-2: matches variants with double quotes and prefix noise (still requires fatal: prefix)", () => {
    const variants = [
      'fatal: Unable to create "/tmp/repo/.git/worktrees/wt1/index.lock" Operation not permitted',
      "fatal:   Unable to create /a/b/.git/worktrees/x/index.lock — Operation not permitted",
    ];
    for (const s of variants) {
      expect(CODEX_SANDBOX_EPERM_RE.test(s)).toBe(true);
    }
  });

  it("T-E-RE-3: does NOT match unrelated EPERM messages (low FP rate)", () => {
    const unrelated = [
      "fatal: Unable to create /tmp/foo: Operation not permitted", // no .git/worktrees
      "fatal: Unable to create '/repo/.git/index.lock': Operation not permitted", // main-worktree index.lock, NOT under worktrees/
      "EPERM: operation not permitted, open /something/else",
      "git: command not found",
    ];
    for (const s of unrelated) {
      expect(CODEX_SANDBOX_EPERM_RE.test(s)).toBe(false);
    }
  });

  it("T-E-RE-4: REJECTS agent-spoofed EPERM without git's `fatal:` prefix (F1 exploit-vector tightening)", () => {
    // Adversarial reviewer F1: an off-task agent could emit the EPERM string
    // in its own summary to trigger auto-commit-recovery and exfiltrate dirty
    // work the orchestrator was rejecting. Requiring git's canonical `fatal:`
    // prefix makes this harder to spoof — the agent has to deliberately fake
    // git's error shape, which is visible in the audit trail.
    const spoofed = [
      "Unable to create '/x/.git/worktrees/y/index.lock': Operation not permitted",
      "  Unable to create /a/.git/worktrees/b/index.lock - Operation not permitted",
      "warning: Unable to create /a/.git/worktrees/b/index.lock - Operation not permitted",
    ];
    for (const s of spoofed) {
      expect(CODEX_SANDBOX_EPERM_RE.test(s)).toBe(false);
    }
  });

  it("T-E-RE-5: REJECTS over-match on `index.lock.bak` and path continuations (regex anchor)", () => {
    const tricky = [
      "fatal: Unable to create '/tmp/.git/worktrees/abc/index.lock.bak': Operation not permitted",
      "fatal: Unable to create /a/.git/worktrees/b/index.lock/extra/file Operation not permitted",
    ];
    for (const s of tricky) {
      expect(CODEX_SANDBOX_EPERM_RE.test(s)).toBe(false);
    }
  });
});

describe("Bug E Leg 2 — applyMutableAgentHygiene routes sandbox-blocked to recovery", () => {
  let tmpRoot: string;
  let cwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csr-"));
    cwd = path.join(tmpRoot, "wt");
    fs.mkdirSync(cwd);
    spawnSync("git", ["init", "-b", "main"], { cwd });
    spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
    spawnSync("git", ["config", "user.name", "t"], { cwd });
    fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
    spawnSync("git", ["add", "seed.txt"], { cwd });
    spawnSync("git", ["commit", "-m", "seed"], { cwd });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  function mkResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
    return {
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: false,
      stallKilled: false,
      logPath: path.join(tmpRoot, "agent.log"),
      durationMs: 100,
      retries: 0,
      ...overrides,
    } as SubAgentResult;
  }

  it("T-E-REC-1: sandbox-blocked + dirty tree + summary listing files → recovery commits with Recovery-Reason trailer", async () => {
    const before = captureGitSnapshot(cwd);
    // Simulate the agent's work: it wrote a file but couldn't commit it.
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(
      outputFilePath,
      "Wrote `src.ts`.\nfeat: add x constant\n",
    );
    // Simulate Codex's non-zero exit with the canonical EPERM signature.
    fs.writeFileSync(path.join(tmpRoot, "agent.log"), "agent ran\n");
    const epermStderr =
      "fatal: Unable to create '/Users/x/.git/worktrees/wt/index.lock': Operation not permitted";
    const result = mkResult({
      exitCode: 1,
      stderr: epermStderr,
    });
    const after = await applyMutableAgentHygiene({
      result,
      before,
      cwd,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
    });
    // Recovery should have succeeded: hygiene synthesized exitCode 0.
    expect(after.exitCode).toBe(0);
    // HEAD should have advanced.
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    expect(head.stdout.trim()).not.toBe(before.head);
    // Recovery-Reason trailer must appear on the new commit.
    const log = spawnSync("git", ["log", "-1", "--format=%B"], { cwd, encoding: "utf8" });
    expect(log.stdout).toContain("Recovery-Reason: codex sandbox blocked commit");
    // Original EPERM line must be preserved in stderr (with sentinel prefix)
    // so fault-triage greps still hit "Operation not permitted". Wiping
    // stderr would lose the signal — F5 hardening.
    expect(after.stderr).toContain("suppressed sandbox EPERM");
    expect(after.stderr).toContain("Operation not permitted");
  });

  it("T-E-REC-2: non-zero exit WITHOUT sandbox signal preserves original early-return (no regression)", async () => {
    const before = captureGitSnapshot(cwd);
    // Dirty tree, summary listing, but the failure was a generic non-zero
    // exit — no sandbox signature. Expected: early-return passes through
    // the failing result; recovery does NOT run.
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(outputFilePath, "Wrote `src.ts`.\n");
    fs.writeFileSync(path.join(tmpRoot, "agent.log"), "agent crashed\n");
    const result = mkResult({
      exitCode: 1,
      stderr: "some other error that has nothing to do with sandboxes",
    });
    const after = await applyMutableAgentHygiene({
      result,
      before,
      cwd,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
    });
    expect(after.exitCode).toBe(1);
    // HEAD must NOT have moved — recovery was correctly skipped.
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    expect(head.stdout.trim()).toBe(before.head);
  });

  it("T-E-REC-4: agent's summary containing `Recovery-Reason:` line gets deduped, exactly ONE trailer on final commit (F6)", async () => {
    const before = captureGitSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    // Adversarial reviewer F6: agent may emit a Recovery-Reason line
    // organically (its own footer conventions). Without dedupe, the
    // resulting commit would have TWO trailers and log-parsing tools
    // would key off the wrong one.
    fs.writeFileSync(
      outputFilePath,
      "Wrote `src.ts`.\nfeat: add x constant\n\nRecovery-Reason: agent's own footer line\n",
    );
    fs.writeFileSync(path.join(tmpRoot, "agent.log"), "agent ran\n");
    const result = mkResult({
      exitCode: 1,
      stderr:
        "fatal: Unable to create '/Users/x/.git/worktrees/wt/index.lock': Operation not permitted",
    });
    const after = await applyMutableAgentHygiene({
      result,
      before,
      cwd,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
    });
    expect(after.exitCode).toBe(0);
    const log = spawnSync("git", ["log", "-1", "--format=%B"], { cwd, encoding: "utf8" });
    // Exactly ONE Recovery-Reason line — the agent's colliding line was
    // stripped, the orchestrator's authoritative one remains.
    const matches = log.stdout.match(/^Recovery-Reason:/gm) || [];
    expect(matches.length).toBe(1);
    expect(log.stdout).toContain("Recovery-Reason: codex sandbox blocked commit");
    expect(log.stdout).not.toContain("Recovery-Reason: agent's own footer line");
  });

  it("T-E-REC-3: clean exit + normal recovery path does NOT add Recovery-Reason trailer (no false attribution)", async () => {
    const before = captureGitSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(outputFilePath, "Wrote `src.ts`.\nfeat: add x\n");
    fs.writeFileSync(path.join(tmpRoot, "agent.log"), "agent ran\n");
    // exitCode=0 simulates an agent that returned success but forgot to
    // commit (the OG recovery scenario — pre-Bug-E behavior).
    const result = mkResult({ exitCode: 0, stderr: "" });
    const after = await applyMutableAgentHygiene({
      result,
      before,
      cwd,
      label: "primary implementor",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
    });
    expect(after.exitCode).toBe(0);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    expect(head.stdout.trim()).not.toBe(before.head);
    // No sandbox attribution for the normal recovery path.
    const log = spawnSync("git", ["log", "-1", "--format=%B"], { cwd, encoding: "utf8" });
    expect(log.stdout).not.toContain("Recovery-Reason:");
    expect(log.stdout).not.toContain("codex sandbox blocked commit");
  });
});

describe("Bug E Leg 2 — static-grep wiring guards", () => {
  it("T-E-LEG2-WIRE-1: applyMutableAgentHygiene checks CODEX_SANDBOX_EPERM_RE before the early-return", () => {
    // The matcher must appear in cli.ts. If the regex export disappears
    // or the early-return reverts to its pre-fix form, the bug returns.
    expect(cliContent).toContain("CODEX_SANDBOX_EPERM_RE");
    expect(cliContent).toMatch(/sandboxBlockedCommit\s*=\s*CODEX_SANDBOX_EPERM_RE\.test/);
    // The early-return MUST be guarded by `&& !sandboxBlockedCommit`.
    expect(cliContent).toMatch(/&&\s*!sandboxBlockedCommit/);
  });

  it("T-E-LEG2-WIRE-2: recoverMutableAgentCommit signature accepts recoveryReason", () => {
    expect(cliContent).toMatch(/recoveryReason\?:\s*string/);
    // The commit-message construction must use it.
    expect(cliContent).toMatch(/Recovery-Reason:/);
  });

  it("T-E-LEG2-WIRE-3: hygiene threads sandboxBlockedCommit into recoveryReason", () => {
    expect(cliContent).toMatch(
      /recoveryReason:\s*sandboxBlockedCommit[^,]*"codex sandbox blocked commit"/s,
    );
  });
});
