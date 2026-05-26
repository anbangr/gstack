/**
 * Regression tests for Bug H — `buildCodexImplArgv` got the implementor
 * prompt for every roleId, including test-writer.
 *
 * Canonical incident:
 *   ~/.gstack/skill-faults/pending-investigations/
 *     polis-mesh-polis-f5-llm-claim-satisfaction-20260526-162359-ae26dedb-PHASE_FAILED:p0:* (and the test-writer-1-hygiene log).
 *
 * The polis-mesh build's Phase 1.1 test-writer (codex/gpt-5.5 post the
 * 2026-05-26 configure.cm swap) was instructed by the wrapper prompt to
 * "Implement the changes... make tests pass". It dutifully wrote
 * production code (sla/satisfaction.py + llm_proxy/polis_prompt.py) AND
 * the tests, ran them to 11/11 + 94% cov, and emitted the output summary.
 * PR #102's role boundary then refused the output ("agent's output
 * summary listed 1 non-test file(s)") and the phase halted dirty.
 *
 * Root cause: `buildCodexImplArgv` had a single hardcoded prompt, no
 * roleId switch. The fix adds a `roleId` parameter; when `"test-writer"`,
 * the prompt swaps to RED-test-only language ("You are the TEST WRITER",
 * "Touch ONLY test files", "Do NOT write production code"). Every other
 * roleId — including undefined — preserves the legacy implementor prompt
 * (back-compat for primary-impl, test-fixer, dual-impl tournament, and
 * every existing call site).
 *
 * Coverage:
 *   T-H1: roleId "test-writer" → test-writer prompt
 *   T-H2: roleId undefined → legacy implementor prompt (back-compat)
 *   T-H3: roleId "primary-impl" → legacy implementor prompt
 *   T-H4: roleId "test-fixer" → legacy implementor prompt (intentional;
 *         test-fixer's job IS to make tests pass)
 *   T-H5: static-grep guards on the cli.ts threading wiring
 *   T-H6: static-grep guard that the test-writer prompt forbids
 *         non-test paths in the exact wording the downstream PR #102
 *         role boundary uses
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildCodexImplArgv } from "../sub-agents";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

function extractPrompt(argv: string[]): string {
  // codex CLI shape: ["exec", <prompt>, ...flags]. The prompt is the
  // single argument after "exec" and before any flag.
  expect(argv[0]).toBe("exec");
  return argv[1] ?? "";
}

describe("Bug H — buildCodexImplArgv role-shaped prompt", () => {
  const baseOpts = {
    inputFilePath: "/tmp/in.md",
    outputFilePath: "/tmp/out.md",
    cwd: "/tmp/cwd",
  };

  it("T-H1: roleId 'test-writer' → test-writer prompt forbidding production code", () => {
    const argv = buildCodexImplArgv({ ...baseOpts, roleId: "test-writer" });
    const prompt = extractPrompt(argv);
    expect(prompt).toContain("You are the TEST WRITER");
    expect(prompt).toContain("write FAILING tests");
    expect(prompt).toContain("Touch ONLY test files");
    expect(prompt).toContain("Do NOT write production code");
    expect(prompt).toContain("Do NOT make existing tests pass");
    // The legacy implementor copy that caused Bug H MUST NOT appear.
    expect(prompt).not.toContain("Implement the changes autonomously");
    expect(prompt).not.toContain(
      "Do NOT change test assertions — only make tests pass",
    );
  });

  it("T-H2: roleId undefined → legacy implementor prompt (back-compat)", () => {
    // Dual-impl tournament + every existing call site that didn't set
    // roleId must continue to get the implementor prompt unchanged.
    const argv = buildCodexImplArgv({ ...baseOpts });
    const prompt = extractPrompt(argv);
    expect(prompt).toContain("Implement the changes autonomously");
    expect(prompt).toContain(
      "Do NOT change test assertions — only make tests pass",
    );
    expect(prompt).not.toContain("You are the TEST WRITER");
  });

  it("T-H3: roleId 'primary-impl' → legacy implementor prompt", () => {
    const argv = buildCodexImplArgv({ ...baseOpts, roleId: "primary-impl" });
    const prompt = extractPrompt(argv);
    expect(prompt).toContain("Implement the changes autonomously");
    expect(prompt).not.toContain("You are the TEST WRITER");
  });

  it("T-H4: roleId 'test-fixer' → legacy implementor prompt (test-fixer's job is impl-side)", () => {
    // test-fixer EXPECTS the make-tests-pass framing — its phase contract
    // is "tests are RED after the test-writer's commit; fix the code".
    // Sharing the implementor prompt is intentional.
    const argv = buildCodexImplArgv({ ...baseOpts, roleId: "test-fixer" });
    const prompt = extractPrompt(argv);
    expect(prompt).toContain("Implement the changes autonomously");
    expect(prompt).toContain(
      "Do NOT change test assertions — only make tests pass",
    );
    expect(prompt).not.toContain("You are the TEST WRITER");
  });

  it("preserves sandbox + --add-dir + reasoning flags regardless of roleId", () => {
    // Smoke: changing the prompt block must not regress the flag set
    // PR #104 (Bug E) added.
    const tw = buildCodexImplArgv({ ...baseOpts, roleId: "test-writer" });
    const pi = buildCodexImplArgv({ ...baseOpts });
    for (const argv of [tw, pi]) {
      expect(argv).toContain("-s");
      expect(argv).toContain("workspace-write");
      expect(argv).toContain("-c");
      expect(argv).toContain('model_reasoning_effort="high"');
      expect(argv).toContain("-C");
      expect(argv).toContain("/tmp/cwd");
    }
  });
});

describe("Bug H — cli.ts threading guards (static-grep)", () => {
  it("T-H5a: runRoleTask declares the optional roleId parameter", () => {
    // The function signature in cli.ts MUST accept roleId so the call
    // site at the test-writer dispatch can pass "test-writer" through to
    // runCodexImpl → buildCodexImplArgv.
    expect(cliContent).toMatch(
      /export async function runRoleTask\(opts:[\s\S]{0,800}roleId\?:/,
    );
  });

  it("T-H5b: runCodexImpl call inside runRoleTask forwards roleId", () => {
    // The codex branch of runRoleTask must pass roleId through; a
    // refactor that drops the field would silently regress every codex
    // role to the implementor prompt.
    expect(cliContent).toMatch(
      /runCodexImpl\(\{[\s\S]{0,600}roleId:\s*opts\.roleId/,
    );
  });

  it("T-H5c: test-writer dispatch site sets roleId: 'test-writer'", () => {
    // The runRoleTask call at the RUN_GEMINI_TEST_SPEC test-writer
    // dispatch MUST set roleId. Without this, the runtime test-writer
    // gets the implementor prompt even though the function signature
    // accepts roleId. The dispatch block spans ~15 lines (role, paths,
    // slug, phaseNumber, iteration, logPrefix, comment block, roleId),
    // so allow a generous gap between the two literals.
    expect(cliContent).toMatch(
      /role:\s*args\.roles\.testWriter[\s\S]{0,1200}roleId:\s*"test-writer"/,
    );
  });
});
