/**
 * Plan-level second-opinion reviewer (planReviewer role).
 *
 * Runs at gstack-build startup, before Phase 1 of Feature 1. Invokes the
 * configured planReviewer sub-agent (default: Codex/gpt-5.5/high), parses
 * its structured output, and routes by severity:
 *
 *   APPROVE              → annotate plan file, proceed
 *   REVISE/SUGGESTION    → inline comment annotations, proceed
 *   REVISE/IMPORTANT     → readline prompt (TTY) or auto-accept (non-TTY), proceed
 *   REVISE/CRITICAL      → write JSON report atomically, return "critical_exit"
 *                          (caller does process.exit(3))
 *
 * Templates:
 *   parsePlanReviewVerdict   ← feature-review.ts::parseFeatureReviewVerdict
 *   runPlanReview            ← sub-agents.ts::runCodexReview (file I/O pattern)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { ensureLogDir } from "./state";
import {
  runConfiguredRoleTask,
  isLikelyCodexTransportFailure,
} from "./sub-agents";
import type { RoleConfig } from "./role-config";
import type {
  PlanReviewVerdict,
  PlanReviewObjection,
  PlanReviewSeverity,
} from "./types";

export type { PlanReviewVerdict, PlanReviewObjection, PlanReviewSeverity };

/**
 * Read the `round` field from a previous plan-review-report.json and return
 * the next round number. Returns 1 when the file is absent or unreadable.
 *
 * Used by the CLI to increment the round counter across re-launch cycles so
 * the SKILL.md Step 5.5 "Round 3 stalemate → AskUser" escape is reachable.
 */
