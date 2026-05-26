import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decideNextAction,
  applyResult,
  DEFAULT_MAX_RED_SPEC_ITERATIONS,
} from "../phase-runner";
import { extractTestCount } from "../test-runner-introspect";
import { loadPendingInvestigations } from "../halt-events";
import type { Phase, PhaseState } from "../types";
import type { SubAgentResult } from "../sub-agents";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function basePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "Test Phase",
    status: "pending",
    ...overrides,
  };
}

function verifyRedResult(stdout: string, exitCode = 0): SubAgentResult {
  return {
    stdout,
    stderr: "",
    exitCode,
    timedOut: false,
    logPath: "/tmp/verify-red.log",
    durationMs: 500,
    retries: 0,
  };
}

function fixturePaths(tmp: string) {
  fs.writeFileSync(path.join(tmp, "stdout.log"), "");
  return {
    stateFile: path.join(tmp, "state.json"),
    stdoutLog: path.join(tmp, "stdout.log"),
    livingPlan: path.join(tmp, "plan.md"),
    worktreePath: tmp,
  };
}

function freshState(): any {
  return {
    slug: "s1",
    phases: [
      { index: 0, number: 1, status: "running" } as any,
    ],
    features: [{ number: "1", status: "running" } as any],
  };
}

/** Build a Phase with the given kind and body. */
function phase(kind: Phase["kind"], body = ""): Phase {
  return {
    index: 0,
    number: "1",
    name: "Test Phase",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "Feature 1",
    implementationDone: false,
    reviewDone: false,
    testSpecDone: true,
    body,
    implementationCheckboxLine: 10,
    reviewCheckboxLine: 11,
    testSpecCheckboxLine: 12,
    dualImpl: false,
    kind,
  };
}

// ------------------------------------------------------------------
// T8 – T13: zero-collection halt + suppression annotations
// ------------------------------------------------------------------

describe("red-gate zero-tests-collected halt (T8-T13)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rgzt-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // T8: Zero collection halts
  test("T8: VERIFY_RED exit=0 with 0 collected → halt with RED_GATE_ZERO_TESTS_COLLECTED", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    // vitest JSON with 0 tests
    const stdout = JSON.stringify({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
    });
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: "some body without suppression",
      testCmd: "npx vitest run",
    });
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/RED_GATE_ZERO_TESTS_COLLECTED/i);
    expect(next.error).toMatch(/did you forget.*<!-- testCmd: -->/i);
  });

  // T9: audit-only suppresses
  test("T9: <!-- audit-only --> in phase body suppresses zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: "some body\n<!-- audit-only -->\nmore body",
      testCmd: "npx vitest run",
    });
    expect(next.status).toBe("test_spec_running");
    expect(next.error).toBeUndefined();
  });

  // T10: [writing] suppresses
  test("T10: [writing] phase kind suppresses zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const p = phase("writing");
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: p.body,
      testCmd: "npx vitest run",
      phaseKind: p.kind,
    });
    expect(next.status).toBe("test_spec_running");
    expect(next.error).toBeUndefined();
  });

  // T11: [research] suppresses
  test("T11: [research] phase kind suppresses zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const p = phase("research");
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: p.body,
      testCmd: "npx vitest run",
      phaseKind: p.kind,
    });
    expect(next.status).toBe("test_spec_running");
    expect(next.error).toBeUndefined();
  });

  // T12: [experiment] suppresses
  test("T12: [experiment] phase kind suppresses zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const p = phase("experiment");
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: p.body,
      testCmd: "npx vitest run",
      phaseKind: p.kind,
    });
    expect(next.status).toBe("test_spec_running");
    expect(next.error).toBeUndefined();
  });

  // T13: [manual] suppresses
  test("T13: [manual] phase kind suppresses zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const p = phase("manual");
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: p.body,
      testCmd: "npx vitest run",
      phaseKind: p.kind,
    });
    expect(next.status).toBe("test_spec_running");
    expect(next.error).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// T14 – T15: cap 3 → 1 + legacy env var
// ------------------------------------------------------------------

