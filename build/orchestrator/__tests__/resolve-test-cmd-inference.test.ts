import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  inferTestCmdFromTouchedPaths,
  resolveTestCmdForPhase,
} from "../cli";
import type { Phase, PhaseState } from "../types";

function freshPhase(overrides?: Partial<Phase>): Phase {
  return {
    index: 0,
    number: "1.1",
    name: "fixture",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "F",
    implementationDone: false,
    reviewDone: false,
    testSpecDone: false,
    body: "",
    implementationCheckboxLine: 0,
    reviewCheckboxLine: 0,
    testSpecCheckboxLine: -1,
    dualImpl: false,
    ...overrides,
  };
}

function writeSubtreePkgJson(tmp: string, subtree: string) {
  const dir = path.join(tmp, subtree);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: subtree, scripts: { test: "vitest run" } }),
  );
}

describe("inferTestCmdFromTouchedPaths", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inf-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null on empty path list", () => {
    expect(inferTestCmdFromTouchedPaths([], tmp)).toBeNull();
  });

  test("returns null when paths share no common prefix dir", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    expect(
      inferTestCmdFromTouchedPaths(
        ["a/foo.test.ts", "b/bar.test.ts"],
        tmp,
      ),
    ).toBeNull();
  });

  test("returns null when common prefix has no package.json", () => {
    expect(
      inferTestCmdFromTouchedPaths(
        ["sidecar-v2/test/a.test.ts", "sidecar-v2/test/b.test.ts"],
        tmp,
      ),
    ).toBeNull();
  });

  test("infers npm --prefix when subtree package.json exists with test script", () => {
    writeSubtreePkgJson(tmp, "sidecar-v2");
    const result = inferTestCmdFromTouchedPaths(
      [
        "sidecar-v2/test/idempotency-replay.test.ts",
        "sidecar-v2/test/another.test.ts",
      ],
      tmp,
    );
    expect(result).toBe("npm --prefix sidecar-v2 test");
  });

  test("uses deepest common prefix when paths nest further", () => {
    writeSubtreePkgJson(tmp, "public-rpc-proxy");
    const result = inferTestCmdFromTouchedPaths(
      [
        "public-rpc-proxy/test/foo.test.ts",
        "public-rpc-proxy/test/bar.test.ts",
      ],
      tmp,
    );
    expect(result).toBe("npm --prefix public-rpc-proxy test");
  });

  test("returns null when subtree package.json has no test script", () => {
    const dir = path.join(tmp, "lib-x");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "lib-x", scripts: { build: "tsc" } }),
    );
    expect(
      inferTestCmdFromTouchedPaths(
        ["lib-x/test/a.test.ts", "lib-x/test/b.test.ts"],
        tmp,
      ),
    ).toBeNull();
  });
});

describe("resolveTestCmdForPhase priority", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtc-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("phase.testCmdOverride wins over everything", () => {
    writeSubtreePkgJson(tmp, "sidecar-v2");
    const phase = freshPhase({ testCmdOverride: "pytest -x" });
    const phaseState: PhaseState = {
      index: 0,
      number: "1.1",
      name: "fixture",
      status: "running",
      testWriterTouchedPaths: ["sidecar-v2/test/foo.test.ts"],
    };
    expect(
      resolveTestCmdForPhase(
        { testCmd: "npm test", testFramework: undefined } as any,
        tmp,
        phase,
        phaseState,
      ),
    ).toBe("pytest -x");
  });

  test("inference fires before global args.testCmd when subtree match", () => {
    writeSubtreePkgJson(tmp, "sidecar-v2");
    const phase = freshPhase();
    const phaseState: PhaseState = {
      index: 0,
      number: "1.1",
      name: "fixture",
      status: "running",
      testWriterTouchedPaths: [
        "sidecar-v2/test/a.test.ts",
        "sidecar-v2/test/b.test.ts",
      ],
    };
    expect(
      resolveTestCmdForPhase(
        { testCmd: "npm test" } as any,
        tmp,
        phase,
        phaseState,
      ),
    ).toBe("npm --prefix sidecar-v2 test");
  });

  test("falls through to args.testCmd when inference yields null", () => {
    const phase = freshPhase();
    const phaseState: PhaseState = {
      index: 0,
      number: "1.1",
      name: "fixture",
      status: "running",
      testWriterTouchedPaths: ["random/path.txt"],
    };
    expect(
      resolveTestCmdForPhase(
        { testCmd: "bun test" } as any,
        tmp,
        phase,
        phaseState,
      ),
    ).toBe("bun test");
  });

  test("works with phaseState undefined (backward compat)", () => {
    const phase = freshPhase();
    expect(
      resolveTestCmdForPhase(
        { testCmd: "bun test" } as any,
        tmp,
        phase,
      ),
    ).toBe("bun test");
  });

  test("inference rung skipped when testWriterTouchedPaths is empty", () => {
    writeSubtreePkgJson(tmp, "sidecar-v2");
    const phase = freshPhase();
    const phaseState: PhaseState = {
      index: 0,
      number: "1.1",
      name: "fixture",
      status: "running",
      testWriterTouchedPaths: [],
    };
    expect(
      resolveTestCmdForPhase(
        { testCmd: "bun test" } as any,
        tmp,
        phase,
        phaseState,
      ),
    ).toBe("bun test");
  });
});
