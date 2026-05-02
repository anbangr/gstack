import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

function readSkill(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

describe('gstack-upgrade skill', () => {
  test('git upgrades merge upstream into the local customized version', () => {
    const tmpl = readSkill('gstack-upgrade/SKILL.md.tmpl');

    expect(tmpl).toContain('preserve the user');
    expect(tmpl).toContain('git fetch origin main');
    expect(tmpl).toContain('git merge --no-edit origin/main');
    expect(tmpl).toContain('git switch "$CURRENT_BRANCH" 2>/dev/null || git switch -c "$CURRENT_BRANCH"');
    expect(tmpl).not.toContain('git reset --hard origin/main');
  });

  test('upgrade flow audits generated skills and custom preamble users', () => {
    const tmpl = readSkill('gstack-upgrade/SKILL.md.tmpl');

    expect(tmpl).toContain('Regenerate and audit skill consistency');
    expect(tmpl).toContain('bun run gen:skill-docs --host all');
    expect(tmpl).toContain('bun run skill:check');
    expect(tmpl).toContain('build/SKILL.md.tmpl');
    expect(tmpl).toContain('PREAMBLE placeholder');
  });
});
