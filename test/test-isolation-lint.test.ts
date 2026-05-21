/**
 * Static-analysis test: every test file that triggers writes to
 * `~/.gstack/` (via the fault detector / monitor surface) must isolate
 * `GSTACK_HOME` to a tmpdir.
 *
 * Why this exists: the build/orchestrator/skill-fault-detector.ts
 * `appendAnalytics()` and `loadLearnedPatterns()` paths resolve
 * `${GSTACK_HOME:-~/.gstack}`. When a test file calls `detectSkillFaults()`
 * (or `evaluateMonitorOnce()`, which fans out to it) without setting
 * `GSTACK_HOME` to an isolated tmpdir, each test run appends a real fault
 * entry to the developer's `~/.gstack/analytics/skill-faults.jsonl`. This
 * happened in the wild: between 2026-05-11 and 2026-05-16 the file grew
 * to 7,091 entries (~2.2MB) before anyone noticed.
 *
 * Fix: `test/helpers/test-home.ts` exports `useIsolatedGstackHome()`
 * which sets a fresh tmpdir per test and cleans up. Any test that
 * triggers home writes MUST use it OR set `process.env.GSTACK_HOME` to
 * a tmpdir directly.
 *
 * The lint catches the class of bug — a new test file added later that
 * imports `detectSkillFaults` without isolation will fail this test.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const TEST_DIR = path.resolve(import.meta.dir);
// Also scan the orchestrator's __tests__ subdirectory. cli.test.ts there
// exercises evaluateMonitorOnce too and lives outside the top-level test/.
const ORCHESTRATOR_TEST_DIR = path.resolve(
  import.meta.dir,
  "..",
  "build",
  "orchestrator",
  "__tests__",
);

// Symbols whose use in a test file means it can write to ~/.gstack/.
// Direct callers of the detector + the monitor that fans out to it.
const HOME_WRITERS = [
  "appendAnalytics",
  "detectSkillFaults",
  "loadLearnedPatterns",
  "evaluateMonitorOnce",
];

/**
 * Two recognized isolation patterns:
 *
 *   1. Helper-level: imports `useIsolatedGstackHome` from `./helpers/test-home`
 *      (or a nested `test/helpers/test-home` path) AND either calls it at
 *      top-level or inside every home-writer describe block before tests.
 *
 *   2. beforeEach-level: a `beforeEach(...)` block that assigns
 *      `process.env.GSTACK_HOME = <something>`. The assignment must be
 *      inside the same block — per-test mutations in test bodies don't
 *      count because they only protect the test that does them, not the
 *      surrounding 50+ tests that don't.
 *
 * Per-test mutation inside a `test(...)` or `it(...)` body is explicitly
 * NOT accepted, because that protects only the test doing the assignment.
 */
function fileIsolatesGstackHome(src: string): boolean {
  // Pattern 1: file-level helper. The import line proves a real binding
  // (not a comment match); the call scan proves it fires before test bodies.
  const importsHelper =
    /import\s*\{[^}]*\buseIsolatedGstackHome\b[^}]*\}\s*from\s*["'](?:\.\/helpers\/test-home|(?:\.\.\/)+test\/helpers\/test-home)["']/.test(
      src,
    );
  const callsHelper = callsGstackHomeHelperOutsideTestBody(src);
  if (importsHelper && callsHelper) return true;

  // Pattern 2: a beforeEach block that sets GSTACK_HOME. Find every
  // `beforeEach(...)` and check whether the assignment lives inside the
  // same brace-balanced block. We scan rather than parse — bun:test
  // doesn't expose an AST and a real parser is overkill for one rule.
  const beforeEachRe = /\bbeforeEach\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = beforeEachRe.exec(src)) !== null) {
    const blockStart = m.index + m[0].length;
    // Walk forward, tracking brace depth, until we close the arrow body.
    let depth = 1;
    let i = blockStart;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = src.slice(blockStart, i - 1);
    if (/process\.env\.GSTACK_HOME\s*=/.test(body)) return true;
  }
  return false;
}

function callsGstackHomeHelperOutsideTestBody(src: string): boolean {
  if (hasTopLevelHelperCall(src)) return true;
  return everyHomeWriterDescribeHasHelper(src);
}

