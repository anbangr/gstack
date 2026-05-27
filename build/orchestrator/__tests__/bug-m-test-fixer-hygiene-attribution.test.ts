/**
 * Regression tests for Bug M — `RUN_GEMINI_FIX` failure handler
 * produced misleading "test-fixer exited N" message when the real
 * failure was a hygiene-gate conversion (empty output, no commit,
 * recovery refused). Same legacy holdout that Bug I (PR #107)
 * closed for `RUN_GEMINI_TEST_SPEC`.
 *
 * Canonical incident:
 *   ~/.gstack/skill-faults/pending-investigations/
 *     agnt2-prototype-prodl2-f3-f4-soak-and-backup-20260527-112737-28b96729
 *       -PHASE_FAILED:p0:17662811.json
 *
 * agnt2 Phase 3.1 (Extract tier resolution into public-rpc-proxy/tier).
 * Codex test-fixer (gpt-5.5) ran for 101 seconds, called
 * `git status --short` multiple times, emitted "Files changed:" in its
 * output, exited 0. applyMutableAgentHygiene with `requireNewCommit:
 * true` fired because no commit was made — wrapped the success as
 * exitCode=1 with `hygieneFailure: true` and body
 * "test fixer did not create a new commit". The pre-fix attribution
 * surfaced as `✗ Phase 3.1 ... failed: test-fixer exited 1` — the
 * operator had to grep the hygiene log for the actual reason.
 *
 * Plan ref: ~/.claude/plans/fixing-plan-bugs-k-through-n-post-pr-108.md
 *
 * Coverage:
 *   T-M1: hygieneFailure result → next.error names the hygiene reason
 *   T-M2: vanilla nonzero exit (no hygiene marker) → legacy "exited N"
 *         shape preserved
 *   T-M3: static-grep — RUN_GEMINI_FIX uses geminiExitError, not
 *         renderRoleStepFailureMessage
 *   T-M4: static-grep — phase-runner.ts now has at least 4
 *         geminiExitError callers (primary-impl + test-fixer +
 *         test-spec writer post-Bug-I + dual-impl/judge)
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyResult } from "../phase-runner";
import type { Action } from "../phase-runner";
import type { SubAgentResult } from "../sub-agents";

const phaseRunnerPath = path.resolve(import.meta.dir, "../phase-runner.ts");
const phaseRunnerContent = fs.readFileSync(phaseRunnerPath, "utf-8");

function mkResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    logPath: "/tmp/agent-log-stub.log",
    durationMs: 1000,
    retries: 0,
    ...overrides,
  };
}

describe("Bug M — RUN_GEMINI_FIX hygiene-aware error attribution", () => {
  it("T-M1: hygieneFailure result surfaces the hygiene reason in next.error", () => {
    // applyMutableAgentHygiene wraps a successful codex spawn as
    // exitCode=1 with `hygieneFailure: true` and a body that begins
    // with "# Post-agent hygiene failure" followed by the reason.
    // The dispatcher must extract the reason for next.error.
    const hygieneBody = [
      "# Post-agent hygiene failure",
      "test fixer did not create a new commit",
      "",
      "Original agent log: /tmp/phase-3.1-gemini-fix-1.log",
      "",
      "GATE FAIL",
    ].join("\n");
    const result = mkResult({
      exitCode: 1,
      stdout: hygieneBody,
      logPath: "/tmp/phase-3.1-gemini-fix-1-hygiene.log",
      hygieneFailure: true,
    } as Partial<SubAgentResult>);
    const phaseState = {
      number: "3.1",
      status: "running",
      kind: "code",
    } as any;
    const action: Action = {
      type: "RUN_GEMINI_FIX",
      phaseIndex: 0,
      iteration: 1,
    };
    const next = applyResult(phaseState, action, result);
    expect(next.status).toBe("failed");
    // The new attribution: name the hygiene reason explicitly.
    expect(next.error).toContain("hygiene failed");
    expect(next.error).toContain("did not create a new commit");
    // Forensics: the agent log path is part of the error so the
    // operator can grep it without hunting through the state file.
    expect(next.error).toContain("hygiene.log");
    // The legacy misleading shape MUST NOT appear.
    expect(next.error).not.toMatch(/^test-fixer exited \d+$/);
  });

  it("T-M2: vanilla nonzero exit (no hygiene marker) falls through to legacy 'exited N'", () => {
    // When codex genuinely crashed (no hygiene wrapping), keep the
    // exit-code message — it's the right signal for that failure
    // class. Only hygiene-converted failures need the new attribution.
    const result = mkResult({
      exitCode: 2,
      stdout: "TypeError: cannot read properties of undefined\n",
      logPath: "/tmp/phase-3.1-gemini-fix-1.log",
    });
    const phaseState = {
      number: "3.1",
      status: "running",
      kind: "code",
    } as any;
    const action: Action = {
      type: "RUN_GEMINI_FIX",
      phaseIndex: 0,
      iteration: 1,
    };
    const next = applyResult(phaseState, action, result);
    expect(next.status).toBe("failed");
    expect(next.error).toContain("test-fixer exited 2");
    expect(next.error).toContain(result.logPath);
    expect(next.error).not.toContain("hygiene failed");
  });
});

describe("Bug M — static-grep wiring guards", () => {
  it("T-M3: RUN_GEMINI_FIX handler uses geminiExitError (hygiene-aware)", () => {
    // Pin the helper choice so a future refactor that swaps in
    // renderRoleStepFailureMessage (the legacy holdout) re-introduces
    // the misleading "exited N" attribution. Match the literal call
    // form so a typo in the prefix fails CI.
    expect(phaseRunnerContent).toMatch(
      /action\.type\s*===\s*"RUN_GEMINI_FIX"[\s\S]{0,2500}geminiExitError\("test-fixer",\s*result\)/,
    );
  });

  it("T-M4: phase-runner.ts has at least 4 geminiExitError callers (primary-impl + test-fixer + test-spec writer + dual-impl/judge family)", () => {
    // Post-Bug-M, four distinct dispatcher families use geminiExitError.
    // Pin the count so a future regression that swaps any of them
    // back to renderRoleStepFailureMessage shows up at review time.
    const calls = (
      phaseRunnerContent.match(/geminiExitError\(/g) || []
    ).length;
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("T-M5: renderRoleStepFailureMessage is no longer called for test-fixer", () => {
    // Negative guard: the old call form
    // `renderRoleStepFailureMessage("test-fixer", result)` must not
    // appear anywhere in phase-runner.ts. Other roles may still use
    // the legacy helper (judge, dual implementation, etc. — those
    // don't go through applyMutableAgentHygiene, so hygiene-aware
    // attribution doesn't apply).
    expect(phaseRunnerContent).not.toMatch(
      /renderRoleStepFailureMessage\("test-fixer",/,
    );
  });
});
