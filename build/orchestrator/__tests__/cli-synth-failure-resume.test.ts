/**
 * Pins the restart-storm guard: on resume, cli.ts refuses to re-run plan
 * review when a prior session left state.planReview.status === "synth_failure"
 * or "synth_failure_stalemate". It emits a STALEMATE stdout event, promotes
 * the status, and throws ExitError(3) — breaking the restart storm at its
 * source rather than silently bypassing the review gate.
 *
 * Single-round model: synth-check / revision failures persist "synth_failure"
 * (exit 1); the guard catches that status on the NEXT run. The deleted
 * multi-round loop used to own "synth_failure_stalemate"; the guard now owns it.
 *
 * See ~/.claude/plans/fix-plan-review-loop-stalemate-restart-storm.md Bug B.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const PLAN_REVIEW_ANCHOR =
  "// Plan review: single-round second-opinion pass before Phase 1 of";

describe("synth_failure resume guard", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const content = fs.readFileSync(cliPath, "utf-8");

  it("declares the stalemate guard BEFORE the plan-review launch if", () => {
    const guardIdx = content.indexOf("Stalemate guard:");
    const loopIfIdx = content.indexOf(PLAN_REVIEW_ANCHOR);
    expect(guardIdx).toBeGreaterThan(0);
    expect(loopIfIdx).toBeGreaterThan(guardIdx);
  });

  it("guard refuses both synth_failure AND synth_failure_stalemate statuses", () => {
    const guardStart = content.indexOf("Stalemate guard:");
    const guardEnd = content.indexOf(PLAN_REVIEW_ANCHOR, guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = content.slice(guardStart, guardEnd);
    expect(guard).toContain('status === "synth_failure"');
    expect(guard).toContain('status === "synth_failure_stalemate"');
    expect(guard).toContain("throw new ExitError(3)");
    expect(guard).toContain('event: "STALEMATE"');
  });

  it("keeps only critical_exit_pending + user_aborted in the resume-retry list (not synth_failure)", () => {
    const loopIfStart = content.indexOf(PLAN_REVIEW_ANCHOR);
    const loopIfEnd = content.indexOf(") {", loopIfStart) + 3;
    const loopIfBlock = content.slice(loopIfStart, loopIfEnd);
    expect(loopIfBlock).toContain('"critical_exit_pending"');
    expect(loopIfBlock).toContain('"user_aborted"');
    // synth_failure MUST NOT auto-retry via the gate — the guard handles it.
    expect(loopIfBlock).not.toContain('"synth_failure"');
  });

  it("the guard (not the exit-3 handler) owns synth_failure_stalemate; exit-3 records critical_exit_pending", () => {
    // Single-round model: the plan-review exit-3 path is a CRITICAL dispute
    // under non-TTY fail-fast → critical_exit_pending. synth_failure_stalemate
    // is produced only by the Stalemate guard promoting a prior synth_failure.
    const guardStart = content.indexOf("Stalemate guard:");
    const guardEnd = content.indexOf(PLAN_REVIEW_ANCHOR, guardStart);
    const guard = content.slice(guardStart, guardEnd);
    expect(guard).toContain('status: "synth_failure_stalemate"');
    expect(guard).toContain("throw new ExitError(3)");

    const exitThreeStart = content.indexOf("if (reviewResult.exitCode === 3)");
    expect(exitThreeStart).toBeGreaterThan(0);
    const exitThreeBlock = content.slice(
      exitThreeStart,
      content.indexOf("if (reviewResult.exitCode === 4)"),
    );
    expect(exitThreeBlock).toContain('"critical_exit_pending"');
    expect(exitThreeBlock).not.toContain("synth_failure_stalemate");
  });

  it("emits STALEMATE event with reason field for telemetry", () => {
    const guardStart = content.indexOf("Stalemate guard:");
    const guardEnd = content.indexOf(PLAN_REVIEW_ANCHOR, guardStart);
    const guard = content.slice(guardStart, guardEnd);
    expect(guard).toContain('"synth_failure_promoted_on_resume"');
    expect(guard).toContain('"synth_failure_stalemate_carried_over"');
  });
});
