/**
 * One-shot backfill: flip all checkboxes for phases that are already
 * `committed` in the JSON state but whose plan-markdown checkboxes
 * were never flipped (because MARK_COMPLETE was bypassed via direct
 * JSON state patching).
 *
 * Usage:
 *   bun run build/orchestrator/backfill-checkboxes.ts <plan.md> <state.json> [--from-artifacts]
 *
 * Idempotent: already-checked boxes are skipped silently.
 *
 * `--from-artifacts` (opt-in): before the checkbox pass, scan the per-slug
 * log dir for `phase-N-{review|qa}-K-output.md` files and reconstruct
 * `state.phases[i].codexReview` when it is null/undefined. The artifacts
 * on disk are the ground truth (a manual `jq` reset of the JSON field
 * does not delete them). When reconstruction yields a populated
 * codexReview AND the phase status is committed, the checkbox pass then
 * flips the review/qa-row checkbox like it would on a clean run.
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
 *   - `--from-artifacts` NEVER clobbers a populated codexReview. Live
 *     data wins over filesystem-derived data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reconcileCodexReviewFromArtifacts } from "./artifact-reconcile";
import { parsePlan } from "./parser";
import { reconcilePhaseCheckboxes } from "./plan-mutator";
import {
  acquireLock,
  deriveSlug,
  logDir,
  releaseLock,
  statePath,
} from "./state";
import type { BuildState } from "./types";

interface ParsedArgs {
  planFile: string;
  stateFile: string;
  fromArtifacts: boolean;
}

/**
 * Parse argv into a {planFile, stateFile, fromArtifacts} record.
 * Exits the process with code 1 on missing required args. Exported for
 * tests; CLI users go through `main()`.
 */
export function parseBackfillArgs(argv: string[]): ParsedArgs | null {
  let planFile: string | undefined;
  let stateFile: string | undefined;
  let fromArtifacts = false;

  for (const a of argv) {
    if (a === "--from-artifacts") {
      fromArtifacts = true;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      return null;
    }
    if (!planFile) {
      planFile = a;
      continue;
    }
    if (!stateFile) {
      stateFile = a;
      continue;
    }
    console.error(`Unexpected extra positional argument: ${a}`);
    return null;
  }

  if (!planFile || !stateFile) {
    return null;
  }

  return {
    planFile: path.resolve(planFile),
    stateFile: path.resolve(stateFile),
    fromArtifacts,
  };
}

function printUsage(): void {
  console.error(
    "Usage: bun run backfill-checkboxes.ts <plan.md> <state.json> [--from-artifacts]",
  );
}

/**
 * Atomic state.json write. We deliberately do NOT route through state.ts's
 * `saveState`: that path runs `reconcileVisiblePlanState` as a side effect
 * via the `visiblePlanProjection` global, which is null in this standalone
 * script and would no-op anyway. Plus saveState performs gbrain mirroring
 * we don't want from a one-shot recovery tool. Temp+rename in the same dir
 * gives us atomicity without the implicit coupling.
 */
