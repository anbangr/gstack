/**
 * Static invariant tests for /spec (consolidates 13 gate-tier checks).
 *
 * Each test asserts a specific contract the spec/SKILL.md.tmpl must encode.
 * If the template drifts away from a contract, the test fails immediately —
 * no LLM, no E2E cost.
 *
 * Covers (W7 plan):
 *   spec-phase-gating       — Phase 1 hard gate ("no issue after first message")
 *   spec-phase4-revise      — Phase 4 "what did I get wrong" loop
 *   spec-dedupe-no-gh       — graceful skip on gh missing / unauth / rate-limit
 *   spec-dedupe-matches     — merge-with-or-file-new AskUserQuestion for matches
 *   spec-execute-dirty      — porcelain check + 3-path AUQ + TOCTOU re-check
 *   spec-execute-race       — unique branch spec/<slug>-$$ + SHA pin
 *   spec-quality-gate-fallback   — codex timeout/unavailable skip-with-warn
 *   spec-quality-gate-redaction  — fail-closed secret regex list + BLOCKED
 *   spec-quality-gate-secret-sink — invariant: raw spec not persisted on block
 *   spec-archive            — gstack-paths eval + atomic tmp/mv + PID suffix
 *   spec-archive-sync-exclusion  — /specs/ auto-exclude from sync allowlist
 *   spec-audit-flag         — flag routes to Audit/Cleanup template
 *   spec-concurrency        — PID suffix in branch + atomic archive write
 *   spec-plan-mode-detection — reads GSTACK_PLAN_MODE env
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = fs.readFileSync(path.join(ROOT, 'spec', 'SKILL.md.tmpl'), 'utf-8');

describe('/spec phase-gating', () => {
  test('HARD GATE prose forbids producing issue after first message', () => {
    expect(TMPL).toMatch(/HARD GATE.*Do NOT produce an issue after the first message/i);
    expect(TMPL).toMatch(/Always start with[\s\S]*?Phase 1/);
  });
  test('Phase 1 lists all five mandatory questions', () => {
    for (const q of ['Who', 'current behavior', 'should the behavior be', 'Why now', "we'll know it's done"]) {
      expect(TMPL.toLowerCase()).toContain(q.toLowerCase().replace("we'll know", 'know'));
    }
  });
});

describe('/spec Phase 4 revise loop', () => {
  test('Phase 4 asks "what did I get wrong" and iterates', () => {
    expect(TMPL).toMatch(/What did I get wrong\?/);
    expect(TMPL).toMatch(/Iterate until the user confirms/i);
  });
});

describe('/spec --dedupe gh failure handling', () => {
  test('handles gh-not-installed, unauthed, rate-limited paths', () => {
    // Template wraps gh in backticks: "`gh` not installed" or "`gh` is not installed".
    expect(TMPL).toMatch(/gh.{0,5}not installed/i);
    expect(TMPL).toMatch(/gh auth status[\s\S]*?not logged in/i);
    expect(TMPL).toMatch(/rate.?limit/i);
  });
  test('never blocks Phase 2 on dedupe failure', () => {
    expect(TMPL).toMatch(/best-effort.*Never block|Never block.*dedupe failure/i);
  });
  test('matches surface as AskUserQuestion with merge-or-file-new options', () => {
    // Template breaks the sentence across lines: "Found {N} similar\n  open issue(s):"
    expect(TMPL).toMatch(/Found \{N\} similar[\s\S]*?open issue/);
    expect(TMPL).toMatch(/Merge with one of these/);
    expect(TMPL).toMatch(/file a new spec anyway/);
  });
});

describe('/spec --execute dirty-worktree gate', () => {
  test('runs git status --porcelain before spawn', () => {
    expect(TMPL).toMatch(/git status --porcelain/);
  });
  test('offers 3-option AskUserQuestion (continue / stash / cancel)', () => {
    expect(TMPL).toMatch(/Continue.*uncommitted/i);
    expect(TMPL).toMatch(/Stash and restore/i);
    expect(TMPL).toMatch(/Cancel spawn/i);
  });
  test('TOCTOU re-check fires after AskUserQuestion answer', () => {
    expect(TMPL).toMatch(/TOCTOU.*re-?check|re-?run.*git status/i);
  });
});

describe('/spec --execute race + concurrency hardening', () => {
  test('captures SHA pin via git rev-parse HEAD (not "HEAD" string)', () => {
    expect(TMPL).toMatch(/PIN_SHA=\$\(git rev-parse HEAD\)/);
    expect(TMPL).toMatch(/git worktree add[^\n]*\$PIN_SHA/);
  });
  test('branch name includes PID suffix for concurrency safety', () => {
    expect(TMPL).toMatch(/SPAWN_BRANCH="spec\/\$\{SLUG_TITLE\}-\$\$"/);
  });
  test('worktree path includes PID suffix', () => {
    expect(TMPL).toMatch(/SPAWN_PATH=.*-\$\$/);
  });
});

describe('/spec quality gate fallback', () => {
  test('skips on codex timeout with explanatory message', () => {
    // Post-refactor: timeout message lives in the case "4)" branch.
    expect(TMPL).toMatch(/codex timed out.*2 min/i);
    // Template uses --no-gate to disable:
    expect(TMPL).toMatch(/--no-gate.{0,20}to disable/i);
  });
  test('skips on codex not installed / unauthed', () => {
    expect(TMPL).toMatch(/codex.*not installed/i);
    // Post-refactor: "not authenticated" replaces "auth.*failed" phrasing.
    expect(TMPL).toMatch(/not (installed|authenticated)/i);
  });
});

// Post-refactor (Increment 2, Task 2): secret regex patterns, hard delimiters,
// and inline dispatch logic moved to bin/codex-spec-gate.ts. Those contracts are
// tested in bin/codex-spec-gate.test.ts. The template must reference the library.
describe('/spec Phase 4.5 → shared library contract (Increment 2)', () => {
  test('Phase 4.5 invokes bin/codex-spec-gate.ts via bun run', () => {
    expect(TMPL).toMatch(/bun run.*codex-spec-gate\.ts/);
  });

  test('Phase 4.5 parses gate output as JSON with .score / .ambiguities / .blocked_reason', () => {
    expect(TMPL).toMatch(/jq -r '\.score/);
    expect(TMPL).toMatch(/jq -r '\.ambiguities/);
    expect(TMPL).toMatch(/jq -r '\.blocked_reason/);
  });

  test('Phase 4.5 handles all four gate exit codes (0, 2, 3, 4)', () => {
    expect(TMPL).toMatch(/case "\$_SPEC_GATE_EXIT"/);
    // 0=pass; 2=secret blocked; 3=codex unavailable; 4=timeout
    const caseBlock = TMPL.match(/case "\$_SPEC_GATE_EXIT"[\s\S]{0,800}/);
    expect(caseBlock).not.toBeNull();
    expect(caseBlock![0]).toMatch(/0\)/);
    expect(caseBlock![0]).toMatch(/2\)/);
    expect(caseBlock![0]).toMatch(/3\)/);
    expect(caseBlock![0]).toMatch(/4\)/);
  });

  test('block dispatch on secret match reports BLOCKED and exits non-zero', () => {
    // Template must surface the BLOCKED state from the library; old inline
    // "do NOT send the spec to codex" check now belongs to the library tests.
    expect(TMPL).toMatch(/Quality gate BLOCKED/);
    // Exit code 2 branch must propagate failure (exit 1).
    const exit2 = TMPL.match(/2\)[\s\S]{0,200}/);
    expect(exit2).not.toBeNull();
    expect(exit2![0]).toMatch(/exit 1/);
  });
});

describe('/spec quality gate secret-sink invariant', () => {
  test('declares "raw spec must NOT be persisted" invariant when redaction fires', () => {
    expect(TMPL).toMatch(/raw spec must NOT[\s\S]*be persisted/i);
  });
  test('Phase 4.5 BLOCKED path propagates failure and prevents Phase 5', () => {
    // Post-refactor: the library exits with code 2 on a secret match; the template
    // case "2)" branch echoes the reason and exits non-zero (exit 1) so Phase 5
    // never runs. "Stop. Do not proceed." was inline prose from the old dispatch.
    const m = TMPL.match(/Quality gate BLOCKED[\s\S]{0,600}/);
    expect(m).not.toBeNull();
    // exit 1 is the new "stop" signal — must appear within the 2) branch.
    expect(m![0]).toMatch(/exit 1/);
  });
});

describe('/spec archive', () => {
  test('uses eval $(gstack-paths) not hardcoded ~/.gstack/', () => {
    expect(TMPL).toMatch(/eval "\$\(.+gstack-paths\)"/);
    expect(TMPL).toMatch(/\$GSTACK_STATE_ROOT\/projects\/\$SLUG\/specs/);
    // No hardcoded ~/.gstack/projects path:
    expect(TMPL).not.toMatch(/~\/\.gstack\/projects\/\$SLUG\/specs/);
  });
  test('atomic write via .tmp + mv', () => {
    expect(TMPL).toMatch(/\$ARCHIVE_PATH\.tmp/);
    expect(TMPL).toMatch(/mv "\$ARCHIVE_PATH\.tmp" "\$ARCHIVE_PATH"/);
  });
  test('PID suffix in archive filename', () => {
    expect(TMPL).toMatch(/ARCHIVE_NAME=.*\$\$/);
  });
  test('frontmatter includes spec_issue_number for /ship integration', () => {
    expect(TMPL).toMatch(/spec_issue_number:/);
    expect(TMPL).toMatch(/spec_branch:/);
    expect(TMPL).toMatch(/spec_executed:/);
  });
});

describe('/spec archive sync exclusion', () => {
  test('/specs/ excluded from artifacts-sync by default; --sync-archive opt-in', () => {
    expect(TMPL).toMatch(/\/specs\/.*auto-excluded.*artifacts-sync|excluded from.*allowlist/i);
    expect(TMPL).toMatch(/--sync-archive/);
  });
});

describe('/spec --audit flag', () => {
  test('flag table includes --audit with routing to Audit template', () => {
    expect(TMPL).toMatch(/\| `--audit` \|/);
    expect(TMPL).toMatch(/Audit\/Cleanup template/);
  });
  test('Audit / Cleanup Issues section exists with --audit cross-reference', () => {
    expect(TMPL).toMatch(/### Audit \/ Cleanup Issues.*routed via.*--audit/);
  });
  test('--bug/--feature/--refactor flags NOT in table (dropped per DX14)', () => {
    expect(TMPL).not.toMatch(/\| `--bug` \|/);
    expect(TMPL).not.toMatch(/\| `--feature` \|/);
    expect(TMPL).not.toMatch(/\| `--refactor` \|/);
  });
});

describe('/spec plan-mode-aware Phase 5 (DX7/DX11/F1)', () => {
  test('reads GSTACK_PLAN_MODE env at Phase 5 dispatch', () => {
    expect(TMPL).toMatch(/GSTACK_PLAN_MODE/);
    expect(TMPL).toMatch(/plan-mode-aware default/i);
  });
  test('plan-mode active → file-only path; inactive → file + spawn', () => {
    expect(TMPL).toMatch(/GSTACK_PLAN_MODE=active.*file-only path/);
    expect(TMPL).toMatch(/GSTACK_PLAN_MODE=inactive.*file \+ spawn/);
  });
  test('--file-only / --no-execute / --plan-file override flags', () => {
    expect(TMPL).toMatch(/--file-only/);
    expect(TMPL).toMatch(/--no-execute/);
    expect(TMPL).toMatch(/--plan-file/);
  });
});

describe('/spec Phase 3 hard-grep with fallback', () => {
  test('Phase 3 mandates reading evidence before asking', () => {
    expect(TMPL).toMatch(/Mandatory:[\s\S]*MUST read at least one[\s\S]*evidence/i);
  });
  test('project-level fallback prose for prompts with no concrete file', () => {
    expect(TMPL).toMatch(/Project-level prompt/);
    expect(TMPL).toMatch(/I inspected the project structure/);
  });
  test('greenfield escape (no related evidence) is explicit', () => {
    expect(TMPL).toMatch(/genuinely cannot find any related evidence/i);
  });
});

describe('/spec concurrency safety (overlap with race; codex F5/F6/F10)', () => {
  test('two concurrent /spec runs get distinct branches via $$ PID', () => {
    expect(TMPL).toMatch(/SPAWN_BRANCH=.*\$\$/);
  });
  test('atomic archive write prevents JSONL/file interleave', () => {
    expect(TMPL).toMatch(/atomic.*rename|atomic write/i);
  });
});
