/**
 * G1 — phase-runner RUN_TESTS timeout robustness.
 *
 * Group G (phase runner / TDD loop), smoke spec. Pure in-memory: drives
 * `applyResult` / `decideNextAction` from `../../phase-runner` against fabricated
 * `PhaseState` + `SubAgentResult` values. No clock, no spawn, no disk — the
 * timeout-vs-red distinction and the (missing) bounded-retry path are both
 * decidable from the state machine alone, so this file touches no env var and
 * needs no temp dir.
 *
 * See ./README.md for the PIN vs RED protocol and
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §"Group G — Phase runner / TDD loop"
 * (spec G1) for the full design context.
 *
 * Long-run failure mode pinned here:
 *   A `runTests` timeout (leaked port, infra hang, flaky suite that wedges)
 *   must record `finalStatus:"timeout"` DISTINCTLY from a real red so the
 *   driver can tell "the suite hung" from "the suite ran and failed", and
 *   one such timeout must NOT permanently throw away the phase — a single
 *   transient hang on a multi-hour build should be retryable.
 */
import { describe, it, expect } from "bun:test";
import { applyResult, decideNextAction } from "../../phase-runner";
import type { Action } from "../../phase-runner";
import type { PhaseState, Phase } from "../../types";
import type { SubAgentResult } from "../../sub-agents";

// --- fixture builders (idioms lifted from ../phase-runner.test.ts) ---

/** A minimal PhaseState; override per case. Mirrors `basePhase` in phase-runner.test.ts. */
function basePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "Test Phase",
    status: "pending",
    ...overrides,
  };
}

/** A green SubAgentResult (exit 0, no timeout). Same shape as geminiSuccess(). */
function testResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    logPath: "",
    durationMs: 100,
    retries: 0,
    ...overrides,
  };
}

/** A test run that the stall watchdog killed (timedOut, exit null). */
function testTimeout(): SubAgentResult {
  return testResult({ timedOut: true, exitCode: null, retries: 1 });
}

/** A TDD code phase: testSpecDone=false routes impl_done -> RUN_TESTS, not Codex review. */
function tddPhase(): Phase {
  return {
    index: 0,
    number: "1",
    name: "TDD Test",
    body: "test content",
    testSpecDone: false,
    testSpecCheckboxLine: 3,
    implementationDone: false,
    implementationCheckboxLine: 4,
    reviewDone: false,
    reviewCheckboxLine: 5,
    dualImpl: false,
    kind: "code",
  };
}

const RUN_TESTS: Action = { type: "RUN_TESTS", phaseIndex: 0, iteration: 1 };

// --------------------------------------------------------------------------
// [PIN] — the timeout-vs-red distinction is ALREADY correct. Guard it.
// --------------------------------------------------------------------------
describe("[PIN] G1 phase-runner RUN_TESTS timeout records finalStatus:timeout, increments iterations", () => {
  it("applyResult(impl_done -> RUN_TESTS, timedOut) -> failed + finalStatus 'timeout' + iter incremented", () => {
    // Pre-state: implementation done, about to run the suite. Pretend a prior
    // RUN_TESTS already happened (iterations=1) so we can assert the counter
    // advances rather than just lands at 1.
    const initial = basePhase({
      status: "impl_done",
      testRun: { iterations: 1, finalStatus: "red" },
    });

    const next = applyResult(initial, RUN_TESTS, testTimeout());

    // The phase fails on a timeout...
    expect(next.status).toBe("failed");
    // ...but the timeout is recorded DISTINCTLY from a real red. This is the
    // load-bearing distinction the design demands: "timeout" != "red".
    expect(next.testRun?.finalStatus).toBe("timeout");
    expect(next.testRun?.finalStatus).not.toBe("red");
    expect(next.testRun?.finalStatus).not.toBe("green");
    // The attempt is counted — a timed-out run still burns an iteration.
    expect(next.testRun?.iterations).toBe(2);
  });

  it("a timeout is distinct from a real red — same action, different result, different finalStatus", () => {
    const initial = basePhase({ status: "impl_done" });

    const timedOut = applyResult(initial, RUN_TESTS, testTimeout());
    const red = applyResult(
      initial,
      RUN_TESTS,
      testResult({ exitCode: 1, timedOut: false }),
    );

    // A timeout records "timeout" and goes to failed; a non-zero exit records
    // "red" and goes to test_fix_running (the recoverable fix loop). The two
    // outcomes must not collapse into one indistinguishable state.
    expect(timedOut.testRun?.finalStatus).toBe("timeout");
    expect(timedOut.status).toBe("failed");
    expect(red.testRun?.finalStatus).toBe("red");
    expect(red.status).toBe("test_fix_running");
    expect(timedOut.testRun?.finalStatus).not.toBe(red.testRun?.finalStatus);
  });

  it("applyResult does not mutate the input PhaseState on a timeout", () => {
    const initial = basePhase({
      status: "impl_done",
      testRun: { iterations: 1, finalStatus: "red" },
    });

    applyResult(initial, RUN_TESTS, testTimeout());

    // Input untouched — applyResult returns a NEW state.
    expect(initial.status).toBe("impl_done");
    expect(initial.testRun?.iterations).toBe(1);
    expect(initial.testRun?.finalStatus).toBe("red");
  });
});

