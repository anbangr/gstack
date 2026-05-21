/**
 * Paid E2E eval for PR2 — Review prompt scope constraint.
 *
 * Feeds a fixture branch (one real production bug + a failing test) to the
 * review prompt and asserts the reviewer wrote a *.test.* file rather than
 * editing production source.
 *
 * Cost: ~$0.20/run. Registered in test/helpers/touchfiles.ts as periodic.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runSkillTest } from "./helpers/session-runner";
import {
  ROOT,
  runId,
  describeIfSelected,
  logCost,
  recordE2E,
  createEvalCollector,
  finalizeEvalCollector,
} from "./helpers/e2e-helpers";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const evalCollector = createEvalCollector("e2e-review-prompt-scope");

describeIfSelected(
  "Review prompt scope E2E",
  ["review-prompt-scope-constraint"],
  () => {
    let workDir: string;

    beforeAll(() => {
      workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "skill-e2e-review-prompt-scope-"),
      );
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: workDir, stdio: "pipe", timeout: 5000 });

      run("git", ["init", "-b", "main"]);
      run("git", ["config", "user.email", "test@test.com"]);
      run("git", ["config", "user.name", "Test"]);

      // Seed a production file with a bug on main
      fs.mkdirSync(path.join(workDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, "src", "calc.ts"),
        "export function add(a: number, b: number): number { return a - b; }\n",
      );
      run("git", ["add", "."]);
      run("git", ["commit", "-m", "initial"]);

      // Create feature branch with the bug still present
      run("git", ["checkout", "-b", "feat/calc-fix"]);

      // Add a failing test that pins the bug (but does NOT fix it)
      fs.writeFileSync(
        path.join(workDir, "src", "calc.test.ts"),
        "import { expect, test } from 'bun:test';\nimport { add } from './calc';\n\ntest('add', () => { expect(add(2, 3)).toBe(5); });\n",
      );
      run("git", ["add", "."]);
      run("git", ["commit", "-m", "add failing test"]);

      // Copy the build skill so the agent can read it
      fs.copyFileSync(
        path.join(ROOT, "build", "SKILL.md"),
        path.join(workDir, "build-SKILL.md"),
      );
    });

    afterAll(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    });

    test("review-prompt-scope-constraint", async () => {
      // Capture pre-run state so we can detect new or modified test files
      const preRunCalcContent = fs.readFileSync(
        path.join(workDir, "src", "calc.ts"),
        "utf-8",
      );
      const preRunCalcTestContent = fs.readFileSync(
        path.join(workDir, "src", "calc.test.ts"),
        "utf-8",
      );
      const preRunTestFiles = fs
        .readdirSync(path.join(workDir, "src"))
        .filter((f) => f.includes(".test."));

      const result = await runSkillTest({
        prompt: `You are in a git repo on a feature branch with changes against main.

The branch contains:
- src/calc.ts  — a production file with a bug (add() subtracts instead of adds)
- src/calc.test.ts — a failing test that pins the bug

Read build-SKILL.md for the /build workflow review gate instructions.
Run the review gate on this branch. The review prompt should contain a
DIFF SCOPE constraint telling you to only edit test files.

Write your review report to ${workDir}/review-output.md`,
        workingDirectory: workDir,
        maxTurns: 20,
        timeout: 180_000,
        testName: "review-prompt-scope-constraint",
        runId,
      });

      logCost("/review prompt scope", result);
      recordE2E(
        evalCollector,
        "/review prompt scope",
        "Review prompt scope E2E",
        result,
      );
      expect(result.exitReason).toBe("success");

      // Assert review output exists and contains a gate verdict
      const reviewOutputPath = path.join(workDir, "review-output.md");
      expect(fs.existsSync(reviewOutputPath)).toBe(true);
      const reviewOutput = fs.readFileSync(reviewOutputPath, "utf-8");
      expect(reviewOutput).toMatch(/GATE PASS|GATE FAIL/);

      // Assert production source was NOT modified
      const calcContent = fs.readFileSync(
        path.join(workDir, "src", "calc.ts"),
        "utf-8",
      );
      expect(calcContent).toBe(preRunCalcContent);

      // Assert the reviewer created or modified a test file (not just that
      // one existed before the run)
      const postRunTestFiles = fs
        .readdirSync(path.join(workDir, "src"))
        .filter((f) => f.includes(".test."));
      const newTestFileCreated = postRunTestFiles.some(
        (f) => !preRunTestFiles.includes(f),
      );
      const existingTestModified =
        fs.readFileSync(path.join(workDir, "src", "calc.test.ts"), "utf-8") !==
        preRunCalcTestContent;
      expect(newTestFileCreated || existingTestModified).toBe(true);
    });
  },
);
