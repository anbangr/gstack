import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// The feature-review loop is deeply embedded in cli.ts. Rather than spin up
// a full orchestrator harness, we exercise the off-by-one bug via static
// source inspection — the bug is in the log-message expression, not in
// behavior reachable from a unit test. The class-1 fault report shows
// `cycle 6/5` when cap=5, meaning the log message prints `currentIter + 1`
// instead of `currentIter` after the last passing iteration. After the
// fix, the source must NOT contain `${currentIter + 1}/${cap}` in the
// UNCLEAR-retry warning.

describe("feature review cap off-by-one (class 1)", () => {
  let cliSrc: string;

  test("T12: UNCLEAR retry log uses currentIter, not currentIter + 1", () => {
    cliSrc = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "cli.ts"),
      "utf8",
    );
    const start = cliSrc.indexOf("review verdict was UNCLEAR");
    expect(start).toBeGreaterThan(-1);
    // Take a window around the warning to capture the template string.
    const window = cliSrc.slice(start - 50, start + 200);
    // The pre-fix pattern that produced "cycle 6/5":
    expect(window).not.toMatch(/currentIter\s*\+\s*1.*\/.*cap/);
    // The post-fix pattern: just `${currentIter}/${cap}`.
    expect(window).toMatch(/\$\{currentIter\}\/\$\{cap\}/);
  });
});
