import * as fs from "node:fs";

export type RunnerKind =
  | "vitest"
  | "pytest"
  | "jest"
  | "bun"
  | "mocha"
  | "go";

export interface TestCountResult {
  collected: number;
  passed: number;
  failed: number;
  source: "json" | "stdout-fallback";
}

export interface RunnerResult {
  stdout: string;
  stderr?: string;
  /** pytest --json-report-file path */
  jsonReportPath?: string;
  /** bun --coverage JSON output path */
  coverageJsonPath?: string;
}

function combinedOutput(result: RunnerResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function objectField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countSummary(summary: Record<string, unknown>): TestCountResult {
  const passed = numberField(summary, "passed");
  const failed =
    numberField(summary, "failed") + numberField(summary, "error");
  return {
    collected:
      numberField(summary, "collected") || numberField(summary, "total"),
    passed,
    failed,
    source: "json",
  };
}

/** Find the first parseable line that looks like a JSON object ({...}). */
function findJsonObjectLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const parsed = safeParseJson(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function parseVitestJson(stdout: string): TestCountResult | null {
  const data = findJsonObjectLine(stdout);
  if (data && typeof data.numTotalTests === "number") {
    return {
      collected: data.numTotalTests,
      passed: numberField(data, "numPassedTests"),
      failed: numberField(data, "numFailedTests"),
      source: "json",
    };
  }
  return null;
}

function parsePytestJson(jsonPath: string): TestCountResult | null {
  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data = safeParseJson(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const report = data as Record<string, unknown>;
      const summary =
        objectField(report, "summary") ||
        objectField(objectField(report, "report") || {}, "summary");
      if (summary) return countSummary(summary);
    }
  } catch {
    // fall through
  }
  return null;
}

function parseJestJson(stdout: string): TestCountResult | null {
  const data = findJsonObjectLine(stdout);
  if (data && typeof data.numTotalTests === "number") {
    return {
      collected: data.numTotalTests,
      passed: numberField(data, "numPassedTests"),
      failed: numberField(data, "numFailedTests"),
      source: "json",
    };
  }
  return null;
}

function parseBunCoverageJson(coveragePath: string): TestCountResult | null {
  try {
    const raw = fs.readFileSync(coveragePath, "utf-8");
    const data = safeParseJson(raw);
    if (
      data &&
      typeof data === "object" &&
      "results" in data &&
      (data as Record<string, unknown>).results &&
      typeof (data as Record<string, unknown>).results === "object"
    ) {
      const results = (data as Record<string, unknown>)
        .results as Record<string, unknown>;
      if (typeof results.numTotalTests === "number") {
        return {
          collected: results.numTotalTests,
          passed: numberField(results, "numPassedTests"),
          failed: numberField(results, "numFailedTests"),
          source: "json",
        };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

// --- stdout fallback regex parsers ---

function parseMochaStdout(stdout: string): TestCountResult {
  const passing = stdout.match(/(\d+)\s+passing/);
  const failing = stdout.match(/(\d+)\s+failing/);
  const passed = passing ? parseInt(passing[1], 10) : 0;
  const failed = failing ? parseInt(failing[1], 10) : 0;
  return {
    collected: passed + failed,
    passed,
    failed,
    source: "stdout-fallback",
  };
}

function parseGoStdout(stdout: string): TestCountResult {
  const lines = stdout.split(/\r?\n/);
  let collected = 0;
  let failed = 0;
  let sawPackageResult = false;
  let sawFailedPackageResult = false;
  for (const line of lines) {
    // e.g. "--- PASS: TestFoo (0.01s)"
    const m = line.match(/^---\s+(PASS|FAIL):\s+\S+/);
    if (m) {
      collected++;
      if (m[1] === "FAIL") failed++;
    }
    if (/^(ok|FAIL)\s+\S+/.test(line) && !/\[no test files\]/.test(line)) {
      sawPackageResult = true;
      if (line.startsWith("FAIL")) sawFailedPackageResult = true;
    }
  }
  if (collected === 0 && sawPackageResult) {
    collected = 1;
    failed = sawFailedPackageResult ? 1 : 0;
  }
  return {
    collected,
    passed: Math.max(0, collected - failed),
    failed,
    source: "stdout-fallback",
  };
}

function parsePytestStdout(stdout: string): TestCountResult {
  // e.g. "collected 4 items" or "4 passed in 0.01s"
  const collectedMatch = stdout.match(/collected\s+(\d+)\s+item/);
  const passedMatch = stdout.match(/(\d+)\s+passed/);
  const failedMatch = stdout.match(/(\d+)\s+failed/);
  const errorMatch = stdout.match(/(\d+)\s+error/);
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed =
    (failedMatch ? parseInt(failedMatch[1], 10) : 0) +
    (errorMatch ? parseInt(errorMatch[1], 10) : 0);
  return {
    collected: collectedMatch ? parseInt(collectedMatch[1], 10) : passed + failed,
    passed,
    failed,
    source: "stdout-fallback",
  };
}

function parseBunStdout(stdout: string): TestCountResult {
  // e.g. "ran 8 tests across 2 files"
  const m = stdout.match(/ran\s+(\d+)\s+tests?\s+across/i);
  const collected = m ? parseInt(m[1], 10) : 0;
  return {
    collected,
    passed: collected,
    failed: 0,
    source: "stdout-fallback",
  };
}

function parseVitestStdout(stdout: string): TestCountResult {
  // e.g. "Tests  1 failed | 2 passed (3)"
  const summary = stdout.match(/Tests?\s+([^\n]+)/);
  const passedMatch = summary?.[1]?.match(/(\d+)\s+passed/);
  const failedMatch = summary?.[1]?.match(/(\d+)\s+failed/);
  const totalMatch = summary?.[1]?.match(/\((\d+)\)/);
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const collected = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;
  return {
    collected,
    passed,
    failed,
    source: "stdout-fallback",
  };
}

function parseJestStdout(stdout: string): TestCountResult {
  // e.g. "Tests:       9 passed, 9 total"
  const m = stdout.match(/(\d+)\s+passed,\s+(\d+)\s+total/);
  if (m) {
    const collected = parseInt(m[2], 10);
    const passed = parseInt(m[1], 10);
    return {
      collected,
      passed,
      failed: collected - passed,
      source: "stdout-fallback",
    };
  }
  return { collected: 0, passed: 0, failed: 0, source: "stdout-fallback" };
}

export function extractTestCount(
  runnerResult: RunnerResult,
  runner: RunnerKind | string,
): TestCountResult {
  const output = combinedOutput(runnerResult);
  switch (runner) {
    case "vitest": {
      const json = parseVitestJson(output);
      if (json) return json;
      return parseVitestStdout(output);
    }
    case "pytest": {
      if (runnerResult.jsonReportPath) {
        try {
          const json = parsePytestJson(runnerResult.jsonReportPath);
          if (json) return json;
        } finally {
          fs.rmSync(runnerResult.jsonReportPath, { force: true });
        }
      }
      return parsePytestStdout(output);
    }
    case "jest": {
      const json = parseJestJson(output);
      if (json) return json;
      return parseJestStdout(output);
    }
    case "bun": {
      if (runnerResult.coverageJsonPath) {
        const json = parseBunCoverageJson(runnerResult.coverageJsonPath);
        if (json) return json;
      }
      return parseBunStdout(output);
    }
    case "mocha": {
      return parseMochaStdout(output);
    }
    case "go": {
      return parseGoStdout(output);
    }
    default: {
      console.warn(
        `[extractTestCount] unrecognized runner "${runner}"; returning zero count with stdout-fallback`,
      );
      return {
        collected: 0,
        passed: 0,
        failed: 0,
        source: "stdout-fallback",
      };
    }
  }
}
