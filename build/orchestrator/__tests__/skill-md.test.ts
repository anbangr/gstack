import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

test("SKILL.md.tmpl contains TDD changes", () => {
  const tmplPath = path.join(os.homedir(), ".claude/skills/gstack/build/SKILL.md.tmpl");
  const content = fs.readFileSync(tmplPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('version: 1.14.0')).toBe(true);
  expect(content.includes('Verify Red')).toBe(true);
  expect(content.includes('Test Specification (Gemini Sub-agent)')).toBe(true);
});