export function readPlanReviewRound(reportPath: string): number {
  try {
    const raw = fs.readFileSync(reportPath, "utf8");
    const parsed = JSON.parse(raw) as { round?: unknown };
    if (typeof parsed.round === "number" && parsed.round >= 1) {
      return parsed.round + 1;
    }
  } catch {
    // No prior report or corrupt JSON — start at round 1
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the planReviewer's structured output into a PlanReviewVerdict.
 *
 * Expected format:
 *   PLAN_REVIEW: APPROVE | REVISE
 *   (objection lines only when REVISE)
 *   ## Overall Assessment
 *   <prose>
 *
 * Tolerant of extra whitespace. Returns a synthetic APPROVE verdict and logs
 * a warning on malformed output — never blocks the build on a broken review.
 */
export function parsePlanReviewVerdict(
  output: string,
  opts?: { reviewedBy?: string; round?: number },
): PlanReviewVerdict {
  const reviewedBy = opts?.reviewedBy ?? "unknown";
  const round = opts?.round ?? 1;

  const verdictMatch = output.match(/^PLAN_REVIEW:\s*(APPROVE|REVISE)\s*$/m);
  if (!verdictMatch) {
    console.warn(
      "[plan-review] malformed reviewer output — no PLAN_REVIEW: line found; treating as APPROVE",
    );
    return {
      verdict: "APPROVE",
      objections: [],
      assessment: "",
      reviewedBy,
      round,
    };
  }

  const verdict = verdictMatch[1] as PlanReviewSeverity;
  const objections: PlanReviewObjection[] = [];

  if (verdict === "REVISE") {
    // Match lines like: - CRITICAL: [Feature 2, Phase 1] issue text → suggestion text
    const objectionRe =
      /^-\s+(CRITICAL|IMPORTANT|SUGGESTION):\s+\[([^\]]+)\]\s+(.*?)\s+→\s+(.*?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = objectionRe.exec(output)) !== null) {
      objections.push({
        severity: m[1] as PlanReviewObjection["severity"],
        location: m[2].trim(),
        issue: m[3].trim(),
        suggestion: m[4].trim(),
      });
    }

    // Log a warning for lines that look like objections but are malformed (missing →).
    const malformedRe = /^-\s+(CRITICAL|IMPORTANT|SUGGESTION):/gm;
    let mal: RegExpExecArray | null;
    while ((mal = malformedRe.exec(output)) !== null) {
      const line = output.slice(mal.index, output.indexOf("\n", mal.index));
      if (!line.includes("→")) {
        console.warn(
          `[plan-review] malformed objection line (missing →): ${line.trim()}`,
        );
      }
    }
  }

  const assessmentMatch = output.match(
    /##\s*Overall Assessment\s*\n([\s\S]*?)(?=\n##\s|$)/,
  );
  const assessment = assessmentMatch ? assessmentMatch[1].trim() : "";

  return { verdict, objections, assessment, reviewedBy, round };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Top-of-file HTML comment header written after any non-CRITICAL verdict. */
function buildAnnotationHeader(opts: {
  reviewed: string;
  reviewer: string;
  round: number;
  objectionsCritical: number;
  objectionsImportant: number;
  objectionsSuggestion: number;
  resolution: string;
}): string {
  const ts = new Date().toISOString();
  return (
    `<!-- gstack-plan-review\n` +
    `reviewed: ${opts.reviewed}\n` +
    `reviewer: ${opts.reviewer}\n` +
    `round: ${opts.round}\n` +
    `ts: ${ts}\n` +
    `objections_critical: ${opts.objectionsCritical}\n` +
    `objections_important: ${opts.objectionsImportant}\n` +
    `objections_suggestion: ${opts.objectionsSuggestion}\n` +
    `resolution: ${opts.resolution}\n` +
    `-->\n`
  );
}

/** Prepend annotation to plan file, inserting before the first ## Feature heading. */
function prependAnnotation(planPath: string, annotation: string): void {
  const content = fs.readFileSync(planPath, "utf8");
  // Replace existing annotation if present (may appear after a # Title preamble, not at byte 0).
  const annotIdx = content.indexOf("<!-- gstack-plan-review");
  if (annotIdx >= 0) {
    const endComment = content.indexOf("-->\n", annotIdx);
    const rest = endComment >= 0 ? content.slice(endComment + 4) : content;
    fs.writeFileSync(
      planPath,
      content.slice(0, annotIdx) + annotation + rest,
      "utf8",
    );
    return;
  }
  // Insert before first ## Feature heading if present; else prepend.
  const featureIdx = content.search(/^## Feature /m);
  if (featureIdx >= 0) {
    fs.writeFileSync(
      planPath,
      content.slice(0, featureIdx) + annotation + content.slice(featureIdx),
      "utf8",
    );
  } else {
    fs.writeFileSync(planPath, annotation + content, "utf8");
  }
}

/** Append inline objection comments after the matching feature/phase heading. */
function applyInlineAnnotations(
  planPath: string,
  objections: PlanReviewObjection[],
): void {
  let content = fs.readFileSync(planPath, "utf8");
  for (const obj of objections) {
    // Try to find "### Phase N" heading matching the location.
    const phaseMatch = obj.location.match(/Phase\s+(\S+)/i);
    if (phaseMatch) {
      // Add (?!\d) to prevent "Phase 1" matching "Phase 10", "Phase 11", etc.
      const phaseRe = new RegExp(
        `(###\\s*Phase\\s+${escapeRegExp(phaseMatch[1])}(?!\\d)[^\\n]*)`,
        "m",
      );
      const comment = `\n<!-- ${obj.severity} [${obj.location}]: ${obj.issue} → ${obj.suggestion} -->`;
      content = content.replace(phaseRe, `$1${comment}`);
    }
  }
  fs.writeFileSync(planPath, content, "utf8");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prompt the user to apply, skip, or partially accept IMPORTANT objections. */
async function promptImportantObjections(
  objections: PlanReviewObjection[],
): Promise<PlanReviewObjection[]> {
  const important = objections.filter((o) => o.severity === "IMPORTANT");
  if (important.length === 0) return [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const accepted: PlanReviewObjection[] = [];
  try {
    for (const obj of important) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `\n[plan-review] IMPORTANT: [${obj.location}]\n  Issue: ${obj.issue}\n  Fix: ${obj.suggestion}\n  Apply? [y/skip/all] `,
          resolve,
        );
      });
      const ans = answer.trim().toLowerCase();
      if (ans === "all") {
        return important;
      }
      if (ans !== "skip" && ans !== "s") {
        accepted.push(obj);
      }
    }
  } finally {
    rl.close();
  }
  return accepted;
}

