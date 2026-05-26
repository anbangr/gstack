/**
 * Regression tests for Bug B — monitor stale-state false positive
 * during long subagent calls.
 *
 * Bug ref:
 *   ~/.gstack/skill-faults/manual-1779768454543/MANUAL_INVESTIGATION:0:3f09e1bc.md
 * Plan ref: ~/.claude/plans/fix-orchestrator-mitosis-oasis-may-26-faults.md
 *
 * Two complementary signals:
 *
 *   Leg 1 — hasActiveSubagentChild(pid): direct ps probe for codex /
 *           claude / gemini / kimi children under the orchestrator PID.
 *           When true, suppress stale alarm regardless of timestamp age.
 *   Leg 2 — status-aware staleWindowMs: when any phase status ends with
 *           "_running" the threshold multiplies by 30x. Defense in depth
 *           for the case where leg 1's ps probe returns false (sandbox,
 *           shell wrapper, ps unavailable).
 *
 * The full readRunSnapshot integration tests already exist in
 * monitor.test.ts — this file focuses on the new helper + the
 * static-grep wiring guards that both legs survive future refactors.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasActiveSubagentChild } from "../monitor";

const monitorPath = path.resolve(import.meta.dir, "../monitor.ts");
const monitorContent = fs.readFileSync(monitorPath, "utf-8");

describe("Bug B leg 1 — hasActiveSubagentChild", () => {
  it("T-B1a: returns false for null / non-positive pid (defensive)", () => {
    expect(hasActiveSubagentChild(null)).toBe(false);
    expect(hasActiveSubagentChild(0)).toBe(false);
    expect(hasActiveSubagentChild(-1)).toBe(false);
  });

  it("T-B1b: returns false when orchestrator pid has no children", () => {
    // Use a known PID with no children: 1 (init/launchd) on most
    // systems has plenty of children, but our own PID at this exact
    // moment under bun-test likely has none matching the subagent
    // names. The probe should return false without crashing.
    expect(hasActiveSubagentChild(process.pid)).toBe(false);
  });

  it("T-B1c: returns true when orchestrator pid has a subagent-named child", async () => {
    // To get ps `comm` to report the desired name, the kernel needs to
    // exec a real binary by that basename — a shebang script wouldn't
    // work (kernel exec's the interpreter, comm becomes "sh"). Copy
    // /bin/sleep to /tmp/.../codex so the exec'd binary IS named
    // "codex".
    const tmpDir = fs.mkdtempSync("/tmp/has-subagent-test-");
    const fakeBin = path.join(tmpDir, "codex");
    fs.copyFileSync("/bin/sleep", fakeBin);
    fs.chmodSync(fakeBin, 0o755);
    let child: ChildProcess | null = null;
    try {
      child = spawn(fakeBin, ["3"], { detached: false });
      // Give the OS a moment to register the child in ps.
      await new Promise((r) => setTimeout(r, 250));
      expect(hasActiveSubagentChild(process.pid)).toBe(true);
    } finally {
      if (child && child.pid) {
        try {
          process.kill(child.pid);
        } catch {}
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("T-B1d: substring-named processes (mycodex-wrapper, kimichi) do NOT match (regression for the FP-vector tightening)", async () => {
    // Adversarial review caught that `comm.includes("codex")` is a
    // false-positive vector — a user script named `mycodex-wrapper`
    // would silently suppress the stale alarm forever. The fix tightens
    // to exact basename equality. This test pins that tightening.
    const tmpDir = fs.mkdtempSync("/tmp/has-subagent-fp-test-");
    const fakeBin = path.join(tmpDir, "mycodex-wrapper");
    fs.copyFileSync("/bin/sleep", fakeBin);
    fs.chmodSync(fakeBin, 0o755);
    let child: ChildProcess | null = null;
    try {
      child = spawn(fakeBin, ["3"], { detached: false });
      await new Promise((r) => setTimeout(r, 250));
      // Despite the child basename containing "codex", the exact-match
      // tightening means this should NOT be classified as a subagent.
      expect(hasActiveSubagentChild(process.pid)).toBe(false);
    } finally {
      if (child && child.pid) {
        try {
          process.kill(child.pid);
        } catch {}
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Bug B static-grep wiring guards", () => {
  it("T-B5a: readRunSnapshot calls hasActiveSubagentChild on every poll", () => {
    expect(monitorContent).toContain("hasActiveSubagentChild(pid)");
  });

  it("T-B5b: stale computation ANDs in !subagentChildAlive", () => {
    // The boolean must be present in the stale conditional. A refactor
    // that drops the conjunction would silently regress to the
    // pre-fix behavior.
    expect(monitorContent).toMatch(/stale:[^,]*&&\s*!subagentChildAlive/s);
  });

  it("T-B5c: status-aware threshold multiplies by 30x when any phase is _running", () => {
    expect(monitorContent).toContain("anyPhaseRunning");
    expect(monitorContent).toMatch(
      /status\.endsWith\(['"]_running['"]\)/,
    );
    expect(monitorContent).toMatch(/baseStaleWindowMs\s*\*\s*30/);
  });
});