describe("red-spec cap behavior (T14-T15)", () => {
  test("T14: cap is 1 when collected > 0 — redSpecAttempts=0 fails immediately", () => {
    const state = basePhase({ status: "test_spec_done", redSpecAttempts: 0 });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 2, numPassedTests: 2 });
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: "some body",
      testCmd: "npx vitest run",
    });
    // With cap lowered to 1, attempts=1 >= 1 → fail
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/could not produce failing tests|RED_GATE|trivially pass/i);
  });

  test("T15: GSTACK_BUILD_RED_LEGACY_CAP=3 restores cap to 3", () => {
    const prev = process.env.GSTACK_BUILD_RED_LEGACY_CAP;
    process.env.GSTACK_BUILD_RED_LEGACY_CAP = "3";
    try {
      // Re-importing would be needed if the module caches the value at load time.
      // For this test we verify the env var is honored by the cap logic.
      // Since DEFAULT_MAX_RED_SPEC_ITERATIONS is evaluated at module load,
      // we test the contract by asserting the env var exists and the cap
      // constant would read it (the implementation will wire it).
      const state = basePhase({
        status: "test_spec_done",
        redSpecAttempts: 1,
      });
      const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
      const stdout = JSON.stringify({ numTotalTests: 2, numPassedTests: 2 });
      const next = applyResult(state, action, verifyRedResult(stdout, 0), {
        phaseBody: "some body",
        testCmd: "npx vitest run",
      });
      // With legacy cap=3, attempts=2 < 3 → should NOT fail
      expect(next.status).toBe("test_spec_running");
    } finally {
      if (prev === undefined) delete process.env.GSTACK_BUILD_RED_LEGACY_CAP;
      else process.env.GSTACK_BUILD_RED_LEGACY_CAP = prev;
    }
  });
});

// ------------------------------------------------------------------
// T16: SKILL.md hint
// ------------------------------------------------------------------

