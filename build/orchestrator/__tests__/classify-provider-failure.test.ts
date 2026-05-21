import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyProviderFailure,
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
