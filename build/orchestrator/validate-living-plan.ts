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
 *            `Acceptance:` line-anchored in its header. Violations are
 *            written to stderr as a single JSON object the wrapper parses
 *            to build the revision prompt for the next synthesizer round.
 *
 * Shares its parser with `skill-fault-detector.ts` via the exported
 * `extractFeatureBlocks` helper — there is one source of truth for "what
 * is a feature block" so the validator and the detector cannot drift.
 */

import * as fs from "fs";
import { extractFeatureBlocks } from "./skill-fault-detector";

interface Violation {
  featureNumber: number;
  featureName: string;
  missing: Array<"originTrace" | "acceptance">;
}

interface ValidationReport {
  planPath: string;
  ok: boolean;
  featureCount: number;
  violations: Violation[];
}

function validate(planPath: string): ValidationReport {
  const content = fs.readFileSync(planPath, "utf8");
  const blocks = extractFeatureBlocks(content);

  if (blocks.length === 0) {
    return {
      planPath,
      ok: false,
      featureCount: 0,
      violations: [
        {
          featureNumber: 0,
          featureName: "",
          missing: ["originTrace", "acceptance"],
        },
      ],
    };
  }

  const violations: Violation[] = [];
  for (const block of blocks) {
    const missing: Array<"originTrace" | "acceptance"> = [];
    if (!block.hasOriginTrace) missing.push("originTrace");
    if (!block.hasAcceptance) missing.push("acceptance");
    if (missing.length > 0) {
      violations.push({
        featureNumber: block.number,
        featureName: block.name,
        missing,
      });
    }
  }

  return {
    planPath,
    ok: violations.length === 0,
    featureCount: blocks.length,
    violations,
  };
}

function main(): number {
  const planPath = process.argv[2];
  if (!planPath) {
    process.stderr.write(
      "usage: validate-living-plan.ts <plan-path>\n",
    );
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

  if (report.ok) {
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
export type { Violation, ValidationReport };
