import { describe, test, expect } from "bun:test";
import * as helpers from "../halt-event-helpers";
import type { FailureRender } from "../halt-event-helpers";

function baseResult(): any {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stallKilled: false,
    logPath: "/tmp/test.log",
    durationMs: 0,
    retries: 0,
  };
}

describe("renderRoleStepFailure", () => {
  test("T4: stalled — stallKilled true with stallSilenceMs", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const result = helpers.renderRoleStepFailure("gemini", {
      ...baseResult(),
      stallKilled: true,
      stallSilenceMs: 120000,
    }) as FailureRender;
    expect(result.kind).toBe("stalled");
    expect(result.summary).toContain("120000ms");
    expect(result.stallSilenceMs).toBe(120000);
  });

  test("T5: timed_out — timedOut true without stallKilled", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const result = helpers.renderRoleStepFailure("codex", {
      ...baseResult(),
      timedOut: true,
      stallKilled: false,
      durationMs: 600000,
    }) as FailureRender;
    expect(result.kind).toBe("timed_out");
    expect(result.summary).toContain("600000ms");
  });

  test("T6: signal_killed — exitCode null with exitSignal", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const result = helpers.renderRoleStepFailure("gemini", {
      ...baseResult(),
      exitCode: null,
      exitSignal: "SIGTERM",
    }) as FailureRender;
    expect(result.kind).toBe("signal_killed");
    expect(result.signal).toBe("SIGTERM");
  });

  test("T7: auth_required — killReason is auth_required", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const result = helpers.renderRoleStepFailure("gemini", {
      ...baseResult(),
      killReason: "auth_required",
    }) as FailureRender;
    expect(result.kind).toBe("auth_required");
    expect(result.summary).toContain("gemini auth login");
  });

  test("T8: exited — plain non-zero exit code", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const result = helpers.renderRoleStepFailure("codex", {
      ...baseResult(),
      exitCode: 1,
    }) as FailureRender;
    expect(result.kind).toBe("exited");
    expect(result.exitCode).toBe(1);
  });

  test("edge: stalled wins when both stallKilled and timedOut are true", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const result = helpers.renderRoleStepFailure("gemini", {
      ...baseResult(),
      stallKilled: true,
      timedOut: true,
      stallSilenceMs: 90000,
    }) as FailureRender;
    expect(result.kind).toBe("stalled");
  });

  test("edge: helper is pure and side-effect-free", () => {
    if (typeof helpers.renderRoleStepFailure !== "function") {
      expect(false).toBe(true);
      return;
    }
    const input = {
      ...baseResult(),
      exitCode: 0,
      stallKilled: false,
      timedOut: false,
    };
    const before = JSON.stringify(input);
    helpers.renderRoleStepFailure("gemini", input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