/**
 * Route the parsed verdict to the appropriate action.
 *
 * Returns "proceed" or "critical_exit". Caller does process.exit(3) on
 * "critical_exit".
 */
export async function reconcilePlanReview(
  verdict: PlanReviewVerdict,
  planPath: string,
  opts: {
    /** Absolute path for the JSON report written on CRITICAL (atomic rename). */
    planReviewReportPath: string;
  },
): Promise<"proceed" | "critical_exit"> {
  const critical = verdict.objections.filter((o) => o.severity === "CRITICAL");
  const important = verdict.objections.filter(
    (o) => o.severity === "IMPORTANT",
  );
  const suggestions = verdict.objections.filter(
    (o) => o.severity === "SUGGESTION",
  );

  // ---------- APPROVE ----------
  if (verdict.verdict === "APPROVE") {
    const annotation = buildAnnotationHeader({
      reviewed: "APPROVE",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: 0,
      objectionsImportant: 0,
      objectionsSuggestion: 0,
      resolution:
        verdict.reviewedBy === "skipped-unavailable"
          ? "skipped-unavailable"
          : "approved",
    });
    prependAnnotation(planPath, annotation);
    console.log(
      `[plan-review] ${verdict.reviewedBy === "skipped-unavailable" ? "⚠ skipped (reviewer unavailable)" : "✓ APPROVED"}`,
    );
    return "proceed";
  }

  // ---------- REVISE — CRITICAL takes priority ----------
  if (critical.length > 0) {
    const annotation = buildAnnotationHeader({
      reviewed: "CRITICAL",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: critical.length,
      objectionsImportant: important.length,
      objectionsSuggestion: suggestions.length,
      resolution: "critical-exit-pending-resynth",
    });
    prependAnnotation(planPath, annotation);

    // Atomic write: temp file → rename.
    const reportDir = path.dirname(opts.planReviewReportPath);
    fs.mkdirSync(reportDir, { recursive: true });
    const tmp = path.join(
      reportDir,
      `.plan-review-report-${Date.now()}.tmp.json`,
    );
    fs.writeFileSync(tmp, JSON.stringify(verdict, null, 2), "utf8");
    fs.renameSync(tmp, opts.planReviewReportPath);

    console.error(
      `[plan-review] ✗ CRITICAL objections found (${critical.length}) — exiting with code 3.\n` +
        `  Report: ${opts.planReviewReportPath}\n` +
        `  Re-synthesis round: ${verdict.round}`,
    );
    for (const c of critical) {
      console.error(`  • [${c.location}] ${c.issue}`);
    }
    return "critical_exit";
  }

  // ---------- REVISE — SUGGESTION only ----------
  if (important.length === 0) {
    applyInlineAnnotations(planPath, suggestions);
    const annotation = buildAnnotationHeader({
      reviewed: "REVISE-SUGGESTIONS",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: 0,
      objectionsImportant: 0,
      objectionsSuggestion: suggestions.length,
      resolution: "approved",
    });
    prependAnnotation(planPath, annotation);
    console.log(
      `[plan-review] ✓ REVISE (${suggestions.length} suggestion(s) annotated inline)`,
    );
    return "proceed";
  }

  // ---------- REVISE — IMPORTANT ----------
  if (!process.stdin.isTTY) {
    // Non-interactive (CI): auto-accept all IMPORTANT, annotate all inline, proceed.
    applyInlineAnnotations(planPath, [...important, ...suggestions]);
    const annotation = buildAnnotationHeader({
      reviewed: "REVISE-IMPORTANT-AUTO-ACCEPTED",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: 0,
      objectionsImportant: important.length,
      objectionsSuggestion: suggestions.length,
      resolution: "auto-accepted",
    });
    prependAnnotation(planPath, annotation);
    console.log(
      `[plan-review] ⚠ REVISE: ${important.length} IMPORTANT objection(s) auto-accepted (non-interactive mode)`,
    );
    for (const obj of important) {
      console.log(`  • [${obj.location}] ${obj.issue}`);
    }
    return "proceed";
  }

  // Interactive: prompt per-objection.
  console.log(
    `\n[plan-review] REVISE: ${important.length} IMPORTANT objection(s) need your input.`,
  );
  const accepted = await promptImportantObjections(verdict.objections);
  applyInlineAnnotations(planPath, [...accepted, ...suggestions]);

  const annotation = buildAnnotationHeader({
    reviewed: "REVISE-IMPORTANT-ACCEPTED",
    reviewer: verdict.reviewedBy,
    round: verdict.round,
    objectionsCritical: 0,
    objectionsImportant: important.length,
    objectionsSuggestion: suggestions.length,
    resolution: `user-accepted (${accepted.length}/${important.length})`,
  });
  prependAnnotation(planPath, annotation);
  console.log(
    `[plan-review] ✓ ${accepted.length}/${important.length} IMPORTANT objection(s) accepted by user`,
  );
  return "proceed";
}

