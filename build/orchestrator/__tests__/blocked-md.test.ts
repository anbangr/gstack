/**
 * BLOCKED.md hygiene + convergence-failure sentinel tests.
 *
 * Two failure modes to defend:
 *   1. The cli.ts BLOCKED.md trigger substring-matched against a hard-coded
 *      English message in phase-runner.ts. Any rephrasing in phase-runner.ts
 *      would silently disable BLOCKED.md production with no compile signal.
 *      Fixed by exporting CODEX_CONVERGENCE_FAILURE_REASON_PREFIX +
 *      isCodexConvergenceFailure() helper from phase-runner.ts.
 *   2. BLOCKED.md was not in .gitignore — `git add .` would ship it,
 *      potentially leaking sensitive review excerpts to public remotes.
 *      Fixed by ensureBlockedGitignored() which idempotently appends
 *      a BLOCKED*.md pattern to the project .gitignore.
 */
import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CODEX_CONVERGENCE_FAILURE_REASON_PREFIX,
  isCodexConvergenceFailure,
} from "../phase-runner";
import { ensureBlockedGitignored, BLOCKED_GITIGNORE_PATTERN } from "../cli";

describe("CODEX_CONVERGENCE_FAILURE_REASON_PREFIX + isCodexConvergenceFailure", () => {
  it("matches the actual reason string emitted by decideNextAction at the cap", () => {
    // The format phase-runner.ts builds: `${PREFIX} after ${maxIter} iterations`
    const reason = `${CODEX_CONVERGENCE_FAILURE_REASON_PREFIX} after 5 iterations`;
    expect(isCodexConvergenceFailure(reason)).toBe(true);
  });

  it("rejects unrelated FAIL reasons (gemini timeout, test fix exhaustion)", () => {
    expect(
      isCodexConvergenceFailure("Gemini timed out (after 3 retries)"),
    ).toBe(false);
    expect(
      isCodexConvergenceFailure("Tests still failing after 4 fix iterations"),
    ).toBe(false);
    expect(isCodexConvergenceFailure("phase previously failed")).toBe(false);
  });

  it("requires the prefix at the start (no false positives on substring buried in another message)", () => {
    expect(
      isCodexConvergenceFailure(
        "phase failed because Codex review failed to converge — see logs",
      ),
    ).toBe(false);
  });

  it("is empty-string safe", () => {
    expect(isCodexConvergenceFailure("")).toBe(false);
  });
});

describe("ensureBlockedGitignored", () => {
  let dir: string;

  function setup(initial?: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-gi-test-"));
    if (initial !== undefined) {
      fs.writeFileSync(path.join(dir, ".gitignore"), initial);
    }
    return dir;
  }

  afterEach(() => {
    if (dir && fs.existsSync(dir))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates .gitignore with the BLOCKED pattern when none exists", () => {
    setup();
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(BLOCKED_GITIGNORE_PATTERN);
  });

  it("appends without duplicating when the exact pattern is already present", () => {
    setup(`node_modules\n${BLOCKED_GITIGNORE_PATTERN}\n`);
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const occurrences = gi.match(/BLOCKED\*\.md/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it("recognizes pre-existing equivalent patterns and does not append again", () => {
    // A user who already gitignored just BLOCKED.md should not get a duplicate
    // line — their pattern covers the original case, even if not the per-phase
    // variants. We accept that as-is rather than rewriting their file.
    setup(`node_modules\nBLOCKED.md\n`);
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi.match(/BLOCKED/g)?.length).toBe(1);
  });

  it("recognizes /BLOCKED*.md (root-anchored) as covering", () => {
    setup(`node_modules\n/BLOCKED*.md\n`);
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi.match(/BLOCKED/g)?.length).toBe(1);
  });

  it("recognizes BLOCKED-phase-*.md (phase-only prefix) as covering", () => {
    setup(`node_modules\nBLOCKED-phase-*.md\n`);
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi.match(/BLOCKED/g)?.length).toBe(1);
  });

  it("preserves trailing newline when appending to a file with no trailing newline", () => {
    setup("node_modules"); // no \n at end
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    // Original line preserved, new pattern added on its own line.
    expect(gi.startsWith("node_modules")).toBe(true);
    expect(gi).toContain(BLOCKED_GITIGNORE_PATTERN);
    // No "node_modulesBLOCKED" mash-up.
    expect(gi).not.toContain("node_modulesBLOCKED");
  });

  it("ignores comment lines when checking for existing coverage", () => {
    setup(`# BLOCKED*.md is what we used to use\nother-stuff\n`);
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    // The commented-out line should NOT count as coverage; the pattern
    // gets appended.
    const lines = gi
      .split(/\r?\n/)
      .filter((l) => l.trim() === BLOCKED_GITIGNORE_PATTERN);
    expect(lines).toHaveLength(1);
  });

  it("is idempotent across multiple invocations", () => {
    setup();
    ensureBlockedGitignored(dir);
    ensureBlockedGitignored(dir);
    ensureBlockedGitignored(dir);
    const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi.match(/BLOCKED\*\.md/g)?.length).toBe(1);
  });
});
