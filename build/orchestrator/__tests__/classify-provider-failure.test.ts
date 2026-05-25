import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyProviderFailure,
  countSubprocessRetryAttempts,
  parseRoleLogFailureEvidence,
  recordProviderFailureVerdict,
} from "../halt-event-helpers";
import { loadPendingInvestigations } from "../halt-events";

describe("classifyProviderFailure (PR1b)", () => {
  test("capacity banner — MODEL_CAPACITY_EXHAUSTED", () => {
    const v = classifyProviderFailure({
      text: "Error: MODEL_CAPACITY_EXHAUSTED — try again in a few seconds.",
    });
    expect(v?.kind).toBe("capacity");
    expect(v?.evidence).toContain("MODEL_CAPACITY_EXHAUSTED");
  });

  test("capacity banner — 529 Overloaded matches capacity (precedence)", () => {
    const v = classifyProviderFailure({
      text: "API Error: 529 Overloaded\nplease retry shortly.",
    });
    expect(v?.kind).toBe("capacity");
  });

  test("overloaded banner — plain 529", () => {
    const v = classifyProviderFailure({
      text: "got HTTP 529 Overloaded from upstream provider",
    });
    expect(v?.kind).toBe("overloaded");
  });

  test("quota banner — You've hit your limit", () => {
    const v = classifyProviderFailure({
      text: "You've hit your weekly limit. Try again next Monday.",
    });
    expect(v?.kind).toBe("quota");
  });

  test("quota banner with resetAt", () => {
    const v = classifyProviderFailure({
      text: "You've hit your limit · resets at 10am",
    });
    expect(v?.kind).toBe("quota");
    expect(v?.resetAt).toMatch(/10am/i);
  });

  test("transport error — ECONNRESET", () => {
    const v = classifyProviderFailure({
      text: "node: read ECONNRESET while reading response body",
    });
    expect(v?.kind).toBe("transport");
  });

  test("auth required — 401 Unauthorized", () => {
    const v = classifyProviderFailure({
      text: "401 Unauthorized — refresh credentials and try again",
    });
    expect(v?.kind).toBe("auth");
  });

  test("stall (no banner, stallKilled=true)", () => {
    const v = classifyProviderFailure({
      text: "",
      stallKilled: true,
    });
    expect(v?.kind).toBe("stall");
  });

  test("stall (no banner, timedOut=true)", () => {
    const v = classifyProviderFailure({
      text: "",
      timedOut: true,
    });
    expect(v?.kind).toBe("stall");
  });

  test("role log footer — stall_killed exit 0 still classifies as stall", () => {
    const log = [
      "# ---- result ----",
      "# timed_out: true",
      "# stall_killed: true",
      "# stall_silence_ms: 120000",
      "# exit: 0",
      "# stdout_bytes: 0",
      "# stderr_bytes: 0",
    ].join("\n");
    const evidence = parseRoleLogFailureEvidence(log);
    expect(evidence.stallKilled).toBe(true);
    expect(evidence.exit).toBe("0");
    const v = classifyProviderFailure({ text: log });
    expect(v?.kind).toBe("stall");
  });

  test("role log footer — timed_out true without banner classifies as stall", () => {
    const log = [
      "# ---- result ----",
      "# timed_out: true",
      "# stall_killed: false",
      "# stall_silence_ms: 0",
      "# exit: SIGTERM",
      "# stdout_bytes: 0",
      "# stderr_bytes: 0",
    ].join("\n");
    const v = classifyProviderFailure({ text: log });
    expect(v?.kind).toBe("stall");
  });

  test("genuine convergence failure → null", () => {
    const v = classifyProviderFailure({
      text: "GATE FAIL\n\nThe test pins production behavior that is not yet implemented.",
    });
    expect(v).toBeNull();
  });

  test("auth precedence: auth wins even with stall flags", () => {
    const v = classifyProviderFailure({
      text: "401 Unauthorized",
      stallKilled: true,
    });
    expect(v?.kind).toBe("auth");
  });

  test("quota precedence: quota wins over capacity in same blob", () => {
    const v = classifyProviderFailure({
      text: "You've hit your limit. (Note: MODEL_CAPACITY_EXHAUSTED was the underlying error.)",
    });
    expect(v?.kind).toBe("quota");
  });
});