function everyHomeWriterDescribeHasHelper(src: string): boolean {
  const describeRe = /\bdescribe\s*\([^=]*?=>\s*\{/g;
  let m: RegExpExecArray | null;
  const topLevelDescribeRanges: { start: number; end: number }[] = [];

  while ((m = describeRe.exec(src)) !== null) {
    if (braceDepthBefore(src, m.index) !== 0) continue;
    const blockStart = m.index + m[0].length;
    const blockEnd = findMatchingBrace(src, blockStart);
    if (blockEnd == null) continue;
    topLevelDescribeRanges.push({ start: m.index, end: blockEnd + 1 });

    const body = src.slice(blockStart, blockEnd);
    if (containsHomeWriter(body) && !describeBodyCallsHelperBeforeTests(body)) {
      return false;
    }
  }

  if (topLevelDescribeRanges.length === 0) return false;

  const outsideDescribes = removeRanges(src, topLevelDescribeRanges);
  return !containsHomeWriter(outsideDescribes);
}

function hasTopLevelHelperCall(src: string): boolean {
  let depth = 0;
  for (const line of src.split("\n")) {
    if (
      depth === 0 &&
      helperCallRe().test(stripLineComment(line).trim())
    ) {
      return true;
    }
    depth += braceDelta(line);
  }
  return false;
}

function describeBodyCallsHelperBeforeTests(body: string): boolean {
  let depth = 0;
  for (const line of body.split("\n")) {
    const code = stripLineComment(line).trim();
    if (depth === 0) {
      if (/^(?:test|it)\s*\(/.test(code)) return false;
      if (helperCallRe().test(code)) return true;
    }
    depth += braceDelta(line);
  }
  return false;
}

function containsHomeWriter(src: string): boolean {
  const withoutImports = src.replace(
    /\bimport\s+[\s\S]*?\s+from\s*["'][^"']+["'];?/g,
    "",
  );
  return HOME_WRITERS.some((sym) =>
    new RegExp(`\\b${sym}\\b`).test(withoutImports),
  );
}

function helperCallRe(): RegExp {
  return /^(?:(?:const|let|var)\s+\w+\s*=\s*)?useIsolatedGstackHome\s*\(/;
}

function braceDepthBefore(src: string, end: number): number {
  let depth = 0;
  for (const line of src.slice(0, end).split("\n")) {
    depth += braceDelta(line);
  }
  return depth;
}

function removeRanges(
  src: string,
  ranges: { start: number; end: number }[],
): string {
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += src.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + src.slice(cursor);
}

function findMatchingBrace(src: string, blockStart: number): number | null {
  let depth = 1;
  for (let i = blockStart; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth === 0) return i;
  }
  return null;
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

function braceDelta(line: string): number {
  const code = stripLineComment(line);
  let delta = 0;
  for (const c of code) {
    if (c === "{") delta++;
    else if (c === "}") delta--;
  }
  return delta;
}

// This file itself names every home-writer symbol in `HOME_WRITERS` so the lint
// would flag itself if we didn't skip it.
const SELF = "test-isolation-lint.test.ts";

function collectFiles(dir: string): { dir: string; name: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts") && f !== SELF)
    .map((name) => ({ dir, name }));
}

describe("test isolation lint", () => {
  test("recognizes useIsolatedGstackHome imported from nested test directories", () => {
    const src = [
      'import { describe } from "bun:test";',
      'import { useIsolatedGstackHome } from "../../../test/helpers/test-home";',
      'import { detectSkillFaults } from "../skill-fault-detector";',
      'describe("nested", () => {',
      '  useIsolatedGstackHome("nested-");',
      '  test("case", () => detectSkillFaults({} as any));',
      "});",
    ].join("\n");

    expect(fileIsolatesGstackHome(src)).toBe(true);
  });

  test("recognizes top-level assigned useIsolatedGstackHome calls", () => {
    const src = [
      'import { describe, test } from "bun:test";',
      'import { useIsolatedGstackHome } from "../../../test/helpers/test-home";',
      'import { detectSkillFaults } from "../skill-fault-detector";',
      'const home = useIsolatedGstackHome("x-");',
      'describe("nested", () => {',
      '  test("case", () => detectSkillFaults({} as any));',
      "});",
    ].join("\n");

    expect(fileIsolatesGstackHome(src)).toBe(true);
  });

  test("rejects useIsolatedGstackHome called inside an individual test", () => {
    const src = [
      'import { describe, test } from "bun:test";',
      'import { useIsolatedGstackHome } from "../../../test/helpers/test-home";',
      'import { detectSkillFaults } from "../skill-fault-detector";',
      'describe("nested", () => {',
      '  test("case", () => {',
      '    useIsolatedGstackHome("bad-");',
      "    detectSkillFaults({} as any);",
      "  });",
      "});",
    ].join("\n");

    expect(fileIsolatesGstackHome(src)).toBe(false);
  });

  test("rejects sibling home-writer describes without local helper setup", () => {
    const src = [
      'import { describe, test } from "bun:test";',
      'import { useIsolatedGstackHome } from "../../../test/helpers/test-home";',
      'import { detectSkillFaults } from "../skill-fault-detector";',
      'describe("isolated", () => {',
      '  useIsolatedGstackHome("good-");',
      '  test("case", () => expect(true).toBe(true));',
      "});",
      'describe("not isolated", () => {',
      '  test("case", () => detectSkillFaults({} as any));',
      "});",
    ].join("\n");

    expect(fileIsolatesGstackHome(src)).toBe(false);
  });

  test("every test that writes to ~/.gstack/ also isolates GSTACK_HOME", () => {
    const entries = [
      ...collectFiles(TEST_DIR),
      ...collectFiles(ORCHESTRATOR_TEST_DIR),
    ];

    const offenders: { file: string; symbols: string[] }[] = [];
    for (const { dir, name } of entries) {
      const src = fs.readFileSync(path.join(dir, name), "utf-8");
      const triggers = HOME_WRITERS.filter((sym) => {
        // Word-boundary-ish: require non-word char before and after to avoid
        // false matches like "appendAnalyticsButDifferent".
        const re = new RegExp(`\\b${sym}\\b`);
        return re.test(src);
      });
      if (triggers.length === 0) continue;
      if (!fileIsolatesGstackHome(src)) {
        const relPath = path.relative(
          path.resolve(import.meta.dir, ".."),
          path.join(dir, name),
        );
        offenders.push({ file: relPath, symbols: triggers });
      }
    }

    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) => `  ${o.file} — uses ${o.symbols.join(", ")}`,
      );
      throw new Error(
        `These test files write to ~/.gstack/ without isolating GSTACK_HOME:\n${lines.join("\n")}\n\n` +
          `Fix: import \`useIsolatedGstackHome\` from \`./helpers/test-home\` and call it at the top of the file's describe() block. ` +
          `See test/skill-fault-detector.test.ts for a reference.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