// ---------------------------------------------------------------------------
// Sub-agent invocation
// ---------------------------------------------------------------------------

const PLAN_REVIEW_PROMPT = `Review this living implementation plan before autonomous TDD execution begins.

Review for:
1. COMPLETENESS — Does it cover all features from the source intent?
2. FEASIBILITY — Are phases reasonably scoped?
3. TEST COVERAGE GAPS — What edge cases or failure modes are missing?
4. RISK — Which phases are high-risk and need extra guard phases?
5. DEPENDENCIES — Implicit prerequisites not captured as phases?
6. TEST SPEC QUALITY — Does every phase have a \`#### Test Spec\` section?
   - Flag CRITICAL if SOME phases have \`#### Test Spec\` and OTHERS don't (structural
     inconsistency — the plan is malformed; the build will apply spec instructions
     to some phases but not others).
   - Flag IMPORTANT if NO phases have \`#### Test Spec\` (likely a legacy plan; user
     can pass --no-plan-review to proceed without fixing).
   - Flag IMPORTANT if a phase has a spec but fewer than 3 test cases, vague scenarios
     (no concrete inputs/outputs named), or no edge cases listed.
   - Flag SUGGESTION if the coverage target line is missing (add \`**Coverage target: ≥80%**\`).

Output format (strict, machine-parsed):
PLAN_REVIEW: APPROVE | REVISE

## Objections (omit section if APPROVE)
- CRITICAL: [Feature N, Phase M] <issue> → <suggested fix>
- IMPORTANT: [Feature N, Phase M] <issue> → <suggested fix>
- SUGGESTION: [Feature N, Phase M] <issue> → <suggested improvement>

## Overall Assessment
<1-2 paragraph assessment>
`;

/**
 * Invoke the configured planReviewer role and return a structured verdict.
 *
 * Single automatic retry on timeout or transport failure. On double-failure,
 * returns a synthetic APPROVE verdict with reviewedBy="skipped-unavailable"
 * so the build proceeds rather than blocking.
 */