function writeStateAtomic(stateFile: string, state: BuildState): void {
  const dir = path.dirname(stateFile);
  const tmp = path.join(
    dir,
    `.${path.basename(stateFile)}.tmp.${process.pid}.${Date.now()}`,
  );
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

interface BackfillSummary {
  flipped: number;
  skipped: number;
  errors: number;
  artifactDerived: number;
}

/**
 * Run the backfill. Exported for tests; the CLI entry just wraps this.
 * Returns a summary; the process exit code is derived from `errors > 0`.
 */
export function runBackfill(args: ParsedArgs): BackfillSummary {
  const { planFile, stateFile, fromArtifacts } = args;

  let planContent: string;
  try {
    planContent = fs.readFileSync(planFile, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read plan file ${planFile}: ${(err as Error).message}`,
    );
  }

  let state: BuildState;
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    state = JSON.parse(raw) as BuildState;
  } catch (err) {
    throw new Error(
      `Failed to read or parse state file ${stateFile}: ${(err as Error).message}\nHint: a crash mid-write to state.json can leave it truncated or invalid.`,
    );
  }

  // Validate that the state file actually belongs to this plan. Without
  // this, passing a stale or mismatched <plan> <state> pair silently
  // marks unrelated checkboxes complete.
  if (typeof state.planFile === "string" && state.planFile.length > 0) {
    const statePlanResolved = path.resolve(state.planFile);
    if (statePlanResolved !== planFile) {
      throw new Error(
        `State file references a different plan than the argument:\n  argv plan:        ${planFile}\n  state.planFile:   ${statePlanResolved}\nRefusing to mutate. Pass the matching <plan.md> <state.json> pair.`,
      );
    }
  }

  // Acquire the orchestrator's exclusive lock for the entire mutation
  // window. acquireLock uses O_EXCL — the only way to actually serialize
  // against a concurrent gstack-build run.
  const slug = deriveSlug(planFile);
  if (!acquireLock(slug)) {
    throw new Error(
      `gstack-build holds the lock for this plan (slug=${slug}). Wait for it to finish, or remove the lock file if it is stale.`,
    );
  }

  let artifactDerived = 0;

  try {
    // Step A (opt-in): reconcile codexReview from on-disk artifacts BEFORE
    // the checkbox pass. If we successfully reconstruct codexReview for a
    // phase whose status is already "committed", the checkbox pass that
    // follows will now flip the review-row checkbox where previously it
    // would have skipped (or, in the legacy path, flipped a checkbox that
    // didn't reflect a real review).
    if (fromArtifacts) {
      const slugForLog = path.basename(stateFile, ".json");
      // Prefer the log dir derived from the state-file basename (matches
      // how cli.ts spawns review sub-agents), with a fallback to the slug
      // we computed from the plan-file path.
      const candidateDirs = [
        logDir(slugForLog),
        logDir(slug),
        // Final fallback: a sibling directory next to the state.json. This
        // is how some test fixtures lay out the artifacts.
        path.join(path.dirname(stateFile), path.basename(stateFile, ".json")),
      ];
      let chosenLogDir = candidateDirs[0];
      for (const d of candidateDirs) {
        if (fs.existsSync(d)) {
          chosenLogDir = d;
          break;
        }
      }

      const rows = reconcileCodexReviewFromArtifacts(state, chosenLogDir);
      for (const r of rows) {
        if (r.action === "derived") {
          artifactDerived++;
          const verdict = r.finalVerdict ?? "verdict-unknown";
          console.log(
            `  ⟳ Phase ${r.phaseNumber}: codexReview derived from ${r.reviewCount + r.qaCount + r.mergedCount} on-disk artifact(s) (review=${r.reviewCount}, qa=${r.qaCount}, merged=${r.mergedCount}, iterations=${r.iterations}, ${verdict})`,
          );
        }
      }
      if (artifactDerived > 0) {
        writeStateAtomic(stateFile, state);
      }
    }

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

    const artifactMsg = fromArtifacts
      ? `, ${artifactDerived} codexReview field(s) derived from artifacts`
      : "";
    console.log(
      `\nDone. ${flipped} checkboxes flipped, ${skipped} phases skipped (not committed or plan-reorder mismatch), ${errors} errors${artifactMsg}.`,
    );

    return { flipped, skipped, errors, artifactDerived };
  } finally {
    releaseLock(slug);
  }
}

// Mute the `statePath` import not being used. We pull it in so that callers
// who consume this module without the CLI surface (e.g. the reconcile
// subcommand in cli.ts, planned in a follow-up commit) can grab the canonical
// state path from one entry point. tsc with `noUnusedLocals` would otherwise
// drop this; ESM tree-shake handles real elimination.
void statePath;

// Run as a CLI when invoked directly. The `import.meta.main` check keeps
// the module importable from tests without spawning the side effects.
if ((import.meta as { main?: boolean }).main) {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (!parsed) {
    printUsage();
    process.exit(1);
  }
  try {
    const summary = runBackfill(parsed);
    process.exit(summary.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
