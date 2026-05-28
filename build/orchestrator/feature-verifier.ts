/**
 * Pre-merge feature verifier (T12).
 *
 * Runs once per feature BEFORE the orchestrator triggers /ship or
 * /ship+/land-and-deploy. The verifier audits the feature's committed-but-
 * not-yet-merged work against the acceptance criteria in the source plan
 * and returns a structured PASS / GAPS verdict.
 *
 *   VERIFICATION: PASS  → ship proceeds.
 *   VERIFICATION: GAPS  → ship is aborted, feature is paused, gaps surface
 *                         to stderr and to state.failureReason.
 *
 * The shell-out (`git symbolic-ref` for base-branch detection, `git
 * merge-base`, then the role spawn via runRoleTask) lives in
 * runFeatureVerifier. The pure parser parseFeatureVerifierOutput is the
 * primary unit-test surface — feed it raw markdown, get back the verdict
 * + gap list.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./child-registry";
import type { RoleConfig } from "./role-config";
import { logDir, ensureLogDir } from "./state";
import type { Feature, FeatureState } from "./types";

export type FeatureVerifierVerdict = "PASS" | "GAPS" | "UNCLEAR";

export interface ParsedFeatureVerifierOutput {
  verdict: FeatureVerifierVerdict;
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Increment 3: Verification Spec extraction + structured JSON report
// ---------------------------------------------------------------------------

/**
 * Extract the `### Verification Spec` block from a feature body.
 * Returns the raw text (preserves formatting) or null when missing.
 * The block is verbatim from the Increment 2 spec-content preservation rule.
 *
 * Two-step pattern: find the header line first, then bound the capture
 * at the next `###` or `##` heading (or end-of-string).
 */
export function extractVerificationSpec(featureBody: string): string | null {
  const startMatch = featureBody.search(/^###\s+Verification Spec\s*$/m);
  if (startMatch < 0) return null;
  const slice = featureBody.slice(startMatch);
  const bodyMatch = slice.match(
    /^###\s+Verification Spec\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/,
  );
  return bodyMatch ? bodyMatch[1].trim() : null;
}

/**
 * Structured JSON report emitted by the verifier agent when the feature has
 * a `### Verification Spec` block. Fields correspond to the three probe
 * categories in the spec.
 */
export interface StructuredVerifierReport {
  smoke_run?: Array<{ cmd: string; exit: number; status: "pass" | "fail" }>;
  acceptance_probes?: Array<{
    ac: number;
    cmd: string;
    expected: string;
    actual: string;
    status: "pass" | "fail";
  }>;
  verification_artifacts?: Array<{
    path: string;
    check: string;
    status: "pass" | "fail";
  }>;
  overall: "pass" | "fail";
  halt_at?: string | null;
  notes?: string;
}

/**
 * Scan verifier stdout for a structured JSON report line.
 * Searches lines in reverse so that the last complete JSON object wins
 * (agent may emit intermediate JSON in verbose mode).
 */
function tryParseStructuredVerifierOutput(
  stdout: string,
): StructuredVerifierReport | null {
  const lines = stdout.split("\n");
  for (const line of [...lines].reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    if (!trimmed.includes('"overall"')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.overall === "string")
        return parsed as StructuredVerifierReport;
    } catch {
      /* not valid JSON — keep scanning */
    }
  }
  return null;
}

/**
 * Parse the verifier's output markdown into a structured verdict + gap list.
 *
 * Contract enforced by the prompt:
 *   - First non-blank line containing `VERIFICATION:` carries PASS or GAPS.
 *   - When verdict is GAPS, a `GAPS:` section follows with `- <bullet>`
 *     lines listing each gap. A single `- none` bullet means no actual
 *     gaps (treated as PASS-equivalent for the gap list, though the
 *     verdict itself stays GAPS — callers may want to surface that as a
 *     "verifier reported GAPS but listed none" diagnostic).
 *
 * Tolerant of whitespace + extra prose around the sentinel; UNCLEAR when
 * neither PASS nor GAPS sentinel is found.
 */
