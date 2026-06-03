/**
 * A1 — provider-capacity-retry-wired (build-robustness suite)
 *
 * Group A (provider failures), tier: smoke. Intended mode: RED.
 *
 * THE GAP (confirmed by reading the production code 2026-06-03):
 *   A transient `API Error: 529 Overloaded` / `RESOURCE_EXHAUSTED` mid-build
 *   must drive backoff+retry via `planProviderRetry`, bounded by
 *   `PROVIDER_RETRY_SESSION_CAP` (6) — NOT an immediate halt.
 *
 *   But `planProviderRetry` / `nextCapacityBackoffMs` have ZERO production
 *   call sites today (dead code, halt-event-helpers.ts:717,744). The FAIL
 *   path in cli.ts (~8800-8978) classifies the verdict
 *   (`recordProviderFailureVerdict`) and then unconditionally `return
 *   "failed"` — no sleep, no re-spawn, no consultation of the backoff
 *   planner, no `PROVIDER_RETRY_SESSION_CAP` budget. cli.ts does not even
 *   import `planProviderRetry`. A single transient 529 kills a multi-hour
 *   build.
 *
 * WHAT THIS FILE PINS (the DESIRED, currently-failing invariant):
 *   1. The FAIL path consults `planProviderRetry` for a capacity/overloaded
 *      verdict and acts on its `{ halt, sleepMs }` decision (sleep+respawn
 *      vs halt) instead of dead-halting. Asserted as production wiring on
 *      the cli.ts FAIL-classification source — the same static-grep idiom
 *      `feature-start-network-retry.test.ts` uses for "route through the
 *      retry helper" invariants. Fails today because the symbol is absent.
 *
 *   2. The OBSERVABLE recovery contract the wiring must satisfy, driven
 *      against the REAL `planProviderRetry` with a `sleepMs` spy, a
 *      deterministic rng, and a canned `SubAgentResult` whose log contains
 *      "API Error: 529 Overloaded" + exitCode:1 on the first N calls then a
 *      clean PASS:
 *        - a clean PASS within budget completes the phase (no halt);
 *        - each capacity retry sleeps a positive backoff;
 *        - `providerRetryAttempts` increments once per attempt;
 *        - the halt fires only AFTER `PROVIDER_RETRY_SESSION_CAP` failures,
 *          not before.
 *      This block asserts that a real respawn loop wired around
 *      `planProviderRetry` produces that contract. It is RED because no
 *      production loop calls `planProviderRetry`, so the contract is
 *      currently unreachable from the orchestrator.
 *
 * Both invariants live in `describe.skip("[RED] ...")` blocks: the fix PR
 * wires `planProviderRetry` into the cli.ts FAIL path and removes `.skip`.
 *
 * Imports only symbols that exist today (the production dead code +
 * `classifyProviderFailure` + the `SubAgentResult` type + the cli.ts
 * source). No real LLM, no network, no spawn. Fake clock via the
 * shared sleepMs spy. See ./README.md for the PIN/RED protocol.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyProviderFailure,
  planProviderRetry,
  nextCapacityBackoffMs,
  PROVIDER_RETRY_SESSION_CAP,
  PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS,
  type ProviderFailureVerdict,
} from "../../halt-event-helpers";
import type { SubAgentResult } from "../../sub-agents";
import { mkTmp } from "./helpers";

// ---------------------------------------------------------------------------
// Deterministic fixtures — no LLM, no network, no spawn.
// ---------------------------------------------------------------------------

/** The canned 529 failure log the FAIL classifier sees on a transient overload. */
const OVERLOAD_LOG = "API Error: 529 Overloaded\nplease retry shortly.";

/**
 * Build a canned SubAgentResult shaped like the orchestrator's role-step
 * output: a 529-overload log + exitCode:1 for a FAIL, or a clean exitCode:0
 * PASS. Mirrors the SubAgentResult fields used by the FAIL path
 * (stdout/exitCode/timedOut/stallKilled/logPath).
 */