describe("SKILL.md synthesizer hint (T16)", () => {
  test("T16: regenerated SKILL.md contains polyglot testCmd hint", () => {
    const skillPath = path.resolve(import.meta.dir, "../../SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toMatch(/<!-- testCmd: -->/);
    expect(content).toMatch(/polyglot.*repo|per-phase runner|differs from the repo root command/i);
  });
});

// ------------------------------------------------------------------
// Edge cases
// ------------------------------------------------------------------

describe("red-gate zero-tests-collected edge cases", () => {
  test("edge: [code] annotation does NOT suppress zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const p = phase("code");
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: p.body,
      testCmd: "npx vitest run",
    });
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/RED_GATE_ZERO_TESTS_COLLECTED/i);
  });

  test("edge: both <!-- audit-only --> AND [code] — audit-only wins (suppression)", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: "<!-- audit-only -->\n[code] stuff",
      testCmd: "npx vitest run",
    });
    expect(next.status).toBe("test_spec_running");
    expect(next.error).toBeUndefined();
  });

  test("edge: stdout-fallback with collected=0 still halts", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    // mocha-style stdout with 0 passing
    const stdout = "\n  0 passing (1ms)\n\n";
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: "some body",
      testCmd: "mocha",
    });
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/RED_GATE_ZERO_TESTS_COLLECTED/i);
  });

  test("edge: zero collection with exit=1 (tests red) does NOT halt — normal red path", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({ numTotalTests: 0 });
    const next = applyResult(state, action, verifyRedResult(stdout, 1), {
      phaseBody: "some body",
      testCmd: "npx vitest run",
    });
    // exitCode !== 0 → normal red path, no extractTestCount call
    expect(next.status).toBe("tests_red");
    expect(next.error).toBeUndefined();
  });

  test("edge: non-code phase kinds skip verify-red in decideNextAction", () => {
    for (const kind of ["writing", "experiment", "research", "manual"] as const) {
      const state = basePhase({ status: "pending" });
      const action = decideNextAction(state, 10, phase(kind));
      expect(action.type).not.toBe("VERIFY_RED");
    }
  });

  test("edge: cli failure path emits RED_GATE_ZERO_TESTS_COLLECTED instead of generic retry cap", () => {
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const content = fs.readFileSync(cliPath, "utf-8");
    expect(content).toContain("recordRedGateZeroTestsCollected");
    expect(content).toMatch(
      /action\.reason\.startsWith\("RED_GATE_ZERO_TESTS_COLLECTED"\)/,
    );
  });

  // Bug A regression: wrapper-script testCmd (resolves to runner "unknown")
  // with vitest JSON in stdout should NOT halt with RED_GATE_ZERO_TESTS_COLLECTED.
  // Previously, "unknown" runner discarded stdout and returned zero. Now the
  // best-effort fallback recovers the vitest count and the orchestrator proceeds
  // through the normal red-cap path instead of a spurious zero-collection halt.
  test("edge: wrapper-script testCmd + vitest JSON stdout → no spurious zero-collection halt", () => {
    const state = basePhase({ status: "test_spec_done" });
    const action = { type: "VERIFY_RED" as const, phaseIndex: 0 };
    const stdout = JSON.stringify({
      numTotalTests: 14,
      numPassedTests: 14,
      numFailedTests: 0,
    });
    const next = applyResult(state, action, verifyRedResult(stdout, 0), {
      phaseBody: "some body without suppression",
      testCmd: "sh scripts/test.sh",
    });
    // 14 collected, all passing, exit=0 → tests trivially passed (not red).
    // The next red-cap iteration kicks in (or fails at the cap), but the
    // failure is "could not produce failing tests", NOT a zero-collection halt.
    expect(next.error ?? "").not.toMatch(/RED_GATE_ZERO_TESTS_COLLECTED/);
  });

  // Bug B regression: phase-runner RUN_GEMINI_TEST_SPEC must surface a
  // hygiene failure (exit=1) as status="failed", not silently advance to
  // test_spec_done. This pins the behavior at the state-machine layer:
  // when the cli dispatch wraps test-writer in applyMutableAgentHygiene
  // and the gate fires, the resulting non-zero exit triggers the existing
  // failure branch in applyResult for RUN_GEMINI_TEST_SPEC.
  test("Bug B: RUN_GEMINI_TEST_SPEC with hygiene-failed result (exit=1) → status failed, no test_spec_done", () => {
    const state = basePhase({ status: "test_spec_running" });
    const action = {
      type: "RUN_GEMINI_TEST_SPEC" as const,
      phaseIndex: 0,
      iteration: 1,
    };
    const hygieneFailed: SubAgentResult = {
      stdout:
        "# Post-agent hygiene failure\n\ntest-writer left the working tree dirty and produced no new commit\n\nGATE FAIL",
      stderr: "",
      exitCode: 1,
      timedOut: false,
      logPath: "/tmp/test-writer-hygiene.log",
      durationMs: 1234,
      retries: 0,
    };
    const next = applyResult(state, action, hygieneFailed);
    expect(next.status).toBe("failed");
    expect(next.status).not.toBe("test_spec_done");
    expect(next.error).toBeDefined();
  });

  // Bug B wiring check: cli.ts must wrap the RUN_GEMINI_TEST_SPEC dispatch
  // in applyMutableAgentHygiene with requireNewCommit=true and a "test-writer"
  // label. Pins the structural fix so a refactor can't silently drop the gate.
  test("Bug B: cli.ts RUN_GEMINI_TEST_SPEC dispatch wires applyMutableAgentHygiene", () => {
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const content = fs.readFileSync(cliPath, "utf-8");
    // Find the RUN_GEMINI_TEST_SPEC dispatch block.
    const blockStart = content.indexOf('"RUN_GEMINI_TEST_SPEC"');
    expect(blockStart).toBeGreaterThan(0);
    // Slice forward to the next `if (action.type ===` block boundary or end.
    const blockEnd = content.indexOf(
      'if (action.type === "VERIFY_RED")',
      blockStart,
    );
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = content.slice(blockStart, blockEnd);
    expect(block).toContain("applyMutableAgentHygiene");
    expect(block).toMatch(/label:\s*"test-writer"/);
    expect(block).toMatch(/requireNewCommit:\s*true/);
  });
});
