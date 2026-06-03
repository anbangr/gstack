/**
 * A1 — provider-capacity-retry-wired  [RED→FIXED]  (build-robustness suite)
 *
 * Group A (provider failures), tier: smoke.
 *
 * THE GAP (confirmed by reading the production code 2026-06-03):
 *   A transient `API Error: 529 Overloaded` / `RESOURCE_EXHAUSTED` mid-build
 *   used to dead-halt a multi-hour build. `planProviderRetry` /
 *   `nextCapacityBackoffMs` were a fully-tested but UNWIRED recovery subsystem
 *   (zero production call sites), and `phaseState.providerRetryAttempts` was a
 *   declared-but-never-written session budget.
 *
 * THE FIX:
 *   `runRoleStepWithProviderRetry(spawnRoleStep, opts)` (sub-agents.ts) is the
 *   third, OUTERMOST provider-retry layer — composed on top of the sub-agent
 *   CLI's own retryWithBackoff/transport retry and runCodexImpl's one-shot
 *   429/403 re-spawn, NOT replacing them. By the time a capacity banner reaches
 *   this seam those inner retries are exhausted, so a persistent overload earns
 *   an escalating backoff (30s → 60s → 120s) instead of killing the build.
 *   Policy is delegated entirely to the pure `planProviderRetry`:
 *     - capacity/overloaded → backoff+respawn, bounded TWO ways:
 *         • per-step: nextCapacityBackoffMs halts after
 *           PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS (3) escalating sleeps; and
 *         • per-phase: sessionAttempts (threaded from
 *           phaseState.providerRetryAttempts) halts at
 *           PROVIDER_RETRY_SESSION_CAP (6) across ALL role steps in the phase.
 *     - auth/quota/transport/stall → halt (no retry): auth/quota won't
 *       self-resolve; transport/stall already had their one-shot inner retry.
 *     - a non-provider failure (real red / gate fail) → handed straight back so
 *       the existing FAIL ladder classifies + halts unchanged.
 *   cli.ts routes the four single-impl LLM dispatch sites (RUN_GEMINI primary,
 *   RUN_GEMINI_FROM_REVIEW re-impl, RUN_GEMINI_TEST_SPEC, RUN_GEMINI_FIX)
 *   through the seam via `capacityRetryOpts(...)`, threading
 *   phaseState.providerRetryAttempts as the running per-phase budget. The seam
 *   is purely additive: on a clean PASS the FAIL path never fires; on any
 *   non-recoverable verdict the failed result is returned and today's behavior
 *   is preserved. A `GSTACK_DISABLE_CAPACITY_RETRY=1` kill switch restores the
 *   pre-fix dead-halt (mirrors GSTACK_DISABLE_PROVIDER_CLASSIFIER).
 *
 *   Deliberately NOT wired in this pass (documented follow-up): the dual-impl
 *   candidates (Promise.all racing a shared session counter + per-iteration
 *   output-path collisions) — dual-impl already has winner-takes-all resilience
 *   so a single 529 doesn't kill it; and the codex-review gates / codex
 *   feature-review paths (lower frequency, separate dispatch fns).
 *
 * WHAT THIS FILE PINS:
 *   RED #1 — the production wiring: the seam exists and calls planProviderRetry
 *     (sub-agents.ts), and cli.ts dispatch sites route through it + thread the
 *     providerRetryAttempts budget + honor the kill switch. (Static-grep idiom,
 *     same as feature-start-network-retry.test.ts.)
 *   RED #2 — the observable recovery contract, driven against the REAL
 *     `runRoleStepWithProviderRetry` with a fake spawn thunk (canned 529s then a
 *     PASS), a sleepMs spy, and zero-jitter rng. This is now a true unit test of
 *     the production seam, not a test-local reconstruction.
 *
 * Note on a corrected assumption: an earlier draft of RED #2 asserted that a
 * single always-529 step halts at PROVIDER_RETRY_SESSION_CAP (6). Reading the
 * real planProviderRetry shows that is wrong — a SINGLE step is bounded first
 * by the per-step backoff cap (3); the session cap (6) governs ACROSS steps in
 * a phase. The tests below pin both bounds correctly (single-step → halts at 3;
 * a step that starts with the budget near the cap → halts at 6).
 *
 * No real LLM, no network, no spawn. Fake clock via the injected sleep spy.
 * See ./README.md for the PIN/RED protocol.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyProviderFailure,
  planProviderRetry,
  nextCapacityBackoffMs,
  PROVIDER_RETRY_SESSION_CAP,
  PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS,
} from "../../halt-event-helpers";
import {
  runRoleStepWithProviderRetry,
  type SubAgentResult,
} from "../../sub-agents";

// ---------------------------------------------------------------------------
// Deterministic fixtures — no LLM, no network, no spawn.
// ---------------------------------------------------------------------------

/** A 529 capacity banner (classifies as kind="capacity"). */
const OVERLOAD_LOG = "API Error: 529 Overloaded\nplease retry shortly.";
/** An auth banner (classifies as kind="auth" — must NOT retry, A3 guard). */
const AUTH_LOG = "authentication required: please run /login";
/** A non-provider failure (no banner → null verdict → hand back to FAIL ladder). */
const GATE_FAIL_LOG =
  "GATE FAIL\nThe test pins behavior that is not implemented.";

