import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import {
  parseVerdict,
  stripAnsi,
  detectTestCmd,
  detectTestFramework,
  inspectProject,
  countTestFiles,
  frameworkToRunner,
  isKnownFramework,
  parseFailureCount,
  parseCoveragePercent,
  injectCoverageFlags,
  parseJudgeVerdict,
  buildCodexImplArgv,
  buildCodexReviewArgv,
  buildCodexFeatureReviewArgv,
  buildClaudeTaskArgv,
  buildKimiTaskArgv,
  buildRoleTaskArgv,
  isLikelyCodexTransportFailure,
  runCodexReview,
  runConfiguredRoleTask,
  runTests,
  runShip,
  runSlashCommand,
  mergeOutputFile,
  stageGeminiIO,
  resolveRoleTimeouts,
  resolveFallbackForConfigured,
  resolveFallbackForRoleTask,
  resolveTimeoutFallback,
  checkPhaseScope,
  spawnCaptured,
  type RunConfiguredRoleTaskOpts,
  type RunRoleTaskOpts,
} from "../sub-agents";
import { deriveGeminiTmpKey } from "../state";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PR4-rest: stub codex/gemini auth preflight off so tests that mock the
// bin via PATH don't get caught by the new preflight probe. Tests that
// specifically exercise the preflight live in
// __tests__/gemini-auth-preflight.test.ts.
let _origAuthPreflightEnv: string | undefined;
beforeAll(() => {
  _origAuthPreflightEnv = process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = "1";
});
afterAll(() => {
  if (_origAuthPreflightEnv === undefined) {
    delete process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  } else {
    process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = _origAuthPreflightEnv;
  }
});

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    const colored =
      "\x1b[31mGATE FAIL\x1b[0m and then \x1b[32mGATE PASS\x1b[0m";
    expect(stripAnsi(colored)).toBe("GATE FAIL and then GATE PASS");
  });
  it("leaves plain text alone", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
  it("handles complex sequences (cursor movement etc)", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Goutput\x1b[0m")).toBe("output");
  });
});

describe("parseVerdict", () => {
  it("returns pass when GATE PASS is the only verdict", () => {
    expect(parseVerdict("All checks complete. GATE PASS.")).toBe("pass");
  });
  it("returns fail when GATE FAIL is the only verdict", () => {
    expect(parseVerdict("Found 3 issues. GATE FAIL.")).toBe("fail");
  });
  it("returns unclear when neither keyword present", () => {
    expect(parseVerdict("Review complete. No issues found.")).toBe("unclear");
  });
  it("returns the LAST verdict when both keywords appear", () => {
    expect(parseVerdict("GATE FAIL first pass. After fix: GATE PASS")).toBe(
      "pass",
    );
    expect(
      parseVerdict("GATE PASS initially, then GATE FAIL on closer look"),
    ).toBe("fail");
  });
  it("strips ANSI before matching", () => {
    expect(parseVerdict("\x1b[32mGATE PASS\x1b[0m")).toBe("pass");
  });
  it("case-sensitive (lowercase gate pass does NOT match)", () => {
    // Per the convention in real plans — Codex emits the keyword in caps.
    expect(parseVerdict("gate pass")).toBe("unclear");
  });
});

describe("mergeOutputFile strict artifact mode", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not promote Claude tool chatter from stdout when the report file is empty", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-output-strict-"));
    const outputFilePath = path.join(tmpDir, "review-output.md");
    fs.writeFileSync(outputFilePath, "");

    const result = mergeOutputFile(
      {
        stdout: 'TaskOutput task: "bulk-tool-output"\nGATE PASS\n',
        stderr: 'TaskOutput stderr task: "bulk-tool-output"\nGATE FAIL\n',
        exitCode: 0,
        timedOut: false,
        logPath: path.join(tmpDir, "review.log"),
        durationMs: 12,
        retries: 0,
      },
      outputFilePath,
      {
        emptyFileIsError: true,
        emptyFileErrorLabel: "Claude output file",
      },
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Claude output file");
    expect(result.stderr).not.toContain("TaskOutput");
    expect(result.stderr).not.toContain("GATE PASS");
    expect(result.stderr).not.toContain("GATE FAIL");
    expect(parseVerdict(result.stdout)).toBe("unclear");
    expect(parseVerdict(`${result.stdout}\n${result.stderr}`)).toBe("unclear");
  });

  it("does not promote Claude tool chatter when the report file is missing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-output-missing-"));
    const outputFilePath = path.join(tmpDir, "missing-review-output.md");

    const result = mergeOutputFile(
      {
        stdout: 'TaskOutput task: "bulk-tool-output"\nGATE PASS\n',
        stderr: 'TaskOutput stderr task: "bulk-tool-output"\nGATE FAIL\n',
        exitCode: 0,
        timedOut: false,
        logPath: path.join(tmpDir, "review.log"),
        durationMs: 12,
        retries: 0,
      },
      outputFilePath,
      {
        emptyFileIsError: true,
        emptyFileErrorLabel: "Claude output file",
      },
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not readable");
    expect(result.stderr).not.toContain("TaskOutput");
    expect(result.stderr).not.toContain("GATE PASS");
    expect(result.stderr).not.toContain("GATE FAIL");
    expect(parseVerdict(`${result.stdout}\n${result.stderr}`)).toBe("unclear");
  });
});

describe("detectTestCmd", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns "bun test" when package.json has "test": "bun test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );
    expect(detectTestCmd(tmpDir)).toBe("bun test");
  });

  it('returns "npm test" when package.json has "test": "npm test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "npm test" } }),
    );
    expect(detectTestCmd(tmpDir)).toBe("npm test");
  });

  it('maps a raw package script with local binaries to "npm test" by default', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    expect(detectTestCmd(tmpDir)).toBe("npm test");
  });

  it("uses pnpm test when pnpm-lock.yaml exists and package script is raw", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    expect(detectTestCmd(tmpDir)).toBe("pnpm test");
  });

  it("uses bun run test when bun.lock exists and package script is raw", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "");
    expect(detectTestCmd(tmpDir)).toBe("bun run test");
  });

  it("uses yarn test when packageManager declares yarn and package script is raw", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        packageManager: "yarn@4.5.0",
        scripts: { test: "vitest run" },
      }),
    );
    expect(detectTestCmd(tmpDir)).toBe("yarn test");
  });

  it("uses bun run test when packageManager declares bun and package script is raw", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        packageManager: "bun@1.3.12",
        scripts: { test: "vitest run" },
      }),
    );
    expect(detectTestCmd(tmpDir)).toBe("bun run test");
  });

  it('returns "pytest" when pytest.ini exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]");
    expect(detectTestCmd(tmpDir)).toBe("pytest");
  });

  it('returns "pytest" when pyproject.toml has [tool.pytest.ini_options]', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "pyproject.toml"),
      "[tool.pytest.ini_options]\n",
    );
    expect(detectTestCmd(tmpDir)).toBe("pytest");
  });

  it('returns "go test ./..." when go.mod exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module test\n");
    expect(detectTestCmd(tmpDir)).toBe("go test ./...");
  });

  it('returns "cargo test" when Cargo.toml exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "[package]\n");
    expect(detectTestCmd(tmpDir)).toBe("cargo test");
  });

  it("returns null when no known files exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    expect(detectTestCmd(tmpDir)).toBeNull();
  });
});

describe("runTests", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs commands through a shell so quoted arguments survive", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-"));
    const result = await runTests({
      testCmd:
        'node -e "if (process.argv[1] !== \'hello world\') process.exit(7)" "hello world"',
      cwd: tmpDir,
      slug: "run-tests-quoted",
      phaseNumber: "1",
      iteration: 1,
    });

    expect(result.exitCode).toBe(0);
  });
});

describe("parseCoveragePercent", () => {
  it("parses jest/vitest Statements line", () => {
    const out = "Statements   : 87.5% ( 70/80 )";
    expect(parseCoveragePercent(out, "jest")).toBe(87.5);
  });

  it("parses jest with --coverage flag in testCmd", () => {
    const out = "Statements: 92.1%";
    expect(
      parseCoveragePercent(out, "jest --coverage --coverageReporters text"),
    ).toBe(92.1);
  });

  it("parses vitest coverage output", () => {
    const out = "Statements : 77.8%";
    expect(parseCoveragePercent(out, "vitest --coverage")).toBe(77.8);
  });

  it("parses bun test coverage line", () => {
    const out = "coverage: 82.3%";
    expect(parseCoveragePercent(out, "bun test")).toBe(82.3);
  });

  it("parses bun run test coverage line", () => {
    const out = "coverage: 64.0%";
    expect(parseCoveragePercent(out, "bun run test")).toBe(64.0);
  });

  it("parses pytest TOTAL line", () => {
    const out = "TOTAL   1000   200   80%";
    expect(parseCoveragePercent(out, "pytest")).toBe(80);
  });

  it("parses pytest with --cov flag in testCmd", () => {
    const out = "TOTAL   500   125   75%";
    expect(
      parseCoveragePercent(out, "pytest --cov --cov-report term-missing"),
    ).toBe(75);
  });

  it("parses go test coverage line", () => {
    const out = "ok  ./...  coverage: 72.3% of statements";
    expect(parseCoveragePercent(out, "go test ./...")).toBe(72.3);
  });

  it("returns null for cargo test (tarpaulin not guaranteed installed)", () => {
    const out = "running 5 tests\ntest result: ok. 5 passed; 0 failed";
    expect(parseCoveragePercent(out, "cargo test")).toBeNull();
  });

  it("returns null for unknown framework", () => {
    expect(parseCoveragePercent("some output", "make test")).toBeNull();
  });

  it("returns null when jest output has no Statements line", () => {
    expect(parseCoveragePercent("no coverage data here", "jest")).toBeNull();
  });

  it("returns null when bun test has no coverage line", () => {
    expect(parseCoveragePercent("5 pass 0 fail", "bun test")).toBeNull();
  });
});

describe("injectCoverageFlags", () => {
  it("appends --coverage to jest command", () => {
    expect(injectCoverageFlags("jest")).toBe(
      "jest --coverage --coverageReporters text",
    );
  });

  it("appends --coverage to vitest command", () => {
    expect(injectCoverageFlags("vitest run")).toBe("vitest run --coverage");
  });

  it("appends --coverage to bun test command", () => {
    expect(injectCoverageFlags("bun test")).toBe("bun test --coverage");
  });

  it("appends --coverage to bun run test command", () => {
    expect(injectCoverageFlags("bun run test")).toBe("bun run test --coverage");
  });

  it("appends --cov to pytest command", () => {
    expect(injectCoverageFlags("pytest")).toBe(
      "pytest --cov --cov-report term-missing",
    );
  });

  it("appends -cover to go test command", () => {
    expect(injectCoverageFlags("go test ./...")).toBe("go test ./... -cover");
  });

  it("is idempotent — does not double-add --coverage for jest", () => {
    expect(injectCoverageFlags("jest --coverage")).toBe("jest --coverage");
  });

  it("is idempotent — does not double-add --coverage for vitest", () => {
    expect(injectCoverageFlags("vitest --coverage")).toBe("vitest --coverage");
  });

  it("is idempotent — does not double-add --cov for pytest", () => {
    expect(injectCoverageFlags("pytest --cov")).toBe("pytest --cov");
  });

  it("is idempotent — does not double-add -cover for go test", () => {
    expect(injectCoverageFlags("go test ./... -cover")).toBe(
      "go test ./... -cover",
    );
  });

  it("returns unknown commands unchanged", () => {
    expect(injectCoverageFlags("make test")).toBe("make test");
    expect(injectCoverageFlags("cargo test")).toBe("cargo test");
    expect(injectCoverageFlags("npm test")).toBe("npm test");
  });
});

describe("parseFailureCount (dual-impl test outcome scoring)", () => {
  it("counts ✗ markers (bun-style)", () => {
    const out = "✗ test 1 failed\n✗ test 2 failed\n✗ test 3 failed\n";
    expect(parseFailureCount(out)).toBe(3);
  });

  it("counts FAIL markers (jest/pytest-style) when no ✗ present", () => {
    const out = "PASS test 1\nFAIL test 2\nFAIL test 3\n";
    expect(parseFailureCount(out)).toBe(2);
  });

  it("returns undefined on output with no failure markers (no signal)", () => {
    expect(parseFailureCount("All tests passed.")).toBeUndefined();
  });

  it("returns undefined on empty output", () => {
    expect(parseFailureCount("")).toBeUndefined();
  });

  it("uses larger of ✗ vs FAIL counts when both appear (no summary line)", () => {
    const out = "✗ a\n✗ b\nFAIL c\n";
    expect(parseFailureCount(out)).toBe(2);
  });

  it('prefers explicit summary line ("3 failed") over marker counts', () => {
    // bun summary line beats a few stray ✗ in stack traces
    const out = "✗ test 1\n✗ test 2\n--- summary ---\n3 failed, 1 passed\n";
    expect(parseFailureCount(out)).toBe(3);
  });

  it('matches pytest summary "===== 2 failed in 0.10s ====="', () => {
    const out = `FAILED test_foo.py::test_bar - AssertionError\nFAILED test_baz.py::test_qux - ValueError\n===== 2 failed in 0.10s =====\n`;
    expect(parseFailureCount(out)).toBe(2);
  });

  it('matches pytest summary with mixed pass/fail "===== 3 failed, 5 passed in 1.2s ====="', () => {
    const out = `===== 3 failed, 5 passed in 1.2s =====\n`;
    expect(parseFailureCount(out)).toBe(3);
  });

  it("counts FAILED markers as fallback when no summary line", () => {
    const out = "FAILED test_a\nFAILED test_b\nFAILED test_c\n";
    expect(parseFailureCount(out)).toBe(3);
  });
});