describe("recordProviderFailureVerdict — emits correct halt kind", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr1b-emit-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function fixture() {
    const stdoutLog = path.join(tmp, "stdout.log");
    fs.writeFileSync(stdoutLog, "");
    return {
      state: {
        slug: "pr1b-test",
        phases: [{ index: 0, number: 1, status: "running" } as any],
      } as any,
      ctx: {
        runId: "pr1b-test-run",
        stateSlug: "pr1b-test",
        pointers: {
          stateFile: path.join(tmp, "state.json"),
          stdoutLog,
          livingPlan: path.join(tmp, "plan.md"),
          worktreePath: tmp,
        },
        queueDir: path.join(tmp, "queue"),
      },
    };
  }

  test("capacity → PROVIDER_OVERLOADED halt", () => {
    const { state, ctx } = fixture();
    recordProviderFailureVerdict(
      state,
      0,
      "codex-review",
      { kind: "capacity", evidence: "MODEL_CAPACITY_EXHAUSTED" },
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: ctx.queueDir });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_OVERLOADED");
  });

  test("quota → PROVIDER_QUOTA_EXHAUSTED with resetAt", () => {
    const { state, ctx } = fixture();
    recordProviderFailureVerdict(
      state,
      0,
      "codex-review",
      { kind: "quota", evidence: "You've hit your limit", resetAt: "10am" },
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: ctx.queueDir });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(pending[0].message).toContain("resets at 10am");
  });

  test("transport → PROVIDER_TRANSPORT_ERROR halt", () => {
    const { state, ctx } = fixture();
    recordProviderFailureVerdict(
      state,
      0,
      "codex-review",
      { kind: "transport", evidence: "ECONNRESET" },
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: ctx.queueDir });
    expect(pending[0].kind).toBe("PROVIDER_TRANSPORT_ERROR");
  });

  test("auth → PROVIDER_AUTH_REQUIRED halt", () => {
    const { state, ctx } = fixture();
    recordProviderFailureVerdict(
      state,
      0,
      "codex-review",
      { kind: "auth", evidence: "401 Unauthorized" },
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: ctx.queueDir });
    expect(pending[0].kind).toBe("PROVIDER_AUTH_REQUIRED");
  });

  test("stall → PROVIDER_TIMEOUT halt", () => {
    const { state, ctx } = fixture();
    recordProviderFailureVerdict(
      state,
      0,
      "codex-review",
      { kind: "stall", evidence: "watchdog timeout" },
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: ctx.queueDir });
    expect(pending[0].kind).toBe("PROVIDER_TIMEOUT");
  });
});

// ---------------------------------------------------------------------------
// countSubprocessRetryAttempts — Bug 7 (simclaw 2026-05-23
// provider-timeout-misreported-as-codex-retry-cap)
// ---------------------------------------------------------------------------
describe("countSubprocessRetryAttempts", () => {
  test("returns 0 for empty / undefined / non-matching input", () => {
    expect(countSubprocessRetryAttempts("")).toBe(0);
    expect(countSubprocessRetryAttempts("nothing to see here")).toBe(0);
    expect(countSubprocessRetryAttempts("Attempt success")).toBe(0);
  });

  test("counts Gemini retryWithBackoff lines (Attempt N/M failed)", () => {
    const log = [
      "Attempt 1/5 failed: MODEL_CAPACITY_EXHAUSTED",
      "sleeping 2000ms",
      "Attempt 2/5 failed: MODEL_CAPACITY_EXHAUSTED",
      "sleeping 4000ms",
      "Attempt 3/5 failed: MODEL_CAPACITY_EXHAUSTED",
    ].join("\n");
    expect(countSubprocessRetryAttempts(log)).toBe(3);
  });

  test("counts generic 'Attempt N failed' without /M suffix", () => {
    const log =
      "Attempt 1 failed: HTTP 529\nbackoff\nAttempt 2 failed: HTTP 529";
    expect(countSubprocessRetryAttempts(log)).toBe(2);
  });

  test("does NOT match prose like 'in this Attempt 1 failed something'", () => {
    // The leading `in this ` puts non-whitespace before Attempt — the regex
    // anchors at line-start (after optional whitespace), so this should not match.
    expect(
      countSubprocessRetryAttempts(
        "Some narrative in this Attempt 1 failed analysis...",
      ),
    ).toBe(0);
  });

  test("case-insensitive", () => {
    expect(countSubprocessRetryAttempts("attempt 1 failed: noisy")).toBe(1);
    expect(countSubprocessRetryAttempts("ATTEMPT 2/3 FAILED: x")).toBe(1);
  });

  test("parseRoleLogFailureEvidence surfaces subprocessRetryAttempts", () => {
    const log = [
      "# timed_out: false",
      "# stall_killed: true",
      "# exit: null",
      "Attempt 1/5 failed: capacity",
      "Attempt 2/5 failed: capacity",
    ].join("\n");
    const evidence = parseRoleLogFailureEvidence(log);
    expect(evidence.stallKilled).toBe(true);
    expect(evidence.subprocessRetryAttempts).toBe(2);
  });
});
