#!/usr/bin/env bun
/**
 * Structural validator for a living plan file produced by the planSynthesizer.
 *
 * Invoked by the shell wrapper in `build/SKILL.md.tmpl` Step 5 after the
 * synthesizer subagent exits. The wrapper runs this against every plan in
 * the run manifest and uses the exit code to drive a bounded-retry loop:
 *
 *   exit 0 — plan passes structural rules; proceed.
 *   exit 1 — usage error / IO error (plan path missing or unreadable).
 *   exit 2 — at least one feature block is missing `Origin trace:` or
 *            `Acceptance:` line-anchored in its header, OR a static check
 *            violation was detected (unused import, missing field, missing
 *            file, multi-arm split, stale quote). Violations are written to
 *            stderr as a single JSON object the wrapper parses to build the
 *            revision prompt for the next synthesizer round.
 *
 * Shares its parser with `skill-fault-detector.ts` via the exported
 * `extractFeatureBlocks` helper — there is one source of truth for "what
 * is a feature block" so the validator and the detector cannot drift.
 */

import * as fs from "fs";
import * as path from "path";
import { extractFeatureBlocks } from "./skill-fault-detector";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface Violation {
  featureNumber: number;
  featureName: string;
  missing: Array<"originTrace" | "acceptance">;
}

interface StaticViolation {
  rule: string;
  message: string;
}

interface ValidationReport {
  planPath: string;
  ok: boolean;
  featureCount: number;
  violations: Violation[];
  staticViolations: StaticViolation[];
}

// ---------------------------------------------------------------------------
// Static-check helpers
// ---------------------------------------------------------------------------

