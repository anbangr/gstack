#!/usr/bin/env bun
/**
 * implement/loop.ts — deterministic phase-execution loop for /implement
 *
 * Usage:
 *   bun run implement/loop.ts [--plan=<path>] [--mode=normal|resume|reexamine]
 *
 * Modes:
 *   normal    — execute unchecked [ ] phases in order (default)
 *   resume    — alias for normal; finds first unchecked phase and continues
 *   reexamine — re-run every phase regardless of [x] status (full audit)
 *
 * The script never pauses to ask for confirmation. It exits non-zero if
 * a sub-agent fails, with a clear message and the exact resume command.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = 'normal' | 'resume' | 'reexamine';

interface Phase {
  number: number;
  name: string;
  /** Full markdown text from the ### Phase N: header to the next phase header */
  content: string;
  implDone: boolean;
  reviewDone: boolean;
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const planArg = argv.find(a => a.startsWith('--plan='))?.slice(7);
const rawMode = argv.find(a => a.startsWith('--mode='))?.slice(7) ?? 'normal';
// 'resume' and 'normal' are behaviourally identical (skip done phases)
const mode: Mode = rawMode === 'resume' ? 'normal' : rawMode as Mode;

// ── Plan file detection ───────────────────────────────────────────────────────

function findPlanFile(): string {
  if (planArg) {
    if (!fs.existsSync(planArg)) {
      console.error(`[loop] Plan file not found: ${planArg}`);
      process.exit(1);
    }
    return planArg;
  }
  const result = spawnSync(
    'bash', ['-c', 'ls -t plans/*-impl-plan-*.md 2>/dev/null | head -1'],
    { encoding: 'utf-8' },
  );
  const found = result.stdout.trim();
  if (!found) {
    console.error(
      '[loop] No impl plan found. Run /implement first, or pass --plan=<path>.',
    );
    process.exit(1);
  }
  return found;
}

// ── Phase parsing ─────────────────────────────────────────────────────────────

function parsePhases(markdown: string): Phase[] {
  const headerRe = /^### Phase (\d+):\s*(.+)$/gm;
  const matches = [...markdown.matchAll(headerRe)];
  return matches.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : markdown.length;
    const content = markdown.slice(start, end);
    return {
      number: parseInt(m[1], 10),
      name: m[2].trim(),
      content,
      implDone: /^- \[x\] \*\*Implementation/im.test(content),
      reviewDone: /^- \[x\] \*\*Review/im.test(content),
    };
  });
}

/** Text before the first ### Phase header — project goals, tech stack, etc. */
function extractPlanHeader(markdown: string): string {
  const firstPhase = markdown.search(/^### Phase \d+:/m);
  return firstPhase > 0 ? markdown.slice(0, firstPhase).trim() : '';
}

// ── Checkbox patching ─────────────────────────────────────────────────────────

function markCheckboxDone(
  planPath: string,
  phaseNumber: number,
  type: 'Implementation' | 'Review',
): void {
  const content = fs.readFileSync(planPath, 'utf-8');
  // Match the phase section (from its header to the next phase header or EOF)
  const phaseSectionRe = new RegExp(
    `(### Phase ${phaseNumber}:[\\s\\S]*?)(?=### Phase \\d+:|$)`,
  );
  const patched = content.replace(phaseSectionRe, section =>
    section.replace(
      new RegExp(`(- \\[ \\] \\*\\*${type})`, 'm'),
      `- [x] **${type}`,
    ),
  );
  if (patched === content) {
    console.warn(
      `[loop] Warning: could not mark Phase ${phaseNumber} ${type} done — checkbox not found`,
    );
    return;
  }
  fs.writeFileSync(planPath, patched, 'utf-8');
}

// ── Sub-agent: implementation ─────────────────────────────────────────────────

function buildImplPrompt(phase: Phase, planHeader: string, reexamine: boolean): string {
  const modeNote = reexamine
    ? 'You are AUDITING this phase. Verify the implementation is complete and correct. Fix anything missing or broken.'
    : 'Implement the tasks described in this phase.';

  return [
    modeNote,
    '',
    planHeader ? `## Project context\n\n${planHeader}\n` : '',
    phase.content,
    '## Rules',
    '- Use your tools (Read, Edit, Write, Bash, Glob, Grep) freely to explore the codebase.',
    '- Write the code, run tests, and fix any failures.',
    '- Commit your work to the current branch with a clear message.',
    '- Do NOT run /ship, /review, /qa, or open any PRs.',
    '- Do NOT ask for confirmation or pause for guidance — implement and commit, then stop.',
    '- If mcp__llm-bridge__ask_gemini is available, use it for heavy coding tasks (≤2 files per call).',
  ].filter(Boolean).join('\n');
}

function runImplementation(phase: Phase, planHeader: string, reexamine: boolean): boolean {
  const prompt = buildImplPrompt(phase, planHeader, reexamine);
  const promptFile = path.join(
    os.tmpdir(),
    `.impl-phase-${phase.number}-${Date.now()}.md`,
  );
  try {
    fs.writeFileSync(promptFile, prompt);
    console.log(`  → Spawning implementation sub-agent (Phase ${phase.number})...`);
    const result = spawnSync(
      'bash',
      ['-c', `cat "${promptFile}" | claude -p --dangerously-skip-permissions --max-turns 80`],
      { stdio: 'inherit', encoding: 'utf-8' },
    );
    return result.status === 0;
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* best-effort cleanup */ }
  }
}

