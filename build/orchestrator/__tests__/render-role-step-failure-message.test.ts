/**
 * Tests for renderRoleStepFailureMessage — the wrapper that converts a
 * FailureRender into a single-line human-readable string. Used by
 * phase-runner.ts at all 4 broken sites (test-spec, fix, dual-impl,
 * judge) to replace the legacy "exit ${result.exitCode}" pattern that
 * hid stall kills, signal kills, and interactive auth prompts behind
 * "exit null" / "exit 0".
 *
 * Coverage (CRITICAL R1 regression rule from the tidy-haven plan):
 *   M1: stalled (stallKilled=true)
 *   M2: timed_out (timedOut=true, stallKilled=false)
 *   M3: signal_killed (exitCode=null + exitSignal set)
 *   M4: exited (normal non-zero exit)
 *   M5: auth_required (killReason="auth_required", future-proofing)
 *   M6: role name is interpolated correctly
 */

import { describe, test, expect } from "bun:test";
import { renderRoleStepFailureMessage } from "../halt-event-helpers";

function baseResult(): {
  stallKilled?: boolean;
  stallSilenceMs?: number;
  timedOut?: boolean;
  totalMs?: number;
  durationMs?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  killReason?: string;
} {
  return {
    stallKilled: false,
    timedOut: false,
    exitCode: 0,
    exitSignal: null,
  };
}

describe("renderRoleStepFailureMessage", () => {
  test("M1: stalled — stallKilled produces watchdog message with stallSilenceMs", () => {
    const msg = renderRoleStepFailureMessage("test-spec writer", {
      ...baseResult(),
      stallKilled: true,
      stallSilenceMs: 480000,
    });
    expect(msg).toBe(
      "test-spec writer stalled (no output for 480000ms, killed by watchdog)",
    );
  });

  test("M2: timed_out — timedOut=true without stallKilled uses totalMs/durationMs", () => {
    const msg = renderRoleStepFailureMessage("test-fixer", {
      ...baseResult(),
      timedOut: true,
      stallKilled: false,
      totalMs: 900000,
    });
    expect(msg).toBe("test-fixer timed out after 900000ms wall clock");
  });

  test("M3: signal_killed — exitCode=null + exitSignal set produces clear signal name", () => {
    const msg = renderRoleStepFailureMessage("dual-impl judge", {
      ...baseResult(),
      exitCode: null,
      exitSignal: "SIGTERM",
    });
    expect(msg).toBe("dual-impl judge killed by signal SIGTERM");
  });

  test("M4: exited — normal non-zero exit reports the code", () => {
    const msg = renderRoleStepFailureMessage("dual implementation", {
      ...baseResult(),
      exitCode: 1,
    });
    expect(msg).toBe("dual implementation exited 1");
  });

  test("M5: auth_required — killReason='auth_required' surfaces clear next-step", () => {
    const msg = renderRoleStepFailureMessage("test-spec writer", {
      ...baseResult(),
      killReason: "auth_required",
    });
    expect(msg).toContain("authentication required");
    expect(msg.startsWith("test-spec writer")).toBe(true);
  });

  test("M6: role name is interpolated correctly across all kinds", () => {
    const roleName = "primary-impl";
    const cases = [
      { stallKilled: true, stallSilenceMs: 100 },
      { timedOut: true, totalMs: 200 },
      { exitCode: null, exitSignal: "SIGKILL" },
      { exitCode: 42 },
      { killReason: "auth_required" },
    ];
    for (const c of cases) {
      const msg = renderRoleStepFailureMessage(roleName, {
        ...baseResult(),
        ...c,
      });
      expect(msg.startsWith(roleName)).toBe(true);
    }
  });

  test("M7: precedence — stallKilled wins over exitCode=null+signal", () => {
    // The watchdog kill always populates exitSignal=SIGTERM too. Helper
    // must report "stalled" not "signal_killed" so the stall reason is
    // surfaced to the user. This is the bug fix from the R4 cluster.
    const msg = renderRoleStepFailureMessage("test-spec writer", {
      ...baseResult(),
      stallKilled: true,
      stallSilenceMs: 480000,
      exitCode: null,
      exitSignal: "SIGTERM",
    });
    expect(msg).toContain("stalled");
    expect(msg).toContain("480000ms");
    expect(msg).not.toContain("SIGTERM");
  });

  test("M8: missing optional fields default safely — never crashes", () => {
    // SubAgentResult has stallSilenceMs and exitSignal as optional for
    // back-compat with hygiene-failure and phase-oversized fallbacks
    // that never invoke the watchdog. Helper must handle missing fields.
    const msg = renderRoleStepFailureMessage("test-fixer", {
      timedOut: false,
      stallKilled: false,
      exitCode: 1,
      // stallSilenceMs, exitSignal, killReason all undefined
    });
    expect(msg).toBe("test-fixer exited 1");
  });
});