describe("parseJudgeVerdict (tournament judge output)", () => {
  it("extracts WINNER: primary + REASONING from valid output", () => {
    const out =
      "Reviewing both implementations...\nWINNER: primary\nREASONING: cleaner code, fewer abstractions\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("cleaner code");
  });

  it("extracts WINNER: secondary + REASONING from valid output", () => {
    const out =
      "WINNER: secondary\nREASONING: handles edge cases better and is more concise";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.reasoning).toContain("edge cases");
  });

  it("returns verdict=null when WINNER line is missing (caller must fail-closed)", () => {
    const out = "The judge output is malformed somehow";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBeNull();
    expect(result.reasoning).toMatch(/no anchored WINNER|fail-closed/i);
  });

  it("rejects legacy gemini/codex winner values", () => {
    expect(
      parseJudgeVerdict("WINNER: gemini\nREASONING: ok").verdict,
    ).toBeNull();
    expect(
      parseJudgeVerdict("WINNER: codex\nREASONING: ok").verdict,
    ).toBeNull();
  });

  it("returns verdict=null when WINNER appears mid-sentence (must be anchored)", () => {
    const out = "I think the WINNER: primary is the better choice here.";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBeNull();
  });

  it("handles missing REASONING (still extracts verdict)", () => {
    const out = "WINNER: secondary\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.reasoning).toBe("");
  });

  it("case-insensitive WINNER value", () => {
    const out = "WINNER: PRIMARY\nREASONING: ok";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
  });

  it("returns verdict=null for empty string (P2-3: emptyFileIsError stdout='' path)", () => {
    // mergeOutputFile sets stdout='' when the judge output file is empty.
    // parseJudgeVerdict must return null so the caller fails-closed (falls back
    // to gemini) rather than extracting a false WINNER from an error message.
    const result = parseJudgeVerdict("");
    expect(result.verdict).toBeNull();
  });

  it("returns verdict=null for diagnostic text that does not contain WINNER: (safety check)", () => {
    // Verify that the error message format used in the old code (before P2-3)
    // would not accidentally produce a verdict even if it appeared in stdout.
    const diagnosticMsg =
      "Judge did not write expected output to /tmp/judge-out.md. Original shell stdout:\nLoading model...";
    const result = parseJudgeVerdict(diagnosticMsg);
    expect(result.verdict).toBeNull();
  });

  it("extracts HARDENING notes when all three sections are present", () => {
    const out =
      "WINNER: primary\nREASONING: cleaner implementation\nHARDENING:\n- Handle null input in processPayment\n- Guard against empty worktree path\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("cleaner implementation");
    expect(result.hardeningNotes).toContain("Handle null input");
    expect(result.hardeningNotes).toContain(
      "Guard against empty worktree path",
    );
  });

  it("returns empty hardeningNotes when HARDENING section is absent", () => {
    const out = "WINNER: secondary\nREASONING: fewer abstractions\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.hardeningNotes).toBe("");
  });

  it("REASONING does not bleed into HARDENING section", () => {
    const out =
      "WINNER: primary\nREASONING: good structure\nHARDENING:\n- edge case A\n";
    const result = parseJudgeVerdict(out);
    expect(result.reasoning).not.toContain("edge case A");
    expect(result.hardeningNotes).toContain("edge case A");
  });

  it("extracts HARDENING when it appears before REASONING (order variation)", () => {
    const out =
      "WINNER: secondary\nHARDENING:\n- null check missing\nREASONING: overall better approach\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.hardeningNotes).toContain("null check missing");
    expect(result.reasoning).toContain("overall better approach");
  });

  it("parses correctly when input has Windows CRLF line endings", () => {
    const out =
      "WINNER: primary\r\nREASONING: clean impl\r\nHARDENING:\r\n- guard null path\r\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("clean impl");
    expect(result.hardeningNotes).toContain("guard null path");
  });

  it("HARDENING: -> none identified inline sentinel is captured and does not bleed into REASONING", () => {
    const out =
      "WINNER: secondary\n" +
      "REASONING: both implementations are clean with no major differences.\n" +
      "HARDENING: -> none identified\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.reasoning).not.toContain("none identified");
    expect(result.hardeningNotes).toContain("none identified");
  });

  it('REASONING does not truncate when "HARDENING:" appears mid-sentence in prose', () => {
    // Fix #3: tightened regex requires HARDENING: to be standalone or bullet-prefixed.
    // A sentence containing "HARDENING:" as prose should not end the REASONING block.
    const out =
      "WINNER: primary\n" +
      "REASONING: The key concern is HARDENING: this is prose, not a section. More text here.\n" +
      "HARDENING:\n" +
      "- actual hardening note\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("HARDENING: this is prose");
    expect(result.hardeningNotes).toContain("actual hardening note");
  });
});

describe("isLikelyCodexTransportFailure", () => {
  it("detects stream disconnects with TLS handshake EOF", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "",
        stderr:
          "ERROR: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses): tls handshake eof",
      }),
    ).toBe(true);
  });

  it("detects websocket connection failures", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "",
        stderr: "failed to connect to websocket: connection closed",
      }),
    ).toBe(true);
  });

  it("rejects normal review gate failures", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "Review found a correctness issue.\nGATE FAIL",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("rejects local sandbox permission failures", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "Chromium failed: mach_port_rendezvous Permission denied",
        stderr: "",
      }),
    ).toBe(false);
  });
});

describe("buildCodexImplArgv (codex exec invocation shape)", () => {
  it("builds argv with exec + workspace-write default + worktree cwd", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/gstack-dual-myslug-p1-1234567890/gemini",
    });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("-s");
    // Default is workspace-write — danger-full-access was unsafe in linked
    // worktrees (shared .git dir + remotes). Override via opts.sandbox or env.
    expect(argv).toContain("workspace-write");
    expect(argv).toContain("-C");
    expect(argv).toContain("/tmp/gstack-dual-myslug-p1-1234567890/gemini");
  });

  it("uses high reasoning effort (thinking mode) by default", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
  });

  it("honors opts.sandbox override (e.g. danger-full-access when explicitly opted in)", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      sandbox: "danger-full-access",
    });
    expect(argv).toContain("danger-full-access");
    expect(argv).not.toContain("workspace-write");
  });

  it("embeds inputFilePath and outputFilePath into the prompt arg", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/MY_INPUT.md",
      outputFilePath: "/tmp/MY_OUTPUT.md",
      cwd: "/tmp/worktree",
    });
    const prompt = argv[1];
    expect(prompt).toContain("/tmp/MY_INPUT.md");
    expect(prompt).toContain("/tmp/MY_OUTPUT.md");
  });

  it("includes -m <model> when model is specified", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      model: "codex-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("codex-model-under-test");
  });

  it("omits -m when model is not specified", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).not.toContain("-m");
  });

  it("-m appears before -s so model is set before sandbox flags", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      model: "codex-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    const sIdx = argv.indexOf("-s");
    expect(mIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(mIdx);
  });
});

describe("buildCodexReviewArgv (codex review invocation shape)", () => {
  it("uses high reasoning effort (thinking mode) by default", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
  });

  it("includes -m <model> when model is specified", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      model: "codex-review-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("codex-review-model-under-test");
  });

  it("omits -m when model is not specified", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).not.toContain("-m");
  });

  it("-m appears before -s so model is set before sandbox flags", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      model: "codex-review-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    const sIdx = argv.indexOf("-s");
    expect(mIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(mIdx);
  });

  it("embeds custom command in the prompt arg", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      command: "/gstack-qa",
    });
    const prompt = argv[1];
    expect(prompt).toContain("/gstack-qa");
    expect(prompt).not.toContain("/gstack-review");
  });

  it("honors sandbox override (read-only)", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      sandbox: "read-only",
    });
    expect(argv).toContain("read-only");
    expect(argv).not.toContain("workspace-write");
  });

  it("honors reasoning override (high overrides xhigh default)", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      reasoning: "high",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
    expect(argv).not.toContain('model_reasoning_effort="xhigh"');
  });

  describe("GSTACK_BUILD_CODEX_REVIEW_SANDBOX env var", () => {
    const ENV_VAR = "GSTACK_BUILD_CODEX_REVIEW_SANDBOX";
    afterEach(() => {
      delete process.env[ENV_VAR];
    });

    it("uses env var sandbox when opts.sandbox is not set", () => {
      process.env[ENV_VAR] = "danger-full-access";
      const argv = buildCodexReviewArgv({
        inputFilePath: "/tmp/review-in.md",
        outputFilePath: "/tmp/review-out.md",
        cwd: "/tmp/wt",
      });
      expect(argv).toContain("danger-full-access");
      expect(argv).not.toContain("workspace-write");
    });

    it("opts.sandbox takes precedence over env var", () => {
      process.env[ENV_VAR] = "danger-full-access";
      const argv = buildCodexReviewArgv({
        inputFilePath: "/tmp/review-in.md",
        outputFilePath: "/tmp/review-out.md",
        cwd: "/tmp/wt",
        sandbox: "read-only",
      });
      expect(argv).toContain("read-only");
      expect(argv).not.toContain("danger-full-access");
    });

    it("falls back to workspace-write when env var is unset", () => {
      const argv = buildCodexReviewArgv({
        inputFilePath: "/tmp/review-in.md",
        outputFilePath: "/tmp/review-out.md",
        cwd: "/tmp/wt",
      });
      expect(argv).toContain("workspace-write");
    });
  });
});

describe("buildCodexFeatureReviewArgv (feature-level reviewer invocation)", () => {
  // Why this exists: feature-review previously routed through runCodexImpl
  // (designed for the implementor half of a dual-impl tournament). The
  // implementor prompt + workspace-write sandbox combination produced an
  // infinite loop of TIMEOUT-rebranded UNCLEAR verdicts because codex wrote
  // implementor-shaped "files changed" prose, missing the `## VERDICT`
  // sentinel parser, and also edited audit files, tripping the post-agent
  // hygiene gate. The dedicated reviewer argv builder fixes both ends.
  it("defaults to workspace-write sandbox (read-only blocks the reviewer's own output file)", () => {
    // Earlier iteration of this code used `read-only`. Independent
    // adversarial reviews flagged it before ship: codex CLI v0.128+ treats
    // `-s read-only` as blocking ALL filesystem writes including the agreed
    // output file, which would produce empty staged output every iteration,
    // hit MISSING_VERDICT, and false-halt after 2 same-shape iterations.
    // Defense-in-depth is now: prompt instruction (don't edit) + hygiene
    // gate (catches mutations post-spawn) + same-shape repeat detector
    // (halts on persistent mutation pattern).
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).toContain("workspace-write");
    expect(argv).not.toContain("read-only");
    expect(argv).not.toContain("danger-full-access");
  });

  it("instructs codex to write the `## VERDICT` sentinel with one of the three feature verdicts", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    const prompt = argv[1];
    expect(prompt).toContain("## VERDICT");
    expect(prompt).toContain("FEATURE_PASS");
    expect(prompt).toContain("FEATURE_NEEDS_PHASES");
    expect(prompt).toContain("FEATURE_REDO");
    // Findings section is also part of the contract.
    expect(prompt).toContain("## Findings");
  });

  it("tells codex it is a REVIEWER and not to edit files", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    const prompt = argv[1];
    expect(prompt).toContain("reviewer");
    expect(prompt.toLowerCase()).toContain("do not edit");
    // No "Implement the changes autonomously" — that's the implementor mode.
    expect(prompt).not.toContain("Implement the changes autonomously");
  });

  it("embeds the inputFilePath and outputFilePath in the prompt", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/REVIEW_BRIEF.md",
      outputFilePath: "/tmp/REVIEW_REPORT.md",
      cwd: "/tmp/wt",
    });
    const prompt = argv[1];
    expect(prompt).toContain("/tmp/REVIEW_BRIEF.md");
    expect(prompt).toContain("/tmp/REVIEW_REPORT.md");
  });

  it("uses high reasoning effort by default", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
  });

  it("honors opts.reasoning override (e.g. medium for cycle-1 fast pass)", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      reasoning: "medium",
    });
    expect(argv).toContain('model_reasoning_effort="medium"');
    expect(argv).not.toContain('model_reasoning_effort="high"');
  });

  it("honors opts.reasoning xhigh for deep-thought escalations", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      reasoning: "xhigh",
    });
    expect(argv).toContain('model_reasoning_effort="xhigh"');
  });

  it("honors opts.sandbox override (e.g. read-only when caller knows it's safe)", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      sandbox: "read-only",
    });
    expect(argv).toContain("read-only");
    expect(argv).not.toContain("workspace-write");
  });

  it("includes -m <model> when model is specified, -m before -s", () => {
    const argv = buildCodexFeatureReviewArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      model: "gpt-feature-reviewer",
    });
    const mIdx = argv.indexOf("-m");
    const sIdx = argv.indexOf("-s");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("gpt-feature-reviewer");
    expect(sIdx).toBeGreaterThan(mIdx);
  });

  describe("GSTACK_BUILD_CODEX_FEATURE_REVIEW_SANDBOX env var", () => {
    const ENV_VAR = "GSTACK_BUILD_CODEX_FEATURE_REVIEW_SANDBOX";
    afterEach(() => {
      delete process.env[ENV_VAR];
    });

    it("uses env var sandbox when opts.sandbox is not set", () => {
      process.env[ENV_VAR] = "read-only";
      const argv = buildCodexFeatureReviewArgv({
        inputFilePath: "/tmp/in.md",
        outputFilePath: "/tmp/out.md",
        cwd: "/tmp/wt",
      });
      expect(argv).toContain("read-only");
      expect(argv).not.toContain("workspace-write");
    });

    it("opts.sandbox takes precedence over env var", () => {
      process.env[ENV_VAR] = "danger-full-access";
      const argv = buildCodexFeatureReviewArgv({
        inputFilePath: "/tmp/in.md",
        outputFilePath: "/tmp/out.md",
        cwd: "/tmp/wt",
        sandbox: "read-only",
      });
      expect(argv).toContain("read-only");
      expect(argv).not.toContain("danger-full-access");
    });

    it("falls back to workspace-write when env var is unset", () => {
      const argv = buildCodexFeatureReviewArgv({
        inputFilePath: "/tmp/in.md",
        outputFilePath: "/tmp/out.md",
        cwd: "/tmp/wt",
      });
      expect(argv).toContain("workspace-write");
    });
  });
});

