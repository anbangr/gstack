/**
 * Investigator prompt builder + report parser for the halt-events pipeline.
 *
 * The halt-events queue produces structured halt events
 * (~/.gstack/skill-faults/pending-investigations/*.json). For each, the drain
 * loop dispatches an LLM investigator (typically codex/gpt-5.5/high per the
 * `investigator` role in build/configure.cm).
 *
 * This module is the boundary between the queue and the LLM:
 *   - buildInvestigatorPrompt: emits a self-contained briefing that embeds the
 *     four-phase root-cause discipline (mirrors /investigate). The prompt must
 *     work for any LLM — it cannot reference Claude-specific tools, because the
 *     default investigator is codex.
 *   - parseInvestigationReport: tolerantly extracts the JSON report from
 *     fenced ```json blocks or prose-wrapped output, then validates the shape.
 *
 * On any structural mismatch, parseInvestigationReport throws. Callers handle
 * by logging and skipping that investigation (the queue file stays in
 * pending-investigations/ for retry).
 */

import type { HaltEvent } from "./halt-events";

export interface InvestigationReport {
  faultId: string;
  outcome:
    | "root-cause-identified"
    | "self-healed"
    | "needs-human"
    | "no-context"
    | "duplicate-of";
  duplicateOfPath?: string;
  rootCause: string; // 1-3 sentences
  evidence: string[]; // "path/to/file.ts:line" citations
  proposedFix: {
    options: Array<{
      label: string;
      description: string;
      blast_radius: "narrow" | "medium" | "wide";
    }>;
  } | null;
  learnedPatternProposal: {
    category: string; // UPPER_SNAKE_CASE
    matcherKind:
      | "stdout_contains"
      | "stdout_regex"
      | "failureReason_contains"
      | "failureReason_regex"
      | "plan_contains"
      | "plan_regex"
      | "state_jsonpath";
    pattern: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM";
    description: string;
  } | null;
}

const VALID_OUTCOMES = new Set([
  "root-cause-identified",
  "self-healed",
  "needs-human",
  "no-context",
  "duplicate-of",
]);

const VALID_MATCHER_KINDS = new Set([
  "stdout_contains",
  "stdout_regex",
  "failureReason_contains",
  "failureReason_regex",
  "plan_contains",
  "plan_regex",
  "state_jsonpath",
]);

/**
 * Build the investigator prompt embedding the 4-phase root-cause discipline.
 *
 * The prompt is a self-contained briefing for codex (or any LLM that doesn't
 * have access to Claude's /investigate skill). Phases mirror the skill's
 * discipline: investigate symptoms -> analyze code -> hypothesize -> propose
 * fix. Returns a structured JSON report at the end.
 *
 * Voice: builder-to-builder, no hype. The investigator is solving a real
 * production halt, not writing a tutorial. Use file:line citations. State
 * the hypothesis directly. Propose 1-3 fix options with blast_radius labels.
 */
