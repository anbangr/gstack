/**
 * F4: convergence-cap interactive prompt + BLOCKED-feature-N.md writer.
 *
 * When the configured cap (default 3) is hit without a FEATURE_PASS, the
 * orchestrator pauses on a TTY and asks whether to allow another cycle.
 * Non-interactive runs (CI, redirected stdin, no TTY) take the cap as
 * final and write BLOCKED-feature-N.md so the user can pick up the
 * forensics later. The user is asked at most ONCE per feature; an
 * approved extension sets userApprovedExtension on featureState so the
 * loop doesn't keep re-prompting indefinitely.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import type { Feature, FeatureState } from "./types";

/**
 * Prompt the user via stdin for a yes/no decision. Returns the user's
 * choice on a TTY, or `defaultValue` when stdin is not a TTY (CI,
 * piped stdin, background runs). Stream injection supports tests.
 *
 * Default semantics: caller picks the safe default. For the convergence
 * cap, the safe default is `false` (don't burn another cycle) so a
 * non-interactive run gets blocked deterministically.
 */
export interface PromptYesNoArgs {
  question: string;
  defaultValue: boolean;
  /** stdin override for tests. Defaults to process.stdin. */
  inStream?: NodeJS.ReadableStream;
  /** stdout override for tests. Defaults to process.stderr (so the prompt is visible even when stdout is piped). */
  outStream?: NodeJS.WritableStream;
  /**
   * isTTY override for tests. When omitted, derived from inStream's
   * isTTY property. The orchestrator's stdin is process.stdin by
   * default, which exposes `isTTY` as boolean | undefined.
   */
  isTTY?: boolean;
}

export async function promptYesNo(args: PromptYesNoArgs): Promise<boolean> {
  const out = args.outStream ?? process.stderr;
  const isTty =
    args.isTTY ??
    (args.inStream
      ? (args.inStream as NodeJS.ReadStream).isTTY === true
      : process.stdin.isTTY === true);

  if (!isTty) {
    out.write(
      `${args.question} → non-interactive (no TTY); using default: ${args.defaultValue ? "yes" : "no"}\n`,
    );
    return args.defaultValue;
  }

  const inStream = args.inStream ?? process.stdin;
  const suffix = args.defaultValue ? " [Y/n]: " : " [y/N]: ";
  out.write(`${args.question}${suffix}`);
  const rl = readline.createInterface({
    input: inStream as NodeJS.ReadableStream,
    output: out,
    terminal: false,
  });
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const finish = (v: boolean) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(v);
    };
    // Use `on` (not `once`) + a resolved guard so we observe both 'line'
    // and 'close'. With a finite stream backed by a Buffer push + null,
    // `close` can fire on the same tick as `line`; whichever lands
    // first wins, but the guard prevents double-resolution.
    rl.on("line", (line) => {
      const ans = (line || "").trim().toLowerCase();
      if (ans === "") return finish(args.defaultValue);
      if (ans === "y" || ans === "yes") return finish(true);
      if (ans === "n" || ans === "no") return finish(false);
      // Unrecognized → safest default. We do not loop / re-prompt here
      // because the caller may have other UX layered on top.
      out.write(
        `Unrecognized answer "${line}"; using default: ${args.defaultValue ? "yes" : "no"}\n`,
      );
      finish(args.defaultValue);
    });
    rl.on("close", () => {
      // Stdin closed before a line was read (piped + EOF). Treat as
      // non-interactive: use default.
      finish(args.defaultValue);
    });
  });
}

/**
 * Build the BLOCKED-feature-N.md report body. Pure function — caller
 * writes the file. Mirrors the per-phase BLOCKED.md format from cluster
 * D so users get a consistent triage surface across phase-level and
 * feature-level convergence failures.
 */
export interface BuildBlockedFeatureMdArgs {
  feature: Feature;
  featureState: FeatureState;
  /** Reason the orchestrator settled on (cap-hit, user-declined, blocked). */
  reason: string;
  /** Path to the most recent feature-review report (last cycle's output). */
  lastReportPath?: string;
  /** Plan file the user should reference when resuming. */
  planFile: string;
  /** Wall-clock timestamp the failure occurred. ISO 8601. */
  timestamp: string;
}

export function buildBlockedFeatureMd(args: BuildBlockedFeatureMdArgs): string {
  const fr = args.featureState.featureReview;
  const cycles = fr?.iterations ?? 0;
  const lastVerdict = fr?.finalVerdict ?? "(none recorded)";
  const reportPaths = fr?.outputFilePaths ?? [];

  let lastReportContent = "(no report content available)";
  if (args.lastReportPath) {
    try {
      const raw = fs.readFileSync(args.lastReportPath, "utf8");
      lastReportContent =
        raw.length > 8000 ? `...${raw.slice(-8000).trim()}` : raw.trim();
    } catch {
      lastReportContent = `(report at ${args.lastReportPath} not readable)`;
    }
  }

  return [
    `# BLOCKED — Feature ${args.feature.number}: ${args.feature.name}`,
    "",
    `**Failure:** ${args.reason}`,
    `**Date:** ${args.timestamp}`,
    `**Review cycles run:** ${cycles}`,
    `**Last verdict:** ${lastVerdict}`,
    `**Phases in feature:** ${args.featureState.phaseIndexes.length}`,
    "",
    "## All review reports (most recent last)",
    "",
    reportPaths.length === 0
      ? "(no review reports persisted)"
      : reportPaths.map((p) => `- ${p}`).join("\n"),
    "",
    "## Last review report (snippet)",
    "",
    "```",
    lastReportContent,
    "```",
    "",
    "## How to resume",
    "",
    "Pick one:",
    "",
    "1. Address the findings above by hand, then continue:",
    "   ```",
    `   gstack-build ${args.planFile} --skip-feature-review`,
    "   ```",
    "",
    "2. Allow more review cycles and let the orchestrator try again:",
    "   ```",
    `   gstack-build ${args.planFile} --feature-review-max-iter 6`,
    "   ```",
    "",
    "3. Reset specific phases yourself, then continue:",
    "   ```",
    `   gstack-build ${args.planFile} --reset-phase <N>`,
    "   ```",
  ].join("\n");
}