function cannedResult(
  kind: "overload" | "pass",
  logPath: string,
): SubAgentResult {
  const fail = kind === "overload";
  return {
    stdout: fail ? OVERLOAD_LOG : "",
    stderr: "",
    exitCode: fail ? 1 : 0,
    timedOut: false,
    stallKilled: false,
    stallSilenceMs: 0,
    exitSignal: null,
    logPath,
    durationMs: 1,
    retries: 0,
  } as SubAgentResult;
}

/**
 * Deterministic, monotone rng so `nextCapacityBackoffMs` jitter is fixed:
 * 0.5 → zero jitter → backoff is exactly base * 2^(attempt-1).
 */
const zeroJitterRng = () => 0.5;

/**
 * A faithful model of the DESIRED FAIL-path retry loop: spawn the role,
 * on a capacity/overloaded verdict consult `planProviderRetry`, sleep the
 * returned backoff and re-spawn until PASS or until the planner says halt.
 * This is the loop the production FAIL path must contain; A1 is RED because
 * cli.ts does NOT contain it (it dead-halts after classifying).
 *
 * Returns the observable contract: outcome, the per-attempt sleeps, and the
 * final providerRetryAttempts counter.
 */
function runDesiredRetryLoop(opts: {
  /** Per-call role result; call index is 0-based. */
  spawn: (call: number) => SubAgentResult;
  sleepMs: (ms: number) => void;
  rng?: () => number;
  /** Hard guard so a wiring bug can't infinite-loop the test. */
  maxCalls?: number;
}): {
  outcome: "completed" | "halted";
  sleeps: number[];
  providerRetryAttempts: number;
  haltReason?: string;
} {
  const sleeps: number[] = [];
  let providerRetryAttempts = 0;
  let capacityAttempt = 0;
  const maxCalls = opts.maxCalls ?? PROVIDER_RETRY_SESSION_CAP + 5;

  for (let call = 0; call < maxCalls; call++) {
    const result = opts.spawn(call);
    // PASS within budget → phase completes.
    if (result.exitCode === 0 && !result.timedOut && !result.stallKilled) {
      return { outcome: "completed", sleeps, providerRetryAttempts };
    }
    // FAIL → classify. A genuine convergence failure (null verdict) is not a
    // provider retry; halt immediately. Capacity/overloaded → consult planner.
    const verdict: ProviderFailureVerdict | null = classifyProviderFailure({
      text: result.stdout + "\n" + result.stderr,
      stallKilled: result.stallKilled,
      timedOut: result.timedOut,
    });
    if (!verdict) {
      return {
        outcome: "halted",
        sleeps,
        providerRetryAttempts,
        haltReason: "convergence",
      };
    }
    capacityAttempt += 1;
    const plan = planProviderRetry({
      verdict,
      capacityAttempt,
      sessionAttempts: providerRetryAttempts,
      rng: opts.rng ?? zeroJitterRng,
    });
    providerRetryAttempts += 1;
    if (plan.halt) {
      return {
        outcome: "halted",
        sleeps,
        providerRetryAttempts,
        haltReason: plan.reason,
      };
    }
    opts.sleepMs(plan.sleepMs);
    sleeps.push(plan.sleepMs);
  }
  return {
    outcome: "halted",
    sleeps,
    providerRetryAttempts,
    haltReason: "maxCalls guard",
  };
}