export async function runPlanReview(opts: {
  planPath: string;
  role: RoleConfig;
  slug: string;
  timeoutMs: number;
  /** Absolute path to the log directory (logDir(slug)). */
  logDirPath: string;
  cwd: string;
  /** 1 or 2 — passed into the verdict for SKILL.md re-synthesis tracking. */
  round?: number;
}): Promise<PlanReviewVerdict> {
  const round = opts.round ?? 1;
  ensureLogDir(opts.slug);

  const planContent = (() => {
    try {
      return fs.readFileSync(opts.planPath, "utf8");
    } catch (err) {
      console.warn(
        `[plan-review] could not read plan file: ${(err as Error).message}`,
      );
      return "";
    }
  })();

  const inputPath = path.join(opts.logDirPath, "plan-review-input.md");
  const outputPath = path.join(opts.logDirPath, "plan-review-output.md");

  fs.writeFileSync(
    inputPath,
    `${PLAN_REVIEW_PROMPT}\n\n---\n\n## Living Plan\n\n${planContent}\n`,
    "utf8",
  );
  fs.writeFileSync(outputPath, "", "utf8");

  const syntheticApprove = (reason: string): PlanReviewVerdict => {
    console.warn(
      `[plan-review] ${reason} — proceeding with skipped-unavailable annotation`,
    );
    return {
      verdict: "APPROVE",
      objections: [],
      assessment: "",
      reviewedBy: "skipped-unavailable",
      round,
    };
  };

  const attempt = async (logSuffix: string) =>
    runConfiguredRoleTask({
      inputFilePath: inputPath,
      outputFilePath: outputPath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: "plan" as const,
      iteration: round,
      logPrefix: `plan-review${logSuffix}`,
      role: opts.role,
      timeoutMs: opts.timeoutMs,
      gate: false,
    });

  let result = await attempt("");

  if (
    result.timedOut ||
    (result.exitCode !== 0 && isLikelyCodexTransportFailure(result))
  ) {
    console.warn("[plan-review] first attempt failed — retrying once");
    // Reset output file for retry.
    fs.writeFileSync(outputPath, "", "utf8");
    result = await attempt("-retry");

    if (
      result.timedOut ||
      (result.exitCode !== 0 && isLikelyCodexTransportFailure(result))
    ) {
      return syntheticApprove(
        "reviewer timed out / transport failure on retry",
      );
    }
  }

  // Treat non-zero non-transport exit as "model not found" or misconfigured role.
  if (result.exitCode !== 0) {
    return syntheticApprove(
      `reviewer exited ${result.exitCode} (model not found or misconfigured) — check GSTACK_BUILD_PLANREVIEWER_MODEL`,
    );
  }

  const rawOutput = result.stdout || "";
  if (!rawOutput.trim()) {
    return syntheticApprove("reviewer produced no output");
  }

  return parsePlanReviewVerdict(rawOutput, {
    reviewedBy: opts.role.model,
    round,
  });
}

// ---------------------------------------------------------------------------
// Round annotation read/write (cross-round memory contract)
// ---------------------------------------------------------------------------

export interface RoundAnnotationEntry {
  round: number;
  userDecision?: "accept" | "reject" | "defer";
  userRationale?: string;
  /** Synth-written. Possible values: "pending", "disputed — <reason>", or "<one-line description>". */
  resolution?: string;
  /** Parser-written when comparing round N to round N-1. "re-raised" | "not re-raised". */
  reviewerOutcome?: string;
}

export interface RoundAnnotation {
  location: string;
  severity: "CRITICAL" | "IMPORTANT" | "SUGGESTION";
  issue: string;
  suggestion: string;
  rounds: RoundAnnotationEntry[];
}

/**
 * Match a full annotation block. Lazy body up to first `-->`.
 * `[^\]\n]+` for location prevents the bracket-group from spanning lines,
 * which would cause malformed blocks to be glued to the next valid block.
 */
const ANNOTATION_BLOCK_RE =
  /<!--\s*ROUND\s+\d+\s+(CRITICAL|IMPORTANT|SUGGESTION)\s+\[([^\]\n]+)\]:\s+([\s\S]*?)-->/gm;

const ROUND_HEADER_RE =
  /ROUND\s+(\d+)\s+(CRITICAL|IMPORTANT|SUGGESTION)\s+\[([^\]\n]+)\]:\s+(.+?)\s+→\s+(.+?)$/m;

const ROUND_USER_RE = /ROUND\s+(\d+)\s+USER:\s+(accept|reject|defer)(?:\s+\("([^"]*)"\))?/g;

/** Stop before trailing ` -->` when the field is the last line in the block. */
const ROUND_RESOLUTION_RE = /ROUND\s+(\d+)\s+RESOLUTION:\s+(.+?)(?:\s+-->)?$/gm;

const ROUND_REVIEWER_RE = /ROUND\s+(\d+)\s+REVIEWER:\s+(.+?)(?:\s+-->)?$/gm;

