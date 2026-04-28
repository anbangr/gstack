import { describe, it, expect, afterEach } from 'bun:test';
import {
  parseVerdict,
  stripAnsi,
  detectTestCmd,
  parseFailureCount,
  parseJudgeVerdict,
  buildCodexImplArgv,
} from '../sub-agents';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    const colored = '\x1b[31mGATE FAIL\x1b[0m and then \x1b[32mGATE PASS\x1b[0m';
    expect(stripAnsi(colored)).toBe('GATE FAIL and then GATE PASS');
  });
  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
  it('handles complex sequences (cursor movement etc)', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Goutput\x1b[0m')).toBe('output');
  });
});

describe('parseVerdict', () => {
  it('returns pass when GATE PASS is the only verdict', () => {
    expect(parseVerdict('All checks complete. GATE PASS.')).toBe('pass');
  });
  it('returns fail when GATE FAIL is the only verdict', () => {
    expect(parseVerdict('Found 3 issues. GATE FAIL.')).toBe('fail');
  });
  it('returns unclear when neither keyword present', () => {
    expect(parseVerdict('Review complete. No issues found.')).toBe('unclear');
  });
  it('returns the LAST verdict when both keywords appear', () => {
    expect(parseVerdict('GATE FAIL first pass. After fix: GATE PASS')).toBe('pass');
    expect(parseVerdict('GATE PASS initially, then GATE FAIL on closer look')).toBe('fail');
  });
  it('strips ANSI before matching', () => {
    expect(parseVerdict('\x1b[32mGATE PASS\x1b[0m')).toBe('pass');
  });
  it('case-sensitive (lowercase gate pass does NOT match)', () => {
    // Per the convention in real plans — Codex emits the keyword in caps.
    expect(parseVerdict('gate pass')).toBe('unclear');
  });
});

describe('detectTestCmd', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns "bun test" when package.json has "test": "bun test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
    expect(detectTestCmd(tmpDir)).toBe('bun test');
  });

  it('returns "npm test" when package.json has "test": "npm test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'npm test' } }));
    expect(detectTestCmd(tmpDir)).toBe('npm test');
  });

  it('returns "pytest" when pytest.ini exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'pytest.ini'), '[pytest]');
    expect(detectTestCmd(tmpDir)).toBe('pytest');
  });

  it('returns "pytest" when pyproject.toml has [tool.pytest.ini_options]', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(detectTestCmd(tmpDir)).toBe('pytest');
  });

  it('returns "go test ./..." when go.mod exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\n');
    expect(detectTestCmd(tmpDir)).toBe('go test ./...');
  });

  it('returns "cargo test" when Cargo.toml exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\n');
    expect(detectTestCmd(tmpDir)).toBe('cargo test');
  });

  it('returns null when no known files exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    expect(detectTestCmd(tmpDir)).toBeNull();
  });
});

describe('parseFailureCount (dual-impl test outcome scoring)', () => {
  it('counts ✗ markers (bun-style)', () => {
    const out = '✗ test 1 failed\n✗ test 2 failed\n✗ test 3 failed\n';
    expect(parseFailureCount(out)).toBe(3);
  });

  it('counts FAIL markers (jest/pytest-style) when no ✗ present', () => {
    const out = 'PASS test 1\nFAIL test 2\nFAIL test 3\n';
    expect(parseFailureCount(out)).toBe(2);
  });

  it('returns 0 on output with no failure markers', () => {
    expect(parseFailureCount('All tests passed.')).toBe(0);
  });

  it('returns 0 on empty output', () => {
    expect(parseFailureCount('')).toBe(0);
  });

  it('uses larger of ✗ vs FAIL counts when both appear', () => {
    // Test runners sometimes emit both — pick whichever signal is stronger.
    const out = '✗ a\n✗ b\nFAIL c\n';
    expect(parseFailureCount(out)).toBe(2);
  });
});

describe('parseJudgeVerdict (Opus tournament judge output)', () => {
  it('extracts WINNER: gemini + REASONING from valid output', () => {
    const out = 'Reviewing both implementations...\nWINNER: gemini\nREASONING: cleaner code, fewer abstractions\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
    expect(result.reasoning).toContain('cleaner code');
  });

  it('extracts WINNER: codex + REASONING from valid output', () => {
    const out = 'WINNER: codex\nREASONING: handles edge cases better and is more concise';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.reasoning).toContain('edge cases');
  });

  it('falls back to gemini when WINNER line is missing', () => {
    const out = 'The judge output is malformed somehow';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
    expect(result.reasoning).toMatch(/no WINNER|malformed|fallback/i);
  });

  it('handles missing REASONING (still extracts verdict)', () => {
    const out = 'WINNER: codex\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.reasoning).toBe('');
  });

  it('case-insensitive WINNER value', () => {
    const out = 'WINNER: GEMINI\nREASONING: ok';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
  });
});

describe('buildCodexImplArgv (codex exec invocation shape)', () => {
  it('builds argv with exec + danger-full-access + worktree cwd', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/gstack-dual-myslug-p1-1234567890/gemini',
    });
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('-s');
    expect(argv).toContain('danger-full-access');
    expect(argv).toContain('-C');
    expect(argv).toContain('/tmp/gstack-dual-myslug-p1-1234567890/gemini');
  });

  it('embeds inputFilePath and outputFilePath into the prompt arg', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/MY_INPUT.md',
      outputFilePath: '/tmp/MY_OUTPUT.md',
      cwd: '/tmp/worktree',
    });
    // The prompt itself should reference both files (file-path I/O pattern)
    const prompt = argv[1];
    expect(prompt).toContain('/tmp/MY_INPUT.md');
    expect(prompt).toContain('/tmp/MY_OUTPUT.md');
  });
});
