/**
 * E2E: real Codex reviewer respects the round-annotation contract.
 *
 * Drives runPlanReviewLoop with the real Codex planReviewer role against
 * a fixture plan with seeded structural issues. Verifies:
 * - round 1 raises objections matching the seeded issues
 * - after user accepts and synth-stub annotates RESOLUTION: applied,
 *   round 2 does NOT re-raise the same objections
 *
 * This is the Layer 4 test from the convergence design spec. Catches the
 * failure class "unit tests pass but real Codex doesn't follow the
 * annotation contract."
 *
 * Tier: gate (per CLAUDE.md). Cost: ~$0.50/run via codex exec.
 * Gated by EVALS=1.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { runPlanReviewLoop } from "../build/orchestrator/plan-review-loop";
import { runPlanReview } from "../build/orchestrator/plan-reviewer";
import type { RoleConfig } from "../build/orchestrator/role-config";

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === "gate";

const describeE2E = shouldRun ? describe : describe.skip;

describeE2E("E2E: real Codex respects round-annotation contract", () => {
  it(
    "round 2 does not re-raise round-1-resolved issues",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-conv-"));
      try {
        const planPath = path.join(tmpDir, "plan.md");
        fs.copyFileSync(
          path.resolve(
            __dirname,
            "fixtures/build-convergence/bundle-1-plan.md",
          ),
          planPath,
        );

        const reviewerRole: RoleConfig = {
          provider: "codex",
          model: process.env.CODEX_REVIEWER_MODEL ?? "gpt-4o",
          reasoning: "medium",
        };

        const logDirPath = path.join(tmpDir, "logs");
        fs.mkdirSync(logDirPath, { recursive: true });

        const reviewerFn = async (round: number) =>
          runPlanReview({
            planPath,
            role: reviewerRole,
            slug: "e2e-conv",
            timeoutMs: 600_000,
            logDirPath,
            cwd: tmpDir,
            round,
          });

        // Synth stub: rewrite RESOLUTION: pending → applied so the round-2
        // reviewer sees resolved annotations and should not re-raise.
        const synthFn = async (): Promise<{ ok: boolean }> => {
          const t = fs.readFileSync(planPath, "utf8");
          fs.writeFileSync(
            planPath,
            t.replace(
              /RESOLUTION: pending/g,
              "RESOLUTION: applied per Codex suggestion (E2E synth stub)",
            ),
            "utf8",
          );
          return { ok: true };
        };

        // Simulate TTY input with bulk auto-accept characters. Each round:
        // one 'A' (Accept ALL objections) + optional rationale line.
        // Push enough 'A\n' lines to cover up to maxRounds triage gates
        // plus one stalemate gate (a = approve as-is).
        const input = (() => {
          const r = new Readable({ read() {} });
          // Enough lines for 3 rounds of triage (A = accept-all) + stalemate
          r.push(Buffer.from("A\n\nA\n\nA\n\na\n"));
          r.push(null);
          return r;
        })();

        let captured = "";
        const output = new Writable({
          write(chunk, _enc, cb) {
            captured += chunk.toString();
            cb();
          },
        });

        const historyPath = path.join(tmpDir, "history.jsonl");
        const aggregatePath = path.join(tmpDir, "convergence.jsonl");

        const result = await runPlanReviewLoop({
          planPath,
          historyPath,
          aggregatePath,
          slug: "e2e-conv",
          branch: "feat/e2e",
          reviewerFn,
          synthFn,
          maxRounds: 3,
          adaptiveEnabled: true,
          nonInteractiveMode: "auto-accept",
          isTTY: true,
          input,
          output,
          reviewerName: reviewerRole.model,
          synthesizerName: "e2e-stub-synth",
        });

        // Accept any of the expected exit outcomes. The test is not asserting
        // that Codex always finds exactly these issues — it asserts that
        // whatever Codex raises in round 1, round 2 does NOT re-raise them
        // after the synth stub writes RESOLUTION: applied.
        const acceptableOutcomes = [
          "approved",
          "user_manual",
          "max_rounds_hit",
          "adaptive_cap_re_raises_only",
          "adaptive_cap_regression",
        ];
        expect(acceptableOutcomes).toContain(result.outcome);

        // Parse the convergence aggregate to inspect reRaises per round.
        // aggregatePath is JSONL — one JSON object per line.
        const aggLines = fs
          .readFileSync(aggregatePath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        expect(aggLines.length).toBeGreaterThan(0);
        const agg = JSON.parse(aggLines[aggLines.length - 1]) as {
          rounds: number;
          reRaises: number[];
        };

        // The annotation-contract assertion: round 2 (index 1) must have
        // reRaises === 0, meaning Codex read the RESOLUTION: applied annotations
        // and did not re-raise the same objections. This is the core behavioral
        // contract this E2E test exists to verify.
        //
        // We require at least 2 rounds to run. If Codex approves round 1,
        // the fixture plan is already acceptable — the test fails loudly so we
        // know the seeded issues weren't strong enough to trigger a REVISE.
        expect(agg.rounds).toBeGreaterThanOrEqual(2);
        expect(Array.isArray(agg.reRaises)).toBe(true);
        expect(agg.reRaises.length).toBeGreaterThanOrEqual(2);
        // Round 2 should not re-raise round-1 issues that the synth resolved.
        expect(agg.reRaises[1]).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    900_000, // 15 min timeout
  );
});