/**
 * Parse all round-annotation blocks out of a plan file's text.
 * Skips malformed blocks (logs to console.warn) instead of throwing.
 */
export function parseRoundAnnotations(planText: string): RoundAnnotation[] {
  const results: RoundAnnotation[] = [];
  let m: RegExpExecArray | null;
  ANNOTATION_BLOCK_RE.lastIndex = 0;
  while ((m = ANNOTATION_BLOCK_RE.exec(planText)) !== null) {
    const body = m[0];
    // The header is the first line inside the comment.
    const headerMatch = body.match(ROUND_HEADER_RE);
    if (!headerMatch) {
      console.warn(
        "[plan-review] malformed annotation block (no header); skipping",
      );
      continue;
    }
    const severity = headerMatch[2] as RoundAnnotation["severity"];
    const location = headerMatch[3].trim();
    const issue = headerMatch[4].trim();
    const suggestion = headerMatch[5].trim();

    // Collect every ROUND N USER / RESOLUTION / REVIEWER line into a per-round map.
    const byRound = new Map<number, RoundAnnotationEntry>();
    const ensure = (round: number): RoundAnnotationEntry => {
      let entry = byRound.get(round);
      if (!entry) {
        entry = { round };
        byRound.set(round, entry);
      }
      return entry;
    };
    // The header itself names round 1 of this annotation; track its round number.
    ensure(parseInt(headerMatch[1], 10));

    ROUND_USER_RE.lastIndex = 0;
    let u: RegExpExecArray | null;
    while ((u = ROUND_USER_RE.exec(body)) !== null) {
      const entry = ensure(parseInt(u[1], 10));
      entry.userDecision = u[2] as RoundAnnotationEntry["userDecision"];
      if (u[3] !== undefined) entry.userRationale = u[3];
    }

    ROUND_RESOLUTION_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = ROUND_RESOLUTION_RE.exec(body)) !== null) {
      const entry = ensure(parseInt(r[1], 10));
      entry.resolution = r[2].trim();
    }

    // ROUND N REVIEWER attaches to round N's own entry: it records the
    // reviewer's observation IN round N (e.g., "re-raised" / "not re-raised")
    // about a prior-round objection, paired with round N's USER decision if
    // present. The round number on the line names the round in which the
    // observation happened, not the round being observed. See the design
    // spec §"Why the format" bullet 4.
    ROUND_REVIEWER_RE.lastIndex = 0;
    let v: RegExpExecArray | null;
    while ((v = ROUND_REVIEWER_RE.exec(body)) !== null) {
      const entry = ensure(parseInt(v[1], 10));
      entry.reviewerOutcome = v[2].trim();
    }

    const rounds = Array.from(byRound.values()).sort((a, b) => a.round - b.round);
    results.push({ location, severity, issue, suggestion, rounds });
  }
  return results;
}

/**
 * Serialize a single RoundAnnotation back to the canonical HTML comment.
 */
function serializeAnnotation(ann: RoundAnnotation): string {
  const lines: string[] = [];
  const head = ann.rounds[0].round;
  lines.push(
    `<!-- ROUND ${head} ${ann.severity} [${ann.location}]: ${ann.issue} → ${ann.suggestion}`,
  );
  for (const r of ann.rounds) {
    if (r.userDecision) {
      const rat = r.userRationale ? ` ("${r.userRationale}")` : "";
      lines.push(`     ROUND ${r.round} USER: ${r.userDecision}${rat}`);
    }
    if (r.resolution) {
      lines.push(`     ROUND ${r.round} RESOLUTION: ${r.resolution}`);
    }
    if (r.reviewerOutcome) {
      lines.push(`     ROUND ${r.round} REVIEWER: ${r.reviewerOutcome}`);
    }
  }
  lines[lines.length - 1] += " -->";
  return lines.join("\n");
}

/**
 * Insert or merge an annotation into the plan text.
 *
 * - If an existing annotation matches by (location, severity, issue), merge the new round's entries into it.
 * - Otherwise insert a new annotation block immediately above the matching `### Phase` heading.
 * - If no matching phase heading is found, prepend the annotation to the file (before any feature).
 */