describe("runCodexReview no-verdict retry (broader transient class)", () => {
  // Fix A from the Codex-review-recurring-failure investigation: a non-zero
  // exit with NO GATE PASS/FAIL marker in the output is "no verdict" — a
  // transport-layer artifact, not a real review verdict. Common shape: HTTP
  // 403 / 429 / 5xx blips, crashes mid-write, the well-known "stream
  // disconnected" string is one specific case the existing regex catches,
  // but the broader class (any non-zero with no verdict) was failing every
  // time without retry. Pre-fix: phase 1.2 in the AGNT2 build dropped to
  // failed on Codex 403. Post-fix: retries once with cleared staged output;
  // second attempt's GATE PASS advances the phase.
  it("retries once when Codex exits non-zero without writing a verdict", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-noverdict-"));
    const slug = `codex-noverdict-${process.pid}-${Date.now()}`;
    const oldPath = process.env.PATH;
    try {
      const fakeCodex = path.join(tmpDir, "codex");
      const callsPath = path.join(tmpDir, "calls.txt");
      // First call: exit 1 with a 403-shaped error in stderr, NO verdict in
      // output file (the failure mode from AGNT2 phase 1.2). Second call:
      // succeeds with GATE PASS — proves retry is wired and clears stale
      // output.
      fs.writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[1] || "";
const match = prompt.match(/Write your full review report to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
const outputPath = match[1];
const callCount = fs.existsSync("${callsPath}") ? Number(fs.readFileSync("${callsPath}", "utf8")) : 0;
fs.writeFileSync("${callsPath}", String(callCount + 1));
if (callCount === 0) {
  // No verdict in output. Stderr names a 403, which the existing
  // transport-failure regex does NOT match. The fix detects this via
  // "non-zero exit + no verdict in output."
  fs.writeFileSync(outputPath, "Connection failed.\\n");
  console.error("ERROR: HTTP 403 Forbidden from codex backend (auth refresh in flight)");
  process.exit(1);
}
if (fs.readFileSync(outputPath, "utf8") !== "") {
  console.error("staged output was not cleared before retry");
  process.exit(3);
}
fs.writeFileSync(outputPath, "GATE PASS\\n");
process.stdout.write(outputPath);
`,
      );
      fs.chmodSync(fakeCodex, 0o755);
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath ?? ""}`;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "review context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runCodexReview({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        phaseNumber: "1",
        iteration: 1,
        command: "/review",
        logPrefix: "review",
        gate: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.retries).toBe(1);
      expect(result.stdout).toBe("GATE PASS\n");
      expect(fs.readFileSync(callsPath, "utf8")).toBe("2");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("GATE PASS\n");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
    }
  });

  it("does NOT retry when Codex exits non-zero WITH a verdict (real review failure)", async () => {
    // Guardrail: a real GATE FAIL must not be retried — that's the agent
    // doing its job. Only no-verdict failures retry.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-realfail-"));
    const slug = `codex-realfail-${process.pid}-${Date.now()}`;
    const oldPath = process.env.PATH;
    try {
      const fakeCodex = path.join(tmpDir, "codex");
      const callsPath = path.join(tmpDir, "calls.txt");
      fs.writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[1] || "";
const match = prompt.match(/Write your full review report to (.+?\\.md)\\./);
if (!match) process.exit(2);
const callCount = fs.existsSync("${callsPath}") ? Number(fs.readFileSync("${callsPath}", "utf8")) : 0;
fs.writeFileSync("${callsPath}", String(callCount + 1));
fs.writeFileSync(match[1], "Review found a real bug.\\nGATE FAIL\\n");
process.exit(1);
`,
      );
      fs.chmodSync(fakeCodex, 0o755);
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath ?? ""}`;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "review context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runCodexReview({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        phaseNumber: "1",
        iteration: 1,
        command: "/review",
        logPrefix: "review",
        gate: true,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.retries ?? 0).toBe(0);
      expect(fs.readFileSync(callsPath, "utf8")).toBe("1");
      expect(result.stdout).toContain("GATE FAIL");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runCodexReview transport retry", () => {
  it("retries once on transient Codex transport failure using the same output protocol", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-"));
    const slug = `codex-review-${process.pid}-${Date.now()}`;
    const oldPath = process.env.PATH;
    try {
      const fakeCodex = path.join(tmpDir, "codex");
      const callsPath = path.join(tmpDir, "calls.txt");
      fs.writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[1] || "";
const match = prompt.match(/Write your full review report to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
const outputPath = match[1];
const callCount = fs.existsSync("${callsPath}") ? Number(fs.readFileSync("${callsPath}", "utf8")) : 0;
fs.writeFileSync("${callsPath}", String(callCount + 1));
if (callCount === 0) {
  fs.writeFileSync(outputPath, "STALE GATE FAIL\\n");
  console.error("ERROR: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses): tls handshake eof");
  process.exit(1);
}
if (fs.readFileSync(outputPath, "utf8") !== "") {
  console.error("staged output was not cleared before retry");
  process.exit(3);
}
fs.writeFileSync(outputPath, "GATE PASS\\n");
process.stdout.write(outputPath);
`,
      );
      fs.chmodSync(fakeCodex, 0o755);
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath ?? ""}`;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "review context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runCodexReview({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        phaseNumber: "1",
        iteration: 1,
        command: "/review",
        logPrefix: "review",
        gate: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.retries).toBe(1);
      expect(result.logPath).toContain("transport-retry");
      expect(result.stdout).toBe("GATE PASS\n");
      expect(fs.readFileSync(callsPath, "utf8")).toBe("2");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("GATE PASS\n");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("buildClaudeTaskArgv (claude role invocation shape)", () => {
  it("builds a configured /review gate prompt with xhigh thinking", () => {
    const argv = buildClaudeTaskArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      command: "/review",
      model: "role-model-under-test",
      reasoning: "xhigh",
      gate: true,
    });
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("role-model-under-test");
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("Use xhigh thinking");
    expect(prompt).toContain("/review");
    expect(prompt).toContain("GATE PASS");
    expect(prompt).toContain("Do not print the report to stdout");
    expect(prompt).toContain("If you cannot write /tmp/review-out.md");
  });

  it("builds a configured /codex review second-opinion prompt", () => {
    const argv = buildClaudeTaskArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      command: "/codex review",
      model: "role-model-under-test",
      reasoning: "xhigh",
      gate: true,
    });
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("/codex review");
  });
});

describe("buildRoleTaskArgv", () => {
  it("builds a configured /ship prompt with file-path I/O and yolo", () => {
    const argv = buildRoleTaskArgv({
      inputFilePath: "/tmp/ship-in.md",
      outputFilePath: "/tmp/ship-out.md",
      command: "/ship",
      model: "role-model-under-test",
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("role-model-under-test");
    expect(argv).toContain("--yolo");
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("Read instructions at /tmp/ship-in.md");
    expect(prompt).toContain("Run /ship");
    expect(prompt).toContain("Write your complete output to /tmp/ship-out.md");
  });

  it("includes a gate verdict instruction when requested", () => {
    const argv = buildRoleTaskArgv({
      inputFilePath: "/tmp/role-in.md",
      outputFilePath: "/tmp/role-out.md",
      command: "/review",
      model: "role-model-under-test",
      gate: true,
    });
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("GATE PASS");
    expect(prompt).toContain("GATE FAIL");
    expect(prompt).toContain("Write your complete output to /tmp/role-out.md");
  });
});

describe("buildKimiTaskArgv", () => {
  it("builds a Kimi file-path prompt with workspace scoping and print mode", () => {
    const argv = buildKimiTaskArgv({
      workDir: "/repo",
      addDir: "/tmp/kimi-stage",
      inputFilePath: "/tmp/kimi-stage/ship-in.md",
      outputFilePath: "/tmp/kimi-stage/ship-out.md",
      command: "/ship",
      model: "kimi-model-under-test",
      gate: true,
    });
    expect(argv).toContain("--work-dir");
    expect(argv[argv.indexOf("--work-dir") + 1]).toBe("/repo");
    expect(argv).toContain("--add-dir");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe("/tmp/kimi-stage");
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("kimi-model-under-test");
    expect(argv).toContain("--yolo");
    expect(argv).toContain("--print");
    expect(argv).toContain("--final-message-only");
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("Read instructions at /tmp/kimi-stage/ship-in.md");
    expect(prompt).toContain("Run /ship");
    expect(prompt).toContain("GATE PASS");
    expect(prompt).toContain(
      "Write your complete output to /tmp/kimi-stage/ship-out.md",
    );
  });
});

describe("runSlashCommand (kimi role dispatch)", () => {
  it("runs configured slash-command roles through the kimi CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-role-"));
    const slug = `kimi-role-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("--work-dir") || !args.includes("--add-dir")) {
  console.error("missing kimi workspace flags");
  process.exit(2);
}
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
fs.writeFileSync(match[1], "fake kimi ran /ship\\n");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeKimi, 0o755);
      process.env.KIMI_BIN = fakeKimi;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runSlashCommand({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship",
        role: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          command: "/ship",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fake kimi ran /ship\n");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe(
        "fake kimi ran /ship\n",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
      expect(fs.readFileSync(result.logPath, "utf8")).toContain(
        path.join(".kimi", "tmp", "gstack", slug),
      );
      const stagingDir = path.join(
        os.homedir(),
        ".kimi",
        "tmp",
        "gstack",
        slug,
      );
      const leftovers = fs.existsSync(stagingDir)
        ? fs.readdirSync(stagingDir)
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runSlashCommand (gemini role dispatch)", () => {
  it("runs configured slash-command roles through the gemini CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-role-"));
    const slug = `gemini-role-${process.pid}-${Date.now()}`;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
fs.writeFileSync(match[1], "fake gemini ran /ship\\n");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runSlashCommand({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship",
        role: {
          provider: "gemini",
          model: "role-model-under-test",
          reasoning: "high",
          command: "/ship",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fake gemini ran /ship\n");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe(
        "fake gemini ran /ship\n",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
      // Staging dir is keyed on the SANITIZED basename(cwd) (deriveGeminiTmpKey)
      // to match Gemini's projects.json key derivation, not on slug. See
      // stageGeminiIO doc comment.
      const stagingKey = deriveGeminiTmpKey(tmpDir);
      expect(fs.readFileSync(result.logPath, "utf8")).toContain(
        path.join(".gemini", "tmp", stagingKey),
      );
      const stagingDir = path.join(os.homedir(), ".gemini", "tmp", stagingKey);
      const leftovers = fs.existsSync(stagingDir)
        ? fs.readdirSync(stagingDir)
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      const stagingKey = deriveGeminiTmpKey(tmpDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", stagingKey), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runConfiguredRoleTask backup fallback", () => {
  it("falls back from a failing kimi role to the configured gemini backup", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-backup-"));
    const slug = `role-backup-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/bin/sh
exit 1
`,
      );
      fs.chmodSync(fakeKimi, 0o755);

      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
fs.writeFileSync(match[1], "backup ok");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);

      process.env.KIMI_BIN = fakeKimi;
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      // Seed with stale content to verify the zeroing step fires before the backup.
      fs.writeFileSync(outputFilePath, "stale-primary-output");

      const result = await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship",
        role: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          command: "/ship",
          backupProvider: "gemini",
          backupModel: "gemini-3.1-pro-preview",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("backup ok");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("backup ok");
      expect(fs.existsSync(result.logPath)).toBe(true);
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });

  it("fires fallback when the primary times out (timedOut path)", async () => {
    // Fake kimi sleeps past the 100ms timeoutMs so spawnCaptured kills it.
    // runKimi retries once on timeout before returning timedOut=true.
    // The fallback should then succeed via fake gemini.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-timeout-"));
    const slug = `role-timeout-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(fakeKimi, `#!/bin/sh\nsleep 10\n`);
      fs.chmodSync(fakeKimi, 0o755);

      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) { console.error("missing output path"); process.exit(2); }
fs.writeFileSync(match[1], "timeout fallback ok");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);

      process.env.KIMI_BIN = fakeKimi;
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship-timeout",
        // 2000ms stall window: the fake kimi emits no stdout, so the watchdog
        // kills it after 2000ms of silence. Primary is single-shot under
        // liveness semantics; the fallback gemini then runs (<500ms).
        timeoutMs: 2000,
        role: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          backupProvider: "gemini",
          backupModel: "gemini-3.1-pro-preview",
        },
      });

      expect(result.exitCode).toBe(0);
      // Wall-clock: kimi stalls (~2000ms), then backup runs (<500ms).
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe(
        "timeout fallback ok",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });

  it("returns empty outputFilePath and non-zero exit when both primary and backup fail", async () => {
    // When primary fails AND backup also fails: the output file is zeroed
    // before the backup call (primary's partial output is discarded). Caller
    // gets an empty output file and a non-zero exit code from the backup.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-double-fail-"));
    const slug = `role-double-fail-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(fakeKimi, `#!/bin/sh\nexit 1\n`);
      fs.chmodSync(fakeKimi, 0o755);

      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(fakeGemini, `#!/bin/sh\nexit 1\n`);
      fs.chmodSync(fakeGemini, 0o755);

      process.env.KIMI_BIN = fakeKimi;
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      // Seed with stale content that should be cleared before backup fires.
      fs.writeFileSync(outputFilePath, "stale-primary-output");

      const result = await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship-double-fail",
        role: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          backupProvider: "gemini",
          backupModel: "gemini-3.1-pro-preview",
        },
      });

      // Both failed: non-zero exit, empty output (zeroed before backup, backup wrote nothing).
      expect(result.exitCode).not.toBe(0);
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("");
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runShip (gemini role dispatch)", () => {
  it("runs ship then land slash-command roles through the configured CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-ship-"));
    const slug = `gemini-ship-${process.pid}-${Date.now()}`;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeGemini = path.join(tmpDir, "gemini");
      const callsPath = path.join(tmpDir, "calls.txt");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