export function parseFeatureVerifierOutput(
  raw: string,
): ParsedFeatureVerifierOutput {
  const passMatch = /^\s*VERIFICATION:\s*PASS\b/m.test(raw);
  const gapsMatch = /^\s*VERIFICATION:\s*GAPS\b/m.test(raw);

  let verdict: FeatureVerifierVerdict;
  if (gapsMatch) {
    verdict = "GAPS";
  } else if (passMatch) {
    verdict = "PASS";
  } else {
    verdict = "UNCLEAR";
  }

  const gaps: string[] = [];
  if (verdict === "GAPS") {
    // Match the `GAPS:` header, capture body until next `##` heading,
    // another `VERIFICATION:` line, or end-of-string. The body of this
    // section is intentionally matched without the /m flag on `$` —
    // multiline `$` matches end-of-LINE and would stop capture after the
    // first bullet. We anchor the GAPS: header itself with /m so it can
    // appear after leading whitespace/blank lines.
    const headerMatch = raw.match(/^\s*GAPS:\s*\n/m);
    if (headerMatch && headerMatch.index !== undefined) {
      const bodyStart = headerMatch.index + headerMatch[0].length;
      const rest = raw.slice(bodyStart);
      // Stop at next `##` heading line, next `VERIFICATION:` line, or EOS.
      const stopRe = /\n\s*(?:##\s|VERIFICATION:)/;
      const stopMatch = rest.match(stopRe);
      const body = stopMatch ? rest.slice(0, stopMatch.index) : rest;
      const lines = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"));
      for (const l of lines) {
        const g = l.replace(/^-\s*/, "").trim();
        if (g && g.toLowerCase() !== "none") gaps.push(g);
      }
    }
  }

  return { verdict, gaps };
}

export interface DetectBaseBranchResult {
  /** Detected base branch name (e.g. "main"). Empty string when none found. */
  baseBranch: string;
  /** Path used: "origin/HEAD", "origin/main", "origin/master", or "" on failure. */
  source: "origin/HEAD" | "origin/main" | "origin/master" | "";
}

/**
 * Detect the base branch via the same fallback chain SKILL.md.tmpl uses:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` (the canonical answer
 *      when git knows the default branch).
 *   2. `origin/main` if it exists.
 *   3. `origin/master` if it exists.
 *
 * Returns `{ baseBranch: "", source: "" }` when none of the three resolve.
 *
 * `runSpawn` is injectable for tests — defaults to node:child_process
 * spawnSync. Tests pass a stub that returns canned `{ status, stdout }`
 * shapes for each git command.
 */
export function detectBaseBranch(args: {
  cwd: string;
  runSpawn?: (
    cmd: string,
    argv: string[],
    opts: { cwd: string; encoding: "utf8" },
  ) => { status: number | null; stdout: string };
}): DetectBaseBranchResult {
  const runSpawn =
    args.runSpawn ??
    ((cmd, argv, opts) => {
      const r = spawnSync(cmd, argv, opts);
      return {
        status: r.status,
        stdout: typeof r.stdout === "string" ? r.stdout : "",
      };
    });

  const headR = runSpawn(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: args.cwd, encoding: "utf8" },
  );
  if (headR.status === 0) {
    const ref = (headR.stdout || "").trim().replace(/^origin\//, "");
    if (ref) return { baseBranch: ref, source: "origin/HEAD" };
  }

  const mainR = runSpawn(
    "git",
    ["rev-parse", "--verify", "--quiet", "origin/main"],
    { cwd: args.cwd, encoding: "utf8" },
  );
  if (mainR.status === 0) return { baseBranch: "main", source: "origin/main" };

  const masterR = runSpawn(
    "git",
    ["rev-parse", "--verify", "--quiet", "origin/master"],
    { cwd: args.cwd, encoding: "utf8" },
  );
  if (masterR.status === 0)
    return { baseBranch: "master", source: "origin/master" };

  return { baseBranch: "", source: "" };
}

/**
 * Resolve the fork-point SHA of the current branch against the detected
 * base branch. Used as the "branch point" for git diff / git log /
 * git diff --name-only invocations that the feature-review prompt builder
 * and T11 skip heuristic feed off of.
 *
 * The legacy pattern `featureState.branch^{tree}..HEAD` resolves the
 * branch's CURRENT tree (post-all-commits), which silently produces an
 * empty diff against HEAD when the branch hasn't accumulated commits
 * the tree doesn't already match. This helper returns the actual fork
 * point so diff scope is correct.
 *
 * Returns `null` when base branch can't be detected OR `git merge-base`
 * fails. Callers fall back to the legacy `branch^{tree}` pattern for
 * backwards compatibility — bug-compatibility is better than crashing
 * a /build that's mid-run on a repo without an `origin/main`.
 */
export function resolveFeatureBaseRef(args: {
  cwd: string;
  runSpawn?: (
    cmd: string,
    argv: string[],
    opts: { cwd: string; encoding: "utf8" },
  ) => { status: number | null; stdout: string };
}): string | null {
  const runSpawn =
    args.runSpawn ??
    ((cmd, argv, opts) => {
      const r = spawnSync(cmd, argv, opts);
      return {
        status: r.status,
        stdout: typeof r.stdout === "string" ? r.stdout : "",
      };
    });
  const base = detectBaseBranch({ cwd: args.cwd, runSpawn });
  if (!base.baseBranch) return null;
  const mbR = runSpawn(
    "git",
    ["merge-base", `origin/${base.baseBranch}`, "HEAD"],
    { cwd: args.cwd, encoding: "utf8" },
  );
  if (mbR.status !== 0) return null;
  const sha = (mbR.stdout || "").trim();
  return sha || null;
}

/** Dispatcher signature compatible with cli.ts's exported runRoleTask. */
export interface RoleTaskDispatcher {
  (opts: {
    role: RoleConfig;
    inputFilePath: string;
    outputFilePath: string;
    cwd: string;
    slug: string;
    phaseNumber: string;
    iteration: number;
    logPrefix: string;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number | null;
    timedOut: boolean;
    logPath: string;
    stdout?: string;
    stderr?: string;
  }>;
}

export interface RunFeatureVerifierArgs {
  feature: Feature;
  featureState: FeatureState;
  planFile: string;
  cwd: string;
  /** Slug used for the per-feature log directory (e.g. `${slug}-feature-N`). */
  slug: string;
  role: RoleConfig;
  /** When true, skip the role spawn and write a stub PASS verdict. */
  dryRun: boolean;
  /** Universal role dispatcher. Pass cli.ts's runRoleTask. */
  dispatcher: RoleTaskDispatcher;
}

export interface FeatureVerifierResult {
  verdict: FeatureVerifierVerdict;
  gaps: string[];
  outputFilePath: string;
  inputFilePath: string;
  /** Log path from the dispatcher when the spawn ran; empty when dryRun or no spawn. */
  logPath: string;
  /** Surfaces "couldn't detect base branch" or similar best-effort failures. */
  reason?: string;
  /**
   * Structured JSON report parsed from the verifier's output when the feature
   * had a `### Verification Spec` block and the agent emitted structured JSON.
   * Undefined when the verifier used the legacy free-text format.
   */
  structuredReport?: StructuredVerifierReport;
}

/**
 * Run the pre-merge feature verifier. Detects the base branch + merge-base,
 * writes the verifier input prompt, spawns the configured role, and parses
 * the output back into a typed verdict.
 *
 * Failure modes:
 *   - Base branch undetectable → UNCLEAR with reason set; caller decides
 *     whether to proceed or fail. Default in cli.ts is "proceed with warn"
 *     because the failure is environmental (no origin remote) rather than
 *     a quality signal about the diff.
 *   - dispatcher returns timedOut / nonzero exit → UNCLEAR with reason.
 *   - Output file has no VERIFICATION: line → UNCLEAR (caller proceeds
 *     with warn; non-blocking by design — verifier is best-effort).
 */
export async function runFeatureVerifier(
  args: RunFeatureVerifierArgs,
): Promise<FeatureVerifierResult> {
  ensureLogDir(args.slug);

  const inputFilePath = path.join(
    logDir(args.slug),
    `feature-${args.feature.number}-verifier-input.md`,
  );
  const outputFilePath = path.join(
    logDir(args.slug),
    `feature-${args.feature.number}-verifier-output.md`,
  );

  // Dry-run: short-circuit to PASS without spawning. Useful for tests and
  // for `--dry-run` orchestrator runs where the goal is to validate the
  // plan + state machine, not pay for a real verifier spawn.
  if (args.dryRun) {
    const stub =
      "VERIFICATION: PASS\nGAPS:\n- none\n\n(dry-run stub — no real verifier ran)\n";
    fs.writeFileSync(inputFilePath, "(dry-run — verifier input not built)\n");
    fs.writeFileSync(outputFilePath, stub);
    return {
      verdict: "PASS",
      gaps: [],
      outputFilePath,
      inputFilePath,
      logPath: "",
    };
  }

  const baseDetection = detectBaseBranch({ cwd: args.cwd });
  if (!baseDetection.baseBranch) {
    fs.writeFileSync(
      inputFilePath,
      "(verifier skipped — base branch undetectable)\n",
    );
    fs.writeFileSync(outputFilePath, "");
    return {
      verdict: "UNCLEAR",
      gaps: [],
      outputFilePath,
      inputFilePath,
      logPath: "",
      reason:
        "could not detect base branch (no origin/HEAD, origin/main, or origin/master)",
    };
  }

  const baseRef = `origin/${baseDetection.baseBranch}`;
  const mbR = spawnSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: args.cwd,
    encoding: "utf8",
  });
  const mergeBase = mbR.status === 0 ? (mbR.stdout || "").trim() : "";
  const mergeBaseDisplay =
    mergeBase || `(unknown — ${baseRef} merge-base failed)`;

  // Increment 3: inject the pre-designed Verification Spec when present.
  const verificationSpec = extractVerificationSpec(args.feature.body);
  const verificationDirective = verificationSpec
    ? [
        `VERIFICATION SPEC FOR THIS FEATURE (Increment 3 contract — run verbatim, do NOT invent probes):`,
        ``,
        verificationSpec,
        ``,
        `After running the smoke commands and acceptance probes in order, output a JSON object on a line by itself with the shape:`,
        `{"smoke_run":[{"cmd":"...","exit":N,"status":"pass|fail"}], "acceptance_probes":[{"ac":N,"cmd":"...","expected":"...","actual":"...","status":"pass|fail"}], "verification_artifacts":[{"path":"...","check":"...","status":"pass|fail"}], "overall":"pass|fail", "halt_at":"...", "notes":"..."}`,
        ``,
        `Halt at the first probe failure. The legacy free-text format is still accepted but the structured JSON is preferred.`,
        ``,
        `---`,
        ``,
      ].join("\n")
    : "";

  const prompt = [
    verificationDirective +
      `You are a feature verifier for gstack-build (PRE-MERGE).`,
    ``,
    `Source plan path: ${args.planFile}`,
    `Feature name: ${args.feature.name}`,
    `Feature number: ${args.feature.number}`,
    `Feature branch: ${args.featureState.branch ?? "(unknown)"}`,
    `Base branch: ${baseDetection.baseBranch} (detected via ${baseDetection.source})`,
    `Merge base (against ${baseRef}): ${mergeBaseDisplay}`,
    ``,
    `Steps:`,
    `1. Read ONLY the Feature ${args.feature.number} section of the source plan.`,
    `2. Read the acceptance criteria for Feature ${args.feature.number}.`,
    `3. Run: git log --oneline ${mergeBase || `${baseRef}..HEAD`}..HEAD`,
    `   to inspect the feature's commits (NOT YET MERGED).`,
    `4. Compare implementation against acceptance criteria.`,
    `5. Write a gap report to ${outputFilePath} starting with the literal`,
    `   line "VERIFICATION: PASS" or "VERIFICATION: GAPS" then a "GAPS:"`,
    `   section with bullet points (or "- none").`,
    ``,
    `Output format (REQUIRED — your verdict will be machine-parsed):`,
    ``,
    `\`\`\``,
    `VERIFICATION: <PASS or GAPS>`,
    `GAPS:`,
    `- <gap description referencing the source plan section> (or "- none")`,
    `\`\`\``,
    ``,
    `Return ONLY the output file path. No narrative.`,
  ].join("\n");

  fs.writeFileSync(inputFilePath, prompt);
  fs.writeFileSync(outputFilePath, "");

  const result = await args.dispatcher({
    role: args.role,
    inputFilePath,
    outputFilePath,
    cwd: args.cwd,
    slug: args.slug,
    phaseNumber: `feature-${args.feature.number}`,
    iteration: 1,
    logPrefix: "feature-verifier-pre-merge",
  });

  let output = "";
  try {
    output = fs.readFileSync(outputFilePath, "utf8");
  } catch {
    // Output file may be missing if the dispatcher crashed before writing.
  }

  // Increment 3: try structured JSON first; fall back to legacy free-text.
  const structuredReport = tryParseStructuredVerifierOutput(output);

  if (result.timedOut || result.exitCode !== 0) {
    const parsed = parseFeatureVerifierOutput(output);
    return {
      verdict: parsed.verdict === "GAPS" ? "GAPS" : "UNCLEAR",
      gaps: parsed.gaps,
      outputFilePath,
      inputFilePath,
      logPath: result.logPath,
      reason: result.timedOut
        ? "verifier subprocess timed out"
        : `verifier subprocess exited ${result.exitCode}`,
      structuredReport: structuredReport ?? undefined,
    };
  }

  const parsed = parseFeatureVerifierOutput(output);
  return {
    verdict: parsed.verdict,
    gaps: parsed.gaps,
    outputFilePath,
    inputFilePath,
    logPath: result.logPath,
    reason:
      parsed.verdict === "UNCLEAR"
        ? "verifier output had no VERIFICATION: line"
        : undefined,
    structuredReport: structuredReport ?? undefined,
  };
}

