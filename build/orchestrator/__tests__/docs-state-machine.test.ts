/**
 * Drift guard for docs/orchestrator-state-machine.md.
 *
 * Every PhaseStatus and FeatureStatus union member must be mentioned by
 * name in the doc. If the union grows without a doc update, this test
 * fails — the spec gets out of sync the moment a new status appears,
 * which is exactly when future debuggers most need an accurate spec.
 *
 * Not a content-quality check; a presence-only check. Detailed prose
 * review is a human concern, not an automated one.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "orchestrator-state-machine.md",
);

// Hard-coded copies of the union members. Keep these in lockstep with
// build/orchestrator/types.ts when the unions change — this test is
// the lockstep enforcer.
const PHASE_STATUSES = [
  "pending",
  "test_spec_running",
  "test_spec_done",
  "tests_red",
  "gemini_running",
  "impl_done",
  "test_fix_running",
  "tests_green",
  "codex_running",
  "review_clean",
  "committed",
  "failed",
  "dual_impl_running",
  "dual_impl_done",
  "dual_tests_running",
  "dual_judge_pending",
  "dual_judge_running",
  "dual_winner_pending",
] as const;

const FEATURE_STATUSES = [
  "pending",
  "running",
  "phases_done",
  "feature_review_pending",
  "feature_review_running",
  "feature_redo_pending",
  "feature_blocked",
  "shipping",
  "release_queued",
  "landed",
  "origin_verifying",
  "origin_verified",
  "committed",
  "failed",
  "paused",
] as const;

describe("docs/orchestrator-state-machine.md drift guard (T9)", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  for (const status of PHASE_STATUSES) {
    it(`PhaseStatus "${status}" is mentioned in the doc`, () => {
      // Match the status as a backtick-wrapped identifier — `failed`,
      // `pending`, etc. This avoids false matches against prose like
      // "pending review" or "running test."
      expect(doc).toContain(`\`${status}\``);
    });
  }

  for (const status of FEATURE_STATUSES) {
    it(`FeatureStatus "${status}" is mentioned in the doc`, () => {
      expect(doc).toContain(`\`${status}\``);
    });
  }

  it("references the recovery escape hatch", () => {
    expect(doc).toContain("markPhaseCommittedAfterManualRecovery");
    expect(doc).toContain("--mark-phase-committed");
  });

  it("references the Bug 1 / Bug 2 fix points", () => {
    expect(doc).toContain("phaseGateProjection");
    expect(doc).toContain("reconcilePhaseVisibleGates");
    // The "undefined = no opinion" semantic is core to the contract.
    expect(doc).toContain("undefined");
  });

  it("references the Bug 5 hygiene-gate fix points", () => {
    expect(doc).toContain("maybeAutoCommitTestOnlyDirty");
    expect(doc).toContain("GSTACK_QA_NO_AUTO_COMMIT");
  });

  it("references the Bug 6 --stop-run subcommand", () => {
    expect(doc).toContain("--stop-run");
    expect(doc).toContain("runStopRun");
  });
});
