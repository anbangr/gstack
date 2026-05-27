/**
 * Regression tests for Bug I — `RUN_GEMINI_TEST_SPEC` failure handler
 * produced misleading "test-spec writer exited N" message when the real
 * failure was a hygiene-gate conversion (empty output, no commit, etc.).
 *
 * Canonical incident:
 *   ~/Documents/Antigravity/agnt2-workspace/agnt2-gstack/inbox/
 *     BUGREPORT-gstack-build-hygiene-gate-kills-test-writer-work.md
 *
 * The operator running /build on AGNT2 hit Phase 3.1 test-writer
 * halts 4 times in a row. Every halt surfaced as
 * `✗ Phase 3.1 ... failed: test-spec writer exited 0`. The worktree
 * was clean, the monitor agent JSON was 0 bytes, and the operator
 * could not tell whether codex crashed, was rate-limited, or silently
 * produced no work. The actual cause (codex backup exited 0 with an
 * empty output file → applyMutableAgentHygiene's requireNonEmptyOutput
 * gate fired → hygieneFailureResult wrapped the success as exitCode=1
 * → phase-runner rendered "test-spec writer exited 1" via
 * `renderRoleStepFailureMessage`) was buried in the hygiene-log file
 * that the operator had to grep for separately.
 *
 * Every other dispatcher in phase-runner.ts (primary-impl, test-fixer,
 * dual-impl, judge, etc.) already used `geminiExitError` which prefers
 * the first non-header line of the hygiene body when present. The
 * test-writer dispatch was the lone holdout still calling
 * `renderRoleStepFailureMessage` directly. This PR aligns it with the
 * rest of the codebase.
 *
 * Coverage:
 *   T-I1: hygieneFailure result → error message names the hygiene reason
 *   T-I2: vanilla nonzero exit → error message names the exit code (legacy
 *         behavior preserved for cases where the failure ISN'T a hygiene
 *         conversion, e.g., codex CLI genuinely crashed with exit 2)
 *   T-I3: static-grep: phase-runner.ts test-writer dispatch uses
 *         geminiExitError (not renderRoleStepFailureMessage)
 *   T-I4: static-grep: every dispatcher in phase-runner.ts that touches
 *         a hygiene-wrapped result uses the geminiExitError idiom
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyResult } from "../phase-runner";
import type { Action } from "../phase-runner";
import type { SubAgentResult } from "../sub-agents";
import type { Phase, FeatureGate } from "../types";

const phaseRunnerPath = path.resolve(import.meta.dir, "../phase-runner.ts");
const phaseRunnerContent = fs.readFileSync(phaseRunnerPath, "utf-8");

function mkPhase(overrides: Partial<Phase> = {}): Phase {
  return {
    index: 0,
    number: "3.1",
    name: "Extract tier resolution into public-rpc-proxy/tier",
    body: "",
    kind: "code",
    auditOnly: false,
    testSpecCheckboxLine: -1,
    checkboxLines: [],
    ...overrides,
  } as Phase;
}

function mkFeatureGate(): FeatureGate {
  return { status: "pending", iterations: 0, recentReviewVerdicts: [] };
}

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

describe("Bug I — RUN_GEMINI_TEST_SPEC hygiene-aware error attribution", () => {
  it("T-I1: hygieneFailure result surfaces the hygiene reason in next.error", () => {
    // applyMutableAgentHygiene wraps a successful spawn as exitCode=1
    // with `hygieneFailure: true` and a body that begins with
    // "# Post-agent hygiene failure" followed by the reason. The
    // dispatcher must extract the reason for next.error.
    const hygieneBody = [
      "# Post-agent hygiene failure",
      "test-writer left an empty output summary: /tmp/phase-3.1-output.md",
      "",
      "Original agent log: /tmp/phase-3.1-test-writer-1.log",
      "",
      "GATE FAIL",
    ].join("\n");
    const result = mkResult({
      exitCode: 1,
      stdout: hygieneBody,
      logPath: "/tmp/phase-3.1-test-writer-1-hygiene.log",
      hygieneFailure: true,
    } as Partial<SubAgentResult>);
    const phaseState = {
      number: "3.1",
      status: "running",
      kind: "code",
    } as any;
    const action: Action = {
      type: "RUN_GEMINI_TEST_SPEC",
      phaseIndex: 0,
      iteration: 1,
    };
    const next = applyResult(phaseState, action, result);
    expect(next.status).toBe("failed");
    // The new attribution: name the hygiene reason explicitly.
    expect(next.error).toContain("hygiene failed");
    expect(next.error).toContain("left an empty output summary");
    // Forensics: the agent log path is part of the error so the
    // operator can grep it without hunting through the state file.
    expect(next.error).toContain("hygiene.log");
    // The legacy misleading shape MUST NOT appear.
    expect(next.error).not.toMatch(/^test-spec writer exited \d+$/);
  });

  it("T-I2: vanilla nonzero exit (no hygiene marker) falls through to legacy 'exited N' shape", () => {
    // When codex genuinely crashed (no hygiene wrapping), keep the
    // exit-code message — it's the right signal for that failure
    // class. Only hygiene-converted failures need the new attribution.
    const result = mkResult({
      exitCode: 2,
      stdout: "TypeError: cannot read properties of undefined\n",
      logPath: "/tmp/phase-3.1-test-writer-1.log",
    });
    const phaseState = {
      number: "3.1",
      status: "running",
      kind: "code",
    } as any;
    const action: Action = {
      type: "RUN_GEMINI_TEST_SPEC",
      phaseIndex: 0,
      iteration: 1,
    };
    const next = applyResult(phaseState, action, result);
    expect(next.status).toBe("failed");
    expect(next.error).toContain("test-spec writer exited 2");
    expect(next.error).toContain(result.logPath);
    expect(next.error).not.toContain("hygiene failed");
  });
});

describe("Bug I — static-grep wiring guards", () => {
  it("T-I3: RUN_GEMINI_TEST_SPEC handler uses geminiExitError (hygiene-aware)", () => {
    // Pin the helper choice so a future refactor that swaps in
    // renderRoleStepFailureMessage (the legacy holdout) re-introduces
    // the misleading "exited N" attribution. Match the literal call
    // form so a typo in the prefix fails CI.
    expect(phaseRunnerContent).toMatch(
      /action\.type\s*===\s*"RUN_GEMINI_TEST_SPEC"[\s\S]{0,2500}geminiExitError\("test-spec writer",\s*result\)/,
    );
  });

  it("T-I4: every dispatcher that touches a hygiene-wrapped result uses geminiExitError", () => {
    // After Bug I lands, all role-step dispatchers in phase-runner.ts
    // that handle a hygiene-wrapped failure should use geminiExitError.
    // renderRoleStepFailureMessage is still allowed for callers that
    // genuinely can't get a hygiene-wrapped result (dual-impl judge
    // path, etc.), but the test-writer / primary-impl / test-fixer
    // family must all go through geminiExitError. Pin the ratio so a
    // future regression that adds a new dispatcher without the helper
    // shows up at review time.
    const geminiExitErrorCalls = (
      phaseRunnerContent.match(/geminiExitError\(/g) || []
    ).length;
    expect(geminiExitErrorCalls).toBeGreaterThanOrEqual(3);
  });
});