const command = prompt.includes("Run /land-and-deploy.")
  ? "/land-and-deploy"
  : prompt.includes("Run /ship.")
    ? "/ship"
    : "unknown";
fs.appendFileSync(${JSON.stringify(callsPath)}, command + "\\n");
fs.writeFileSync(match[1], "fake gemini ran " + command + "\\n");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);
      process.env.GEMINI_BIN = fakeGemini;

      const result = await runShip({
        cwd: tmpDir,
        slug,
        ship: {
          provider: "gemini",
          model: "role-model-under-test",
          reasoning: "high",
          command: "/ship",
        },
        land: {
          provider: "gemini",
          model: "role-model-under-test",
          reasoning: "high",
          command: "/land-and-deploy",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fake gemini ran /land-and-deploy\n");
      expect(fs.readFileSync(callsPath, "utf8")).toBe(
        "/ship\n/land-and-deploy\n",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
    } finally {
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runShip (kimi empty-output hard error)", () => {
  it("returns non-zero exit when kimi exits 0 but writes nothing to the staged output", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-ship-empty-"));
    const slug = `kimi-ship-empty-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    try {
      // Fake kimi: exits 0, prints a fake output-file path, but never writes
      // to that file. Reproduces mode B from the investigation: Kimi's
      // `--print --final-message-only` returned the file path as if it
      // wrote the file, but the inner /ship slash command silently skipped
      // writing. Pre-fix this propagates as "ship succeeded" to cli.ts.
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
// Deliberately do NOT write to match[1]. Just print the path and exit 0.
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeKimi, 0o755);
      process.env.KIMI_BIN = fakeKimi;

      const result = await runShip({
        cwd: tmpDir,
        slug,
        ship: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          command: "/ship",
        },
        land: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          command: "/land-and-deploy",
        },
      });

      // The contract: when Kimi doesn't write the output file, runShip must
      // surface that as a hard failure, not a phantom "ship succeeded".
      // cli.ts checks `result.exitCode !== 0 || result.timedOut` to detect
      // ship failure, so we assert exitCode is non-zero. The stderr/stdout
      // should also make the protocol violation visible for forensics.
      expect(result.exitCode).not.toBe(0);
      const forensic = `${result.stdout}\n${result.stderr}`;
      expect(forensic.toLowerCase()).toMatch(/empty|not readable|output file/);
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

// ============================================================================
// Test framework detection (v1.40.1.0)
// ============================================================================

function withTmp(fn: (cwd: string) => void): void {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "inspect-project-")),
  );
  try {
    fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("isKnownFramework", () => {
  it("accepts every Framework literal", () => {
    for (const f of [
      "vitest",
      "jest",
      "playwright",
      "bun",
      "pytest",
      "go",
      "cargo",
    ]) {
      expect(isKnownFramework(f)).toBe(true);
    }
  });
  it("rejects unknown values", () => {
    expect(isKnownFramework("mocha")).toBe(false);
    expect(isKnownFramework("")).toBe(false);
    expect(isKnownFramework("VITEST")).toBe(false);
  });
});

describe("inspectProject — framework-config priority", () => {
  it("vitest.config.ts beats every other signal", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(path.join(cwd, "vitest.config.ts"), "");
      const r = inspectProject(cwd);
      expect(r.framework).toBe("vitest");
      expect(r.runner).toMatch(/vitest|npm|pnpm|yarn|bun/);
    });
  });
  it("vitest.config.js detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "vitest.config.js"), "");
      expect(inspectProject(cwd).framework).toBe("vitest");
    });
  });
  it("vitest.config.mjs detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "vitest.config.mjs"), "");
      expect(inspectProject(cwd).framework).toBe("vitest");
    });
  });
  it("jest.config.ts detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "jest.config.ts"), "");
      expect(inspectProject(cwd).framework).toBe("jest");
    });
  });
  it("jest.config.js detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "jest.config.js"), "");
      expect(inspectProject(cwd).framework).toBe("jest");
    });
  });
  it("jest.config.cjs detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "jest.config.cjs"), "");
      expect(inspectProject(cwd).framework).toBe("jest");
    });
  });
  it("jest.config.mjs detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "jest.config.mjs"), "");
      expect(inspectProject(cwd).framework).toBe("jest");
    });
  });
  it("playwright.config.ts detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "playwright.config.ts"), "");
      const r = inspectProject(cwd);
      expect(r.framework).toBe("playwright");
      expect(r.runner).toBe("npx playwright test");
    });
  });
  it("playwright.config.js detected", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "playwright.config.js"), "");
      expect(inspectProject(cwd).framework).toBe("playwright");
    });
  });
  it("setup.cfg [tool:pytest] section detected as pytest", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "setup.cfg"),
        "[tool:pytest]\nminversion = 6.0\n",
      );
      const r = inspectProject(cwd);
      expect(r.framework).toBe("pytest");
      expect(r.runner).toBe("pytest");
    });
  });
  it("setup.cfg without [tool:pytest] is NOT detected as pytest", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "setup.cfg"), "[metadata]\nname=foo\n");
      expect(inspectProject(cwd).framework).not.toBe("pytest");
    });
  });
});

describe("inspectProject — REGRESSION: vitest.config.ts beats stray pytest.ini", () => {
  it("CRITICAL: framework=vitest, runner not pytest, evidence cites vitest.config.ts", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(path.join(cwd, "vitest.config.ts"), "");
      fs.writeFileSync(path.join(cwd, "pytest.ini"), "[pytest]\n");
      const r = inspectProject(cwd);
      expect(r.framework).toBe("vitest");
      expect(r.runner).not.toBe("pytest");
      expect(r.evidence.join(" ")).toContain("vitest.config.ts");
    });
  });
});

describe("inspectProject — subdir framework-config discovery", () => {
  // Regression for the mitosis-prototype skill fault (2026-05-18):
  // project root has `pyproject.toml [tool.pytest.ini_options]` AND
  // `openclaw/vitest.config.ts`. The build dispatched pytest against the
  // whole 2890-test Python suite when the feature under test had TS specs
  // in `openclaw/`. Bug surfaced as a 15-minute timeout on
  // `test_mode_runs_to_completion[async]`.
  it("CRITICAL: vitest.config.ts in subdir beats pytest signal at cwd", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\nminversion = '6.0'\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");
      const r = inspectProject(cwd);
      expect(r.framework).toBe("vitest");
      expect(r.runner).not.toBe("pytest");
      expect(r.evidence.join(" ")).toContain("openclaw/vitest.config.ts");
    });
  });
  it("jest.config.ts in subdir beats pyproject pytest signal", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "pkg-a"));
      fs.writeFileSync(path.join(cwd, "pkg-a", "jest.config.ts"), "");
      const r = inspectProject(cwd);
      expect(r.framework).toBe("jest");
    });
  });
  it("playwright.config.ts in subdir beats pyproject pytest signal", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "e2e"));
      fs.writeFileSync(path.join(cwd, "e2e", "playwright.config.ts"), "");
      expect(inspectProject(cwd).framework).toBe("playwright");
    });
  });
  it("cwd-level vitest.config.ts beats subdir jest.config.ts (shallowest wins)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "vitest.config.ts"), "");
      fs.mkdirSync(path.join(cwd, "pkg"));
      fs.writeFileSync(path.join(cwd, "pkg", "jest.config.ts"), "");
      expect(inspectProject(cwd).framework).toBe("vitest");
    });
  });
  it("subdir-only vitest config in deeply nested package found within depth limit", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "packages", "foo"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "packages", "foo", "vitest.config.ts"),
        "",
      );
      expect(inspectProject(cwd).framework).toBe("vitest");
    });
  });
  it("vitest config inside node_modules is IGNORED (skip vendored)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "node_modules", "some-pkg"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(cwd, "node_modules", "some-pkg", "vitest.config.ts"),
        "",
      );
      // pyproject still wins because the subdir walk skips node_modules.
      expect(inspectProject(cwd).framework).toBe("pytest");
    });
  });
  it("vitest config inside vendor is IGNORED", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "vendor", "thing"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "vendor", "thing", "vitest.config.ts"),
        "",
      );
      expect(inspectProject(cwd).framework).toBe("pytest");
    });
  });
  it("vitest config inside .worktrees is IGNORED", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, ".worktrees", "lane-a"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, ".worktrees", "lane-a", "vitest.config.ts"),
        "",
      );
      expect(inspectProject(cwd).framework).toBe("pytest");
    });
  });
  it("vitest config deeper than depth limit is NOT found (pytest wins)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      // depth 5 from cwd: a/b/c/d/e/vitest.config.ts
      const deep = path.join(cwd, "a", "b", "c", "d", "e");
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, "vitest.config.ts"), "");
      // walk depth caps at 3 → vitest not found, pytest wins.
      expect(inspectProject(cwd).framework).toBe("pytest");
    });
  });
  it("when only pytest.ini at cwd, NO subdir walk runs (cwd-only wins)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "pytest.ini"), "[pytest]\n");
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");
      // pytest.ini at cwd is a strong explicit signal — subdir walk should
      // not override it, since the user/project authored pytest.ini at root
      // intentionally. Only [tool.pytest.ini_options] (which can be a stray
      // tooling block) is overridable.
      const r = inspectProject(cwd);
      // Permissive: either pytest (cwd-only short-circuits) OR vitest if we
      // chose to subdir-walk even past explicit pytest.ini. Current contract:
      // explicit pytest.ini wins (consistent with v1: no subdir walk for
      // explicit pytest config files).
      expect(r.framework).toBe("pytest");
    });
  });
  it("evidence includes the subdir path of the discovered config", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[tool.pytest.ini_options]\n",
      );
      fs.mkdirSync(path.join(cwd, "openclaw"));
      fs.writeFileSync(path.join(cwd, "openclaw", "vitest.config.ts"), "");
      const r = inspectProject(cwd);
      const ev = r.evidence.join(" ");
      // Use posix separator in the assertion since the helper normalises.
      expect(ev).toMatch(/openclaw[\\/]vitest\.config\.ts/);
    });
  });
});

describe("inspectProject — package.json scripts.test", () => {
  it("scripts.test = 'vitest' yields framework=vitest", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      );
      expect(inspectProject(cwd).framework).toBe("vitest");
    });
  });
  it("scripts.test = 'jest --coverage' yields framework=jest", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "jest --coverage" } }),
      );
      expect(inspectProject(cwd).framework).toBe("jest");
    });
  });
  it("scripts.test = 'bun test' yields framework=bun", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "bun test" } }),
      );
      expect(inspectProject(cwd).framework).toBe("bun");
    });
  });
  it("WRAPPER: scripts.test='make test' yields framework=null", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "make test" } }),
      );
      const r = inspectProject(cwd);
      expect(r.framework).toBe(null);
      expect(r.runner).toMatch(/^(npm|pnpm|yarn|bun)\b/);
    });
  });
});

describe("countTestFiles — bounded walk", () => {
  it("counts *.test.ts and _test.go files in a small tree", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "a.test.ts"), "");
      fs.writeFileSync(path.join(cwd, "b.test.tsx"), "");
      fs.writeFileSync(path.join(cwd, "c_test.go"), "");
      fs.writeFileSync(path.join(cwd, "d_test.py"), "");
      const r = countTestFiles(cwd, 1000, () => Date.now());
      expect(r.ts).toBe(2);
      expect(r.go).toBe(1);
      expect(r.py).toBe(1);
      expect(r.aborted).toBe(false);
    });
  });
  it("ignores node_modules/, .git/, dist/, vendored/, __pycache__/", () => {
    withTmp((cwd) => {
      for (const ignored of [
        "node_modules",
        ".git",
        "dist",
        "vendored",
        "__pycache__",
      ]) {
        fs.mkdirSync(path.join(cwd, ignored));
        fs.writeFileSync(path.join(cwd, ignored, "hidden.test.ts"), "");
      }
      fs.writeFileSync(path.join(cwd, "visible.test.ts"), "");
      const r = countTestFiles(cwd, 1000, () => Date.now());
      expect(r.ts).toBe(1);
    });
  });
  it("aborts when time budget exceeded (injected clock)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "a.test.ts"), "");
      const calls = { n: 0 };
      const fakeNow = () => {
        calls.n += 1;
        return calls.n === 1 ? 0 : 999;
      };
      const r = countTestFiles(cwd, 250, fakeNow);
      expect(r.aborted).toBe(true);
    });
  });
  it("respects depth-4 cap", () => {
    withTmp((cwd) => {
      let dir = cwd;
      for (let depth = 1; depth <= 6; depth += 1) {
        dir = path.join(dir, `level${depth}`);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, `d${depth}.test.ts`), "");
      }
      fs.writeFileSync(path.join(cwd, "root.test.ts"), "");
      const r = countTestFiles(cwd, 5000, () => Date.now());
      // Depth 0 (cwd) + depths 1-4 = 5 files; depths 5-6 excluded.
      expect(r.ts).toBe(5);
    });
  });
});

describe("inspectProject — tie-break for mixed-language repos", () => {
  it("majority TS test files → JS runner, framework=null", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[project]\nname='x'\n",
      );
      for (let i = 0; i < 7; i += 1) {
        fs.writeFileSync(path.join(cwd, `a${i}.test.ts`), "");
      }
      fs.writeFileSync(path.join(cwd, "z_test.py"), "");
      const r = inspectProject(cwd);
      expect(r.runner).toMatch(/^(npm|pnpm|yarn|bun|npx)\b/);
      expect(r.framework).toBe(null);
    });
  });
  it("majority Python test files → pytest", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(
        path.join(cwd, "pyproject.toml"),
        "[project]\nname='x'\n",
      );
      fs.writeFileSync(path.join(cwd, "a.test.ts"), "");
      for (let i = 0; i < 7; i += 1) {
        fs.writeFileSync(path.join(cwd, `test_x${i}.py`), "");
      }
      const r = inspectProject(cwd);
      expect(r.runner).toBe("pytest");
      expect(r.framework).toBe("pytest");
    });
  });
  it("Go + stray package.json (docs site) → go test", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(path.join(cwd, "go.mod"), "module foo\ngo 1.22\n");
      for (let i = 0; i < 5; i += 1) {
        fs.writeFileSync(path.join(cwd, `pkg${i}_test.go`), "");
      }
      const r = inspectProject(cwd);
      expect(r.runner).toBe("go test ./...");
      expect(r.framework).toBe("go");
    });
  });
});

describe("inspectProject — CLAUDE.md gstack.testCmd override", () => {
  // Reproduces F2 from AGNT2 run: a Go service with a Node tooling sidecar
  // has both go.mod and package.json. The tie-break heuristic flipped to
  // `npx vitest run`, test-fixer ran in a Go directory with no JS tests to
  // fix, hygiene rejected. The fix: an explicit CLAUDE.md override is
  // Priority 0, ahead of every heuristic.
  it("Go + Node sidecar with gstack.testCmd override → returns override verbatim", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "go.mod"), "module foo\ngo 1.22\n");
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      // Stack the deck against go test: more TS test files than Go.
      for (let i = 0; i < 5; i += 1) {
        fs.writeFileSync(path.join(cwd, `a${i}.test.ts`), "");
      }
      fs.writeFileSync(path.join(cwd, "pkg_test.go"), "package foo\n");
      // Override in CLAUDE.md beats the heuristic.
      fs.writeFileSync(
        path.join(cwd, "CLAUDE.md"),
        "# proj\n\ngstack.testCmd: go test ./...\n\nmore prose\n",
      );

      const r = inspectProject(cwd);
      expect(r.runner).toBe("go test ./...");
      // framework stays null when override is used — we know the command,
      // not the framework, and don't need to guess.
      expect(r.framework).toBe(null);
      expect(r.evidence.some((e) => e.includes("CLAUDE.md"))).toBe(true);
    });
  });

  it("override beats vitest.config.ts (the highest-priority heuristic)", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "vitest.config.ts"), "");
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(
        path.join(cwd, "CLAUDE.md"),
        "gstack.testCmd: pnpm exec vitest run --reporter=verbose\n",
      );

      const r = inspectProject(cwd);
      expect(r.runner).toBe("pnpm exec vitest run --reporter=verbose");
      expect(r.framework).toBe(null);
    });
  });

  it("ignores a malformed/empty override and falls through to heuristics", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "go.mod"), "module foo\ngo 1.22\n");
      // Empty value on the right-hand side: not a usable command. Ignore.
      fs.writeFileSync(
        path.join(cwd, "CLAUDE.md"),
        "gstack.testCmd:\n\nrest of doc\n",
      );

      const r = inspectProject(cwd);
      // Falls through to single-language Go fallthrough (Priority 3).
      expect(r.runner).toBe("go test ./...");
      expect(r.framework).toBe("go");
    });
  });

  it("no CLAUDE.md present → falls through to heuristics", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "go.mod"), "module foo\ngo 1.22\n");
      const r = inspectProject(cwd);
      expect(r.runner).toBe("go test ./...");
      expect(r.framework).toBe("go");
    });
  });
});

describe("inspectProject — single-language fallthrough", () => {
  it("go.mod alone → go test ./...", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "go.mod"), "module foo\ngo 1.22\n");
      const r = inspectProject(cwd);
      expect(r.runner).toBe("go test ./...");
      expect(r.framework).toBe("go");
    });
  });
  it("Cargo.toml alone → cargo test", () => {
    withTmp((cwd) => {
      fs.writeFileSync(
        path.join(cwd, "Cargo.toml"),
        "[package]\nname='x'\nversion='0.1.0'\n",
      );
      const r = inspectProject(cwd);
      expect(r.runner).toBe("cargo test");
      expect(r.framework).toBe("cargo");
    });
  });
  it("bun.lockb alone → bun test", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "bun.lockb"), "");
      const r = inspectProject(cwd);
      expect(r.runner).toBe("bun test");
      expect(r.framework).toBe("bun");
    });
  });
  it("nothing detected → null", () => {
    withTmp((cwd) => {
      const r = inspectProject(cwd);
      expect(r.runner).toBe(null);
      expect(r.framework).toBe(null);
    });
  });
});

describe("detectTestFramework wrapper", () => {
  it("returns the framework from inspectProject", () => {
    withTmp((cwd) => {
      fs.writeFileSync(path.join(cwd, "vitest.config.ts"), "");
      expect(detectTestFramework(cwd)).toBe("vitest");
    });
  });
  it("returns null for unrecognised repos", () => {
    withTmp((cwd) => {
      expect(detectTestFramework(cwd)).toBe(null);
    });
  });
});

describe("frameworkToRunner mapping", () => {
  it("vitest → vitest run command", () => {
    withTmp((cwd) => {
      expect(frameworkToRunner("vitest", cwd)).toMatch(/vitest/);
    });
  });
  it("pytest → 'pytest'", () => {
    withTmp((cwd) => {
      expect(frameworkToRunner("pytest", cwd)).toBe("pytest");
    });
  });
  it("go → 'go test ./...'", () => {
    withTmp((cwd) => {
      expect(frameworkToRunner("go", cwd)).toBe("go test ./...");
    });
  });
  it("cargo → 'cargo test'", () => {
    withTmp((cwd) => {
      expect(frameworkToRunner("cargo", cwd)).toBe("cargo test");
    });
  });
  it("bun → 'bun test'", () => {
    withTmp((cwd) => {
      expect(frameworkToRunner("bun", cwd)).toBe("bun test");
    });
  });
  it("playwright → 'npx playwright test'", () => {
    withTmp((cwd) => {
      expect(frameworkToRunner("playwright", cwd)).toBe("npx playwright test");
    });
  });
});

describe("buildGeminiTestSpecPrompt — framework hint", () => {
  it("framework hint absent when framework=null", async () => {
    const { buildGeminiTestSpecPrompt } = await import("../cli.ts");
    const fakePhase = {
      number: 1,
      name: "test phase",
      body: "do the thing",
      testSpecCheckboxLine: -1,
    } as any;
    const out = buildGeminiTestSpecPrompt(fakePhase, "/tmp/plan.md", null);
    expect(out).not.toContain("Detected test framework");
  });
  it("framework hint present when framework='vitest'", async () => {
    const { buildGeminiTestSpecPrompt } = await import("../cli.ts");
    const fakePhase = {
      number: 1,
      name: "test phase",
      body: "do the thing",
      testSpecCheckboxLine: -1,
    } as any;
    const out = buildGeminiTestSpecPrompt(fakePhase, "/tmp/plan.md", "vitest");
    expect(out).toContain("Detected test framework");
    expect(out).toContain("`vitest`");
  });
  it("framework hint omitted by default (backwards compatibility)", async () => {
    const { buildGeminiTestSpecPrompt } = await import("../cli.ts");
    const fakePhase = {
      number: 1,
      name: "test phase",
      body: "do the thing",
      testSpecCheckboxLine: -1,
    } as any;
    const out = buildGeminiTestSpecPrompt(fakePhase, "/tmp/plan.md");
    expect(out).not.toContain("Detected test framework");
  });
});

describe("stageGeminiIO", () => {
  // Regression history (this block pins all three iterations):
  //   1. ~/.gemini/tmp/gstack/<slug>/ — T111646, fixed 2026-05-17 (67480efe).
  //   2. ~/.gemini/tmp/<state-slug>/ where slug=`build-<runId>` — single-impl
  //      `build-` prefix bug, fixed 2026-05-18.
  //   3. ~/.gemini/tmp/<basename(cwd)>/ — still broken: dual-impl uses cwd
  //      basename `primary`/`secondary` (different from state slug), and
  //      worktrees with `_`/`.`/uppercase in the basename diverge from what
  //      Gemini's projects.json actually stores (lowercased, non-alphanumeric
  //      → `-`). PR #49 fixed dual-impl + slug-in-filename concurrency. This
  //      file additionally pins (a) full Gemini key sanitization via
  //      deriveGeminiTmpKey and (b) pid-in-filename for same-slug retries.
  //
  // All tests override HOME to an isolated tmp directory so they don't
  // pollute the developer's real ~/.gemini/tmp/ on every test run (which
  // would leak into Gemini's projects.json — pre-existing pattern fixed
  // here as part of adversarial review Finding 6).

  let stagedPaths: string[] = [];
  let isolatedHome: string;
  let realHome: string | undefined;

  beforeEach(() => {
    realHome = process.env.HOME;
    isolatedHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-stage-test-home-"),
    );
    process.env.HOME = isolatedHome;
  });

  afterEach(() => {
    for (const p of stagedPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    stagedPaths = [];
    try {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    } catch {}
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  });

  it("derives staging dir from basename(cwd), NOT from slug (Gemini sandbox alignment)", () => {
    // Simulate the failing 2026-05-18 production case:
    //   basename(cwd) = mitosis-test-<ts>      (worktree name)
    //   slug          = build-mitosis-test-<ts> (deriveSlug() output)
    // Gemini whitelists ~/.gemini/tmp/<basename(cwd)>/, so staging MUST land
    // there — not under the build-prefixed slug.
    const worktreeName = `mitosis-test-${Date.now()}`;
    const cwd = path.join(os.tmpdir(), worktreeName);
    fs.mkdirSync(cwd, { recursive: true });

    const slug = `build-${worktreeName}`;

    const inputFile = path.join(
      os.tmpdir(),
      `gstack-test-input-${Date.now()}.md`,
    );
    fs.writeFileSync(inputFile, "test input\n");
    stagedPaths.push(inputFile);

    const outputFile = path.join(os.tmpdir(), `out-${worktreeName}.md`);
    stagedPaths.push(outputFile);

    const r = stageGeminiIO({
      cwd,
      slug,
      phaseNumber: "3.3",
      iteration: 1,
      suffix: "primary-impl",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    stagedPaths.push(r.stagedInput, r.stagedOutput);

    const expectedDir = path.join(isolatedHome, ".gemini", "tmp", worktreeName);
    const wrongDir = path.join(isolatedHome, ".gemini", "tmp", slug); // build-prefixed

    // Staged files land in the basename(cwd) directory (sandbox-aligned).
    expect(r.stagedInput.startsWith(expectedDir + path.sep)).toBe(true);
    expect(r.stagedOutput.startsWith(expectedDir + path.sep)).toBe(true);

    // The whole point of the fix: they do NOT land in the slug directory.
    expect(r.stagedInput.startsWith(wrongDir + path.sep)).toBe(false);
    expect(r.stagedOutput.startsWith(wrongDir + path.sep)).toBe(false);

    // Prior T111646 guard: no `/gstack/` segment between `/tmp/` and the dir.
    expect(r.stagedInput).not.toContain("/.gemini/tmp/gstack/");
    expect(r.stagedOutput).not.toContain("/.gemini/tmp/gstack/");

    // Files exist at the new location, then cleanup removes them.
    expect(fs.existsSync(r.stagedInput)).toBe(true);
    expect(fs.existsSync(r.stagedOutput)).toBe(true);
    r.cleanup();
    expect(fs.existsSync(r.stagedInput)).toBe(false);
    expect(fs.existsSync(r.stagedOutput)).toBe(false);

    try {
      fs.rmdirSync(cwd);
    } catch {}
  });

  it("copies output content back to outputFilePath on cleanup", () => {
    const inputFile = path.join(
      os.tmpdir(),
      `gstack-test-input-${Date.now()}.md`,
    );
    fs.writeFileSync(inputFile, "test input\n");
    stagedPaths.push(inputFile);

    const worktreeName = `smoke-copyback-${Date.now()}`;
    const cwd = path.join(os.tmpdir(), worktreeName);
    fs.mkdirSync(cwd, { recursive: true });

    const outputFile = path.join(os.tmpdir(), `out-${worktreeName}.md`);
    stagedPaths.push(outputFile);

    const r = stageGeminiIO({
      cwd,
      slug: worktreeName,
      phaseNumber: "2.1",
      iteration: 1,
      suffix: "review",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });

    // Simulate the agent writing to stagedOutput.
    fs.writeFileSync(r.stagedOutput, "agent wrote this");

    r.cleanup();

    // After cleanup, outputFilePath should hold the agent's content.
    expect(fs.readFileSync(outputFile, "utf8")).toBe("agent wrote this");

    try {
      fs.rmdirSync(cwd);
    } catch {}
  });

  it("parallel runs sharing basename(cwd) do NOT collide on filename (dual-impl safety)", () => {
    // Dual-impl always produces worktrees named `primary` and `secondary`
    // (build/orchestrator/worktree.ts). Two concurrent dual-impl builds of
    // different plans would BOTH stage primary under ~/.gemini/tmp/primary/.
    // Per-filename slug disambiguation prevents one run from clobbering the
    // other's input/output before cleanup. Without the slug in the filename,
    // run B would overwrite run A's input mid-flight and A would copy B's
    // output back as its own. Adversarial review (Claude + Codex) flagged
    // this on the directory-fix patch; this test pins the disambiguation.
    const sharedBasename = `primary-${Date.now()}`;
    const cwd = path.join(os.tmpdir(), sharedBasename);
    fs.mkdirSync(cwd, { recursive: true });

    const inputFileA = path.join(os.tmpdir(), `in-a-${Date.now()}.md`);
    const inputFileB = path.join(os.tmpdir(), `in-b-${Date.now()}.md`);
    fs.writeFileSync(inputFileA, "input A\n");
    fs.writeFileSync(inputFileB, "input B\n");
    stagedPaths.push(inputFileA, inputFileB);

    const outputFileA = path.join(os.tmpdir(), `out-a-${Date.now()}.md`);
    const outputFileB = path.join(os.tmpdir(), `out-b-${Date.now()}.md`);
    stagedPaths.push(outputFileA, outputFileB);

    // Same cwd, same phase/iteration/suffix — only slug differs.
    // This mirrors the production case: two parallel dual-impl runs of
    // different plans both hit phase 1.1 attempt 1 with suffix "dual-primary".
    const commonOpts = {
      cwd,
      phaseNumber: "1.1",
      iteration: 1,
      suffix: "dual-primary",
    };

    const a = stageGeminiIO({
      ...commonOpts,
      slug: "build-plan-a-20260519-aaaa",
      inputFilePath: inputFileA,
      outputFilePath: outputFileA,
    });
    const b = stageGeminiIO({
      ...commonOpts,
      slug: "build-plan-b-20260519-bbbb",
      inputFilePath: inputFileB,
      outputFilePath: outputFileB,
    });
    stagedPaths.push(
      a.stagedInput,
      a.stagedOutput,
      b.stagedInput,
      b.stagedOutput,
    );

    // Both runs land in the same directory (Gemini sandbox alignment).
    expect(path.dirname(a.stagedInput)).toBe(path.dirname(b.stagedInput));

    // CRITICAL: filenames MUST diverge so concurrent writes don't clobber.
    expect(a.stagedInput).not.toBe(b.stagedInput);
    expect(a.stagedOutput).not.toBe(b.stagedOutput);

    // Each file holds its own input (no cross-contamination).
    expect(fs.readFileSync(a.stagedInput, "utf8")).toBe("input A\n");
    expect(fs.readFileSync(b.stagedInput, "utf8")).toBe("input B\n");

    // Simulate both agents writing.
    fs.writeFileSync(a.stagedOutput, "result A");
    fs.writeFileSync(b.stagedOutput, "result B");

    // Each cleanup copies back its own result.
    a.cleanup();
    b.cleanup();
    expect(fs.readFileSync(outputFileA, "utf8")).toBe("result A");
    expect(fs.readFileSync(outputFileB, "utf8")).toBe("result B");

    try {
      fs.rmdirSync(cwd);
    } catch {}
  });

  it("sanitizes path-traversal characters out of slug before embedding in filename", () => {
    // opts.slug is orchestrator-controlled today but we don't want a future
    // caller passing a slug containing `../` or `/` to escape stagingDir.
    // The sanitizer collapses anything outside [a-zA-Z0-9._-] to `-`.
    const worktreeName = `sanitize-${Date.now()}`;
    const cwd = path.join(os.tmpdir(), worktreeName);
    fs.mkdirSync(cwd, { recursive: true });

    const inputFile = path.join(os.tmpdir(), `in-sanitize-${Date.now()}.md`);
    fs.writeFileSync(inputFile, "test\n");
    stagedPaths.push(inputFile);
    const outputFile = path.join(os.tmpdir(), `out-sanitize-${Date.now()}.md`);
    stagedPaths.push(outputFile);

    const r = stageGeminiIO({
      cwd,
      slug: "../../etc/passwd",
      phaseNumber: "1.1",
      iteration: 1,
      suffix: "x",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    stagedPaths.push(r.stagedInput, r.stagedOutput);

    const expectedDir = path.join(isolatedHome, ".gemini", "tmp", worktreeName);
    expect(r.stagedInput.startsWith(expectedDir + path.sep)).toBe(true);
    expect(r.stagedOutput.startsWith(expectedDir + path.sep)).toBe(true);

    // The filename (everything after stagingDir/) must contain no path separators
    // and no `etc/passwd`-style segment. `..` as literal characters within
    // a single filename is harmless — `path.join` treats it as filename text,
    // not as a parent reference — but `/` would escape stagingDir.
    const filename = path.basename(r.stagedInput);
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("\\");
    expect(filename).not.toMatch(/etc[\/\\]passwd/);

    r.cleanup();
    try {
      fs.rmdirSync(cwd);
    } catch {}
  });

  // Regression for the 2026-05-19 follow-up: PR #49 used `basename(opts.cwd)`
  // verbatim as the staging dir name, but Gemini's projects.json sanitizes
  // its keys (lowercase, non-alphanumeric → `-`, trim). Worktrees with `_`,
  // `.`, or uppercase still diverge. The mitosis-prototype-socc26-v022a-
  // schema-v3_1 worktree on disk is the real example: cwd basename has
  // `v3_1`, Gemini's allowlist key has `v3-1`. This test pins the alignment.
  it("sanitizes basename(cwd) to match Gemini's projects.json key (underscore → hyphen)", () => {
    const cwdName =
      "mitosis-prototype-socc26-v022a-schema-v3_1-behavior-subtree-20260518";
    const cwd = path.join(os.tmpdir(), `${cwdName}-${Date.now()}`);
    fs.mkdirSync(cwd, { recursive: true });

    const inputFile = path.join(os.tmpdir(), `in-underscore-${Date.now()}.md`);
    fs.writeFileSync(inputFile, "test\n");
    stagedPaths.push(inputFile);
    const outputFile = path.join(
      os.tmpdir(),
      `out-underscore-${Date.now()}.md`,
    );
    stagedPaths.push(outputFile);

    const r = stageGeminiIO({
      cwd,
      slug: "build-mitosis-prototype-socc26",
      phaseNumber: "3.3",
      iteration: 1,
      suffix: "primary-impl",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    stagedPaths.push(r.stagedInput, r.stagedOutput);

    // Staging dir basename must be the sanitized form Gemini stores
    // (no `_`), NOT the raw cwd basename (which has `_`).
    const stagingDir = path.dirname(r.stagedInput);
    const stagingKey = path.basename(stagingDir);
    expect(stagingKey).not.toContain("_");
    expect(stagingKey).toMatch(/^[a-z0-9-]+$/);
    // Specifically: v3_1 must become v3-1.
    expect(stagingKey).toContain("v3-1");
    expect(stagingKey).not.toContain("v3_1");

    try {
      r.cleanup();
      fs.rmdirSync(cwd);
    } catch {}
  });

  it("sanitizes uppercase characters in basename(cwd) (matches Gemini's lowercase keys)", () => {
    const cwd = path.join(os.tmpdir(), `MyObs-${Date.now()}`);
    fs.mkdirSync(cwd, { recursive: true });

    const inputFile = path.join(os.tmpdir(), `in-upper-${Date.now()}.md`);
    fs.writeFileSync(inputFile, "test\n");
    stagedPaths.push(inputFile);
    const outputFile = path.join(os.tmpdir(), `out-upper-${Date.now()}.md`);
    stagedPaths.push(outputFile);

    const r = stageGeminiIO({
      cwd,
      slug: "build-myobs",
      phaseNumber: "1.1",
      iteration: 1,
      suffix: "impl",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    stagedPaths.push(r.stagedInput, r.stagedOutput);

    const stagingKey = path.basename(path.dirname(r.stagedInput));
    // Must be lowercase (matching Gemini's projects.json key shape).
    expect(stagingKey).toBe(stagingKey.toLowerCase());
    expect(stagingKey).toMatch(/^myobs-/);

    try {
      r.cleanup();
      fs.rmdirSync(cwd);
    } catch {}
  });

  // Regression for adversarial review Finding 3: an all-punctuation cwd
  // basename would sanitize to "", and `path.join(HOME, ".gemini", "tmp", "")`
  // would stage in the shared tmp root, colliding with everything else.
  // Fall back to a literal "gstack-run" key so failures are debuggable.
  it("falls back to `gstack-run` key when cwd basename sanitizes to empty", () => {
    const cwd = path.join(os.tmpdir(), `___-${Date.now()}-___`);
    fs.mkdirSync(cwd, { recursive: true });

    const inputFile = path.join(os.tmpdir(), `in-empty-${Date.now()}.md`);
    fs.writeFileSync(inputFile, "test\n");
    stagedPaths.push(inputFile);
    const outputFile = path.join(os.tmpdir(), `out-empty-${Date.now()}.md`);
    stagedPaths.push(outputFile);

    // Construct a pathological cwd whose basename is all punctuation when
    // sanitized to lowercase-alphanumeric only. `___-<digits>-___` keeps
    // the digits via timestamp, so use a fully punctuation basename:
    const punctCwd = path.join(cwd, "_._._.");
    fs.mkdirSync(punctCwd, { recursive: true });

    const r = stageGeminiIO({
      cwd: punctCwd,
      slug: "build-empty",
      phaseNumber: "1.1",
      iteration: 1,
      suffix: "impl",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    stagedPaths.push(r.stagedInput, r.stagedOutput);

    const stagingKey = path.basename(path.dirname(r.stagedInput));
    expect(stagingKey).toBe("gstack-run");

    try {
      r.cleanup();
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  // Regression for adversarial review Finding 1 (pid layer): #49's slug-in-
  // filename catches different runs sharing a cwd. But two concurrent runs
  // of the SAME slug (replay, retry storms, etc.) would still collide. The
  // pid in the filename is a finer-grain discriminator.
  it("includes process.pid in staged filenames to disambiguate same-slug runs", () => {
    const cwdName = `pidcheck-${Date.now()}`;
    const cwd = path.join(os.tmpdir(), cwdName);
    fs.mkdirSync(cwd, { recursive: true });

    const inputFile = path.join(os.tmpdir(), `in-pid-${Date.now()}.md`);
    fs.writeFileSync(inputFile, "test\n");
    stagedPaths.push(inputFile);
    const outputFile = path.join(os.tmpdir(), `out-pid-${Date.now()}.md`);
    stagedPaths.push(outputFile);

    const r = stageGeminiIO({
      cwd,
      slug: "build-same-slug",
      phaseNumber: "1.1",
      iteration: 1,
      suffix: "impl",
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    stagedPaths.push(r.stagedInput, r.stagedOutput);

    expect(r.stagedInput).toContain(`-${process.pid}-input.md`);
    expect(r.stagedOutput).toContain(`-${process.pid}-output.md`);

    try {
      r.cleanup();
      fs.rmdirSync(cwd);
    } catch {}
  });
});

// ---------------------------------------------------------------------------
// Timeout-fix helpers: resolveRoleTimeouts, resolveFallback*, checkPhaseScope
// ---------------------------------------------------------------------------

describe("resolveRoleTimeouts", () => {
  const baseRole = {
    provider: "kimi" as const,
    model: "kimi-x",
    reasoning: "high" as const,
  };

  it("falls back to provider default when role.timeoutMs unset", () => {
    const r = resolveRoleTimeouts(baseRole);
    expect(r.primaryMs).toBe(1500000); // KIMI default (bumped to 25min in phase 1.1)
  });

  it("role.timeoutMs wins over provider default", () => {
    const r = resolveRoleTimeouts({ ...baseRole, timeoutMs: 1800000 });
    expect(r.primaryMs).toBe(1800000);
  });

  it("callerTimeoutMs wins over role.timeoutMs", () => {
    const r = resolveRoleTimeouts({ ...baseRole, timeoutMs: 1800000 }, 60000);
    expect(r.primaryMs).toBe(60000);
  });

  it("backupMs is max(60s, floor(primary/2))", () => {
    expect(resolveRoleTimeouts(baseRole).backupMs).toBe(750000); // 1500000/2 (kimi default)
    expect(
      resolveRoleTimeouts({ ...baseRole, timeoutMs: 200000 }).backupMs,
    ).toBe(100000);
  });

  it("backupMs floor is 60s when primary is small", () => {
    const r = resolveRoleTimeouts({ ...baseRole, timeoutMs: 100000 });
    expect(r.backupMs).toBe(60000); // not 50000
  });

  it("role.backupTimeoutMs wins over the half-default", () => {
    const r = resolveRoleTimeouts({
      ...baseRole,
      timeoutMs: 900000,
      backupTimeoutMs: 300000,
    });
    expect(r.backupMs).toBe(300000);
  });

  it("claude provider falls back to codex default (BuildTimeoutsMs has no claude key)", () => {
    const r = resolveRoleTimeouts({ ...baseRole, provider: "claude" });
    expect(r.primaryMs).toBe(900000); // codex default
  });

  it("gemini provider uses gemini default", () => {
    const r = resolveRoleTimeouts({ ...baseRole, provider: "gemini" });
    expect(r.primaryMs).toBe(900000); // gemini default
  });
});

describe("resolveFallbackForConfigured", () => {
  const baseOpts: RunConfiguredRoleTaskOpts = {
    inputFilePath: "/tmp/in",
    outputFilePath: "/tmp/out",
    cwd: "/tmp",
    slug: "test",
    logPrefix: "primary-impl",
    role: {
      provider: "kimi",
      model: "kimi-x",
      reasoning: "high",
      backupProvider: "gemini",
      backupModel: "gemini-x",
    },
    codexDefaultCommand: "/gstack-review",
    sandbox: "workspace-write",
  };

  it("swaps provider/model to backup", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role, baseOpts.timeoutMs);
    const out = resolveFallbackForConfigured(baseOpts, resolved);
    expect(out.role.provider).toBe("gemini");
    expect(out.role.model).toBe("gemini-x");
  });

  it("sets backup timeout to resolved.backupMs", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForConfigured(baseOpts, resolved);
    expect(out.timeoutMs).toBe(resolved.backupMs);
    expect(out.timeoutMs).toBe(750000); // half of 1500s kimi default
  });

  it("explicitly clears codexDefaultCommand (caller-specific)", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForConfigured(baseOpts, resolved);
    expect(out.codexDefaultCommand).toBeUndefined();
  });

  it("preserves sandbox setting for codex backup paths", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForConfigured(baseOpts, resolved);
    expect(out.sandbox).toBe("workspace-write");
  });

  it("empty string backupModel when role.backupModel absent (lets provider default win)", () => {
    const resolved = resolveRoleTimeouts({
      ...baseOpts.role,
      backupModel: undefined,
    });
    const out = resolveFallbackForConfigured(
      { ...baseOpts, role: { ...baseOpts.role, backupModel: undefined } },
      resolved,
    );
    expect(out.role.model).toBe("");
  });

  it("appends -backup-<provider> to the logPrefix", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForConfigured(baseOpts, resolved);
    expect(out.logPrefix).toBe("primary-impl-backup-gemini");
  });
});

describe("resolveTimeoutFallback (F3 budget-aware fallback)", () => {
  // Reproduces F3 from AGNT2 run: Kimi test-fixer timed out, Gemini backup got
  // "blind execution" because Gemini was given half the time Kimi just
  // exhausted on the same prompt. Symptom: backup model gives up reading and
  // starts guessing. Fix shape: on primary.timedOut === true (not generic
  // exitCode != 0), re-check scope; if oversized, surface phase_oversized
  // directly; otherwise escalate backup timeout to match the primary.
  it("returns 'phase_oversized' verdict when re-check trips a stricter threshold", () => {
    // Pre-fix this function doesn't exist. Post-fix: timed out + input
    // exceeds stricter threshold → no Gemini spawn, return verdict.
    const v = resolveTimeoutFallback({
      primaryFailureKind: "timeout",
      primaryTimeoutMs: 1_500_000,
      inputFileSize: 200_000, // bytes — large prompt
      strictThresholdBytes: 100_000,
    });
    expect(v.kind).toBe("phase_oversized");
    if (v.kind === "phase_oversized") {
      expect(v.reason).toMatch(/200000|too large|exceeds/);
    }
  });

  it("escalates backup timeout to the primary's budget when scope re-check passes", () => {
    const v = resolveTimeoutFallback({
      primaryFailureKind: "timeout",
      primaryTimeoutMs: 1_500_000,
      inputFileSize: 50_000,
      strictThresholdBytes: 100_000,
    });
    expect(v.kind).toBe("escalate_budget");
    if (v.kind === "escalate_budget") {
      // Same budget Kimi had, not half.
      expect(v.timeoutMs).toBe(1_500_000);
    }
  });

  it("keeps half-budget behavior for non-timeout failures (model service hiccup)", () => {
    const v = resolveTimeoutFallback({
      primaryFailureKind: "error",
      primaryTimeoutMs: 1_500_000,
      inputFileSize: 50_000,
      strictThresholdBytes: 100_000,
    });
    expect(v.kind).toBe("halved_budget");
    if (v.kind === "halved_budget") {
      // Current behavior: backupMs = max(60s, primary/2) ≈ 750_000.
      expect(v.timeoutMs).toBe(750_000);
    }
  });
});

describe("resolveFallbackForRoleTask", () => {
  const baseOpts: RunRoleTaskOpts = {
    role: {
      provider: "kimi",
      model: "kimi-x",
      reasoning: "high",
      backupProvider: "gemini",
      backupModel: "gemini-x",
    },
    inputFilePath: "/tmp/in",
    outputFilePath: "/tmp/out",
    cwd: "/tmp",
    slug: "test",
    phaseNumber: "1",
    iteration: 1,
    logPrefix: "primary-impl",
  };

  it("swaps provider/model to backup", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForRoleTask(baseOpts, resolved);
    expect(out.role.provider).toBe("gemini");
    expect(out.role.model).toBe("gemini-x");
  });

  it("sets backup timeout from resolved.backupMs", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForRoleTask(baseOpts, resolved);
    expect(out.timeoutMs).toBe(750000); // half of 1500s kimi default
  });

  it("appends -backup-<provider> to the logPrefix", () => {
    const resolved = resolveRoleTimeouts(baseOpts.role);
    const out = resolveFallbackForRoleTask(baseOpts, resolved);
    expect(out.logPrefix).toBe("primary-impl-backup-gemini");
  });
});

describe("checkPhaseScope", () => {
  const oldMaxChars = process.env.GSTACK_BUILD_MAX_PROMPT_CHARS;
  const oldMaxFiles = process.env.GSTACK_BUILD_MAX_FILES_PER_PHASE;
  afterEach(() => {
    if (oldMaxChars === undefined)
      delete process.env.GSTACK_BUILD_MAX_PROMPT_CHARS;
    else process.env.GSTACK_BUILD_MAX_PROMPT_CHARS = oldMaxChars;
    if (oldMaxFiles === undefined)
      delete process.env.GSTACK_BUILD_MAX_FILES_PER_PHASE;
    else process.env.GSTACK_BUILD_MAX_FILES_PER_PHASE = oldMaxFiles;
  });

  it("ok:true for a small prompt", () => {
    const tmp = path.join(os.tmpdir(), `scope-small-${Date.now()}.md`);
    fs.writeFileSync(tmp, "implement foo.ts");
    try {
      const r = checkPhaseScope(tmp);
      expect(r.ok).toBe(true);
      expect(r.promptChars).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it("ok:false when prompt exceeds 10000 chars by default", () => {
    const tmp = path.join(os.tmpdir(), `scope-large-${Date.now()}.md`);
    fs.writeFileSync(tmp, "a".repeat(12000));
    try {
      const r = checkPhaseScope(tmp);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("12000 chars");
    } finally {
      fs.rmSync(tmp);
    }
  });

  it("ok:false when prompt mentions more than 4 distinct file paths", () => {
    const tmp = path.join(os.tmpdir(), `scope-files-${Date.now()}.md`);
    fs.writeFileSync(
      tmp,
      "modify a.ts, b.ts, c.ts, d.ts, e.ts, and f.ts — six files in total",
    );
    try {
      const r = checkPhaseScope(tmp);
      expect(r.ok).toBe(false);
      expect(r.filePathMentions).toBeGreaterThan(4);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it("respects GSTACK_BUILD_MAX_PROMPT_CHARS env override", () => {
    process.env.GSTACK_BUILD_MAX_PROMPT_CHARS = "50";
    const tmp = path.join(os.tmpdir(), `scope-env-chars-${Date.now()}.md`);
    fs.writeFileSync(
      tmp,
      "this prompt is longer than fifty characters, easily.",
    );
    try {
      const r = checkPhaseScope(tmp);
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it("respects GSTACK_BUILD_MAX_FILES_PER_PHASE env override", () => {
    process.env.GSTACK_BUILD_MAX_FILES_PER_PHASE = "1";
    const tmp = path.join(os.tmpdir(), `scope-env-files-${Date.now()}.md`);
    fs.writeFileSync(tmp, "modify a.ts and b.ts");
    try {
      const r = checkPhaseScope(tmp);
      expect(r.ok).toBe(false);
      expect(r.filePathMentions).toBe(2);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it("ok:true for missing input file (don't break the caller)", () => {
    const r = checkPhaseScope("/nonexistent/path/that/does/not/exist.md");
    expect(r.ok).toBe(true);
    expect(r.promptChars).toBe(0);
    expect(r.filePathMentions).toBe(0);
  });

  it("counts distinct file paths (dedupes repeats)", () => {
    const tmp = path.join(os.tmpdir(), `scope-dedupe-${Date.now()}.md`);
    fs.writeFileSync(tmp, "foo.ts and foo.ts again and foo.ts thrice");
    try {
      const r = checkPhaseScope(tmp);
      expect(r.filePathMentions).toBe(1);
    } finally {
      fs.rmSync(tmp);
    }
  });
});

describe("runConfiguredRoleTask: timeout-fix integration", () => {
  it("stall kill spawns primary exactly once, then falls through to backup", async () => {
    // Under liveness semantics, a stalled primary is NOT retried — same stall
    // window will stall again. Caller's fallback path runs the backup instead.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-once-"));
    const slug = `stall-once-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const oldGeminiBin = process.env.GEMINI_BIN;
    const callsPath = path.join(tmpDir, "kimi-calls.txt");
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/bin/sh\necho call >> ${callsPath}\nsleep 10\n`,
      );
      fs.chmodSync(fakeKimi, 0o755);

      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) process.exit(2);
fs.writeFileSync(match[1], "backup ok");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);

      process.env.KIMI_BIN = fakeKimi;
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "small");
      fs.writeFileSync(outputFilePath, "");

      await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship-stall-once",
        // 2000ms stall window — long enough for the shell to flush its
        // `echo call >> $callsPath` write under parallel test-suite load
        // before the watchdog SIGTERMs.
        timeoutMs: 2000,
        role: {
          provider: "kimi",
          model: "kimi-x",
          reasoning: "high",
          backupProvider: "gemini",
          backupModel: "gemini-x",
        },
      });

      // Exactly one kimi spawn (no retry under liveness), then gemini backup ran.
      const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n");
      expect(calls.length).toBe(1);
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("backup ok");
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });

  it("phase_oversized fail-fast for primary-impl logPrefix when prompt > maxChars", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oversized-"));
    const slug = `oversized-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const callsPath = path.join(tmpDir, "kimi-calls.txt");
    try {
      // Fake kimi that records calls; this should never get called.
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/bin/sh\necho call >> ${callsPath}\nexit 0\n`,
      );
      fs.chmodSync(fakeKimi, 0o755);
      process.env.KIMI_BIN = fakeKimi;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      // Oversized prompt: exceeds default 10000 char threshold.
      fs.writeFileSync(inputFilePath, "x".repeat(12000));
      fs.writeFileSync(outputFilePath, "stale");

      const result = await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "primary-impl", // gated role
        role: {
          provider: "kimi",
          model: "kimi-x",
          reasoning: "high",
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("phase_oversized");
      expect(result.timedOut).toBe(false);
      expect(fs.existsSync(callsPath)).toBe(false); // no spawn
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe(""); // output cleared
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
    }
  });

  it("oversized check skipped for non-impl roles (e.g. judge logPrefix)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oversized-skip-"));
    const slug = `oversized-skip-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const idx = args.indexOf("-p");
const prompt = idx >= 0 ? args[idx + 1] : "";
// Both kimi-task and codex-review use "to <path>" in their prompt — but
// runKimi uses staged paths inside its own staging dir. Just write a non-empty
// status to the staged output dir referenced in the prompt and exit 0.
const match = prompt.match(/output to (.+?\\.md)\\./);
if (match) { try { fs.writeFileSync(match[1], "ok"); } catch (e) {} }
process.stdout.write(match ? match[1] : "ok");
`,
      );
      fs.chmodSync(fakeKimi, 0o755);
      process.env.KIMI_BIN = fakeKimi;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      // Oversized prompt — would trigger fail-fast for primary-impl, but logPrefix is "judge".
      fs.writeFileSync(inputFilePath, "x".repeat(12000));
      fs.writeFileSync(outputFilePath, "");

      const result = await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "judge", // not in ENFORCE_SCOPE_ROLES
        role: {
          provider: "kimi",
          model: "kimi-x",
          reasoning: "high",
        },
      });

      // No fail-fast — kimi was actually invoked.
      expect(result.stderr).not.toContain("phase_oversized");
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });

  it("backup uses halved-and-floored timeout (450s when primary defaults to 900s)", async () => {
    // We can't directly observe the spawn timeout from outside, but we can
    // observe the warning message via console.warn. Use a fake console.warn
    // capture via process.stderr buffering.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halved-"));
    const slug = `halved-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const oldGeminiBin = process.env.GEMINI_BIN;
    const oldWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(fakeKimi, `#!/bin/sh\nexit 1\n`);
      fs.chmodSync(fakeKimi, 0o755);
      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (match) fs.writeFileSync(match[1], "backup ok");
process.stdout.write(match ? match[1] : "");
`,
      );
      fs.chmodSync(fakeGemini, 0o755);
      process.env.KIMI_BIN = fakeKimi;
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "small");
      fs.writeFileSync(outputFilePath, "");

      await runConfiguredRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship-halved",
        // No timeoutMs passed → role.timeoutMs unset → provider default = 900s → backup = 450s
        role: {
          provider: "kimi",
          model: "kimi-x",
          reasoning: "high",
          backupProvider: "gemini",
          backupModel: "gemini-x",
        },
      });

      const warn = warnings.find((w) => w.includes("falling back"));
      expect(warn).toBeDefined();
      expect(warn).toContain("750000ms"); // half of kimi 1500000 default
      expect(warn).toContain("single-shot");
    } finally {
      console.warn = oldWarn;
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("spawnCaptured streaming", () => {
  // Pre-streaming, spawnCaptured did a single fs.writeFileSync on child close.
  // /ship-driven e2e runs that took 10+ min produced 0 bytes of visible log
  // until the very end, so the orchestrator looked frozen for the whole window.
  // These tests pin the new contract: header at top, channel-tagged live body,
  // result footer at end, all via a single fd.

  // Liveness assertion. The original A-T1 used a 1s child sleep and a 1s
  // poll window — the bounds matched, so on a slow CI runner the poll could
  // finish AFTER the child exits, in which case the [OUT] line is also
  // visible in the post-close write — i.e. the assertion `observed.includes`
  // would pass even if streaming were buffered to the end. The fix:
  // 1. Extend the child's sleep to 3s so the poll-while-alive window is
  //    unambiguously inside the run.
  // 2. After observing the streamed line, race the pending promise against
  //    a setImmediate-resolved promise and require setImmediate wins — this
  //    proves the child has not yet resolved (i.e. is still running) at the
  //    moment of observation. Returns the same observed text either way; the
  //    failure surface is that the pending wins the race when streaming is
  //    actually buffered-on-close.
  async function expectStreamingWhileAlive(
    pending: ReturnType<typeof spawnCaptured>,
    logPath: string,
    needle: string,
  ): Promise<string> {
    let observed = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        observed = fs.readFileSync(logPath, "utf8");
      } catch {
        // file not flushed yet, keep polling
      }
      if (observed.includes(needle)) break;
    }
    expect(observed).toContain(needle);

    // Liveness check: the pending promise must NOT have resolved by the time
    // we observe the streamed line. If pending wins the race against
    // setImmediate, the child exited before we observed — meaning the line
    // could have been written on close, not streamed mid-run.
    const RACE_SENTINEL = Symbol("setImmediate-won");
    const livenessRace = await Promise.race([
      pending.then(() => "pending-resolved" as const),
      new Promise<typeof RACE_SENTINEL>((r) =>
        setImmediate(() => r(RACE_SENTINEL)),
      ),
    ]);
    expect(livenessRace).toBe(RACE_SENTINEL);

    return observed;
  }

  it("streams stdout to logPath while the child is still alive (A-T1)", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-stream-"),
    );
    const logPath = path.join(tmpDir, "streamed.log");
    try {
      const pending = spawnCaptured({
        bin: "bash",
        argv: ["-c", "echo STREAMED; sleep 3"],
        cwd: tmpDir,
        timeoutMs: 10000,
        logPath,
        closeStdin: true,
      });
      // Poll up to 1s for the streamed line, then prove the child is still
      // alive at observation time. The 3s sleep gives us ~2s of headroom.
      const observed = await expectStreamingWhileAlive(
        pending,
        logPath,
        "[OUT] STREAMED",
      );
      // Header is at the top (preserves existing log-format contract).
      expect(observed.split("\n")[0]).toMatch(/^# command: bash/);
      // Let the child finish so we don't leak.
      const result = await pending;
      expect(result.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("streams stderr with [ERR] prefix (A-T2)", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-stream-err-"),
    );
    const logPath = path.join(tmpDir, "stderr.log");
    try {
      const pending = spawnCaptured({
        bin: "bash",
        argv: ["-c", "echo STREAMED-ERR 1>&2; sleep 3"],
        cwd: tmpDir,
        timeoutMs: 10000,
        logPath,
        closeStdin: true,
      });
      await expectStreamingWhileAlive(pending, logPath, "[ERR] STREAMED-ERR");
      await pending;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("final log contains streamed body and footer block after close (A-T3)", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-footer-"),
    );
    const logPath = path.join(tmpDir, "full.log");
    try {
      const result = await spawnCaptured({
        bin: "bash",
        argv: ["-c", "echo body-line; echo body-err 1>&2; exit 0"],
        cwd: tmpDir,
        timeoutMs: 5000,
        logPath,
        closeStdin: true,
      });
      expect(result.exitCode).toBe(0);
      const log = fs.readFileSync(logPath, "utf8");
      // Header at top.
      expect(log).toMatch(/^# command: bash/);
      // Body contains both channels.
      expect(log).toContain("[OUT] body-line");
      expect(log).toContain("[ERR] body-err");
      // Footer at end. Match across newlines; the `# duration_ms:` line must
      // come AFTER the `# ---- result ----` marker (single fd, in-order).
      const resultIdx = log.indexOf("# ---- result ----");
      const durationIdx = log.indexOf("# duration_ms:");
      const exitIdx = log.indexOf("# exit: 0");
      expect(resultIdx).toBeGreaterThan(0);
      expect(durationIdx).toBeGreaterThan(resultIdx);
      expect(exitIdx).toBeGreaterThan(durationIdx);
      // Byte-counts present and non-trivial.
      expect(log).toMatch(/# stdout_bytes: \d+/);
      expect(log).toMatch(/# stderr_bytes: \d+/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writer error is logged via console.warn but does not throw (A-T4)", async () => {
    // Construct a logPath whose parent does not exist. createWriteStream
    // returns a stream that emits 'error' on first write (ENOENT). This
    // exercises the ws.on('error') path: the run should still complete
    // successfully, console.warn should fire exactly once, and the result
    // object should still resolve cleanly.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-werr-"),
    );
    const badLogPath = path.join(tmpDir, "no-such-dir", "log.txt");
    const warnings: string[] = [];
    const oldWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const result = await spawnCaptured({
        bin: "bash",
        argv: ["-c", "echo unaffected"],
        cwd: tmpDir,
        timeoutMs: 5000,
        logPath: badLogPath,
        closeStdin: true,
      });
      // Child runs and exits normally even though the log writer never
      // reached disk.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("unaffected");
      // Exactly one writer-error warning surfaced (NOT swallowed silently).
      const writerErrors = warnings.filter((w) =>
        w.includes("log writer error"),
      );
      expect(writerErrors.length).toBeGreaterThanOrEqual(1);
      expect(writerErrors[0]).toContain(badLogPath);
    } finally {
      console.warn = oldWarn;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // F5 — channel-prefix mid-line corruption.
  // The original naive `text.split(/(?<=\n)/).map(prefix).join('')` form
  // would inject a fresh `[OUT] `/`[ERR] ` prefix mid-line whenever a
  // child chunked output mid-line. Cross-channel interleave is worse:
  // it could make a stdout fragment look like part of a stderr line.
  // These tests pin the corrected behavior.

  it("A-T5: chunked stdout (no terminator in chunk 1) does not inject mid-line prefix", async () => {
    // Use printf with explicit pauses so chunk 1 arrives without \n, then
    // chunk 2 completes the line. If the naive split-and-prefix form ran,
    // the log would contain `[OUT] foo [OUT] bar\n` — a spurious prefix.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-f5-stdout-"),
    );
    const logPath = path.join(tmpDir, "chunked.log");
    try {
      const result = await spawnCaptured({
        bin: "bash",
        argv: ["-c", "printf 'foo '; sleep 0.2; printf 'bar\\n'"],
        cwd: tmpDir,
        timeoutMs: 5000,
        logPath,
        closeStdin: true,
      });
      expect(result.exitCode).toBe(0);
      const log = fs.readFileSync(logPath, "utf8");
      // Exactly one [OUT] prefix on the "foo bar" line. Spurious mid-line
      // prefix would produce `[OUT] foo [OUT] bar\n`.
      expect(log).toContain("[OUT] foo bar\n");
      expect(log).not.toContain("foo [OUT] bar");
      // Channel count check: the body has exactly one [OUT] occurrence
      // for this content. Header has no channel tags.
      const outCount = (log.match(/\[OUT\]/g) || []).length;
      expect(outCount).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("A-T6: cross-channel interleave mid-line does not smear OUT into ERR", async () => {
    // Sequence: OUT "foo " (no \n), ERR "warn\n", OUT "bar\n".
    // Without per-channel line-start tracking, the disk content would be
    // `[OUT] foo [ERR] warn\n[OUT] bar\n` — readers see "foo warn" as
    // a single ERR line, completely wrong about which channel said
    // "foo". The fix injects a `[OUT] (cont)\n` continuation marker
    // when the active channel switches mid-line.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-f5-cross-"),
    );
    const logPath = path.join(tmpDir, "cross.log");
    try {
      const result = await spawnCaptured({
        bin: "bash",
        argv: [
          "-c",
          "printf 'foo '; sleep 0.2; printf 'warn\\n' 1>&2; sleep 0.2; printf 'bar\\n'",
        ],
        cwd: tmpDir,
        timeoutMs: 5000,
        logPath,
        closeStdin: true,
      });
      expect(result.exitCode).toBe(0);
      const log = fs.readFileSync(logPath, "utf8");
      // "foo " must NEVER appear immediately followed by "[ERR]" on the
      // same visible line — the continuation marker breaks them apart.
      expect(log).not.toMatch(/\[OUT\] foo \[ERR\]/);
      // "warn" is an ERR line, "bar" is an OUT line, and both must
      // appear with their own prefix on their own line.
      expect(log).toMatch(/\[ERR\] warn$/m);
      expect(log).toMatch(/\[OUT\] bar$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("A-T7: trailing partial line at EOF is flushed with a newline before the footer", async () => {
    // Child exits before emitting a terminator. The pre-streaming model
    // produced a log with no trailing newline between the last [OUT]
    // line and the `# ---- result ----` footer, which made the result
    // header look like a continuation of the last [OUT] line. The fix
    // injects a synthetic newline at finish() time so the footer
    // always starts at column 0.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "spawncaptured-f5-partial-"),
    );
    const logPath = path.join(tmpDir, "partial.log");
    try {
      const result = await spawnCaptured({
        bin: "bash",
        // No trailing \n on "tail".
        argv: ["-c", "printf 'head\\ntail'"],
        cwd: tmpDir,
        timeoutMs: 5000,
        logPath,
        closeStdin: true,
      });
      expect(result.exitCode).toBe(0);
      const log = fs.readFileSync(logPath, "utf8");
      // The footer marker is at line start, not appended to "[OUT] tail".
      expect(log).toMatch(/\n# ---- result ----\n/);
      // The last body line is "[OUT] tail" terminated by exactly one \n.
      expect(log).toMatch(/\[OUT\] tail\n\n?# ---- result ----/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
