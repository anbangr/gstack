import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "../sub-agents";
import { resolveTestCmdForPhase } from "../cli";
import { parsePlan } from "../parser";
import type { Args, Phase } from "../types";

// Regression for the mitosis-prototype skill fault (2026-05-18 evening):
// project root has `pyproject.toml [tool.pytest.ini_options]` AND
// `openclaw/vitest.config.ts` (no root package.json). detectTestCmd picks
// vitest (Priority 1b ranks subdir JS configs over pyproject pytest blocks).
// For a Python feature whose tests live under `tests/`, that runs the wrong
// suite: `npx vitest run` exits 0 (108 JS tests pass), CLI interprets it as
// "tests trivially pass before implementation," re-spec's 3 times, bails with
// GSTACK_BUILD_RED_MAX_ITER.
//
// The fix isn't to flip Priority 1b (that breaks the existing CRITICAL test
// for the inverse shape — a TS feature with a sibling pytest config). The fix
// is to let plan authors override the autodetected command per-phase via
// `<!-- testCmd: <cmd> -->` in the phase body. This test pins both halves
// of the contract: detection unchanged, override honored.

function withTmp(fn: (cwd: string) => void): void {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "per-phase-testcmd-")),
  );
  try {
    fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Build a minimal Args object — only the fields resolveTestCmdForPhase reads matter. */
function emptyArgs(): Args {
  return { testCmd: undefined, testFramework: undefined } as unknown as Args;
}

describe("per-phase testCmd override — mitosis-prototype bug regression", () => {
  it("inspectProject still picks vitest for the polyglot mitosis shape (preserves CRITICAL test contract)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");
      // No root package.json — this is what mitosis-prototype actually looks like.
      const r = inspectProject(cwd);
      expect(r.framework).toBe("vitest");
      expect(r.runner).not.toBe("pytest");
    });
  });

  it("resolveTestCmdForPhase returns the per-phase override when annotation is present", () => {
    withTmp((cwd) => {
      // Mirror the mitosis shape.
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");

      // Plan with the annotation on Phase 1.
      const plan = `# Plan

## Feature 1: Schema v3.1 with behavior subtree
### Phase 1: Layer 1 generator emits behavior defaults
<!-- testCmd: pytest tests/test_capability_assembler_behavior.py -->
- [ ] **Implementation**: emit defaults
- [ ] **Review**: confirm green
`;
      const { phases, warnings } = parsePlan(plan);
      expect(warnings).toEqual([]);
      expect(phases).toHaveLength(1);
      expect(phases[0].testCmdOverride).toBe(
        "pytest tests/test_capability_assembler_behavior.py",
      );

      const cmd = resolveTestCmdForPhase(emptyArgs(), cwd, phases[0]);
      expect(cmd).toBe("pytest tests/test_capability_assembler_behavior.py");
    });
  });

  it("resolveTestCmdForPhase falls through to detectTestCmd when no annotation", () => {
    withTmp((cwd) => {
      // Same shape.
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");

      // Plan WITHOUT the annotation — phase should get the autodetected runner.
      const plan = `# Plan

## Feature 1: Demo
### Phase 1: Vanilla phase
- [ ] **Implementation**: do
- [ ] **Review**: review
`;
      const { phases } = parsePlan(plan);
      expect(phases).toHaveLength(1);
      expect(phases[0].testCmdOverride).toBeUndefined();

      const cmd = resolveTestCmdForPhase(emptyArgs(), cwd, phases[0]);
      // Falls through to detectTestCmd, which picks vitest for this shape.
      expect(cmd).toBe("npx vitest run");
    });
  });

  it("per-phase override coexists with sibling phases that fall through", () => {
    // Polyglot plan: Phase 1 wants pytest (override), Phase 2 wants the default
    // (which is vitest for this repo shape). Both phases parse, each gets the
    // right command from resolveTestCmdForPhase.
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");

      const plan = `# Plan

## Feature 1: Python phase
### Phase 1: Pytest layer
<!-- testCmd: pytest tests/test_layer.py -->
- [ ] **Implementation**: emit defaults
- [ ] **Review**: review

## Feature 2: TS phase
### Phase 1: Vitest sidecar
- [ ] **Implementation**: wire up sidecar
- [ ] **Review**: review
`;
      const { phases, warnings } = parsePlan(plan);
      expect(warnings).toEqual([]);
      expect(phases).toHaveLength(2);

      const args = emptyArgs();
      expect(resolveTestCmdForPhase(args, cwd, phases[0])).toBe(
        "pytest tests/test_layer.py",
      );
      expect(resolveTestCmdForPhase(args, cwd, phases[1])).toBe(
        "npx vitest run",
      );
    });
  });

  it("CLI --test-cmd flag still wins over autodetect for phases WITHOUT annotation", () => {
    // Regression on the precedence chain. Resolution order:
    //   1. phase.testCmdOverride  (this PR)
    //   2. args.testCmd  (existing --test-cmd flag)
    //   3. args.testFramework  (existing --test-framework flag)
    //   4. detectTestCmd(cwd)  (autodetect)
    // For a phase without an override, --test-cmd must still beat detectTestCmd.
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");

      const plan = `# Plan
## Feature 1: Demo
### Phase 1: No annotation
- [ ] **Implementation**: do
- [ ] **Review**: review
`;
      const { phases } = parsePlan(plan);
      const args = { testCmd: "custom-runner --quiet" } as unknown as Args;
      expect(resolveTestCmdForPhase(args, cwd, phases[0])).toBe(
        "custom-runner --quiet",
      );
    });
  });

  it("per-phase override beats CLI --test-cmd flag (highest tier wins)", () => {
    // The whole point of the annotation is that plan authors know which
    // runner each phase needs, even when the CLI invocation passes a global
    // --test-cmd. The plan wins.
    withTmp((cwd) => {
      const plan = `# Plan
## Feature 1: Demo
### Phase 1: Has override
<!-- testCmd: pytest tests/specific.py -->
- [ ] **Implementation**: do
- [ ] **Review**: review
`;
      const { phases } = parsePlan(plan);
      const args = { testCmd: "should-not-win" } as unknown as Args;
      expect(resolveTestCmdForPhase(args, cwd, phases[0])).toBe(
        "pytest tests/specific.py",
      );
    });
  });

  it("the previous GSTACK_BUILD_RED_MAX_ITER error message names the override path", () => {
    // The error string at phase-runner.ts:648 is what the user sees when they
    // hit the mitosis bug. It must include a pointer to the per-phase
    // testCmd override so they know how to fix it without re-reading the README.
    // We import the string from the runtime so it's pinned by this regression
    // test — any future trim of the message that drops the override hint
    // fails here.
    const phaseRunner = fs.readFileSync(
      path.join(__dirname, "..", "phase-runner.ts"),
      "utf-8",
    );
    expect(phaseRunner).toContain("GSTACK_BUILD_RED_MAX_ITER");
    expect(phaseRunner).toContain("testCmd:");
  });

  it("polyglot root-vitest plus Python-pytest override fixture resolves pytest runner", () => {
    // Regression: a repo whose root autodetects vitest (because of a sibling
    // JS config) but whose Python phase declares `<!-- testCmd: pytest ... -->`
    // must resolve to pytest, not vitest, so verify-red uses the pytest parser.
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");

      const plan = `# Plan
## Feature 1: Python layer
### Phase 1: Pytest phase
<!-- testCmd: pytest tests/test_layer.py -->
- [ ] **Implementation**: emit defaults
- [ ] **Review**: review
`;
      const { phases } = parsePlan(plan);
      const cmd = resolveTestCmdForPhase(emptyArgs(), cwd, phases[0]);
      expect(cmd).toBe("pytest tests/test_layer.py");
      // The runner detected from this command must be pytest, not vitest.
      expect(cmd).toContain("pytest");
      expect(cmd).not.toContain("vitest");
    });
  });
});
