import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as helpers from "../halt-event-helpers";
import { loadPendingInvestigations } from "../halt-events";
import type { BuildState } from "../types";

function freshState(): BuildState {
  return {
    slug: "s1",
    phases: [
      { index: 0, number: 1, status: "running" } as any,
      { index: 1, number: 2, status: "tests_green" } as any,
    ],
    features: [{ number: "1", status: "running" } as any],
  } as any;
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

function helperCtx(tmp: string) {
  return {
    runId: "r1",
    stateSlug: "s1",
    pointers: fixturePaths(tmp),
    queueDir: tmp,
  };
}

describe("halt kind constants (T1)", () => {
  test("PROVIDER_TIMEOUT is exported as a string constant", () => {
    expect(helpers.PROVIDER_TIMEOUT).toBe("PROVIDER_TIMEOUT");
  });

  test("PROVIDER_QUOTA_EXHAUSTED is exported as a string constant", () => {
    expect(helpers.PROVIDER_QUOTA_EXHAUSTED).toBe("PROVIDER_QUOTA_EXHAUSTED");
  });

  test("PROVIDER_OVERLOADED is exported as a string constant", () => {
    expect(helpers.PROVIDER_OVERLOADED).toBe("PROVIDER_OVERLOADED");
  });

  test("PROVIDER_TRANSPORT_ERROR is exported as a string constant", () => {
    expect(helpers.PROVIDER_TRANSPORT_ERROR).toBe("PROVIDER_TRANSPORT_ERROR");
  });

  test("PROVIDER_AUTH_REQUIRED is exported as a string constant", () => {
    expect(helpers.PROVIDER_AUTH_REQUIRED).toBe("PROVIDER_AUTH_REQUIRED");
  });
});

describe("recordProviderTimeout (T2)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ht-timeout-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits PROVIDER_TIMEOUT with role and evidence in the message", () => {
    if (typeof helpers.recordProviderTimeout !== "function") {
      expect(false).toBe(true);
      return;
    }
    const state = freshState();
    const ctx = helperCtx(tmp);
    helpers.recordProviderTimeout(state, 0, "gemini", "no response for 30s", ctx);
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_TIMEOUT");
    expect(pending[0].message).toContain("gemini");
    expect(pending[0].message).toContain("no response for 30s");
    expect(pending[0].severity).toBe("HIGH");
  });
});

describe("recordProviderQuotaExhausted (T3)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ht-quota-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits PROVIDER_QUOTA_EXHAUSTED and message carries resetAt when provided", () => {
    if (typeof helpers.recordProviderQuotaExhausted !== "function") {
      expect(false).toBe(true);
      return;
    }
    const state = freshState();
    const ctx = helperCtx(tmp);
    helpers.recordProviderQuotaExhausted(
      state,
      0,
      "codex",
      "You've hit your limit",
      ctx,
      "10am",
    );
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(pending[0].message).toContain("10am");
    expect(pending[0].severity).toBe("HIGH");
  });

  test("emits without resetAt when omitted", () => {
    if (typeof helpers.recordProviderQuotaExhausted !== "function") {
      expect(false).toBe(true);
      return;
    }
    const state = freshState();
    const ctx = helperCtx(tmp);
    helpers.recordProviderQuotaExhausted(
      state,
      0,
      "codex",
      "You've hit your limit",
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_QUOTA_EXHAUSTED");
  });
});

describe("recordProviderOverloaded", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ht-overload-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits PROVIDER_OVERLOADED with role and evidence", () => {
    if (typeof helpers.recordProviderOverloaded !== "function") {
      expect(false).toBe(true);
      return;
    }
    const state = freshState();
    const ctx = helperCtx(tmp);
    helpers.recordProviderOverloaded(state, 0, "gemini", "529 Overloaded", ctx);
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_OVERLOADED");
    expect(pending[0].message).toContain("gemini");
    expect(pending[0].message).toContain("529 Overloaded");
    expect(pending[0].severity).toBe("HIGH");
  });
});

describe("recordProviderTransportError", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ht-transport-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits PROVIDER_TRANSPORT_ERROR with role and evidence", () => {
    if (typeof helpers.recordProviderTransportError !== "function") {
      expect(false).toBe(true);
      return;
    }
    const state = freshState();
    const ctx = helperCtx(tmp);
    helpers.recordProviderTransportError(
      state,
      0,
      "codex",
      "tls handshake eof",
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_TRANSPORT_ERROR");
    expect(pending[0].message).toContain("codex");
    expect(pending[0].message).toContain("tls handshake eof");
    expect(pending[0].severity).toBe("HIGH");
  });
});

describe("recordProviderAuthRequired", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ht-auth-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits PROVIDER_AUTH_REQUIRED with role and evidence", () => {
    if (typeof helpers.recordProviderAuthRequired !== "function") {
      expect(false).toBe(true);
      return;
    }
    const state = freshState();
    const ctx = helperCtx(tmp);
    helpers.recordProviderAuthRequired(
      state,
      0,
      "gemini",
      "auth status returned non-zero",
      ctx,
    );
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PROVIDER_AUTH_REQUIRED");
    expect(pending[0].message).toContain("gemini");
    expect(pending[0].message).toContain("auth status returned non-zero");
    expect(pending[0].severity).toBe("HIGH");
  });
});

describe("consumer import compatibility", () => {
  test("new kinds can be imported and used in a switch from a consumer context", () => {
    // Simulates what skill-fault-detector.ts will do in Phase 2.
    const kinds = [
      helpers.PROVIDER_TIMEOUT,
      helpers.PROVIDER_QUOTA_EXHAUSTED,
      helpers.PROVIDER_OVERLOADED,
      helpers.PROVIDER_TRANSPORT_ERROR,
      helpers.PROVIDER_AUTH_REQUIRED,
    ];
    for (const kind of kinds) {
      let matched = false;
      switch (kind) {
        case "PROVIDER_TIMEOUT":
        case "PROVIDER_QUOTA_EXHAUSTED":
        case "PROVIDER_OVERLOADED":
        case "PROVIDER_TRANSPORT_ERROR":
        case "PROVIDER_AUTH_REQUIRED":
          matched = true;
          break;
      }
      expect(matched).toBe(true);
    }
  });
});