type CannedKind = "overload" | "auth" | "gatefail" | "stall" | "pass";

/** Build a canned SubAgentResult shaped like a role-step output. */
function cannedResult(kind: CannedKind): SubAgentResult {
  const base = {
    stderr: "",
    timedOut: false,
    stallKilled: false,
    stallSilenceMs: 0,
    exitSignal: null,
    logPath: "/tmp/a1-role.log",
    durationMs: 1,
    retries: 0,
  };
  switch (kind) {
    case "pass":
      return { ...base, stdout: "", exitCode: 0 } as SubAgentResult;
    case "overload":
      return { ...base, stdout: OVERLOAD_LOG, exitCode: 1 } as SubAgentResult;
    case "auth":
      return { ...base, stdout: AUTH_LOG, exitCode: 1 } as SubAgentResult;
    case "gatefail":
      return { ...base, stdout: GATE_FAIL_LOG, exitCode: 1 } as SubAgentResult;
    case "stall":
      // A stall kill: watchdog fired (kind="stall" → planProviderRetry halts).
      return {
        ...base,
        stdout: "",
        exitCode: null,
        timedOut: true,
        stallKilled: true,
        stallSilenceMs: 120_000,
      } as SubAgentResult;
  }
}

/**
 * A spawn thunk that returns the next kind in `seq`, holding the LAST element
 * once the sequence is exhausted (so [overload,overload,pass] passes on call 3,
 * and [overload] stays overloaded forever).
 */
function sequenceSpawn(seq: CannedKind[]): () => Promise<SubAgentResult> {
  let i = 0;
  return async () => {
    const kind = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return cannedResult(kind);
  };
}

/** Zero-jitter rng so nextCapacityBackoffMs is exactly base * 2^(attempt-1). */
const zeroJitterRng = () => 0.5;

/** Standard test opts: sleep spy + zero jitter. `slept` captures backoff ms. */
function retryOpts(slept: number[], over: Record<string, unknown> = {}) {
  return {
    sessionAttempts: 0,
    sleep: (ms: number) => {
      slept.push(ms);
    },
    rng: zeroJitterRng,
    ...over,
  };
}