/** Extract code-fenced snippets from markdown text. */
function extractCodeSnippets(text: string): string[] {
  const snippets: string[] = [];
  const re = /```(?:\w+)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    snippets.push(m[1]);
  }
  return snippets;
}

/** Split a feature body into individual phase bodies. */
function extractPhases(body: string): string[] {
  return body
    .split(/(?=^### Phase)/m)
    .filter((p) => p.trim().startsWith("### Phase"));
}

const BUILTIN_MODULES = new Set([
  "bun",
  "node:fs",
  "node:path",
  "node:os",
  "node:child_process",
  "node:util",
  "node:stream",
  "node:events",
  "node:buffer",
  "node:url",
  "node:http",
  "node:https",
  "node:net",
  "node:crypto",
  "node:zlib",
  "node:readline",
  "node:process",
  "node:timers",
  "node:querystring",
  "node:string_decoder",
  "fs",
  "path",
  "os",
  "child_process",
  "util",
  "stream",
  "events",
  "buffer",
  "url",
  "http",
  "https",
  "net",
  "crypto",
  "zlib",
  "readline",
  "process",
  "timers",
  "querystring",
  "string_decoder",
]);

/** Regex matching ES-module import statements (single-line, inside code blocks). */
const IMPORT_RE =
  /import\s+(?:type\s+)?(?:(\w+)\s*,\s*)?(?:(\w+)|\*\s+as\s+(\w+)|\{([^}]+)\})\s+from\s+["']([^"']+)["'];?/g;

function extractNamedImportIdentifiers(specifierList: string): string[] {
  const idents: string[] = [];
  for (const part of specifierList.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const typeMatch = trimmed.match(/^type\s+(\w+)(?:\s+as\s+(\w+))?$/);
    const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (typeMatch) {
      idents.push(typeMatch[2] ?? typeMatch[1]);
    } else if (asMatch) {
      idents.push(asMatch[2]);
    } else if (/^\w+$/.test(trimmed)) {
      idents.push(trimmed);
    }
  }
  return idents;
}

/** T1 — detect unused imports inside a single phase. */
function findUnusedImports(phaseBody: string): string[] {
  const snippets = extractCodeSnippets(phaseBody);
  const imports: Array<{ ident: string; source: string; statement: string }> =
    [];

  for (const snippet of snippets) {
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(snippet)) !== null) {
      const source = m[5];
      const statement = m[0];
      const idents: string[] = [];

      if (m[1]) idents.push(m[1]); // default import in "default, { named }"
      if (m[2]) idents.push(m[2]); // default import
      if (m[3]) idents.push(m[3]); // namespace import
      if (m[4]) idents.push(...extractNamedImportIdentifiers(m[4]));

      for (const ident of idents) {
        imports.push({ ident, source, statement });
      }
    }
  }

  // Strip every import statement from the phase body so that the import
  // line itself does not count as usage.
  let bodyWithoutImports = phaseBody;
  for (const imp of imports) {
    bodyWithoutImports = bodyWithoutImports.replace(imp.statement, "");
  }

  const unused: string[] = [];
  for (const imp of imports) {
    if (BUILTIN_MODULES.has(imp.source) || imp.source.startsWith("node:"))
      continue;
    const usageRe = new RegExp(`\\b${imp.ident}\\b`);
    if (!usageRe.test(bodyWithoutImports)) {
      unused.push(imp.ident);
    }
  }
  return unused;
}

/** T2 — detect phaseState field references in acceptance that do not appear in plan code. */
function checkMissingFields(content: string): StaticViolation[] {
  const violations: StaticViolation[] = [];
  const blocks = extractFeatureBlocks(content);

  // Gather every code snippet in the entire plan to use as the "current code" pool.
  const allCode: string[] = [];
  for (const block of blocks) {
    for (const phase of extractPhases(block.body)) {
      allCode.push(...extractCodeSnippets(phase));
    }
  }
  const codePool = allCode.join("\n");

  const fieldRe = /phaseState\.(?:\w+\.)+(\w+)/g;
  for (const block of blocks) {
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(block.header)) !== null) {
      const field = m[1];
      const fieldWordRe = new RegExp(`\\b${field}\\b`);
      if (!fieldWordRe.test(codePool)) {
        violations.push({
          rule: "missing-field",
          message: `field not in current code: ${field}`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// T3 helpers — file existence
// ---------------------------------------------------------------------------

const KNOWN_FILE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".html",
  ".txt",
  ".sh",
  ".py",
  ".go",
  ".rs",
]);

function isFileLikePath(s: string): boolean {
  if (!s.includes("/")) return false;
  // Reject shell commands, globs, vars, and URIs.
  if (/\s/.test(s)) return false;
  if (s.startsWith("$")) return false;
  if (s.includes("*")) return false;
  // Reject ':' except when it is the file:line suffix at the very end.
  if (/:(?!\d+$)/.test(s)) return false;
  const ext = path.extname(s).toLowerCase();
  return KNOWN_FILE_EXTS.has(ext);
}

function isExemptPath(s: string): boolean {
  return (
    s.startsWith("~/.gstack/") ||
    s.startsWith("inbox/") ||
    s.startsWith("/tmp/") ||
    s.includes("/inbox/") ||
    /(^|[\s|>~])(\.\/|\/)?(~\/\.gstack|inbox|tmp)\//.test(s)
  );
}

/** Scan a feature block for "Add|Create|Write|New `path`" patterns to build its planned-file allow-list.
 *  Also captures the common idiom "Add `A` and `B`" / "Add `A`, `B`, and `C`" where a single verb
 *  governs multiple paths joined by commas and/or "and". */
function extractPlannedFiles(text: string): Set<string> {
  const planned = new Set<string>();
  // Primary capture: verb + first backticked path, plus any additional paths
  // joined by ", ", " and ", or ", and ".
  const re =
    /(?:Add|Create|Write|New)\s+`([^`]+)`((?:\s*(?:,\s*(?:and\s+)?|and\s+)`[^`]+`)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (isFileLikePath(m[1])) planned.add(m[1]);
    const tail = m[2] || "";
    if (tail) {
      const tailRe = /`([^`]+)`/g;
      let tm: RegExpExecArray | null;
      while ((tm = tailRe.exec(tail)) !== null) {
        if (isFileLikePath(tm[1])) planned.add(tm[1]);
      }
    }
  }
  return planned;
}

/** Extract only the acceptance line(s) from a feature block header. */
function extractAcceptanceLines(header: string): string {
  return header
    .split("\n")
    .filter((line) => /^Acceptance:/.test(line))
    .join("\n");
}

/** T3 — detect non-existent file references in acceptance lines only. */
function checkFileRefs(content: string): StaticViolation[] {
  const violations: StaticViolation[] = [];
  const blocks = extractFeatureBlocks(content);

  for (const block of blocks) {
    // Only scan acceptance lines, not the entire block (spec compliance).
    const acceptanceText = extractAcceptanceLines(block.header);
    const plannedFiles = extractPlannedFiles(block.header + "\n" + block.body);
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(acceptanceText)) !== null) {
      const candidate = m[1];

      // Skip file:line references (T5 handles those).
      if (/:\d+$/.test(candidate)) continue;

      // Skip phaseState field references (T2 handles those).
      if (candidate.startsWith("phaseState.")) continue;

      if (!isFileLikePath(candidate)) continue;
      if (isExemptPath(candidate)) continue;
      if (plannedFiles.has(candidate)) continue;

      const fullPath = path.resolve(REPO_ROOT, candidate);
      try {
        fs.accessSync(fullPath, fs.constants.F_OK);
      } catch {
        violations.push({
          rule: "missing-file",
          message: `referenced file does not exist: ${candidate}`,
        });
      }
    }
  }
  return violations;
}

/** T4 — detect multi-arm split (registry addition and orchestrator usage in different phases). */
function checkMultiArmSplit(content: string): StaticViolation[] {
  const violations: StaticViolation[] = [];
  const blocks = extractFeatureBlocks(content);
  const registryAdds = new Map<string, string>();
  const orchestratorUses = new Map<string, string>();

  for (const block of blocks) {
    const phases = extractPhases(block.body);
    phases.forEach((phase, phaseIndex) => {
      const phaseKey = `${block.number}:${phaseIndex + 1}`;
      const addRe = /Add\s+`(\w+)`\s+to\s+`child-registry\.ts`/gi;
      let am: RegExpExecArray | null;
      while ((am = addRe.exec(phase)) !== null) {
        registryAdds.set(am[1], phaseKey);
      }

      const useRe = /Call\s+`(\w+)`\s+in\s+`phase-runner\.ts`/gi;
      let um: RegExpExecArray | null;
      while ((um = useRe.exec(phase)) !== null) {
        orchestratorUses.set(um[1], phaseKey);
      }
    });
  }

  for (const [ident, addPhase] of registryAdds) {
    const usePhase = orchestratorUses.get(ident);
    if (usePhase && usePhase !== addPhase) {
      violations.push({
        rule: "multi-arm-split",
        message: `registry entry must land with orchestrator: ${ident}`,
      });
    }
  }
  return violations;
}

/** T5 — detect stale file:line quotes in acceptance. */
function checkStaleQuotes(content: string): StaticViolation[] {
  const violations: StaticViolation[] = [];
  const blocks = extractFeatureBlocks(content);
  const quoteRe = /`([^`]+):(\d+)`\s+contains\s+"([^"]+)"/g;

  for (const block of blocks) {
    let m: RegExpExecArray | null;
    while ((m = quoteRe.exec(block.header)) !== null) {
      const filePath = m[1];
      const lineNum = parseInt(m[2], 10);
      const expectedSnippet = m[3];

      if (isExemptPath(filePath)) continue;

      const fullPath = path.resolve(REPO_ROOT, filePath);
      try {
        const fileContent = fs.readFileSync(fullPath, "utf8");
        const lines = fileContent.split("\n");
        const actualLine = lines[lineNum - 1]; // 1-based → 0-based
        if (!actualLine || !actualLine.includes(expectedSnippet)) {
          violations.push({
            rule: "stale-quote",
            message: `quoted file:line drifted: ${filePath}:${lineNum}`,
          });
        }
      } catch {
        violations.push({
          rule: "stale-quote",
          message: `quoted file:line drifted: ${filePath}:${lineNum}`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

/**
 * Detect H2 headings that LOOK like feature headings but don't match the
 * strict `^## Feature N:` regex the parser requires. Common LLM drift:
 * `## Feature 1 - Foo` (ASCII dash), `## Feature 1 — Foo` (em-dash),
 * `## Feature 1. Foo` (period), `## Feature 1 Foo` (no separator).
 *
 * Runs unconditionally on every plan, not just plans where zero blocks
 * parse — a single drifted heading mixed in with valid ones would
 * otherwise be silently dropped by `extractFeatureBlocks` and never
 * flagged. The adversarial review caught this as a real bypass: an LLM
 * can hide an entire feature section by emitting one bad heading while
 * keeping its siblings valid.
 *
 * Lines inside fenced code blocks (``` ... ```) are skipped so plan
 * authors can document the heading format with example snippets without
 * tripping the diagnostic.
 *
 * Per-line output is truncated to MAX_EXAMPLE_LENGTH chars and the
 * example list is capped to MAX_EXAMPLES. The diagnostic is reflected
 * verbatim into the synthesizer's revision prompt; unbounded reflection
 * is both a context-cost blowup and a weak prompt-injection vector
 * (a malicious heading "## Feature 1 - Ignore above and ..." becomes
 * text the next LLM sees). JSON.stringify in main() escapes control
 * chars, but length and prompt-leverage are the policy controls here.
 */
