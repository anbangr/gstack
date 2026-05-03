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
 *
 * Safety guarantees (each enforced explicitly here, not by convention):
 *   - Holds the orchestrator's exclusive lock for the entire mutation
 *     window. A concurrent gstack-build run cannot interleave its own
 *     atomic temp+rename writes against the same plan file.
 *   - Validates that <state.json>'s recorded planFile matches the
 *     <plan.md> argument. Passing a mismatched pair would silently mark
 *     a different plan complete.
 *   - Per-phase number guard: if state.phases[i].number disagrees with
 *     the parsed plan's phase[i].number (plan was reordered between
 *     runs), skips that phase with a warning rather than flipping the
 *     wrong checkboxes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parsePlan } from "./parser";
import { reconcilePhaseCheckboxes } from "./plan-mutator";
import { acquireLock, deriveSlug, releaseLock } from "./state";

const [planFileArg, stateFileArg] = process.argv.slice(2);
if (!planFileArg || !stateFileArg) {
  console.error("Usage: bun run backfill-checkboxes.ts <plan.md> <state.json>");
  process.exit(1);
}

// Resolve both paths up front so error messages and validation are
// unambiguous (no relative-path drift between cwd and argv).
const planFile = path.resolve(planFileArg);
const stateFile = path.resolve(stateFileArg);

let planContent: string;
try {
  planContent = fs.readFileSync(planFile, "utf8");
} catch (err) {
  console.error(
    `Failed to read plan file ${planFile}: ${(err as Error).message}`,
  );
  process.exit(1);
}

let state: any;
try {
  const raw = fs.readFileSync(stateFile, "utf8");
  state = JSON.parse(raw);
} catch (err) {
  console.error(
    `Failed to read or parse state file ${stateFile}: ${(err as Error).message}`,
  );
  console.error(
    "Hint: a crash mid-write to state.json can leave it truncated or invalid.",
  );
  process.exit(1);
}

// Validate that the state file actually belongs to this plan. Without this,
// passing a stale or mismatched <plan> <state> pair silently marks unrelated
// checkboxes complete. State.planFile is a string written by saveState().
if (typeof state.planFile === "string" && state.planFile.length > 0) {
  const statePlanResolved = path.resolve(state.planFile);
  if (statePlanResolved !== planFile) {
    console.error(`State file references a different plan than the argument:`);
    console.error(`  argv plan:        ${planFile}`);
    console.error(`  state.planFile:   ${statePlanResolved}`);
    console.error(
      "Refusing to mutate. Pass the matching <plan.md> <state.json> pair.",
    );
    process.exit(1);
  }
}

// Acquire the orchestrator's exclusive lock for the entire mutation window.
// readLockInfo() (the prior implementation) was TOCTOU: it observed the
// lock state at line N, then mutated at line M. A gstack-build process
// could acquireLock between N and M and start its own atomic temp+rename
// writes, race-clobbering this script's writes (or vice versa).
// acquireLock uses O_EXCL — the only way to actually serialize against
// the orchestrator.
const slug = deriveSlug(planFile);
if (!acquireLock(slug)) {
  console.error(
    `gstack-build holds the lock for this plan (slug=${slug}). Wait for it to finish, or remove the lock file if it is stale.`,
  );
  process.exit(1);
}

let exitCode = 0;
try {
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

    // Phase-number guard (mirrors cli.ts:reconcileCommittedCheckboxes).
    // If the plan was reordered or had phases inserted between runs,
    // state.phases[i].number stops matching the parsed plan's phase[i].number.
    // Without this guard, the backfill would flip checkboxes on the WRONG
    // phase silently. Skip with a warning instead.
    if (phaseState.number !== phase.number) {
      console.warn(
        `[backfill] index ${phase.index} mismatch: plan has phase ${phase.number} but state has phase ${phaseState.number} — skipping (plan reordered since last run?)`,
      );
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
    `\nDone. ${flipped} checkboxes flipped, ${skipped} phases skipped (not committed or plan-reorder mismatch), ${errors} errors.`,
  );
  if (errors > 0) exitCode = 1;
} finally {
  releaseLock(slug);
}

process.exit(exitCode);