/**
 * Post-merge tree-hash audit (T13).
 *
 * After /ship + merge, compare the feature branch HEAD tree against the
 * squash-merge commit tree. When they match, the landed code is byte-
 * equivalent to what pre-merge verify approved. When they differ, the
 * squash resolved a conflict in a way that mutated behavior — exactly
 * the case pre-merge verify could not catch.
 *
 * Pure comparison; the caller resolves the trees via `git rev-parse`.
 * Non-blocking: this is an audit signal, not a gate. The merge has
 * already happened.
 */
export type PostMergeAuditVerdict = "NO_DELTA" | "DELTA_DETECTED" | "SKIPPED";

export interface PostMergeAuditResult {
  verdict: PostMergeAuditVerdict;
  preTree: string | null;
  postTree: string | null;
  reason?: string;
}

/**
 * Compare two tree hashes from `git rev-parse <ref>^{tree}`. When either
 * is null/empty (e.g., merge-commit not yet available, branch deleted),
 * returns SKIPPED with a reason. When both are present and equal,
 * NO_DELTA. When both are present and differ, DELTA_DETECTED.
 */
export function comparePostMergeTrees(
  preTree: string | null | undefined,
  postTree: string | null | undefined,
): PostMergeAuditResult {
  const pre = (preTree ?? "").trim() || null;
  const post = (postTree ?? "").trim() || null;
  if (!pre || !post) {
    return {
      verdict: "SKIPPED",
      preTree: pre,
      postTree: post,
      reason:
        !pre && !post
          ? "both pre-merge and post-merge tree hashes unavailable"
          : !pre
            ? "pre-merge tree hash unavailable"
            : "post-merge tree hash unavailable (merge not yet landed?)",
    };
  }
  if (pre === post) {
    return { verdict: "NO_DELTA", preTree: pre, postTree: post };
  }
  return { verdict: "DELTA_DETECTED", preTree: pre, postTree: post };
}
