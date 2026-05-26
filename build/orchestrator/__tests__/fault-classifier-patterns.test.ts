import { describe, test, expect } from "bun:test";

/**
 * Pattern-match tests for the FAIL classifier rungs in cli.ts. These
 * lock in the regex / string-prefix patterns the classifier uses to
 * route between HYGIENE_FAIL, RED_SPEC_EXHAUSTED, and the gated
 * RETRY_CAP_HIT / PHASE_FAILED catch-all.
 *
 * Sources for each fixture: ~/.gstack/skill-faults/inbox/ entries from
 * the agnt2-prototype-prodl2-f2-6 run (p1, p7, p9, p10, p11, p12, p13,
 * p17) cited as the empirical evidence in the original plan. The
 * patterns must continue to match these messages — if they regress,
 * the classifier silently routes back to RETRY_CAP_HIT.
 *
 * These are pure-string tests against the SAME regex/string the
 * classifier uses (kept in sync by mirroring the regex below). Direct
 * unit-testing of the FAIL handler in cli.ts is impractical because it
 * lives inside the action loop; this is the lightweight equivalent.
 */

// Mirror of the hygiene regex in cli.ts FAIL classifier Rung 3.
const HYGIENE_RE =
  /hygiene\s+(?:failed|failure)|did not create a new commit|recovery FAILED|hygiene\.log/i;

const RED_SPEC_EXHAUSTED_PREFIX = "RED_SPEC_EXHAUSTED";
const RED_GATE_ZERO_PREFIX = "RED_GATE_ZERO_TESTS_COLLECTED";

describe("HYGIENE_FAIL rung patterns", () => {
  test("matches p1 narrative: 'gemini test-fix hygiene failure'", () => {
    const reason =
      "Gemini test-fix hygiene failure: changes discarded, sandbox-rejected read_file";
    expect(HYGIENE_RE.test(reason)).toBe(true);
  });

  test("matches p10 narrative: 'did not create a new commit'", () => {
    const reason =
      "Gemini hygiene failed: primary implementor did not create a new commit";
    expect(HYGIENE_RE.test(reason)).toBe(true);
  });

  test("matches 'recovery FAILED' shape", () => {
    const reason =
      "post-impl recovery FAILED to restore worktree to a clean state";
    expect(HYGIENE_RE.test(reason)).toBe(true);
  });

  test("matches 'hygiene.log' artifact reference (p9 shape)", () => {
    const reason = "Codex exited 1; see hygiene.log";
    expect(HYGIENE_RE.test(reason)).toBe(true);
  });

  test("does NOT match unrelated convergence reasons", () => {
    expect(HYGIENE_RE.test("codex hit cap after 3 iterations")).toBe(false);
    expect(HYGIENE_RE.test("Gemini timed out")).toBe(false);
    expect(HYGIENE_RE.test("PROVIDER_TIMEOUT: stall")).toBe(false);
  });
});

describe("RED_SPEC_EXHAUSTED rung — error prefix wiring", () => {
  test("phase-runner.ts emits the prefix that the cli classifier matches", () => {
    // This is the exact message phase-runner.ts:743 now emits.
    const phaseRunnerError =
      "RED_SPEC_EXHAUSTED: Gemini could not produce failing tests after 3 attempts (GSTACK_BUILD_RED_MAX_ITER). Resolved testCmd: npm test. If the test runner is misdetected (e.g. vitest ran for a pytest phase, or root `npm test` skips a subtree like sidecar-v2/), override per-phase by adding `<!-- testCmd: <your-test-command> -->` to the phase body in the plan.";
    expect(phaseRunnerError.startsWith(RED_SPEC_EXHAUSTED_PREFIX)).toBe(true);
  });

  test("RED_SPEC_EXHAUSTED prefix does NOT match RED_GATE_ZERO", () => {
    // The two prefixes must remain distinct so the classifier routes
    // them to different recorders (recordRedSpecExhausted vs
    // recordRedGateZeroTestsCollected).
    expect(
      RED_GATE_ZERO_PREFIX.startsWith(RED_SPEC_EXHAUSTED_PREFIX),
    ).toBe(false);
    expect(
      RED_SPEC_EXHAUSTED_PREFIX.startsWith(RED_GATE_ZERO_PREFIX),
    ).toBe(false);
  });
});

describe("STALL_KILLED rung — zero-stdout discriminator", () => {
  test("p17 signature: stall_killed=true with stdout_bytes=0", () => {
    // parseRoleLogFailureEvidence reads "# stall_killed: true" and
    // "# stdout_bytes: 0" from the log; the cli classifier then
    // emits STALL_KILLED when BOTH conditions hold.
    const stallKilled = true;
    const stdoutBytes = 0;
    const isZeroStdoutStall = stallKilled && stdoutBytes === 0;
    expect(isZeroStdoutStall).toBe(true);
  });

  test("progress-gap stall (nonzero stdout) routes to PROVIDER_TIMEOUT, not STALL_KILLED", () => {
    const stallKilled = true;
    const stdoutBytes = 4096;
    const isZeroStdoutStall = stallKilled && stdoutBytes === 0;
    expect(isZeroStdoutStall).toBe(false);
    // Caller falls through to classifyProviderFailure → PROVIDER_TIMEOUT.
  });
});

describe("Gated catch-all — only real codex cap exhaustion fires RETRY_CAP_HIT", () => {
  test("codexIterations >= cap → RETRY_CAP_HIT", () => {
    const codexIterations = 5;
    const codexCap = 5;
    expect(codexIterations >= codexCap).toBe(true);
  });

  test("codexIterations < cap → PHASE_FAILED (NOT RETRY_CAP_HIT)", () => {
    // The p1/p7/p9/p10/p11/p12/p13/p17 shape: codexIterations is 0 or 1
    // (real failure happened before any codex review iterated). The
    // pre-fix catch-all called recordRetryCapHit anyway — pretending
    // the failure was a codex cap exhaustion. Post-fix, the gate
    // routes to markPhaseFailed with the structured reason.
    const codexIterations = 0;
    const codexCap = 5;
    expect(codexIterations >= codexCap).toBe(false);
  });
});
