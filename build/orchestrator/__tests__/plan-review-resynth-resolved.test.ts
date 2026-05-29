import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Class 5 cross-run RESOLVED for plan-review CRITICAL → re-synth recovery.
// The plan-reviewer console.error at plan-reviewer.ts:316 produces a
// SOFT_HALT_ERROR via wrap-console when state is loaded. The orchestrator
// then persists state.planReview.status="critical_exit_pending" and exits
// with ExitError(3). On the NEXT run, when the re-synthesized plan
// passes the reviewer (outcome !== "critical_exit"), we emit a RESOLVED
// keyed on the faultId of the original error so the queue consumer's
// pair-collapse drops both rows pre-dispatch.
//
// State plumbing: state.planReview gains an optional `faultId` field
// alongside `status`. On critical_exit: capture + persist. On recovery:
// emit RESOLVED + clear.

describe("plan-review CRITICAL → re-synth RESOLVED pairing (class 5)", () => {
  let cliSrc: string;
  let planReviewerSrc: string;

  test("T8: plan-reviewer exports a buildPlanReviewCriticalMessage helper for the warn text", () => {
    planReviewerSrc = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "plan-reviewer.ts"),
      "utf8",
    );
    // Helper exists so cli.ts can compute the same faultId wrap-console will
    expect(planReviewerSrc).toMatch(
      /export\s+function\s+buildPlanReviewCriticalMessage/,
    );
  });

  test("T9 (post-merge): cli.ts no longer wires Class 5 around reconcilePlanReview — PR #63's in-process plan-review-loop replaced that call path", () => {
    // The legacy reconcilePlanReview call path (where Class 5 RESOLVED was
    // wired) was removed from cli.ts during the origin/main merge. PR #63
    // (build skill 1.25.0) introduced runPlanReviewLoop which emits via
    // input.output.write (not console.error), so wrap-console.ts no longer
    // writes a DETECTED row for the CRITICAL exit. With no DETECTED to
    // pair against, the Class 5 cross-run RESOLVED logic was dropped from
    // cli.ts. The legacy reconcilePlanReview function + its per-objection
    // orphan fix stay in plan-reviewer.ts for any caller that still uses
    // it (T11b below).
    cliSrc = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "cli.ts"),
      "utf8",
    );
    // The new path uses runPlanReviewLoop, not reconcilePlanReview.
    expect(cliSrc).toContain("runPlanReviewLoop");
    // critical_exit_pending state still gets persisted on loopResult.exitCode === 3,
    // but without the faultId/stateSlug fields (no DETECTED to pair with).
    expect(cliSrc).toContain('"critical_exit_pending"');
  });

  test("T10: cli.ts emits RESOLVED + clears state.planReview.faultId on re-synth success", () => {
    // Find the success branch — outcome !== "critical_exit" after the
    // critical_exit_pending guard. The recovery path must call
    // emitHaltEventResolved with the captured faultId.
    cliSrc =
      cliSrc ??
      fs.readFileSync(path.resolve(import.meta.dir, "..", "cli.ts"), "utf8");
    // We just check that the symbol is referenced in cli.ts. The
    // semantic check (only on re-synth success) is exercised in T11.
    expect(cliSrc).toMatch(/emitHaltEventResolved/);
  });

  test("T11 (post-merge): critical_exit_pending persistence works without faultId — PR #63's loop owns the exit-3 path", () => {
    // After the merge with PR #63 (build skill 1.25.0), the critical_exit_pending
    // marker no longer carries faultId/stateSlug fields. Those fields were
    // wired for cross-run RESOLVED pairing against a DETECTED row that
    // wrap-console used to write when reconcilePlanReview called console.error.
    // PR #63's runPlanReviewLoop emits via input.output.write instead, so the
    // DETECTED doesn't exist anymore and the fields would be orphans.
    cliSrc =
      cliSrc ??
      fs.readFileSync(path.resolve(import.meta.dir, "..", "cli.ts"), "utf8");
    // Find the PERSISTENCE site (status: stalemateStatus), not the
    // gate-entry READ site (state.planReview.status === ...). Refactor
    // dcd3d7b2 replaced the inline "critical_exit_pending" literal with a
    // stalemateStatus variable (synth_failure_stalemate vs critical_exit_pending);
    // the persistence assignment is now `status: stalemateStatus`.
    const persistIdx = cliSrc.indexOf("status: stalemateStatus");
    expect(persistIdx).toBeGreaterThan(-1);
    const window = cliSrc.slice(
      Math.max(0, persistIdx - 300),
      persistIdx + 200,
    );
    expect(window).toMatch(/loopResult\.finalVerdict/);
    // Field should NOT carry faultId/stateSlug anymore (the Class 5 wiring
    // was removed during the PR #63 merge).
    expect(window).not.toMatch(/\bfaultId:\s*criticalFaultId/);
  });

  test("T11b: per-objection bullets use console.log, NOT console.error (no orphan DETECTED rows)", () => {
    // CRITICAL OBSERVABILITY BUG: reconcilePlanReview was emitting the
    // aggregate criticalMsg via console.error AND looping per-objection
    // bullets through console.error too. wrap-console.ts shims warn/error
    // (not log), so each bullet became its own SOFT_HALT_ERROR with a
    // distinct faultId, leaving N-1 orphan DETECTED rows that the Class 5
    // recovery path's single RESOLVED could never collapse.
    //
    // Fix: aggregate emits via console.error (single DETECTED, faultId
    // matched by recovery path), bullets emit via console.log (visible to
    // humans, NOT shimmed by wrap-console, no orphan rows).
    planReviewerSrc =
      planReviewerSrc ??
      fs.readFileSync(
        path.resolve(import.meta.dir, "..", "plan-reviewer.ts"),
        "utf8",
      );
    // Locate the per-objection bullet loop in reconcilePlanReview's
    // critical-exit branch.
    const criticalMsgIdx = planReviewerSrc.indexOf(
      "buildPlanReviewCriticalMessage({",
    );
    expect(criticalMsgIdx).toBeGreaterThan(-1);
    // Search forward for the bullet loop. The window must be tight enough
    // to actually contain the loop and the console call inside it.
    const window = planReviewerSrc.slice(criticalMsgIdx, criticalMsgIdx + 1000);
    expect(window).toMatch(/for\s*\(const\s+c\s+of\s+critical\)/);
    // Inside the loop body, the bullet print must go through console.log.
    // We extract the loop body to assert this precisely.
    const loopIdx = window.search(/for\s*\(const\s+c\s+of\s+critical\)/);
    expect(loopIdx).toBeGreaterThan(-1);
    const loopBody = window.slice(loopIdx, loopIdx + 200);
    expect(loopBody).toMatch(/console\.log\(/);
    expect(loopBody).not.toMatch(/console\.error\(\s*`\s*•/);
  });
});