const MAX_EXAMPLE_LENGTH = 120;
const MAX_EXAMPLES = 3;

function truncateExample(line: string): string {
  if (line.length <= MAX_EXAMPLE_LENGTH) return line;
  return line.slice(0, MAX_EXAMPLE_LENGTH) + "... (truncated)";
}

/**
 * Match a fenced-code-block delimiter per CommonMark rules:
 *   - 3 or more backticks OR 3 or more tildes (matching the opening char)
 *   - Optional leading whitespace (up to 3 spaces before counts as fence;
 *     4+ would be an indented code block per CommonMark, but we accept
 *     them here too — plan files rarely deep-indent fences and the cost
 *     of being permissive is lower than the cost of missing a fence)
 *   - Optional info string after the open fence; closing fence is a bare
 *     run of fence chars with optional trailing whitespace only.
 *
 * A fence opened with N chars can only be closed by ≥ N of the SAME
 * char on a line by itself. This matters because plan authors who
 * document the format may use longer outer fences to embed shorter
 * inner fences in their examples:
 *
 *     ```` markdown            <- outer (4 backticks)
 *     Example of a wrong heading inside a code block:
 *     ```                       <- inner; must NOT close outer
 *     ## Feature 1 - wrong
 *     ```
 *     ````                      <- closes outer
 *
 * Without length tracking, the inner 3-backtick line would close the
 * outer prematurely and unmask later headings as scannable lines.
 */
