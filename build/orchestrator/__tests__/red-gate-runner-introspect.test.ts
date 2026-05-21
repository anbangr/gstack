import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Import the module-under-test. It does not yet exist — tests will fail
// at module-resolution time, which is the intended Red-phase TDD state.
import { extractTestCount, RunnerKind } from "../test-runner-introspect";

describe("extractTestCount — T1-T7 core cases", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rgri-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // T1: vitest JSON
  test("T1: vitest JSON output → collected, passed, failed, source=json", () => {
    const stdout = JSON.stringify({
      numTotalTests: 4,
      numPassedTests: 4,
      numFailedTests: 0,
    });
    const result = extractTestCount({ stdout }, "vitest");
    expect(result.collected).toBe(4);
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.source).toBe("json");
  });

  // T2: pytest JSON
  test("T2: pytest JSON report → collected, source=json", () => {
    const jsonPath = path.join(tmp, "pytest-report.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        report: {
          summary: {
            collected: 7,
            passed: 5,
            failed: 2,
          },
        },
      }),
    );
    const stdout = "========================= test session starts =========================\n";
    const result = extractTestCount({ stdout, jsonReportPath: jsonPath }, "pytest");
    expect(result.collected).toBe(7);
    expect(result.source).toBe("json");
  });

  // T3: jest JSON
  test("T3: jest --json output → collected, source=json", () => {
    const stdout = JSON.stringify({
      numTotalTests: 9,
      numPassedTests: 8,
      numFailedTests: 1,
    });
    const result = extractTestCount({ stdout }, "jest");
    expect(result.collected).toBe(9);
    expect(result.source).toBe("json");
  });

  // T4: bun test coverage JSON
  test("T4: bun --coverage JSON → parses, source=json", () => {
    const coveragePath = path.join(tmp, "bun-coverage.json");
    fs.writeFileSync(
      coveragePath,
      JSON.stringify({
        results: {
          numTotalTests: 6,
          numPassedTests: 5,
          numFailedTests: 1,
        },
      }),
    );
    const stdout = "";
    const result = extractTestCount(
      { stdout, coverageJsonPath: coveragePath },
      "bun",
    );
    expect(result.source).toBe("json");
    expect(result.collected).toBe(6);
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(1);
  });

  // T5: mocha fallback
  test("T5: mocha stdout-only → source=stdout-fallback, collected ≥ 3", () => {
    const stdout = "\n  3 passing (42ms)\n\n";
    const result = extractTestCount({ stdout }, "mocha");
    expect(result.source).toBe("stdout-fallback");
    expect(result.collected).toBeGreaterThanOrEqual(3);
  });

  // T6: go test fallback
  test("T6: go test stdout-only → source=stdout-fallback, best-effort count", () => {
    const stdout = "PASS\nok      github.com/example/pkg  0.123s\n";
    const result = extractTestCount({ stdout }, "go");
    expect(result.source).toBe("stdout-fallback");
    expect(typeof result.collected).toBe("number");
  });

  // T7: unrecognized runner
  test("T7: unrecognized runner → collected 0, source=stdout-fallback, warning", () => {
    const stdout = "some output";
    const warnSpy: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnSpy.push(args.map(String).join(" "));
    };
    try {
      const result = extractTestCount({ stdout }, "unknown" as RunnerKind);
      expect(result.collected).toBe(0);
      expect(result.source).toBe("stdout-fallback");
      expect(warnSpy.length).toBeGreaterThanOrEqual(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("extractTestCount — edge cases", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rgri-edge-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Edge: vitest with extra console.log lines before JSON
  test("edge: vitest console.log noise before JSON line → still finds JSON object", () => {
    const stdout = [
      "some setup log",
      "console.log from test harness",
      JSON.stringify({ numTotalTests: 5, numPassedTests: 3, numFailedTests: 2 }),
    ].join("\n");
    const result = extractTestCount({ stdout }, "vitest");
    expect(result.source).toBe("json");
    expect(result.collected).toBe(5);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(2);
  });

  // Edge: pytest JSON report file write failing → stdout fallback
  test("edge: pytest JSON report file missing → falls back to stdout regex", () => {
    const stdout =
      "========================= test session starts =========================\n" +
      "collected 4 items\n" +
      "4 passed in 0.01s\n";
    const missingPath = path.join(tmp, "does-not-exist.json");
    const result = extractTestCount(
      { stdout, jsonReportPath: missingPath },
      "pytest",
    );
    expect(result.source).toBe("stdout-fallback");
    expect(result.collected).toBeGreaterThanOrEqual(4);
  });

  test("edge: pytest JSON report file is cleaned up after parse", () => {
    const jsonPath = path.join(tmp, "pytest-report.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        report: { summary: { collected: 2, passed: 2, failed: 0 } },
      }),
    );

    const result = extractTestCount(
      { stdout: "", jsonReportPath: jsonPath },
      "pytest",
    );

    expect(result).toEqual({
      collected: 2,
      passed: 2,
      failed: 0,
      source: "json",
    });
    expect(fs.existsSync(jsonPath)).toBe(false);
  });

  test("edge: vitest skips invalid brace-like stdout before JSON", () => {
    const stdout = [
      "{not valid json}",
      JSON.stringify({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0 }),
    ].join("\n");

    const result = extractTestCount({ stdout }, "vitest");

    expect(result).toEqual({
      collected: 3,
      passed: 3,
      failed: 0,
      source: "json",
    });
  });

  // Edge: bun test with no --coverage flag → stdout regex fallback
  test("edge: bun test without --coverage → falls through to stdout regex", () => {
    const stdout = "bun test v1.0.0\n\nran 8 tests across 2 files\n";
    const result = extractTestCount({ stdout }, "bun");
    expect(result.source).toBe("stdout-fallback");
    expect(result.collected).toBeGreaterThanOrEqual(8);
  });
});

describe("RunnerKind type export", () => {
  test("RunnerKind union type is exported", () => {
    // Compile-time check: the type symbol must exist.
    // If the module is missing, this test file itself won't compile,
    // which is the intended Red-phase failure.
    const _kindCheck: RunnerKind = "vitest";
    expect(_kindCheck).toBe("vitest");
  });
});
