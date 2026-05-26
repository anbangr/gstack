/**
 * Pins Fix B: cli.ts refuses to auto-retry plan-review-loop when prior
 * session left state.planReview.status === "synth_failure" or
 * "synth_failure_stalemate". The first occurrence triggers a STALEMATE
 * stdout event, promotes the status, and throws ExitError(3). This breaks
 * the restart storm at its source.
 *
 * See ~/.claude/plans/fix-plan-review-loop-stalemate-restart-storm.md
 * Bug B for the full failure chain.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Fix B: synth_failure resume guard", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const content = fs.readFileSync(cliPath, "utf-8");

  it("declares the stalemate guard BEFORE the plan-review-loop-launch if", () => {
    // Locate the guard and the loop launcher.
    const guardIdx = content.indexOf("Stalemate guard:");
    const loopIfIdx = content.indexOf(
      "// Plan review: second-opinion pass before Phase 1 of Feature 1.",
    );
    expect(guardIdx).toBeGreaterThan(0);
    expect(loopIfIdx).toBeGreaterThan(guardIdx);
  });

  it("guard refuses both synth_failure AND synth_failure_stalemate statuses", () => {
    // Extract the guard block (between "Stalemate guard:" and the next blank-comment boundary).
    const guardStart = content.indexOf("Stalemate guard:");
    const guardEnd = content.indexOf(
      "// Plan review: second-opinion pass",
      guardStart,
    );
    const guard = content.slice(guardStart, guardEnd);
    expect(guard).toContain('status === "synth_failure"');
    expect(guard).toContain('status === "synth_failure_stalemate"');
    expect(guard).toContain('throw new ExitError(3)');
    expect(guard).toContain('event: "STALEMATE"');
  });

  it("removes synth_failure from the resume-retry list", () => {
    // The original retry condition included synth_failure. Find the new
    // condition and verify only critical_exit_pending and user_aborted
    // remain as auto-retry triggers (synth_failure is handled by the guard).
    const loopIfStart = content.indexOf(
      "// Plan review: second-opinion pass",
    );
    const loopIfEnd = content.indexOf(") {", loopIfStart) + 3;
    const loopIfBlock = content.slice(loopIfStart, loopIfEnd);
    expect(loopIfBlock).toContain('"critical_exit_pending"');
    expect(loopIfBlock).toContain('"user_aborted"');
    // synth_failure MUST NOT appear in the retry condition anymore.
    expect(loopIfBlock).not.toContain('"synth_failure"');
  });

  it("the new exit-3 handler records synth_failure_stalemate status when loop returns synth_failure_stalemate outcome", () => {
    // Verify the routing logic from loopResult.outcome → state.planReview.status.
    const exitThreeStart = content.indexOf(
      "if (loopResult.exitCode === 3)",
    );
    expect(exitThreeStart).toBeGreaterThan(0);
    const exitThreeEnd = content.indexOf("if (loopResult.exitCode === 4)");
    const exitThreeBlock = content.slice(exitThreeStart, exitThreeEnd);
    expect(exitThreeBlock).toContain(
      'loopResult.outcome === "synth_failure_stalemate"',
    );
    // The status is computed into a variable; verify both the variable
    // declaration and the assignment-to-state pattern.
    expect(exitThreeBlock).toMatch(/"synth_failure_stalemate"/);
    expect(exitThreeBlock).toMatch(/status:\s*stalemateStatus/);
  });

  it("emits STALEMATE event with reason field for telemetry", () => {
    const guardStart = content.indexOf("Stalemate guard:");
    const guardEnd = content.indexOf(
      "// Plan review: second-opinion pass",
      guardStart,
    );
    const guard = content.slice(guardStart, guardEnd);
    // Two reason variants depending on whether status was already stalemate
    // or got promoted on this resume.
    expect(guard).toContain('"synth_failure_promoted_on_resume"');
    expect(guard).toContain('"synth_failure_stalemate_carried_over"');
  });
});
