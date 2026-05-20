import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// applyGateHygiene's blind-execution path requires `before.workTreeContents`
// to roll back gemini sandbox escapes. The captureGitSnapshot call that
// produces `before` must therefore pass `{captureContents: true}` — without
// it, `discardBlindExecutionChanges` refuses and prints
// "before.workTreeContents not captured; refusing to discard without it"
// (class 2 fault from the inbox).
//
// We exercise this via static source check: the captureGitSnapshot call
// immediately preceding `applyGateHygiene` in the gate loop must pass the
// captureContents flag.

describe("BLIND_EXECUTION rollback (class 2)", () => {
  test("T13: captureGitSnapshot call upstream of applyGateHygiene passes captureContents:true", () => {
    const cliSrc = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "cli.ts"),
      "utf8",
    );
    // The gate-loop body. Look for the `for (const { name, role } of plan.gates)`
    // block and confirm its captureGitSnapshot call carries captureContents.
    const gateLoopStart = cliSrc.indexOf(
      "for (const { name, role } of plan.gates)",
    );
    expect(gateLoopStart).toBeGreaterThan(-1);
    // Slice up to the next applyGateHygiene call so the window covers the
    // entire captureGitSnapshot line regardless of intervening doc comments.
    const gateHygieneIdx = cliSrc.indexOf("applyGateHygiene({", gateLoopStart);
    expect(gateHygieneIdx).toBeGreaterThan(gateLoopStart);
    const window = cliSrc.slice(gateLoopStart, gateHygieneIdx);
    expect(window).toContain("captureGitSnapshot");
    expect(window).toMatch(/captureGitSnapshot\([^)]*\{[^}]*captureContents:\s*true/s);
  });

  test("T13b: discardBlindExecutionChanges still refuses on missing workTreeContents", () => {
    // Sanity: the defensive check inside discardBlindExecutionChanges is
    // still there (it's the trigger that surfaced the bug). The fix is
    // upstream — make the caller pass the flag — not in the defensive
    // check itself.
    const cliSrc = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "cli.ts"),
      "utf8",
    );
    const fnStart = cliSrc.indexOf("export function discardBlindExecutionChanges");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = cliSrc.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain("workTreeContents not captured");
  });
});
