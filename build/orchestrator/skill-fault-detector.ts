/**
 * Skill fault detector — scans build state, plan files, and run artifacts
 * for well-known failure modes so the orchestrator can report them.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BuildState } from "./types";
import {
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_MAX_TEST_ITERATIONS,
} from "./phase-runner";

export interface DetectorInput {
  state: BuildState | null;
  livingPlanPath: string;
  worktreePath: string;
  stateDir: string;
  stdoutLogPath: string;
}

export interface SkillFault {
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  description: string;
  sourceFiles: string[];
  evidence: {
    phaseIndex?: number;
    iterationCount?: number;
    stateValue?: string;
    planReviewRound?: number;
  };
}

export type LearnedMatcherKind =
  | "stdout_contains"
  | "stdout_regex"
  | "failureReason_contains"
  | "failureReason_regex"
  | "plan_contains"
  | "plan_regex";

export interface LearnedPattern {
  category: string; // UPPER_SNAKE_CASE, unique key
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  description: string;
  matcherKind: LearnedMatcherKind;
  pattern: string; // literal string or JS regex string — never eval'd
  source: string; // "investigator:<report-filename>"
  learnedAt: string; // ISO 8601
  hitCount: number; // incremented each time this pattern fires
}

const CHECKED_IMPLEMENTATION_RE =
  /^\s*-\s+\[[xX]\]\s+\*\*Implementation(?:\s+\([^*\n]*\))?\*\*/m;
const CHECKED_REVIEW_QA_RE =
  /^\s*-\s+\[[xX]\]\s+\*\*Review & QA(?:\s+\([^*\n]*\))?\*\*/m;

