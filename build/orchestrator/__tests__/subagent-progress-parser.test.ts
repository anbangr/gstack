import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseCodexLine,
  parseGeminiLine,
  parseKimiLine,
  parseClaudeLine,
  type ProgressEvent,
} from "../subagent-progress-parser";

const FIXTURE_ROOT = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "subagent-stdout",
);

interface GoldenRow {
  lineIndex: number;
  expected: Omit<ProgressEvent, "ts"> | null;
}

function loadFixture(name: string): { lines: string[]; rows: GoldenRow[] } {
  const text = fs.readFileSync(path.join(FIXTURE_ROOT, `${name}.txt`), "utf8");
  const golden = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, `${name}.golden.json`), "utf8"),
  ) as { rows: GoldenRow[] };
  return { lines: text.split("\n"), rows: golden.rows };
}

function assertRow(
  name: string,
  parser: (line: string, now: number) => ProgressEvent | null,
) {
  const { lines, rows } = loadFixture(name);
  const NOW = 1_000_000;
  for (const row of rows) {
    const line = lines[row.lineIndex];
    const got = parser(line, NOW);
    if (row.expected === null) {
      expect(got).toBeNull();
    } else {
      expect(got).not.toBeNull();
      expect(got!.event).toBe(row.expected.event);
      expect(got!.tool).toBe(row.expected.tool);
      expect(got!.bucket).toBe(row.expected.bucket);
      expect(got!.ts).toBe(NOW);
    }
  }
}

describe("parseCodexLine", () => {
  it("matches the golden fixture", () => {
    assertRow("codex", parseCodexLine);
  });
});

describe("parseGeminiLine", () => {
  it("matches the golden fixture", () => {
    assertRow("gemini", parseGeminiLine);
  });
});

describe("parseKimiLine", () => {
  it("returns null for all lines (silent by design)", () => {
    assertRow("kimi", parseKimiLine);
  });
});

describe("parseClaudeLine", () => {
  it("returns null for all lines (no stream-json yet)", () => {
    assertRow("claude", parseClaudeLine);
  });
});

describe("bucket gating", () => {
  it("returns null for a Gemini tool not in TOOL_BUCKET", () => {
    // 'image_generation' is a hypothetical tool not in TOOL_BUCKET.
    // Even if Gemini emits 'Tool: image_generation', parser must return
    // null so the watchdog falls back to legacy stallMs.
    const line = "Tool: image_generation";
    const got = parseGeminiLine(line, 1000);
    expect(got).toBeNull();
  });
});