function parseFenceOpen(
  line: string,
): { char: "`" | "~"; length: number } | null {
  const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { char: m[1][0] as "`" | "~", length: m[1].length };
}

function isFenceClose(
  line: string,
  open: { char: "`" | "~"; length: number },
): boolean {
  // Closing fence: same char, ≥ open length, optional trailing whitespace
  // only (no info string allowed on the close).
  const pattern = new RegExp(`^\\s{0,3}\\${open.char}{${open.length},}\\s*$`);
  return pattern.test(line);
}

function findMisshapenFeatureHeadings(content: string): string[] {
  const lines = content.split("\n");
  const bad: string[] = [];
  let openFence: { char: "`" | "~"; length: number } | null = null;
  for (const line of lines) {
    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
      }
      continue;
    }
    const fence = parseFenceOpen(line);
    if (fence) {
      openFence = fence;
      continue;
    }

    // Heading lines that start with `## Feature <digits>` but don't have
    // the canonical colon separator immediately after the digits.
    const m = /^## Feature (\d+)(.*)$/.exec(line);
    if (!m) continue;
    const tail = m[2];
    if (!tail.startsWith(":")) {
      bad.push(truncateExample(line));
    }
  }
  return bad;
}

function validate(planPath: string): ValidationReport {
  const content = fs.readFileSync(planPath, "utf8");
  const blocks = extractFeatureBlocks(content);

  const structuralViolations: Violation[] = [];
  const staticViolations: StaticViolation[] = [];

  // Heading-shape detection runs unconditionally. A plan with a mix of
  // valid `## Feature N:` headings and drifted `## Feature N - ...`
  // headings would otherwise pass: `extractFeatureBlocks` silently
  // skips the bad headings, validation passes on the good ones, and
  // entire feature sections vanish from the build run. The adversarial
  // review caught this exact bypass.
  const misshapen = findMisshapenFeatureHeadings(content);
  if (misshapen.length > 0) {
    staticViolations.push({
      rule: "feature-heading-shape",
      message:
        `${misshapen.length} heading(s) start with "## Feature N" but ` +
        `lack the required ":" separator. ` +
        `Required form: "## Feature N: <name>". ` +
        `Examples found: ${misshapen.slice(0, MAX_EXAMPLES).join(" | ")}`,
    });
  }

  if (blocks.length === 0) {
    // No `## Feature N` headings at all (or all were drifted and already
    // flagged above) — emit the legacy phantom missing-fields row only
    // when nothing was misshapen either, so the LLM doesn't get two
    // contradictory diagnostics.
    if (misshapen.length === 0) {
      structuralViolations.push({
        featureNumber: 0,
        featureName: "",
        missing: ["originTrace", "acceptance"],
      });
    }
  } else {
    for (const block of blocks) {
      const missing: Array<"originTrace" | "acceptance"> = [];
      if (!block.hasOriginTrace) missing.push("originTrace");
      if (!block.hasAcceptance) missing.push("acceptance");
      if (missing.length > 0) {
        structuralViolations.push({
          featureNumber: block.number,
          featureName: block.name,
          missing,
        });
      }
    }
  }

  // T1 — unused imports (per-phase)
  for (const block of blocks) {
    for (const phase of extractPhases(block.body)) {
      for (const ident of findUnusedImports(phase)) {
        staticViolations.push({
          rule: "unused-import",
          message: `unused import: ${ident}`,
        });
      }
    }
  }

  // T2 — missing field references
  staticViolations.push(...checkMissingFields(content));

  // T3 — non-existent file references
  staticViolations.push(...checkFileRefs(content));

  // T4 — multi-arm split
  staticViolations.push(...checkMultiArmSplit(content));

  // T5 — stale file:line quotes
  staticViolations.push(...checkStaleQuotes(content));

  // Increment 1 spec-grade checks: out-of-scope, verification spec,
  // file reference table, quantified acceptance must be present per feature.
  // Task 6 will append the final `if` to this same loop.
  for (const block of blocks) {
    if (!block.hasOutOfScope) {
      staticViolations.push({
        rule: "missing-out-of-scope",
        message: `Feature ${block.number} (${block.name}): missing "Out of scope:" line-anchored field. Add a line starting at column 0 like "Out of scope: none" or "Out of scope: vendor billing integration".`,
      });
    }
    if (!block.hasVerificationSpec) {
      staticViolations.push({
        rule: "missing-verification-spec",
        message: `Feature ${block.number} (${block.name}): missing "### Verification Spec" subsection. Add an H3 heading "### Verification Spec" with smoke commands + acceptance probes table (for code features) or verification artifacts + pass criteria (for non-code features). See docs/spec-archive-format.md for the exact shape.`,
      });
    }
    if (!block.hasFileReferenceTable) {
      staticViolations.push({
        rule: "missing-file-reference-table",
        message: `Feature ${block.number} (${block.name}): missing "### File Reference Table" subsection. Add an H3 heading with a markdown table listing every file the feature creates or modifies (columns: File, Action, Lines, Why). See docs/spec-archive-format.md for the exact shape.`,
      });
    }
  }

  return {
    planPath,
    ok: structuralViolations.length === 0 && staticViolations.length === 0,
    featureCount: blocks.length,
    violations: structuralViolations,
    staticViolations,
  };
}

function main(): number {
  const planPath = process.argv[2];
  if (!planPath) {
    process.stderr.write("usage: validate-living-plan.ts <plan-path>\n");
    return 1;
  }

  let report: ValidationReport;
  try {
    report = validate(planPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  const hasViolations = !report.ok || report.staticViolations.length > 0;
  if (!hasViolations) {
    return 0;
  }

  process.stderr.write(JSON.stringify(report) + "\n");
  return 2;
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  process.exit(main());
}

export { validate };
export type { Violation, ValidationReport, StaticViolation };