function appendAnalytics(faults: SkillFault[]): void {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  const analyticsDir = path.join(home, "analytics");
  const analyticsPath = path.join(analyticsDir, "skill-faults.jsonl");
  try {
    fs.mkdirSync(analyticsDir, { recursive: true });
    const line =
      JSON.stringify({ ts: new Date().toISOString(), faults }) + "\n";
    fs.appendFileSync(analyticsPath, line, "utf8");
  } catch {
    // Swallow analytics failures — must not block fault return.
  }
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const LEARNED_PATTERNS_PATH = (): string => {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults", "learned-patterns.json");
};

/**
 * Load learned fault patterns from disk.
 * Returns [] on missing file, malformed JSON, or any I/O error.
 */
export function loadLearnedPatterns(): LearnedPattern[] {
  try {
    const raw = fs.readFileSync(LEARNED_PATTERNS_PATH(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const VALID_MATCHER_KINDS = new Set<string>([
      "stdout_contains",
      "stdout_regex",
      "failureReason_contains",
      "failureReason_regex",
      "plan_contains",
      "plan_regex",
    ]);
    const VALID_SEVERITIES = new Set<string>(["CRITICAL", "HIGH", "MEDIUM"]);
    return parsed.filter(
      (entry): entry is LearnedPattern =>
        entry != null &&
        typeof entry.category === "string" &&
        entry.category.trim() !== "" && // FIXME: does not enforce UPPER_SNAKE_CASE; bash M3.6 Phase 2 does
        typeof entry.severity === "string" &&
        VALID_SEVERITIES.has(entry.severity) &&
        typeof entry.description === "string" &&
        entry.description.trim() !== "" &&
        typeof entry.matcherKind === "string" &&
        VALID_MATCHER_KINDS.has(entry.matcherKind) &&
        typeof entry.pattern === "string" &&
        entry.pattern.trim() !== "",
    );
  } catch {
    return [];
  }
}

function applyLearnedPattern(
  lp: LearnedPattern,
  input: DetectorInput,
  planContent: string | null,
  stdoutContent: string | null,
): boolean {
  try {
    switch (lp.matcherKind) {
      case "stdout_contains":
        return stdoutContent?.includes(lp.pattern) ?? false;
      case "stdout_regex":
        return new RegExp(lp.pattern).test(stdoutContent ?? "");
      case "failureReason_contains":
        return (input.state?.failureReason ?? "").includes(lp.pattern);
      case "failureReason_regex":
        return new RegExp(lp.pattern).test(input.state?.failureReason ?? "");
      case "plan_contains":
        return planContent?.includes(lp.pattern) ?? false;
      case "plan_regex":
        return new RegExp(lp.pattern).test(planContent ?? "");
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Detect faults using learned patterns loaded from disk.
 * Never throws — bad inputs return [].
 */
export function detectLearnedFaults(
  input: DetectorInput,
  staticCategories: Set<string>,
  patterns: LearnedPattern[],
  planContent: string | null,
  stdoutContent: string | null,
): SkillFault[] {
  if (!patterns || patterns.length === 0) return [];
  try {
    const faults: SkillFault[] = [];
    for (const lp of patterns) {
      if (staticCategories.has(lp.category)) continue;
      if (applyLearnedPattern(lp, input, planContent, stdoutContent)) {
        faults.push({
          category: lp.category,
          severity: lp.severity,
          description: "[learned] " + lp.description,
          sourceFiles: [],
          evidence: {},
        });
      }
    }
    return faults;
  } catch {
    return [];
  }
}

function persistHitCounts(learnedFaultCategories: string[]): void {
  if (learnedFaultCategories.length === 0) return;
  try {
    const filePath = LEARNED_PATTERNS_PATH();
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (
        entry != null &&
        typeof entry.category === "string" &&
        learnedFaultCategories.includes(entry.category)
      ) {
        entry.hitCount =
          (typeof entry.hitCount === "number" ? entry.hitCount : 0) + 1;
      }
    }
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Swallow all errors — must not block fault return.
  }
}

/**
 * Detect skill faults from build state and run artifacts.
 * Never throws — bad inputs are handled gracefully.
 */
export function detectSkillFaults(
  input: DetectorInput,
  learnedPatterns?: LearnedPattern[],
): SkillFault[] {
  const faults: SkillFault[] = [];
  const state = input?.state ?? null;

  if (!state) {
    return faults;
  }

  try {
    // ------------------------------------------------------------------
    // CODEX_CONVERGENCE & TEST_FIXER_LOOP
    // ------------------------------------------------------------------
    if (state && Array.isArray(state.phases)) {
      for (const phase of state.phases) {
        if (
          phase.codexReview &&
          typeof phase.codexReview.iterations === "number" &&
          phase.codexReview.iterations >= DEFAULT_MAX_CODEX_ITERATIONS
        ) {
          faults.push({
            category: "CODEX_CONVERGENCE",
            severity: "HIGH",
            description: `Codex review did not converge after ${phase.codexReview.iterations} iterations (limit ${DEFAULT_MAX_CODEX_ITERATIONS}).`,
            sourceFiles: [],
            evidence: {
              phaseIndex: phase.index,
              iterationCount: phase.codexReview.iterations,
            },
          });
        }

        if (
          phase.testFix &&
          typeof phase.testFix.iterations === "number" &&
          phase.testFix.iterations >= DEFAULT_MAX_TEST_ITERATIONS
        ) {
          faults.push({
            category: "TEST_FIXER_LOOP",
            severity: "HIGH",
            description: `Test-fix loop did not converge after ${phase.testFix.iterations} iterations (limit ${DEFAULT_MAX_TEST_ITERATIONS}).`,
            sourceFiles: [],
            evidence: {
              phaseIndex: phase.index,
              iterationCount: phase.testFix.iterations,
            },
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // PREMATURE_COMPLETION — checked checkboxes for non-committed phases
    // ------------------------------------------------------------------
    const planContent = readFileSafe(input.livingPlanPath);
    const stdoutContent = readFileSafe(input.stdoutLogPath);
    if (planContent && state && Array.isArray(state.phases)) {
      // Split into phase blocks
      const blocks = planContent.split(/(?=### Phase)/);
      let phaseIdx = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block.startsWith("### Phase")) continue;

        const phaseState = state.phases[phaseIdx];
        phaseIdx++;
        if (!phaseState) continue;
        if (phaseState.status === "committed") continue;

        const hasCheckedImpl = CHECKED_IMPLEMENTATION_RE.test(block);
        const hasCheckedReview = CHECKED_REVIEW_QA_RE.test(block);

        if (hasCheckedImpl || hasCheckedReview) {
          faults.push({
            category: "PREMATURE_COMPLETION",
            severity: "MEDIUM",
            description: `Phase ${phaseState.number || i + 1} has checked task(s) but status is '${phaseState.status}', not 'committed'.`,
            sourceFiles: [input.livingPlanPath],
            evidence: { phaseIndex: phaseState.index ?? phaseIdx - 1 },
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // PLAN_SYNTHESIS_INVALID — missing Origin trace: or Acceptance:
    // ------------------------------------------------------------------
    if (planContent) {
      const blocks = planContent.split(/(?=### Phase)/);
      let phaseIdx = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block.startsWith("### Phase")) continue;
        phaseIdx++;

        const hasOrigin = block.includes("Origin trace:");
        const hasAcceptance = block.includes("Acceptance:");

        if (!hasOrigin || !hasAcceptance) {
          faults.push({
            category: "PLAN_SYNTHESIS_INVALID",
            severity: "CRITICAL",
            description: `Phase block ${phaseIdx} is missing ${!hasOrigin && !hasAcceptance ? "Origin trace: and Acceptance:" : !hasOrigin ? "Origin trace:" : "Acceptance:"}.`,
            sourceFiles: [input.livingPlanPath],
            evidence: {},
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // WORKTREE_LEAK
    // ------------------------------------------------------------------
    if (state && state.completed === true && dirExists(input.worktreePath)) {
      faults.push({
        category: "WORKTREE_LEAK",
        severity: "MEDIUM",
        description: `Build is completed but worktree directory still exists at ${input.worktreePath}.`,
        sourceFiles: [],
        evidence: {},
      });
    }

    // ------------------------------------------------------------------
    // RED_SPEC_TRIVIAL
    // ------------------------------------------------------------------
    if (state && state.failureReason) {
      const reason = state.failureReason;
      if (
        reason.includes("trivially") ||
        reason.includes("without implementation")
      ) {
        faults.push({
          category: "RED_SPEC_TRIVIAL",
          severity: "MEDIUM",
          description: `Tests passed trivially without implementation: ${reason}`,
          sourceFiles: [],
          evidence: { stateValue: reason },
        });
      }
    }

    // ------------------------------------------------------------------
    // PLAN_MUTATOR_MISMATCH
    // ------------------------------------------------------------------
    if (state && state.failureReason) {
      const reason = state.failureReason;
      if (reason.includes("line not found") || reason.includes("checkbox")) {
        faults.push({
          category: "PLAN_MUTATOR_MISMATCH",
          severity: "HIGH",
          description: `Plan mutator could not locate expected content: ${reason}`,
          sourceFiles: [],
          evidence: {},
        });
      }
    }

    // ------------------------------------------------------------------
    // PLAN_REVIEW_STALEMATE
    // ------------------------------------------------------------------
    const reportPath = path.join(input.stateDir, "plan-review-report.json");
    const reportRaw = readFileSafe(reportPath);
    if (reportRaw) {
      try {
        const report = JSON.parse(reportRaw) as {
          round?: number;
          objections?: Array<{ severity?: string }>;
        };
        const round = typeof report.round === "number" ? report.round : 0;
        const hasCritical = Array.isArray(report.objections)
          ? report.objections.some((o) => o && o.severity === "CRITICAL")
          : false;
        if (round >= 3 && hasCritical) {
          faults.push({
            category: "PLAN_REVIEW_STALEMATE",
            severity: "CRITICAL",
            description: `Plan review is stalled at round ${round} with unresolved CRITICAL objections.`,
            sourceFiles: [reportPath],
            evidence: { planReviewRound: round },
          });
        }
      } catch {
        // Malformed JSON — ignore silently.
      }
    }

    // ------------------------------------------------------------------
    // FEATURE_VERIFIER_SCOPE
    // ------------------------------------------------------------------
    if (stdoutContent && stdoutContent.includes("VERIFICATION: GAPS")) {
      faults.push({
        category: "FEATURE_VERIFIER_SCOPE",
        severity: "HIGH",
        description: "Feature verifier reported gaps in feature coverage.",
        sourceFiles: [input.stdoutLogPath],
        evidence: {},
      });
    }

    // ------------------------------------------------------------------
    // LEARNED PATTERNS — dynamic patterns from learned-patterns.json
    // ------------------------------------------------------------------
    const staticCategories = new Set(faults.map((f) => f.category));
    const learnedFaults = detectLearnedFaults(
      input,
      staticCategories,
      learnedPatterns ?? [],
      planContent,
      stdoutContent,
    );
    faults.push(...learnedFaults);
    if (learnedFaults.length > 0) {
      persistHitCounts(learnedFaults.map((f) => f.category));
    }
  } catch {
    // Outer safety net: never throw on bad input.
  }

  if (faults.length > 0) {
    appendAnalytics(faults);
  }

  return faults;
}