// ── Sub-agent: review ─────────────────────────────────────────────────────────

function runReview(): boolean {
  console.log('  → Running codex /gstack-review...');
  const result = spawnSync('codex', ['/gstack-review'], { stdio: 'inherit' });
  return result.status === 0;
}

// ── Context save (best-effort) ────────────────────────────────────────────────

function contextSave(): void {
  spawnSync(
    'bash',
    ['-c', "claude --model sonnet -p /context-save 2>/dev/null || true"],
    { stdio: 'inherit' },
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const planPath = findPlanFile();
  const reexamine = mode === 'reexamine';

  console.log(`[loop] plan  : ${planPath}`);
  console.log(`[loop] mode  : ${rawMode}`);

  const markdown = fs.readFileSync(planPath, 'utf-8');
  const planHeader = extractPlanHeader(markdown);
  const phases = parsePhases(markdown);

  if (phases.length === 0) {
    console.error(
      '[loop] No phases found. Phases must follow the format: ### Phase N: Name',
    );
    process.exit(1);
  }

  console.log(`[loop] phases: ${phases.length}`);

  const bar = '═'.repeat(70);
  let executed = 0;

  for (const phase of phases) {
    // Re-read the plan each iteration so we see the latest checkbox state
    const fresh = parsePhases(fs.readFileSync(planPath, 'utf-8'))
      .find(p => p.number === phase.number) ?? phase;

    if (!reexamine && fresh.implDone && fresh.reviewDone) {
      console.log(`\n[loop] Phase ${phase.number}: ${phase.name} — already complete, skipping.`);
      continue;
    }

    console.log(`\n${bar}`);
    console.log(`[loop] Phase ${phase.number}/${phases.length}: ${phase.name}`);
    console.log(bar);

    // Implementation
    if (reexamine || !fresh.implDone) {
      const ok = runImplementation(fresh, planHeader, reexamine);
      if (!ok) {
        console.error(`\n[loop] FATAL: implementation sub-agent failed for Phase ${phase.number}.`);
        console.error(`[loop] Fix the issue manually, then resume with:`);
        console.error(`[loop]   bun run implement/loop.ts --plan=${planPath} --mode=resume`);
        process.exit(1);
      }
      markCheckboxDone(planPath, phase.number, 'Implementation');
    }

    // Review
    if (reexamine || !fresh.reviewDone) {
      const ok = runReview();
      if (!ok) {
        // Review failure is a warning, not fatal — log and continue
        console.warn(`[loop] WARNING: codex review failed for Phase ${phase.number}. Continuing.`);
      }
      markCheckboxDone(planPath, phase.number, 'Review');
    }

    contextSave();
    executed++;
  }

  console.log(`\n${bar}`);
  if (executed === 0) {
    console.log('[loop] All phases were already complete. Nothing to do.');
    console.log('[loop] To re-audit everything: bun run implement/loop.ts --mode=reexamine');
  } else {
    console.log(`[loop] Done. ${executed} of ${phases.length} phase(s) executed.`);
  }
}

main();