// Production sources for the wiring greps.
const cliSource = fs.readFileSync(
  path.resolve(import.meta.dir, "../../cli.ts"),
  "utf-8",
);
const subAgentsSource = fs.readFileSync(
  path.resolve(import.meta.dir, "../../sub-agents.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Sanity (runs live): the pure planner + classifier building blocks the seam
// consumes. A refactor that breaks them is caught even before the seam tests.
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
// RED #1 — the production wiring. The capacity-recovery boundary must route
// through planProviderRetry (in the seam) and cli.ts dispatch sites must call
// the seam, thread phaseState.providerRetryAttempts, and honor the kill switch.
// ---------------------------------------------------------------------------
describe("[RED→FIXED] A1 provider-capacity-retry wired into the dispatch path", () => {
  it("the seam calls planProviderRetry (no longer dead code)", () => {
    // planProviderRetry now has a real call site inside runRoleStepWithProviderRetry.
    expect(subAgentsSource).toMatch(/planProviderRetry\(/);
  });

  it("the seam exists and is bounded by PROVIDER_RETRY_SESSION_CAP", () => {
    expect(subAgentsSource).toMatch(
      /export async function runRoleStepWithProviderRetry/,
    );
    expect(subAgentsSource).toMatch(/PROVIDER_RETRY_SESSION_CAP/);
  });

  it("cli.ts dispatch routes role steps through the capacity-retry seam", () => {
    // Same static-grep idiom feature-start-network-retry.test.ts uses to pin
    // that the boundary routes through the retry helper.
    expect(cliSource).toMatch(/runRoleStepWithProviderRetry\(/);
  });

  it("cli.ts threads providerRetryAttempts as the per-phase session budget", () => {
    // types.ts declared phaseState.providerRetryAttempts but nothing wrote it.
    // The wiring now reads it into the seam and accumulates what each step used.
    expect(cliSource).toMatch(/providerRetryAttempts/);
    expect(cliSource).toMatch(/sessionAttemptsConsumed/);
  });

  it("cli.ts wires the GSTACK_DISABLE_CAPACITY_RETRY kill switch", () => {
    expect(cliSource).toMatch(/GSTACK_DISABLE_CAPACITY_RETRY/);
  });

  it("the FAIL classifier ladder still exists alongside the new dispatch-boundary retry", () => {
    // The seam only intercepts capacity/overloaded at dispatch; every other
    // provider kind still flows to the FAIL ladder, which must remain.
    expect(cliSource).toContain("GSTACK_DISABLE_PROVIDER_CLASSIFIER");
    expect(cliSource).toMatch(/runRoleStepWithProviderRetry\(/);
  });
});

// ---------------------------------------------------------------------------
// RED #2 — the observable recovery contract, driven against the REAL seam.
// ---------------------------------------------------------------------------
describe("[RED→FIXED] A1 provider-capacity recovery contract (real seam)", () => {
  it("a clean PASS within budget completes the step (recovered, no halt)", async () => {
    // Two 529s then a PASS — recovery succeeds.
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload", "overload", "pass"]),
      retryOpts(slept),
    );
    expect(out.halted).toBe(false);
    expect(out.haltReason).toBe("completed");
    expect(out.result.exitCode).toBe(0);
    expect(out.retries).toBe(2);
    expect(out.sessionAttemptsConsumed).toBe(2);
    expect(out.sleptMs.length).toBe(2);
    for (const ms of out.sleptMs) expect(ms).toBeGreaterThan(0);
  });

  it("each capacity retry sleeps the escalating backoff schedule (jitter-free)", async () => {
    // Three 529s then PASS — sleeps follow nextCapacityBackoffMs for 1..3.
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload", "overload", "overload", "pass"]),
      retryOpts(slept),
    );
    expect(out.halted).toBe(false);
    expect(out.sleptMs).toEqual([
      nextCapacityBackoffMs(1, zeroJitterRng),
      nextCapacityBackoffMs(2, zeroJitterRng),
      nextCapacityBackoffMs(3, zeroJitterRng),
    ]);
    expect(out.sleptMs[1]).toBeGreaterThan(out.sleptMs[0]);
    expect(out.sleptMs[2]).toBeGreaterThan(out.sleptMs[1]);
    expect(PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS).toBe(3);
  });

  it("a single always-529 step is bounded by the per-step backoff cap (3), not the session cap", async () => {
    // CORRECTED invariant: a SINGLE step halts after the per-step backoff cap
    // (3 escalating sleeps), NOT after the per-phase session cap (6). The
    // session cap governs across steps (see the next test).
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload"]),
      retryOpts(slept),
    );
    expect(out.halted).toBe(true);
    expect(out.retries).toBe(PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS); // 3
    expect(out.sessionAttemptsConsumed).toBe(
      PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS,
    );
    expect(out.sleptMs.length).toBe(PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS);
    expect(out.haltReason).toContain(
      String(PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS),
    );
    expect(out.result.exitCode).toBe(1);
  });

  it("the per-phase session cap halts a step that starts with the budget nearly spent", async () => {
    // A phase that already burned (cap - 1) provider retries gets exactly ONE
    // more before the session cap fires — proving the budget threads across
    // steps and that the halt reason names the session cap (6), not a per-step
    // backoff exhaustion.
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload"]),
      retryOpts(slept, { sessionAttempts: PROVIDER_RETRY_SESSION_CAP - 1 }),
    );
    expect(out.halted).toBe(true);
    expect(out.sleptMs.length).toBe(1);
    expect(out.sessionAttemptsConsumed).toBe(1);
    expect(out.haltReason).toContain(String(PROVIDER_RETRY_SESSION_CAP));
  });

  it("a step that starts at the session cap halts immediately with zero retries", async () => {
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload"]),
      retryOpts(slept, { sessionAttempts: PROVIDER_RETRY_SESSION_CAP }),
    );
    expect(out.halted).toBe(true);
    expect(out.retries).toBe(0);
    expect(out.sessionAttemptsConsumed).toBe(0);
    expect(out.sleptMs.length).toBe(0);
    expect(out.haltReason).toContain(String(PROVIDER_RETRY_SESSION_CAP));
  });

  it("a genuine convergence failure (no provider banner) is handed back without retry", async () => {
    // Negative control: a real red must NOT become endless capacity retries.
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["gatefail"]),
      retryOpts(slept),
    );
    expect(out.halted).toBe(true);
    expect(out.haltReason).toBe("non-provider failure");
    expect(out.retries).toBe(0);
    expect(out.sessionAttemptsConsumed).toBe(0);
    expect(out.sleptMs.length).toBe(0);
  });

  it("an auth verdict halts without retry (A3 guard: auth never self-resolves)", async () => {
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["auth"]),
      retryOpts(slept),
    );
    expect(out.halted).toBe(true);
    expect(out.retries).toBe(0);
    expect(out.sleptMs.length).toBe(0);
    expect(out.haltReason.toLowerCase()).toContain("auth");
  });

  it("a stall kill halts without retry (stall is not a capacity verdict)", async () => {
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["stall"]),
      retryOpts(slept),
    );
    expect(out.halted).toBe(true);
    expect(out.retries).toBe(0);
    expect(out.sleptMs.length).toBe(0);
    expect(out.haltReason).toContain("stall");
  });

  it("the kill switch returns the first failure unretried (pre-fix behavior)", async () => {
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload"]),
      retryOpts(slept, { disabled: true }),
    );
    expect(out.halted).toBe(true);
    expect(out.haltReason).toBe("capacity-retry disabled");
    expect(out.retries).toBe(0);
    expect(out.sleptMs.length).toBe(0);
    expect(out.result.exitCode).toBe(1);
  });

  it("the per-phase budget accumulates across sequential steps up to the session cap", async () => {
    // The wiring's core value: cli.ts threads the budget across role steps via
    //   phaseState.providerRetryAttempts = (... ?? 0) + _cap.sessionAttemptsConsumed
    // Reproduce that carry-forward across two seam calls and prove a phase
    // can't exceed PROVIDER_RETRY_SESSION_CAP total provider-retry churn — so a
    // `+ →  =` clobber regression in the wiring fails here.
    const slept1: number[] = [];
    const step1 = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload"]),
      retryOpts(slept1, { sessionAttempts: 0 }),
    );
    // Step 1 exhausts its per-step cap (3) starting from an empty budget.
    expect(step1.sessionAttemptsConsumed).toBe(
      PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS,
    );
    // The orchestrator carries that forward as the next step's starting budget.
    const carried = 0 + step1.sessionAttemptsConsumed;
    const slept2: number[] = [];
    const step2 = await runRoleStepWithProviderRetry(
      sequenceSpawn(["overload"]),
      retryOpts(slept2, { sessionAttempts: carried }),
    );
    // Step 2 gets only the remaining budget, then the SESSION cap fires
    // (not a per-step backoff exhaustion) — the halt reason names the cap (6).
    expect(step2.haltReason).toContain(String(PROVIDER_RETRY_SESSION_CAP));
    // Total provider-retry churn across the phase is bounded by the session cap.
    expect(carried + step2.sessionAttemptsConsumed).toBe(
      PROVIDER_RETRY_SESSION_CAP,
    );
  });

  it("a watchdog kill that exits 0 is NOT treated as a PASS (stall guard, not bare exitCode===0)", async () => {
    // The success check is `exitCode === 0 && !timedOut && !stallKilled`. A
    // process the stall watchdog killed can still exit 0 on the way down; the
    // seam must treat that as a failure (classify → stall → halt), not a
    // completion. Pins the !timedOut && !stallKilled clause so a regression to
    // a bare `exitCode === 0` success check fails CI.
    const slept: number[] = [];
    const out = await runRoleStepWithProviderRetry(
      async () => ({ ...cannedResult("stall"), exitCode: 0 }) as SubAgentResult,
      retryOpts(slept),
    );
    expect(out.halted).toBe(true);
    expect(out.haltReason).not.toBe("completed");
    expect(out.haltReason).toContain("stall");
    expect(out.sleptMs.length).toBe(0);
  });
});
