/**
 * Pins the structural fix for Bug A: cli.ts's outer finally honors any
 * ExitError thrown inside the try via a captured pendingExitError. Without
 * this, `process.exit(exitCode)` in the finally would mask thrown codes
 * because `exitCode` defaults to 1 and gets set to 0 on the success path
 * BEFORE the failure branches throw — so a throw new ExitError(3) after a
 * successful prior phase would exit 0 (false success).
 *
 * The behavioral consequence of the bug is the synth_failure restart storm
 * documented in ~/.claude/plans/fix-plan-review-loop-stalemate-restart-storm.md:
 * the monitor sees exit 0 + a "synth_failure" state status, auto-resumes the
 * crashed run, which hits the same failure again, ad infinitum.
 *
 * This test is intentionally a static-grep wiring check rather than a
 * subprocess invocation. The pattern is 3 lines of plain JS semantics; what
 * matters is that all three pieces stay wired together. Behavioral coverage
 * comes from plan-reviewer-loop.test.ts (which exercises the new exit-3
 * path end-to-end through the actual loop function).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Bug A: ExitError code propagation through outer finally", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const content = fs.readFileSync(cliPath, "utf-8");

  it("declares pendingExitError near exitCode", () => {
    expect(content).toContain(
      "let pendingExitError: ExitError | null = null",
    );
  });

  it("captures ExitError in catch and re-throws", () => {
    expect(content).toMatch(
      /if \(err instanceof ExitError\) pendingExitError = err/,
    );
  });

  it("finally exits with the pending ExitError code if any", () => {
    expect(content).toMatch(
      /process\.exit\(pendingExitError\?\.code \?\? exitCode\)/,
    );
  });

  it("imports ExitError (the captured type)", () => {
    expect(content).toMatch(/import \{[^}]*ExitError[^}]*\} from "\.\/errors"/);
  });

  it("pendingExitError pattern verified semantically (sanity)", () => {
    // Sanity check: prove the JS semantics of the pattern work. If this ever
    // fails, JavaScript itself broke. Kept for completeness so a future
    // contributor can read this file and see the pattern in action.
    class TestExitError extends Error {
      constructor(public readonly code: number) {
        super(`ExitError(${code})`);
      }
    }
    let exitCode = 1;
    let pendingExitError: TestExitError | null = null;
    let effectiveCode: number | undefined;
    try {
      try {
        exitCode = 0; // success path runs first
        throw new TestExitError(3); // then failure throws
      } catch (err) {
        if (err instanceof TestExitError) pendingExitError = err;
        throw err;
      } finally {
        effectiveCode = pendingExitError?.code ?? exitCode;
      }
    } catch {
      // expected — the inner throw re-throws past finally
    }
    expect(effectiveCode).toBe(3);
  });
});
