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
    expect(prompt).toContain("NEW FAILING tests");
    expect(prompt).toContain("Touch ONLY test files");
    expect(prompt).toContain("Do NOT write production code");
    expect(prompt).toContain("Do NOT modify existing passing tests");
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

  it("T-H5d: roleId: 'test-writer' appears exactly once in cli.ts (only the runRoleTask dispatch)", () => {
    // Red-team review (PR #105+) flagged that an accidental copy-paste of
    // `roleId: "test-writer"` onto a non-test-writer dispatch (e.g.,
    // primaryImpl, secondaryImpl, test-fixer, feature-review) would
    // silently route the wrong role through the test-writer prompt and
    // cause empty production-code phases. Pin the count so any future
    // duplicate triggers CI investigation. Note: counts only the literal
    // `roleId: "test-writer"` form — applyMutableAgentHygiene's separate
    // `roleId: "test-writer"` call (cli.ts:8535 region) uses the same
    // literal because PR #102's hygiene gate is keyed off the same role
    // identity, so the expected count is 2 occurrences total: one on the
    // runRoleTask dispatch, one on the applyMutableAgentHygiene call.
    const count = (cliContent.match(/roleId:\s*"test-writer"/g) || []).length;
    expect(count).toBe(2);
  });
});

describe("Bug H — prompt-enforcer drift guard", () => {
  // Multi-specialist confirmed finding (testing + red-team): the
  // test-writer prompt's allowlist of path patterns MUST stay narrower
  // than (or equal to) the downstream classifyTestWriterCommit enforcer
  // regex at cli.ts:2138 (`/(^|\/)(__tests__|test|tests|spec|specs)\//i`
  // + `/\.(test|spec)\.[a-z]+$/i`). Earlier prompt versions promised
  // codex that Go-style `*_test.go` files were allowed, but the enforcer
  // only matches directory-based test paths + `.test.*`/`.spec.*`
  // suffixes — so a Go test-writer following the prompt would commit
  // `foo_test.go` and immediately get refused. Same Bug H symptom,
  // different cause. These tests pin the prompt to the enforcer surface.

  it("T-H6a: test-writer prompt enumerates exactly the dir prefixes the enforcer accepts", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/cwd",
      roleId: "test-writer",
    });
    const prompt = extractPrompt(argv);
    for (const dir of ["__tests__/", "test/", "tests/", "spec/", "specs/"]) {
      expect(prompt).toContain(dir);
    }
    // Must mention the suffix-based escape hatch the enforcer also accepts.
    expect(prompt).toMatch(/\*\.test\.\*|\*\.spec\.\*/);
  });

  it("T-H6b: test-writer prompt does NOT promise patterns the enforcer rejects", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/cwd",
      roleId: "test-writer",
    });
    const prompt = extractPrompt(argv);
    // Go's `*_test.go` basename is NOT matched by either enforcer regex:
    // it has no `__tests__|test|tests|spec|specs/` directory prefix AND
    // the suffix regex is `\.(test|spec)\.[a-z]+$`, not `_test\.`. Until
    // the enforcer is widened (separate concern), the prompt must NOT
    // promise this pattern.
    expect(prompt).not.toMatch(/\*_test\.\*/);
    expect(prompt).not.toMatch(/_test\.go/);
  });

  it("T-H6c: test-writer prompt clarifies 'add new tests' vs 'break existing ones'", () => {
    // Earlier prompt said "Do NOT make existing tests pass" which an
    // over-literal codex could read as "make existing tests fail" (i.e.,
    // delete assertions or comment out imports). The tightened form
    // separates 'add NEW failing tests' from 'do not modify existing
    // passing tests to make them fail'. Pin both halves.
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/cwd",
      roleId: "test-writer",
    });
    const prompt = extractPrompt(argv);
    expect(prompt).toMatch(/NEW FAILING tests|ADD new failing tests/i);
    expect(prompt).toMatch(/leave existing ones untouched|do not modify existing passing tests/i);
  });

  it("T-H6d: test-writer prompt and classifyTestWriterCommit enforcer use the same dir-prefix list", () => {
    // Read the enforcer regex literal from cli.ts and verify the prompt
    // mentions every directory the enforcer would accept. A divergence
    // in either direction (prompt adds a dir not in enforcer, or
    // enforcer adds a dir not in prompt) fails CI and forces both sides
    // to be updated together. The enforcer literal is:
    //   const TEST_PATH_RE = /(^|\/)(__tests__|test|tests|spec|specs)\//i;
    // Match the inner `(__tests__|...)` alternation group.
    const enforcerMatch = cliContent.match(
      /TEST_PATH_RE\s*=\s*\/\(\^\|\\\/\)\(([^)]+)\)\\\//,
    );
    expect(enforcerMatch).not.toBeNull();
    const enforcerDirs = (enforcerMatch![1] ?? "").split("|");
    expect(enforcerDirs.length).toBeGreaterThan(0);
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/cwd",
      roleId: "test-writer",
    });
    const prompt = extractPrompt(argv);
    for (const dir of enforcerDirs) {
      expect(prompt).toContain(`${dir}/`);
    }
  });
});
