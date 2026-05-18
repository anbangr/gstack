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

/**
 * Synthesis-complete sentinel. The planSynthesizer writes this as the last
 * action of producing a living plan, after passing its own structural
 * self-check. The shell wrapper around the synthesizer dispatch appends the
 * sentinel as a safety net when the validator passes but no sentinel is
 * present (see build/SKILL.md.tmpl Step 5).
 *
 * Detector gate: if a living plan exists but the sentinel is absent, treat as
 * "synthesis-in-progress" — emit no PLAN_SYNTHESIS_INVALID faults. Without
 * this gate the detector races the synthesizer and fires false positives on
 * partial files (observed 2026-05-17 in 2/3 drain-faults investigations).
 */
const SYNTHESIS_COMPLETE_SENTINEL = "<!-- gstack-synthesis-complete";

/**
 * Parsed shape of a `## Feature N:` block in a living plan.
 *
 * Single source of truth for "what is a feature block" — consumed by the
 * detector's PLAN_SYNTHESIS_INVALID branch AND by the standalone validator
 * CLI at `build/orchestrator/validate-living-plan.ts`. Drift between the two
 * is structurally impossible because they share this parse.
 */
export interface FeatureBlock {
  /** Parsed integer from "## Feature N:". */
  number: number;
  /** Text after the colon, trimmed. */
  name: string;
  /**
   * From the heading line to (exclusive) whichever comes first: the next
   * `### Phase` heading OR the next `## ` heading. The structural fields
   * (`Origin trace:`, `Acceptance:`) must appear line-anchored in here.
   */
  header: string;
  /** Everything from the header cut to the next `## ` (or end of input). */
  body: string;
  /** `^Origin trace:` matched line-anchored within `header`. */
  hasOriginTrace: boolean;
  /** `^Acceptance:` matched line-anchored within `header`. */
  hasAcceptance: boolean;
}

/**
 * Heading-anchored feature-block extractor.
 *
 * Rules (all anchored, none use bare substring matching):
 *   1. Split on lines starting with `## `.
 *   2. Keep only sections whose first line matches `^## Feature (\d+):`
 *      — i.e. the exact feature-section format. A `## Features overview`
 *      summary list (one feature per line) does NOT match and is excluded.
 *   3. `header` = heading line through (exclusive) the first of:
 *        - the next `^### Phase` heading
 *        - the next `^## ` H2 heading
 *      `body` = remainder of the section up to the next `^## ` cut.
 *   4. `hasOriginTrace` / `hasAcceptance` are line-anchored regexes against
 *      `header` only. Run-on prose like `Origin trace: ... . Acceptance: ...`
 *      on a single line yields `hasAcceptance=false` because there is no
 *      line that STARTS with `Acceptance:`.
 *
 * Exported for use from `validate-living-plan.ts` and from the detector
 * branch below.
 */
const FEATURE_HEADING_RE = /^## Feature (\d+):\s*(.*)$/;

export function extractFeatureBlocks(planContent: string): FeatureBlock[] {
  if (!planContent) return [];

  const sections = planContent.split(/(?=^## )/m);
  const blocks: FeatureBlock[] = [];

  for (const section of sections) {
    const newlineIdx = section.indexOf("\n");
    const headingLine =
      newlineIdx >= 0 ? section.slice(0, newlineIdx) : section;
    const headingMatch = FEATURE_HEADING_RE.exec(headingLine);
    if (!headingMatch) continue;

    const number = parseInt(headingMatch[1], 10);
    const name = headingMatch[2].trim();

    // Find header end: first `^### Phase` OR first `^## ` AFTER the heading.
    // Search starts after the heading line so the heading itself isn't a cut.
    const afterHeading = section.slice(newlineIdx >= 0 ? newlineIdx + 1 : 0);
    const phaseCut = afterHeading.search(/^### Phase/m);
    const h2Cut = afterHeading.search(/^## /m);

    let cuts = [phaseCut, h2Cut].filter((c) => c >= 0);
    const cut = cuts.length ? Math.min(...cuts) : -1;

    const header =
      cut >= 0
        ? headingLine + "\n" + afterHeading.slice(0, cut)
        : headingLine + "\n" + afterHeading;
    const body = cut >= 0 ? afterHeading.slice(cut) : "";

    const hasOriginTrace = /^Origin trace:/m.test(header);
    const hasAcceptance = /^Acceptance:/m.test(header);

    blocks.push({
      number,
      name,
      header,
      body,
      hasOriginTrace,
      hasAcceptance,
    });
  }

  return blocks;
}

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
    // The orchestrator legitimately ticks Implementation/Review checkboxes
    // at intermediate non-terminal states (tests_green, codex_running,
    // review_clean, etc.) BEFORE the phase reaches "committed". Firing the
    // detector on those is a false-positive class observed in the wild
    // (agnt2-prototype-bisectiongame-settlement, 2026-05-16: 78 fires for
    // one healthy Phase 2.1 progressing through tests_green → codex_running
    // → committed). The detector should only fire when the phase is stuck
    // in a TERMINAL-FAILED state: failed, blocked, or has explicit error
    // baggage. tests_green/codex_running/etc are healthy transitions.
    //
    // Allowed in-flight states (do NOT fire even with checkboxes ticked):
    //   pending, test_spec_running, test_spec_done, tests_red,
    //   gemini_running, dual_impl_*, impl_done, test_fix_running,
    //   tests_green, codex_running, review_clean
    // States that DO fire (genuine premature-completion signal):
    //   failed, blocked, paused
    const PREMATURE_COMPLETION_FIRING_STATUSES = new Set([
      "failed",
      "blocked",
      "paused",
    ]);
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
        if (!PREMATURE_COMPLETION_FIRING_STATUSES.has(phaseState.status)) {
          continue;
        }

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
    // The synthesizer template (build/SKILL.md.tmpl Step 5) places these
    // headers on `## Feature N:` blocks.
    //
    // Gate: only run this check when the synthesis-complete sentinel is
    // present. Plans still being written by the synthesizer subagent will
    // not yet have the sentinel — emit nothing rather than racing the write
    // and reporting transient false positives.
    // ------------------------------------------------------------------
    if (planContent && planContent.includes(SYNTHESIS_COMPLETE_SENTINEL)) {
      for (const block of extractFeatureBlocks(planContent)) {
        if (!block.hasOriginTrace || !block.hasAcceptance) {
          const missing =
            !block.hasOriginTrace && !block.hasAcceptance
              ? "Origin trace: and Acceptance:"
              : !block.hasOriginTrace
                ? "Origin trace:"
                : "Acceptance:";
          faults.push({
            category: "PLAN_SYNTHESIS_INVALID",
            severity: "CRITICAL",
            description: `Feature block ${block.number} is missing ${missing}.`,
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
