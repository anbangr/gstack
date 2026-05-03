/**
 * One-shot backfill: flip all checkboxes for phases that are already
 * `committed` in the JSON state but whose plan-markdown checkboxes
 * were never flipped (because MARK_COMPLETE was bypassed via direct
 * JSON state patching).
 *
 * Usage:
 *   bun run build/orchestrator/backfill-checkboxes.ts <plan.md> <state.json>
 *
 * Idempotent: already-checked boxes are skipped silently.
 */

import * as fs from "node:fs";
import { parsePlan } from "./parser";
import { reconcilePhaseCheckboxes } from "./plan-mutator";
import { deriveSlug, readLockInfo } from "./state";

const [planFile, stateFile] = process.argv.slice(2);
if (!planFile || !stateFile) {
  console.error("Usage: bun run backfill-checkboxes.ts <plan.md> <state.json>");
  process.exit(1);
}

// Refuse to run while gstack-build holds the lock — concurrent writes to
// the plan file would clobber each other's atomic temp+rename operations.
const slug = deriveSlug(planFile);
const lockInfo = readLockInfo(slug);
if (lockInfo !== null) {
  console.error(
    `gstack-build is currently running for this plan (${lockInfo}).`,
  );
  console.error(
    "Wait for it to finish, or remove the lock file if it is stale.",
  );
  process.exit(1);
}

const planContent = fs.readFileSync(planFile, "utf8");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const { phases, warnings } = parsePlan(planContent);

if (warnings.length) {
  console.warn("Parser warnings:");
  warnings.forEach((w) => console.warn(" ", w));
}

let flipped = 0;
let skipped = 0;
let errors = 0;

for (const phase of phases) {
  const phaseState = state.phases?.[phase.index];
  if (!phaseState || phaseState.status !== "committed") {
    skipped++;
    continue;
  }

  const { flipped: f, errors: errs } = reconcilePhaseCheckboxes(
    planFile,
    phase,
  );
  flipped += f;
  errors += errs.length;
  if (f > 0) {
    console.log(
      `  ✓ Phase ${phase.number} (${phase.name}) — ${f} checkbox(es) flipped`,
    );
  }
  for (const err of errs) {
    console.error(`  Phase ${phase.number}: ${err}`);
  }
}

console.log(
  `\nDone. ${flipped} checkboxes flipped, ${skipped} phases skipped (not committed), ${errors} errors.`,
);
if (errors > 0) process.exit(1);
