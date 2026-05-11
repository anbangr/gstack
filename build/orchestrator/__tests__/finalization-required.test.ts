/**
 * Feature 1 — FINALIZATION_REQUIRED constant: TDD red-phase tests.
 *
 * These tests MUST FAIL before implementation (the constant is not yet exported
 * from cli.ts and magic-13 literals have not been replaced).
 *
 * Why each test fails in red phase:
 *   T1  — FINALIZATION_REQUIRED is undefined (not exported) → toBe(13) fails
 *   T2  — magic `13` literals still exist in cli.ts source → regex matches found
 *   T3  — 13 === undefined is false → ternary yields "failed", not "paused"
 *   T5  — 13 === undefined is false → event = "failed", not "success"
 *   const-not-let edge — no `const FINALIZATION_REQUIRED =` in source yet
 *   undefined-doesnt-match edge — undefined === undefined is true (not false)
 *
 * After implementation (const exported, literals replaced), all tests pass.
 *
 * Import note: Bun throws a hard SyntaxError for static named imports of
 * non-existent exports. Using `import *` + property access gives `undefined`
 * in red phase without blowing up the module load.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cliModule from "../cli";

// FINALIZATION_REQUIRED will be `undefined` in red phase (not yet exported).
// After implementation it will be the number 13.
const FINALIZATION_REQUIRED: number | undefined = (
  cliModule as Record<string, unknown>
).FINALIZATION_REQUIRED as number | undefined;

const CLI_SRC = fs.readFileSync(
  path.resolve(import.meta.dir, "../cli.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// T1: Constant exported and equals 13
// ---------------------------------------------------------------------------
describe("T1: FINALIZATION_REQUIRED constant", () => {
  it("is exported from cli.ts and equals 13 (number)", () => {
    // Fails: FINALIZATION_REQUIRED is undefined before implementation
    expect(FINALIZATION_REQUIRED).toBe(13);
    expect(typeof FINALIZATION_REQUIRED).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// T2: No remaining magic `13` for finalization in cli.ts source
// ---------------------------------------------------------------------------
describe("T2: no remaining magic 13 in finalization context", () => {
  function nonCommentLines(src: string): string[] {
    return src.split("\n").filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
  }

  const codeLines = nonCommentLines(CLI_SRC);

  it("no `=== 13` literal in code lines (all replaced with constant)", () => {
    // Fails: lines ~7385 and ~7408 currently contain `=== 13`
    const matches = codeLines.filter((l) => /=== 13\b/.test(l));
    expect(matches).toHaveLength(0);
  });

  it("no `exitCode = 13` literal assignment in code lines", () => {
    // Fails: line ~7354 currently contains `exitCode = 13`
    const matches = codeLines.filter((l) => /\bexitCode\s*=\s*13\b/.test(l));
    expect(matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T3 / T4: Active-run status ternary classification (mirrors cli.ts finally block)
// ---------------------------------------------------------------------------
describe("T3 / T4: active-run status ternary", () => {
  function activeRunStatus(
    code: number | null | undefined,
  ): "paused" | "failed" {
    return code === 0 || code === FINALIZATION_REQUIRED ? "paused" : "failed";
  }

  it("T3: exit code 13 classifies as paused via FINALIZATION_REQUIRED", () => {
    // Red-phase fail: FINALIZATION_REQUIRED = undefined → 13 === undefined is false
    // → activeRunStatus(13) returns "failed", not "paused"
    expect(activeRunStatus(13)).toBe("paused");
  });

  it("T4: exit code 1 classifies as failed", () => {
    expect(activeRunStatus(1)).toBe("failed");
  });

  it("T4 (extra): exit code 2 classifies as failed", () => {
    expect(activeRunStatus(2)).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// T5: logActivity event classification (mirrors cli.ts:7408)
// ---------------------------------------------------------------------------
describe("T5: logActivity event classification", () => {
  function logActivityEvent(
    code: number | null | undefined,
  ): "success" | "failed" {
    return code === 0 || code === FINALIZATION_REQUIRED ? "success" : "failed";
  }

  it("exit code 13 logs as success via FINALIZATION_REQUIRED", () => {
    // Red-phase fail: FINALIZATION_REQUIRED = undefined → 13 === undefined is false
    // → event = "failed", not "success"
    expect(logActivityEvent(13)).toBe("success");
  });

  it("exit code 0 logs as success (unchanged)", () => {
    expect(logActivityEvent(0)).toBe("success");
  });

  it("exit code 1 logs as failed", () => {
    expect(logActivityEvent(1)).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("Edge cases", () => {
  it("exit code 0 still classifies as paused (0 === 0 path unchanged)", () => {
    const exitCode = 0;
    const status =
      exitCode === 0 || exitCode === FINALIZATION_REQUIRED
        ? "paused"
        : "failed";
    expect(status).toBe("paused");
  });

  it("null exit code does NOT match FINALIZATION_REQUIRED", () => {
    // null === undefined is false (strict equality) → passes even in red phase
    const exitCode: number | null = null;
    expect(exitCode === FINALIZATION_REQUIRED).toBe(false);
  });

  it("undefined exit code does NOT match FINALIZATION_REQUIRED", () => {
    // Red-phase fail: FINALIZATION_REQUIRED is undefined →
    //   undefined === undefined is true, but this test expects false.
    // After implementation: undefined === 13 is false → passes.
    const exitCode: number | null | undefined = undefined;
    expect(exitCode === FINALIZATION_REQUIRED).toBe(false);
  });

  it("negative exit codes do NOT match FINALIZATION_REQUIRED", () => {
    expect(-1 === FINALIZATION_REQUIRED).toBe(false);
    expect(-13 === FINALIZATION_REQUIRED).toBe(false);
  });

  it("FINALIZATION_REQUIRED is declared as const (not let) in cli.ts source", () => {
    // Red-phase fail: no FINALIZATION_REQUIRED declaration exists yet
    expect(CLI_SRC).toMatch(/\bconst\s+FINALIZATION_REQUIRED\s*=/);
    expect(CLI_SRC).not.toMatch(/\blet\s+FINALIZATION_REQUIRED\s*=/);
  });
});
