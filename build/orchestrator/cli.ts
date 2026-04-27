#!/usr/bin/env bun
/**
 * gstack-build — code-driven phase orchestrator for the /build skill.
 *
 * Phase 1 scope: parse a plan file and print a status table. No execution yet.
 *
 *   gstack-build <plan-file> [--print-only]
 *
 * Later phases add: state persistence, sub-agent invocation, plan mutation,
 * gbrain integration, ship step.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parsePlan, isPhaseComplete } from './parser';

interface Args {
  planFile: string;
  printOnly: boolean;
  noResume: boolean;
  noGbrain: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    planFile: '',
    printOnly: false,
    noResume: false,
    noGbrain: false,
    dryRun: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print-only') args.printOnly = true;
    else if (a === '--no-resume' || a === '--restart') args.noResume = true;
    else if (a === '--no-gbrain') args.noGbrain = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    console.error('usage: gstack-build <plan-file> [--print-only] [--no-resume] [--no-gbrain] [--dry-run]');
    process.exit(2);
  }
  args.planFile = path.resolve(positional[0]);
  return args;
}

function printHelp() {
  console.log(`gstack-build — code-driven phase orchestrator

Usage:
  gstack-build <plan-file> [flags]

Flags:
  --print-only    Parse and show phase table; do not execute.
  --no-resume     Ignore any existing state file and start over.
  --no-gbrain     Skip gbrain persistence; use local JSON only.
  --dry-run       Walk state machine without invoking sub-agents.
  -h, --help      This help.

Plan file format: standard /build implementation plan with
  ### Phase N: <name>
  - [ ] **Implementation (Gemini Sub-agent)**: ...
  - [ ] **Review & QA (Codex Sub-agent)**: ...
`);
}

function printPhaseTable(phases: ReturnType<typeof parsePlan>['phases']) {
  if (phases.length === 0) {
    console.log('(no phases parsed)');
    return;
  }
  const numWidth = Math.max(5, ...phases.map((p) => p.number.length));
  const nameWidth = Math.max(20, ...phases.map((p) => p.name.length));

  const header = `  ${'Phase'.padEnd(numWidth)}  ${'Name'.padEnd(nameWidth)}  Impl  Review  Status`;
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const p of phases) {
    const impl = p.implementationDone ? '  ✓' : '  ·';
    const rev = p.reviewDone ? '  ✓ ' : '  · ';
    let status: string;
    if (isPhaseComplete(p)) status = 'done';
    else if (p.implementationDone || p.reviewDone) status = 'partial';
    else status = 'pending';
    console.log(`  ${p.number.padEnd(numWidth)}  ${p.name.padEnd(nameWidth)}  ${impl}   ${rev}  ${status}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.planFile)) {
    console.error(`plan file not found: ${args.planFile}`);
    process.exit(2);
  }

  const content = fs.readFileSync(args.planFile, 'utf8');
  const { phases, warnings } = parsePlan(content);

  console.log(`Plan: ${args.planFile}`);
  console.log(`Phases parsed: ${phases.length}`);
  console.log('');
  printPhaseTable(phases);

  if (warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (args.printOnly) {
    process.exit(0);
  }

  // Phase 1 stub: execution is not yet implemented.
  console.log('');
  console.log('execution loop not yet implemented (Phase 1 of orchestrator build)');
  console.log('use --print-only to suppress this stub message in scripts');
  process.exit(0);
}

main();