// --------------------------------------------------------------------------
// [RED] — DESIRED invariant that the code does NOT satisfy today.
//
// Today a RUN_TESTS timeout sets status -> "failed", and `decideNextAction`
// has NO `case "failed":` — it falls through to the exhaustiveness `default`
// and returns FAIL ("unknown status: failed"). So a single transient suite
// hang (leaked port, flaky infra) permanently throws away the phase: there is
// no bounded retry that re-issues RUN_TESTS, so a subsequent green run can
// never be reached through the driver. UNSKIP this block when G1 is fixed to
// route a recorded `finalStatus:"timeout"` back through a bounded RUN_TESTS
// retry instead of treating the first timeout as terminal.
// --------------------------------------------------------------------------
describe("[RED→FIXED] G1 phase-runner one RUN_TESTS timeout is not permanently terminal", () => {
  it("after a recorded test-run timeout, decideNextAction re-issues RUN_TESTS (bounded retry), not FAIL", () => {
    // Reconstruct the state the driver holds right after applyResult processed
    // a timeout: status "failed" with testRun.finalStatus "timeout", iter 1.
    const afterTimeout = applyResult(
      basePhase({ status: "impl_done" }),
      RUN_TESTS,
      testTimeout(),
    );
    expect(afterTimeout.status).toBe("failed");
    expect(afterTimeout.testRun?.finalStatus).toBe("timeout");

    // DESIRED: a single timeout is retryable. The driver should ask the state
    // machine what to do next and be told to re-run the suite (a bounded
    // retry), NOT to give up. Today this returns FAIL — that's the gap.
    const action = decideNextAction(afterTimeout, 5, tddPhase());
    expect(action.type).toBe("RUN_TESTS");
    if (action.type === "RUN_TESTS") {
      // The retry counts as the next iteration on top of the timed-out one.
      expect(action.iteration).toBe(2);
    }
  });

  it("a second RUN_TESTS with a green result after a timeout reaches tests_green", () => {
    // First run times out.
    const afterTimeout = applyResult(
      basePhase({ status: "impl_done" }),
      RUN_TESTS,
      testTimeout(),
    );
    expect(afterTimeout.testRun?.finalStatus).toBe("timeout");

    // DESIRED: the driver re-issues RUN_TESTS (the bounded retry that does not
    // exist today — see the sibling test). Drive that retry through the real
    // routing so the assertion fails pre-fix exactly where the gap is: today
    // the state is "failed" and decideNextAction returns FAIL, so the retry
    // action is never a RUN_TESTS and tests_green is unreachable.
    const retry = decideNextAction(afterTimeout, 5, tddPhase());
    expect(retry.type).toBe("RUN_TESTS");

    const afterGreen = applyResult(afterTimeout, retry, testResult());

    // One transient hang does not throw away the phase: a clean green re-run
    // recovers to tests_green and the timeout is no longer the final word.
    expect(afterGreen.status).toBe("tests_green");
    expect(afterGreen.testRun?.finalStatus).toBe("green");
    expect(afterGreen.testRun?.iterations).toBe(2);
  });
});
