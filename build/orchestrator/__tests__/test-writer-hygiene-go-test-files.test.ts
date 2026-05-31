/**
 * Regression test for the test-writer role-drift hygiene gate's path classifier.
 *
 * Bug (filed 2026-05-31, repro on Go repo `polis-mesh`): the test-writer phase
 * wrote valid co-located Go test files (`pkg/reputation/ledger_set_adjust_test.go`,
 * `update_signed_test.go`) and the post-agent hygiene gate aborted the phase with
 * RUN_FAILED — "test-writer recovery REFUSED: agent's output summary listed N
 * non-test file(s)" — treating real Go tests as production-code role drift. It
 * reproduced on EVERY run; no Go feature could complete.
 *
 * Root cause: `isTestPath` was defined twice (cli.ts classifyTestWriterCommit +
 * recoverMutableAgentCommit's test-writer block) and neither recognized Go's
 * co-located `<name>_test.go` convention — Go tests live next to source (not in a
 * `test/` dir) and the basename is `*_test.go`, not `*.test.*`. A v1.51 local
 * hotfix was reverted by the v1.52 upgrade, hence the durable fix: one shared
 * `isTestWriterPath` helper both gate sites route through, plus the test-writer
 * PROMPT (sub-agents.ts) widened to name `*_test.go` and the T-H6d/T-H6e drift
 * guards (codex-role-prompt.test.ts) keeping prompt and enforcer in lockstep.
 *
 * Failure direction is asymmetric: a false NEGATIVE (real test not recognized)
 * discards real agent work — severe; a false POSITIVE (non-test counted) merely
 * lets the gate pass — low harm. The table recognizes mainstream co-located
 * conventions; production source must still be excluded.
 *
 * Report: ~/.gstack/skill-faults/inbox/BUGREPORT-2026-05-31-test-writer-hygiene-go-test-files.md
 */

import { describe, it, expect } from "bun:test";
import { isTestWriterPath, classifyTestWriterCommit } from "../cli";

describe("test-writer hygiene: isTestWriterPath ecosystem coverage", () => {
  it("THE BUG: recognizes co-located Go `*_test.go` files (verbatim incident)", () => {
    expect(isTestWriterPath("pkg/reputation/ledger_set_adjust_test.go")).toBe(
      true,
    );
    expect(isTestWriterPath("pkg/reputation/update_signed_test.go")).toBe(true);
    expect(isTestWriterPath("main_test.go")).toBe(true);
  });

  it("does NOT classify Go SOURCE as a test (false-positive guard)", () => {
    // The discard-real-work risk is asymmetric, but production source must
    // still read as non-test or the gate becomes meaningless. These are the
    // exact files the hygiene-attribution test pins as nonTestPaths.
    expect(isTestWriterPath("pkg/reputation/ledger.go")).toBe(false);
    expect(isTestWriterPath("soak/soak_runner.go")).toBe(false);
    expect(isTestWriterPath("main.go")).toBe(false);
    expect(isTestWriterPath("lib/baz.go")).toBe(false);
  });

  it("recognizes the other co-located conventions", () => {
    expect(isTestWriterPath("test_foo.py")).toBe(true); // Python prefix
    expect(isTestWriterPath("foo_test.py")).toBe(true); // Python suffix
    expect(isTestWriterPath("src/FooTest.kt")).toBe(true); // Kotlin
    expect(isTestWriterPath("Tests/AppTests.swift")).toBe(true); // Swift
    expect(isTestWriterPath("UserServiceTests.cs")).toBe(true); // C#
    expect(isTestWriterPath("tests/OrderTest.php")).toBe(true); // PHP
    expect(isTestWriterPath("test/foo_test.exs")).toBe(true); // Elixir
    expect(isTestWriterPath("FooSpec.scala")).toBe(true); // Scala
    expect(isTestWriterPath("BarTest.scala")).toBe(true); // Scala
  });

  it("still recognizes the pre-existing conventions (no regression)", () => {
    expect(isTestWriterPath("src/a.test.ts")).toBe(true); // *.test.*
    expect(isTestWriterPath("src/b.spec.tsx")).toBe(true); // *.spec.*
    expect(isTestWriterPath("foo/__tests__/x.ts")).toBe(true); // __tests__/
    expect(isTestWriterPath("tests/integration.rs")).toBe(true); // tests/
    expect(isTestWriterPath("spec/models/user_spec.rb")).toBe(true); // spec/
    expect(isTestWriterPath("test/bar_spec.rb")).toBe(true); // test/
  });

  it("excludes production source and docs", () => {
    expect(isTestWriterPath("src/index.ts")).toBe(false);
    expect(isTestWriterPath("app/models/user.rb")).toBe(false);
    expect(isTestWriterPath("README.md")).toBe(false);
    expect(isTestWriterPath("foo.py")).toBe(false);
  });
});

describe("test-writer hygiene: classifyTestWriterCommit (leg 3 gate)", () => {
  it("passes a Go-only test commit (the incident scenario)", () => {
    const r = classifyTestWriterCommit([
      "pkg/reputation/ledger_set_adjust_test.go",
      "pkg/reputation/update_signed_test.go",
    ]);
    expect(r.ok).toBe(true);
    expect(r.nonTestPaths).toEqual([]);
    expect(r.testPaths.length).toBe(2);
  });

  it("refuses a mixed test+production commit (role drift preserved)", () => {
    const r = classifyTestWriterCommit(["app_test.go", "app.go"]);
    expect(r.ok).toBe(false);
    expect(r.nonTestPaths).toContain("app.go");
  });

  it("refuses an empty commit (must produce at least one test)", () => {
    expect(classifyTestWriterCommit([]).ok).toBe(false);
  });
});
