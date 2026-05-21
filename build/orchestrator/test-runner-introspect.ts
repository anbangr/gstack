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
  /** pytest --json-report-file path */
  jsonReportPath?: string;
  /** bun --coverage JSON output path */
  coverageJsonPath?: string;
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
    if (
      data &&
      typeof data === "object" &&
      data.report &&
      typeof data.report === "object" &&
      (data.report as Record<string, unknown>).summary &&
      typeof (data.report as Record<string, unknown>).summary === "object"
    ) {
      const summary = (data.report as Record<string, unknown>)
        .summary as Record<string, unknown>;
      return {
        collected: numberField(summary, "collected"),
        passed: numberField(summary, "passed"),
        failed: numberField(summary, "failed"),
        source: "json",
      };
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
  const m = stdout.match(/(\d+)\s+passing/);
  const collected = m ? parseInt(m[1], 10) : 0;
  return {
    collected,
    passed: collected,
    failed: 0,
    source: "stdout-fallback",
  };
}

function parseGoStdout(stdout: string): TestCountResult {
  // Best-effort: count "PASS" lines or lines with test names.
  // If we see "PASS" or "ok", signal that tests ran.
  const lines = stdout.split(/\r?\n/);
  let collected = 0;
  for (const line of lines) {
    // e.g. "--- PASS: TestFoo (0.01s)"
    const m = line.match(/^---\s+(PASS|FAIL):\s+\S+/);
    if (m) collected++;
  }
  return {
    collected,
    passed: collected,
    failed: 0,
    source: "stdout-fallback",
  };
}

function parsePytestStdout(stdout: string): TestCountResult {
  // e.g. "collected 4 items" or "4 passed in 0.01s"
  const collectedMatch = stdout.match(/collected\s+(\d+)\s+item/);
  const passedMatch = stdout.match(/(\d+)\s+passed/);
  const failedMatch = stdout.match(/(\d+)\s+failed/);
  return {
    collected: collectedMatch ? parseInt(collectedMatch[1], 10) : (passedMatch ? parseInt(passedMatch[1], 10) : 0),
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    source: "stdout-fallback",
  };
}

function parseBunStdout(stdout: string): TestCountResult {
  // e.g. "ran 8 tests across 2 files"
  const m = stdout.match(/ran\s+(\d+)\s+tests?\s+across/);
  const collected = m ? parseInt(m[1], 10) : 0;
  return {
    collected,
    passed: collected,
    failed: 0,
    source: "stdout-fallback",
  };
}

function parseVitestStdout(stdout: string): TestCountResult {
  // e.g. "Test Files  2 passed (2)"
  const m = stdout.match(/Tests?\s+(\d+)\s+passed/);
  const collected = m ? parseInt(m[1], 10) : 0;
  return {
    collected,
    passed: collected,
    failed: 0,
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
  switch (runner) {
    case "vitest": {
      const json = parseVitestJson(runnerResult.stdout);
      if (json) return json;
      return parseVitestStdout(runnerResult.stdout);
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
      return parsePytestStdout(runnerResult.stdout);
    }
    case "jest": {
      const json = parseJestJson(runnerResult.stdout);
      if (json) return json;
      return parseJestStdout(runnerResult.stdout);
    }
    case "bun": {
      if (runnerResult.coverageJsonPath) {
        const json = parseBunCoverageJson(runnerResult.coverageJsonPath);
        if (json) return json;
      }
      return parseBunStdout(runnerResult.stdout);
    }
    case "mocha": {
      return parseMochaStdout(runnerResult.stdout);
    }
    case "go": {
      return parseGoStdout(runnerResult.stdout);
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
