/**
 * Regression tests for Bug A — FEATURE_REDO findings injection.
 *
 * Bug ref:
 *   ~/.gstack/skill-faults/manual-1779768463981/MANUAL_INVESTIGATION:0:b335a492.md
 *   ~/.gstack/skill-faults/manual-1779766926082/MANUAL_INVESTIGATION:0:efe61aab.md
 * Plan ref: ~/.claude/plans/fix-orchestrator-mitosis-oasis-may-26-faults.md
 *
 * Three behavioral guarantees:
 *
 *   T-A1: resetPhaseStateForRedo with featureReviewOutputPath persists
 *         the path on phase state; without the option clears it.
 *   T-A2: When phaseState.pendingFeatureReviewOutputPath is set and the
 *         dispatch wrapper reads it, buildGeminiPromptBody includes a
 *         "## Previous review findings" block (via the existing 4-arg
 *         signature that already supports prompt-injection defenses).
 *   T-A3: applyResult(RUN_GEMINI) clears pendingFeatureReviewOutputPath
 *         from the next-state regardless of result success/failure.
 *   T-A4: Missing/unreadable findings path triggers a graceful fallback
 *         to the no-findings prompt (no crash).
 *   T-A5 (static-grep wiring): the FEATURE_REDO dispatch block at
 *         cli.ts:7480-7510 passes outputFilePath to
 *         resetPhaseStateForRedo, so a future refactor cannot silently
 *         regress to the no-findings reset.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildGeminiPromptBody,
  resetPhaseStateForRedo,
} from "../cli";
import { applyResult } from "../phase-runner";
import type { BuildState, Phase, PhaseState } from "../types";

function mkPhaseState(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1.1",
    name: "demo",
    status: "pending",
    ...overrides,
  };
}

function mkState(phases: PhaseState[]): BuildState {
  return {
    slug: "test-slug",
    branch: "main",
    planFile: "/tmp/plan.md",
    phases,
    completed: false,
    lastUpdatedAt: new Date().toISOString(),
  } as unknown as BuildState;
}

describe("Bug A — resetPhaseStateForRedo persists feature-review path", () => {
  it("T-A1a: with featureReviewOutputPath option sets the field", () => {
    const ps = mkPhaseState({
      status: "committed",
      committedSha: "abc1234",
      committedAt: "2026-05-26T00:00:00Z",
    });
    const state = mkState([ps]);
    resetPhaseStateForRedo(state, 0, {
      featureReviewOutputPath: "/tmp/feature-1-review-1-output.md",
    });
    expect(state.phases[0].status).toBe("pending");
    expect(state.phases[0].pendingFeatureReviewOutputPath).toBe(
      "/tmp/feature-1-review-1-output.md",
    );
    expect(state.phases[0].committedSha).toBeUndefined();
    expect(state.phases[0].committedAt).toBeUndefined();
  });

  it("T-A1b: without the option clears any prior pending path (no stale bleed)", () => {
    const ps = mkPhaseState({
      pendingFeatureReviewOutputPath: "/tmp/old-stale-findings.md",
      status: "committed",
    });
    const state = mkState([ps]);
    resetPhaseStateForRedo(state, 0); // 2-arg form
    expect(state.phases[0].status).toBe("pending");
    expect(state.phases[0].pendingFeatureReviewOutputPath).toBeUndefined();
  });

  it("T-A1c: explicit undefined option also clears the field", () => {
    const ps = mkPhaseState({
      pendingFeatureReviewOutputPath: "/tmp/old.md",
    });
    const state = mkState([ps]);
    resetPhaseStateForRedo(state, 0, {});
    expect(state.phases[0].pendingFeatureReviewOutputPath).toBeUndefined();
  });
});

describe("Bug A — buildGeminiPromptBody injects findings block when threaded", () => {
  const phase: Phase = {
    index: 0,
    number: "1.1",
    name: "demo",
    body: "Phase body here.",
    auditOnly: false,
  } as unknown as Phase;

  it("T-A2a: without reviewFeedback, no findings block present", () => {
    const out = buildGeminiPromptBody(phase, "/tmp/plan.md", "main");
    expect(out).not.toContain("## Previous review findings");
    expect(out).not.toContain("NO_CHANGES_NEEDED");
  });

  it("T-A2b: with reviewFeedback, findings block + NO_CHANGES_NEEDED sentinel present", () => {
    const findings = "## VERDICT: FEATURE_REDO\nFinding 1: foo bar baz";
    const out = buildGeminiPromptBody(phase, "/tmp/plan.md", "main", findings);
    expect(out).toContain("## Previous review findings");
    expect(out).toContain("NO_CHANGES_NEEDED");
    // Prompt-injection defenses must be present (existing behavior).
    expect(out).toContain("UNTRUSTED");
    expect(out).toContain("REVIEW_FEEDBACK_BEGIN");
    expect(out).toContain("REVIEW_FEEDBACK_END");
  });
});

describe("Bug A — applyResult clears pendingFeatureReviewOutputPath on RUN_GEMINI", () => {
  const mockResult = (overrides: Partial<any> = {}) => ({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stallKilled: false,
    logPath: "/tmp/log.log",
    durationMs: 1000,
    retries: 0,
    ...overrides,
  });

  it("T-A3a: success clears the field", () => {
    const ps = mkPhaseState({
      pendingFeatureReviewOutputPath: "/tmp/findings.md",
      status: "pending",
    });
    const next = applyResult(
      ps,
      { type: "RUN_GEMINI", iteration: 1 } as any,
      mockResult() as any,
      { outputFilePath: "/tmp/out.md" } as any,
    );
    expect(next.status).toBe("impl_done");
    expect(next.pendingFeatureReviewOutputPath).toBeUndefined();
  });

  it("T-A3b: failure (exit != 0) also clears the field", () => {
    const ps = mkPhaseState({
      pendingFeatureReviewOutputPath: "/tmp/findings.md",
      status: "pending",
    });
    const next = applyResult(
      ps,
      { type: "RUN_GEMINI", iteration: 1 } as any,
      mockResult({ exitCode: 1 }) as any,
      { outputFilePath: "/tmp/out.md" } as any,
    );
    expect(next.status).toBe("failed");
    expect(next.pendingFeatureReviewOutputPath).toBeUndefined();
  });

  it("T-A3c: timeout also clears the field", () => {
    const ps = mkPhaseState({
      pendingFeatureReviewOutputPath: "/tmp/findings.md",
      status: "pending",
    });
    const next = applyResult(
      ps,
      { type: "RUN_GEMINI", iteration: 1 } as any,
      mockResult({ timedOut: true }) as any,
      { outputFilePath: "/tmp/out.md" } as any,
    );
    expect(next.status).toBe("failed");
    expect(next.pendingFeatureReviewOutputPath).toBeUndefined();
  });
});

describe("Bug A — file-read fallback graceful path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-findings-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("T-A4a: a real findings file is readable and contributes contents to prompt", () => {
    const findingsPath = path.join(tmpDir, "feature-1-review-1-output.md");
    fs.writeFileSync(
      findingsPath,
      "## VERDICT: FEATURE_REDO\nMissing fix for ordering bug",
    );
    const phase: Phase = {
      index: 0,
      number: "1.1",
      name: "demo",
      body: "Phase body.",
      auditOnly: false,
    } as unknown as Phase;
    const content = fs.readFileSync(findingsPath, "utf8");
    const out = buildGeminiPromptBody(phase, "/tmp/plan.md", "main", content);
    expect(out).toContain("Missing fix for ordering bug");
  });

  it("T-A4b: cli.ts dispatch reads the findings file via try/catch (graceful on missing file)", () => {
    // Static-grep wiring guard: the dispatch site MUST wrap the read in
    // try/catch so a missing file (deleted between FEATURE_REDO and the
    // next impl call) produces a warning, not a crash. Adversarial review
    // flagged that T-A5 only checks the field is read, not that the read
    // is guarded. Search from the local-variable declaration which only
    // appears at the dispatch site.
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const content = fs.readFileSync(cliPath, "utf-8");
    const start = content.indexOf("let pendingFeatureFindings");
    expect(start).toBeGreaterThan(0);
    const block = content.slice(start, start + 2500);
    expect(block).toContain("fs.readFileSync");
    expect(block).toMatch(/try\s*{/);
    expect(block).toMatch(/catch\s*\(/);
    // Warning text must name the path so operators can diagnose.
    expect(block).toMatch(/failed to read findings/);
  });

  it("T-A4c: cli.ts dispatch validates the path is in slug scope (path-traversal guard)", () => {
    // Adversarial review finding: state.json is operator-editable, so
    // pendingFeatureReviewOutputPath is untrusted at read time. A
    // tampered path like ~/.ssh/id_rsa could be slurped into the impl
    // prompt and exfiltrated to the Gemini API. The dispatch MUST call
    // validateLogPathInScope before reading. Search from the local
    // variable declaration which only appears at the dispatch site
    // (NOT at the field-declaration comment in resetPhaseStateForRedo).
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const content = fs.readFileSync(cliPath, "utf-8");
    const start = content.indexOf("let pendingFeatureFindings");
    expect(start).toBeGreaterThan(0);
    const block = content.slice(start, start + 2500);
    expect(block).toContain("validateLogPathInScope");
    expect(block).toContain("FINDINGS_MAX_BYTES");
    expect(block).toMatch(/out of slug scope/);
  });
});

describe("Bug A — static-grep wiring guards", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  let cliContent: string;

  beforeEach(() => {
    cliContent = fs.readFileSync(cliPath, "utf-8");
  });

  it("T-A5a: FEATURE_REDO dispatch passes outputFilePath to resetPhaseStateForRedo", () => {
    // Find the FEATURE_REDO branch.
    const start = cliContent.indexOf('verdict.verdict === "FEATURE_REDO"');
    expect(start).toBeGreaterThan(0);
    const end = cliContent.indexOf(
      "FEATURE_NEEDS_PHASES",
      start,
    );
    expect(end).toBeGreaterThan(start);
    const block = cliContent.slice(start, end);
    expect(block).toMatch(/resetPhaseStateForRedo\([^)]*,\s*i\s*,/);
    expect(block).toContain("featureReviewOutputPath");
    expect(block).toContain("outputFilePath");
  });

  it("T-A5b: RUN_GEMINI dispatch reads pendingFeatureReviewOutputPath and threads to buildGeminiPromptBody", () => {
    const start = cliContent.indexOf('action.type === "RUN_GEMINI"');
    expect(start).toBeGreaterThan(0);
    // Locate the next major action block — RUN_GEMINI_FROM_REVIEW is the
    // immediate successor for primary-impl rerun.
    const end = cliContent.indexOf(
      'action.type === "RUN_GEMINI_FROM_REVIEW"',
      start,
    );
    expect(end).toBeGreaterThan(start);
    const block = cliContent.slice(start, end);
    expect(block).toContain("pendingFeatureReviewOutputPath");
    expect(block).toContain("pendingFeatureFindings");
    // The findings must be threaded into buildGeminiPromptBody as the
    // 4th argument — not just read and discarded.
    expect(block).toMatch(/buildGeminiPromptBody\([^)]*pendingFeatureFindings/s);
  });

  it("T-A5c: applyResult RUN_GEMINI branch deletes pendingFeatureReviewOutputPath", () => {
    const phaseRunnerPath = path.resolve(
      import.meta.dir,
      "../phase-runner.ts",
    );
    const content = fs.readFileSync(phaseRunnerPath, "utf-8");
    const start = content.indexOf('action.type === "RUN_GEMINI"');
    expect(start).toBeGreaterThan(0);
    const end = content.indexOf(
      'action.type === "RUN_CODEX_REVIEW"',
      start,
    );
    expect(end).toBeGreaterThan(start);
    const block = content.slice(start, end);
    expect(block).toContain("pendingFeatureReviewOutputPath");
    expect(block).toMatch(/delete[^;]*pendingFeatureReviewOutputPath/);
  });
});