// cli.ts FAIL-path source — read once for the wiring grep (same pattern as
// feature-start-network-retry.test.ts reads ../cli.ts).
const cliSource = fs.readFileSync(
  path.resolve(import.meta.dir, "../../cli.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Sanity (runs live): the production planner + classifier exist and behave as
// the pure building blocks the wiring needs. These are NOT the gap — they pin
// the seams the fix must consume so a refactor that breaks the planner is
// caught even before the wiring lands. (No assertion here about cli.ts.)
// ---------------------------------------------------------------------------
describe("[PIN] A1 provider-retry building blocks (planner + classifier exist)", () => {
  it("classifies a 529 Overloaded log as a capacity verdict", () => {
    const v = classifyProviderFailure({ text: OVERLOAD_LOG });
    expect(v?.kind).toBe("capacity");
  });

  it("planProviderRetry sleeps a positive backoff for an in-budget capacity verdict", () => {
    const plan = planProviderRetry({
      verdict: { kind: "capacity", evidence: "529 Overloaded" },
      capacityAttempt: 1,
      sessionAttempts: 0,
      rng: zeroJitterRng,
    });
    expect(plan.halt).toBe(false);
    expect(plan.sleepMs).toBeGreaterThan(0);
    // base * 2^0 with zero jitter.
    expect(plan.sleepMs).toBe(nextCapacityBackoffMs(1, zeroJitterRng));
  });

  it("planProviderRetry halts once sessionAttempts hits PROVIDER_RETRY_SESSION_CAP", () => {
    const plan = planProviderRetry({
      verdict: { kind: "capacity", evidence: "529 Overloaded" },
      capacityAttempt: 1,
      sessionAttempts: PROVIDER_RETRY_SESSION_CAP,
      rng: zeroJitterRng,
    });
    expect(plan.halt).toBe(true);
    expect(plan.sleepMs).toBe(-1);
    expect(plan.reason).toContain(String(PROVIDER_RETRY_SESSION_CAP));
  });
});

// ---------------------------------------------------------------------------
// RED #1 — the production wiring. The cli.ts FAIL classification path must
// consult planProviderRetry for a capacity/overloaded verdict and act on its
// decision, instead of dead-halting after recordProviderFailureVerdict.
//
// Today cli.ts does NOT import or call planProviderRetry — the FAIL path runs
// the classifier ladder and then `return "failed"`. This block is RED until
// the planner is wired in. UNSKIP WHEN A1 IS FIXED.
// ---------------------------------------------------------------------------
describe.skip("[RED] A1 provider-capacity-retry-wired (cli FAIL path) — UNSKIP WHEN A1 IS FIXED", () => {
  it("FAIL classification path references planProviderRetry (dead code today)", () => {
    // Same static-grep idiom feature-start-network-retry.test.ts uses to pin
    // that the fetch boundary routes through gitFetchWithRetry. The capacity
    // recovery boundary must route through planProviderRetry.
    expect(cliSource).toMatch(/planProviderRetry\(/);
  });

  it("FAIL path imports planProviderRetry / PROVIDER_RETRY_SESSION_CAP from halt-event-helpers", () => {
    // The planner + session cap must be in scope where the FAIL classifier
    // runs. Today neither symbol appears anywhere in cli.ts.
    expect(cliSource).toMatch(/planProviderRetry/);
    expect(cliSource).toMatch(/PROVIDER_RETRY_SESSION_CAP/);
  });

  it("FAIL path consumes providerRetryAttempts as the session budget", () => {
    // types.ts declares phaseState.providerRetryAttempts (capped at
    // PROVIDER_RETRY_SESSION_CAP) but cli.ts never reads or increments it.
    // The wiring must thread it into planProviderRetry's sessionAttempts.
    expect(cliSource).toMatch(/providerRetryAttempts/);
  });

  it("FAIL path no longer dead-halts a capacity verdict without consulting the backoff planner", () => {
    // Pre-fix shape: classify the verdict, set classified=true, fall straight
    // to `return "failed"` with no backoff sleep / re-spawn between. Post-fix
    // a capacity/overloaded verdict reaches the planProviderRetry seam before
    // any terminal `return "failed"`. Anchor on the planner being present in
    // the same source that owns the FAIL ladder.
    const classifierRungs = cliSource.indexOf(
      "GSTACK_DISABLE_PROVIDER_CLASSIFIER",
    );
    expect(classifierRungs).toBeGreaterThan(-1);
    expect(cliSource).toMatch(/planProviderRetry/);
  });
});

// ---------------------------------------------------------------------------
// RED #2 — the observable recovery contract. Drives the REAL planProviderRetry
// through a faithful respawn loop (the loop the FAIL path must contain) with a
// sleepMs spy + deterministic rng + canned 529 SubAgentResults. The contract
// these assertions pin is currently UNREACHABLE from the orchestrator because
// no production loop calls planProviderRetry. UNSKIP WHEN A1 IS FIXED.
// ---------------------------------------------------------------------------
describe.skip("[RED] A1 provider-capacity recovery contract (backoff + bounded retry) — UNSKIP WHEN A1 IS FIXED", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkTmp("gstack-a1-");
    logPath = path.join(tmp, "role.log");
    fs.writeFileSync(logPath, OVERLOAD_LOG);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a clean PASS within budget completes the phase (no halt, no sleep)", () => {
    // First 2 calls 529-overload, 3rd call PASS — recovery succeeds.
    const slept: number[] = [];
    const out = runDesiredRetryLoop({
      spawn: (call) => cannedResult(call < 2 ? "overload" : "pass", logPath),
      sleepMs: (ms) => slept.push(ms),
      rng: zeroJitterRng,
    });
    expect(out.outcome).toBe("completed");
    // Two transient failures → two backoff sleeps before the PASS.
    expect(out.providerRetryAttempts).toBe(2);
    expect(slept.length).toBe(2);
    for (const ms of slept) expect(ms).toBeGreaterThan(0);
  });

  it("each capacity retry sleeps the backoff schedule (growing, jitter-free)", () => {
    // Three 529s then PASS — sleeps follow nextCapacityBackoffMs for attempts 1..3.
    const slept: number[] = [];
    const out = runDesiredRetryLoop({
      spawn: (call) => cannedResult(call < 3 ? "overload" : "pass", logPath),
      sleepMs: (ms) => slept.push(ms),
      rng: zeroJitterRng,
    });
    expect(out.outcome).toBe("completed");
    const expected = [
      nextCapacityBackoffMs(1, zeroJitterRng),
      nextCapacityBackoffMs(2, zeroJitterRng),
      nextCapacityBackoffMs(3, zeroJitterRng),
    ];
    expect(slept).toEqual(expected);
    // Strictly growing (doubling) within the per-attempt backoff budget.
    expect(slept[1]).toBeGreaterThan(slept[0]);
    expect(slept[2]).toBeGreaterThan(slept[1]);
    // Per-attempt cap is honored — no 4th retry is even attempted here.
    expect(PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS).toBe(3);
  });

  it("halt fires ONLY after PROVIDER_RETRY_SESSION_CAP failures, not before", () => {
    // Always-529: the session cap bounds the churn. The loop must NOT halt
    // before the cap, and MUST halt at it.
    const slept: number[] = [];
    const out = runDesiredRetryLoop({
      spawn: () => cannedResult("overload", logPath),
      sleepMs: (ms) => slept.push(ms),
      rng: zeroJitterRng,
    });
    expect(out.outcome).toBe("halted");
    // providerRetryAttempts is incremented for every classified capacity
    // failure, including the one that trips the cap; it must reach the cap
    // and not exceed it.
    expect(out.providerRetryAttempts).toBe(PROVIDER_RETRY_SESSION_CAP);
    expect(out.providerRetryAttempts).not.toBeLessThan(
      PROVIDER_RETRY_SESSION_CAP,
    );
    // The halt reason names the session cap, not a generic convergence fail.
    expect(out.haltReason).toContain(String(PROVIDER_RETRY_SESSION_CAP));
  });

  it("a genuine convergence failure (no provider banner) halts immediately — does NOT consume the retry budget", () => {
    // Negative control: the retry loop must not turn a real red into endless
    // capacity retries. A null verdict halts on the first failure.
    const slept: number[] = [];
    const out = runDesiredRetryLoop({
      spawn: () =>
        ({
          stdout: "GATE FAIL\nThe test pins behavior that is not implemented.",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          stallKilled: false,
          stallSilenceMs: 0,
          exitSignal: null,
          logPath,
          durationMs: 1,
          retries: 0,
        }) as SubAgentResult,
      sleepMs: (ms) => slept.push(ms),
      rng: zeroJitterRng,
    });
    expect(out.outcome).toBe("halted");
    expect(out.haltReason).toBe("convergence");
    expect(out.providerRetryAttempts).toBe(0);
    expect(slept.length).toBe(0);
  });
});