export function buildInvestigatorPrompt(args: {
  haltEvent: HaltEvent;
  existingCategories: string[];
}): string {
  const { haltEvent, existingCategories } = args;
  return `You are the gstack-build orchestrator's investigator subagent. A halt event occurred during a build. Your job is to investigate it and return a structured InvestigationReport in JSON.

# Halt event

\`\`\`json
${JSON.stringify(haltEvent, null, 2)}
\`\`\`

# Root-cause discipline (mandatory four phases)

**Phase 1: investigate.** Read the symptoms in the halt event. Use the file pointers (\`stateFile\`, \`stdoutLog\`, \`livingPlan\`, \`worktreePath\`) to gather more context if you need it. Identify the reproduction conditions. Note: pointers may reference files that no longer exist (worktree cleaned up, log rotated) — if you can't read them, that's signal too.

**Phase 2: analyze.** Trace the code path from symptom back to candidate causes. Common patterns: race condition, nil/null propagation, state corruption, integration boundary failure, configuration drift, stale cache, swallowed error. Name the pattern you see.

**Phase 3: hypothesize.** State a specific, testable claim about what is wrong and why. If the evidence suggests the halt has self-healed (e.g., state has advanced past the halt point on disk), return \`outcome: "self-healed"\`. If the worktree is gone and you cannot make a confident call, return \`outcome: "no-context"\`. If the same halt has been investigated before (check existing categories below), return \`outcome: "duplicate-of"\` with a \`duplicateOfPath\`.

**Phase 4: propose fix.** If you have a root cause, return up to 3 fix options labeled by blast_radius (narrow / medium / wide). If you can express the halt shape as a reusable detector pattern (e.g., a JSONPath, stdout substring, or failureReason regex), include a \`learnedPatternProposal\` — but only if the category is NOT already in this list:

${existingCategories.length === 0 ? "(no existing categories)" : existingCategories.map((c) => `  - ${c}`).join("\n")}

Skip the proposal entirely if no reusable pattern exists. A one-off log message is not a pattern.

# Output format

Return EXACTLY one JSON object matching this TypeScript type. The \`faultId\` MUST equal the halt event's faultId: "${haltEvent.faultId}".

\`\`\`typescript
interface InvestigationReport {
  faultId: string;
  outcome: "root-cause-identified" | "self-healed" | "needs-human" | "no-context" | "duplicate-of";
  duplicateOfPath?: string;
  rootCause: string;        // 1-3 sentences naming the root cause
  evidence: string[];       // file:line citations
  proposedFix: {
    options: Array<{
      label: string;
      description: string;
      blast_radius: "narrow" | "medium" | "wide";
    }>;
  } | null;
  learnedPatternProposal: {
    category: string;
    matcherKind: "stdout_contains" | "stdout_regex" | "failureReason_contains" | "failureReason_regex" | "plan_contains" | "plan_regex" | "state_jsonpath";
    pattern: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM";
    description: string;
  } | null;
}
\`\`\`

Return ONLY the JSON object, optionally wrapped in a single fenced \`\`\`json block. No prose outside the JSON.`;
}

/**
 * Parse an investigator's raw output into an InvestigationReport. Tolerates
 * fenced ```json blocks and leading/trailing prose. Validates:
 *   - faultId matches expected
 *   - outcome is one of the 5 known values
 *   - rootCause is a string
 *   - evidence is an array
 *   - learnedPatternProposal.matcherKind (if present) is valid
 *
 * Throws on any structural mismatch — caller handles the error (typically by
 * logging and skipping that investigation).
 */
export function parseInvestigationReport(
  raw: string,
  expectedFaultId: string,
): InvestigationReport {
  let jsonText = raw.trim();
  // Extract JSON from fenced ```json ... ``` block if present
  const fenceMatch = jsonText.match(
    /```(?:json)?\s*(\{[\s\S]*?\})\s*```/,
  );
  if (fenceMatch) {
    jsonText = fenceMatch[1];
  } else {
    // Otherwise, find the outermost { ... }
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }
  }
  const parsed = JSON.parse(jsonText);
  if (parsed.faultId !== expectedFaultId) {
    throw new Error(
      `InvestigationReport faultId mismatch: got "${parsed.faultId}", expected "${expectedFaultId}"`,
    );
  }
  if (!VALID_OUTCOMES.has(parsed.outcome)) {
    throw new Error(
      `InvestigationReport: invalid outcome "${parsed.outcome}"`,
    );
  }
  if (typeof parsed.rootCause !== "string") {
    throw new Error("InvestigationReport: rootCause must be a string");
  }
  if (!Array.isArray(parsed.evidence)) {
    throw new Error("InvestigationReport: evidence must be array");
  }
  if (parsed.learnedPatternProposal) {
    const lp = parsed.learnedPatternProposal;
    if (!VALID_MATCHER_KINDS.has(lp.matcherKind)) {
      throw new Error(
        `InvestigationReport: invalid matcherKind "${lp.matcherKind}"`,
      );
    }
  }
  return parsed as InvestigationReport;
}
