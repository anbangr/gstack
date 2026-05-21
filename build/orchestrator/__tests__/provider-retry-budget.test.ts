import { describe, test, expect } from "bun:test";
import {
  nextCapacityBackoffMs,
  planProviderRetry,
  PROVIDER_CAPACITY_BACKOFF_BASE_MS,
  PROVIDER_CAPACITY_BACKOFF_JITTER_MS,
  PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS,
  PROVIDER_CAPACITY_BACKOFF_MAX_SLEEP_MS,
  PROVIDER_RETRY_SESSION_CAP,
} from "../halt-event-helpers";

describe("nextCapacityBackoffMs (PR1b-part2)", () => {
  // Deterministic rng: returns 0.5 → zero jitter (since rng()*2-1 = 0).
  const noJitter = () => 0.5;

  test("attempt 1: base ± jitter, with no-jitter rng → base", () => {
    expect(nextCapacityBackoffMs(1, noJitter)).toBe(
      PROVIDER_CAPACITY_BACKOFF_BASE_MS,
    );
  });

  test("attempt 2: base*2 with no-jitter rng", () => {
    expect(nextCapacityBackoffMs(2, noJitter)).toBe(
      PROVIDER_CAPACITY_BACKOFF_BASE_MS * 2,
    );
  });

  test("attempt 3: base*4 with no-jitter rng", () => {
    expect(nextCapacityBackoffMs(3, noJitter)).toBe(
      PROVIDER_CAPACITY_BACKOFF_BASE_MS * 4,
    );
  });

  test("attempt 4: -1 (cap exceeded)", () => {
    expect(nextCapacityBackoffMs(4, noJitter)).toBe(-1);
  });

  test("attempt 0: -1 (invalid input)", () => {
    expect(nextCapacityBackoffMs(0, noJitter)).toBe(-1);
  });

  test("jitter applied: rng=0 → minus full jitter; rng=1 → plus near-full jitter", () => {
    const minJitter = () => 0; // rng()*2-1 = -1 → -JITTER
    const maxJitter = () => 0.999999; // rng()*2-1 ≈ +1 → +JITTER
    const lo = nextCapacityBackoffMs(1, minJitter);
    const hi = nextCapacityBackoffMs(1, maxJitter);
    expect(lo).toBe(
      PROVIDER_CAPACITY_BACKOFF_BASE_MS - PROVIDER_CAPACITY_BACKOFF_JITTER_MS,
    );
    // tolerate 1ms drift from floating-point arithmetic
    expect(
      Math.abs(
        hi -
          (PROVIDER_CAPACITY_BACKOFF_BASE_MS +
            PROVIDER_CAPACITY_BACKOFF_JITTER_MS),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("never returns negative when jitter would push it below 0", () => {
    // Construct a hypothetical where base+jitter < 0 cannot happen with the
    // current constants (30000 - 15000 = 15000), but the floor guard exists.
    // We assert the floor by passing rng=0 at attempt 1 — it should equal
    // base - jitter = 15000, not negative.
    const v = nextCapacityBackoffMs(1, () => 0);
    expect(v).toBeGreaterThanOrEqual(0);
  });

  test("clamps to max sleep", () => {
    // Even if we crafted a scenario producing >300_000 (we can't with current
    // constants), the clamp protects future tuning. Sanity-check via the
    // largest legal attempt (3): base*4 = 120_000, well under cap.
    const v = nextCapacityBackoffMs(3, () => 1);
    expect(v).toBeLessThanOrEqual(PROVIDER_CAPACITY_BACKOFF_MAX_SLEEP_MS);
  });
});

describe("planProviderRetry (PR1b-part2)", () => {
  const noJitter = () => 0.5;

  test("auth → halt immediately, no sleep", () => {
    const r = planProviderRetry({
      verdict: { kind: "auth", evidence: "401 Unauthorized" },
      capacityAttempt: 1,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(true);
    expect(r.sleepMs).toBe(-1);
    expect(r.reason).toMatch(/auth/i);
  });

  test("quota → halt immediately, no sleep, reason mentions resetAt", () => {
    const r = planProviderRetry({
      verdict: {
        kind: "quota",
        evidence: "You've hit your limit",
        resetAt: "10am",
      },
      capacityAttempt: 1,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toContain("10am");
  });

  test("capacity attempt 1 → backoff", () => {
    const r = planProviderRetry({
      verdict: { kind: "capacity", evidence: "MODEL_CAPACITY_EXHAUSTED" },
      capacityAttempt: 1,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(false);
    expect(r.sleepMs).toBe(PROVIDER_CAPACITY_BACKOFF_BASE_MS);
  });

  test("capacity attempt > cap → halt with cap-exhausted reason", () => {
    const r = planProviderRetry({
      verdict: { kind: "capacity", evidence: "529 Overloaded" },
      capacityAttempt: PROVIDER_CAPACITY_BACKOFF_MAX_ATTEMPTS + 1,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/exhausted/i);
  });

  test("overloaded behaves identically to capacity", () => {
    const r = planProviderRetry({
      verdict: { kind: "overloaded", evidence: "529" },
      capacityAttempt: 2,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(false);
    expect(r.sleepMs).toBe(PROVIDER_CAPACITY_BACKOFF_BASE_MS * 2);
  });

  test("transport → halt (caller may keep its existing one-shot retry)", () => {
    const r = planProviderRetry({
      verdict: { kind: "transport", evidence: "ECONNRESET" },
      capacityAttempt: 1,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toBe("transport");
  });

  test("stall → halt", () => {
    const r = planProviderRetry({
      verdict: { kind: "stall", evidence: "watchdog kill" },
      capacityAttempt: 1,
      sessionAttempts: 0,
      rng: noJitter,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toBe("stall");
  });

  test("sessionAttempts >= cap halts regardless of verdict kind", () => {
    const r = planProviderRetry({
      verdict: { kind: "capacity", evidence: "MODEL_CAPACITY_EXHAUSTED" },
      capacityAttempt: 1,
      sessionAttempts: PROVIDER_RETRY_SESSION_CAP,
      rng: noJitter,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toContain("session cap");
  });

  test("sessionAttempts at cap-1 still allows one more retry for capacity", () => {
    const r = planProviderRetry({
      verdict: { kind: "capacity", evidence: "MODEL_CAPACITY_EXHAUSTED" },
      capacityAttempt: 1,
      sessionAttempts: PROVIDER_RETRY_SESSION_CAP - 1,
      rng: noJitter,
    });
    expect(r.halt).toBe(false);
  });
});
