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

import * as fs from 'node:fs';
import { parsePlan } from './parser';
import { flipCheckbox, flipPhaseCheckboxes, flipTestSpecCheckbox } from './plan-mutator';

const [planFile, stateFile] = process.argv.slice(2);
if (!planFile || !stateFile) {
  console.error('Usage: bun run backfill-checkboxes.ts <plan.md> <state.json>');
  process.exit(1);
}

const planContent = fs.readFileSync(planFile, 'utf8');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const { phases, warnings } = parsePlan(planContent);

if (warnings.length) {
  console.warn('Parser warnings:');
  warnings.forEach(w => console.warn(' ', w));
}

let flipped = 0;
let skipped = 0;
let errors = 0;

for (const phase of phases) {
  const phaseState = state.phases?.[phase.index];
  if (!phaseState || phaseState.status !== 'committed') {
    skipped++;
    continue;
  }

  // Test spec checkbox (only for TDD phases that actually ran the spec step)
  if (phase.testSpecCheckboxLine !== -1) {
    const r = flipCheckbox({
      planFile,
      lineNumber: phase.testSpecCheckboxLine,
      expectedMarker: '**Test Specification',
    });
    if (r.error) {
      console.error(`  Phase ${phase.number} test-spec: ${r.error}`);
      errors++;
    } else if (r.flipped) {
      console.log(`  ✓ Phase ${phase.number} (${phase.name}) — test-spec flipped`);
      flipped++;
    }
  }

  // Implementation + Review checkboxes
  const result = flipPhaseCheckboxes({
    planFile,
    implementationLine: phase.implementationCheckboxLine,
    reviewLine: phase.reviewCheckboxLine,
  });

  if (result.implementation.error) {
    console.error(`  Phase ${phase.number} impl: ${result.implementation.error}`);
    errors++;
  } else if (result.implementation.flipped) {
    console.log(`  ✓ Phase ${phase.number} (${phase.name}) — implementation flipped`);
    flipped++;
  }

  if (result.review.error) {
    console.error(`  Phase ${phase.number} review: ${result.review.error}`);
    errors++;
  } else if (result.review.flipped) {
    console.log(`  ✓ Phase ${phase.number} (${phase.name}) — review flipped`);
    flipped++;
  }
}

console.log(`\nDone. ${flipped} checkboxes flipped, ${skipped} phases skipped (not committed), ${errors} errors.`);
if (errors > 0) process.exit(1);