export function writeRoundAnnotation(
  planText: string,
  ann: RoundAnnotation,
): string {
  // Merge path: scan existing annotations, find a match.
  const existing = parseRoundAnnotations(planText);
  const matchIdx = existing.findIndex(
    (e) =>
      e.location === ann.location &&
      e.severity === ann.severity &&
      e.issue === ann.issue,
  );
  if (matchIdx >= 0) {
    const merged: RoundAnnotation = {
      ...existing[matchIdx],
      rounds: [...existing[matchIdx].rounds, ...ann.rounds],
    };
    const oldText = serializeAnnotation(existing[matchIdx]);
    const newText = serializeAnnotation(merged);
    return planText.replace(oldText, newText);
  }

  // Insert path: place above `### Phase <phaseId>` for the location.
  const phaseMatch = ann.location.match(/Phase\s+(\S+)/i);
  const newBlock = serializeAnnotation(ann);
  if (phaseMatch) {
    const phaseRe = new RegExp(
      `(^###\\s*Phase\\s+${escapeRegExp(phaseMatch[1])}(?!\\d)[^\\n]*$)`,
      "m",
    );
    if (phaseRe.test(planText)) {
      return planText.replace(phaseRe, `${newBlock}\n$1`);
    }
  }
  // Fallback: prepend.
  return `${newBlock}\n${planText}`;
}

// ---------------------------------------------------------------------------
// Round-history header (top-of-plan block)
// ---------------------------------------------------------------------------

export interface RoundHistoryEntry {
  round: number;
  ts: string;
  reviewer: string;
  verdict: "APPROVE" | "REVISE";
  criticalCount: number;
  accepted: number;
  rejected: number;
  deferred: number;
}

const HISTORY_BLOCK_RE =
  /<!--\s*gstack-plan-review-history\s*\n([\s\S]*?)-->\s*/m;

export function parseRoundHistoryHeader(planText: string): RoundHistoryEntry[] {
  const m = planText.match(HISTORY_BLOCK_RE);
  if (!m) return [];
  const lines = m[1].split("\n").filter((l) => l.trim().startsWith("round "));
  const entries: RoundHistoryEntry[] = [];
  for (const line of lines) {
    const parsed = line.match(
      /^round\s+(\d+)\s+\(([^)]+)\):\s+(\S+)\s+→\s+(APPROVE|REVISE)\s+—\s+(\d+)\s+CRITICAL\s+\((\d+)\s+accepted,\s+(\d+)\s+rejected(?:,\s+(\d+)\s+deferred)?\)/,
    );
    if (!parsed) continue;
    entries.push({
      round: parseInt(parsed[1], 10),
      ts: parsed[2],
      reviewer: parsed[3],
      verdict: parsed[4] as "APPROVE" | "REVISE",
      criticalCount: parseInt(parsed[5], 10),
      accepted: parseInt(parsed[6], 10),
      rejected: parseInt(parsed[7], 10),
      deferred: parsed[8] ? parseInt(parsed[8], 10) : 0,
    });
  }
  return entries;
}

export function updateRoundHistoryHeader(
  planText: string,
  newEntry: RoundHistoryEntry,
  opts?: { finalLine?: string },
): string {
  const entries = parseRoundHistoryHeader(planText);
  entries.push(newEntry);
  const lines = entries.map(
    (e) =>
      `round ${e.round} (${e.ts}): ${e.reviewer} → ${e.verdict} — ${e.criticalCount} CRITICAL (${e.accepted} accepted, ${e.rejected} rejected${e.deferred ? `, ${e.deferred} deferred` : ""})`,
  );
  if (opts?.finalLine) lines.push(opts.finalLine);
  const newBlock = `<!-- gstack-plan-review-history\n${lines.join("\n")}\n-->\n`;
  if (HISTORY_BLOCK_RE.test(planText)) {
    return planText.replace(HISTORY_BLOCK_RE, newBlock);
  }
  return newBlock + planText;
}
