/**
 * T12: pre-merge feature verifier — pure-helper + spawn-dispatcher tests.
 *
 * parseFeatureVerifierOutput and detectBaseBranch are pure (no real fs /
 * subprocess); they're exercised directly with raw input. runFeatureVerifier
 * shells out to git + spawns a role, so we test it through an injectable
 * dispatcher stub (and a runSpawn stub for the base-branch detection
 * fallback chain).
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseFeatureVerifierOutput,
  detectBaseBranch,
  runFeatureVerifier,
  type RoleTaskDispatcher,
} from "../feature-verifier";
import type { RoleConfig } from "../role-config";
import type { Feature, FeatureState } from "../types";

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    index: 0,
    number: "1",
    name: "Test feature",
    body: "feature body",
    phaseIndexes: [0],
    ...overrides,
  };
}

function makeFeatureState(overrides: Partial<FeatureState> = {}): FeatureState {
  return {
    index: 0,
    number: "1",
    name: "Test feature",
    status: "phases_done",
    branch: "feat/test-feature-1",
    ...overrides,
  } as FeatureState;
}

const roleStub: RoleConfig = {
  provider: "codex",
  model: "gpt-5.5",
  reasoning: "high",
};

describe("parseFeatureVerifierOutput", () => {
  it("parses VERIFICATION: PASS with no real gaps", () => {
    const raw = "VERIFICATION: PASS\nGAPS:\n- none\n";
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("PASS");
    expect(r.gaps).toEqual([]);
  });

  it("parses VERIFICATION: GAPS and extracts every gap bullet", () => {
    const raw = [
      "VERIFICATION: GAPS",
      "GAPS:",
      "- missing migration for new field",
      "- no docs for public API",
      "- integration test absent",
    ].join("\n");
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("GAPS");
    expect(r.gaps).toEqual([
      "missing migration for new field",
      "no docs for public API",
      "integration test absent",
    ]);
  });

  it("returns UNCLEAR when output has no VERIFICATION: line", () => {
    const raw = "I'll start by reading the plan...\nNo verdict emitted.\n";
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("UNCLEAR");
    expect(r.gaps).toEqual([]);
  });

  it("returns UNCLEAR on empty string", () => {
    const r = parseFeatureVerifierOutput("");
    expect(r.verdict).toBe("UNCLEAR");
    expect(r.gaps).toEqual([]);
  });

  it("prefers GAPS when both sentinels appear at line start (defense-in-depth)", () => {
    // If the model writes both at line start (rare but possible — e.g., a
    // first-pass PASS verdict the model later overrides), treat the more
    // conservative GAPS as the verdict to avoid silently shipping work
    // that has any flagged gap.
    const raw = [
      "VERIFICATION: PASS",
      "",
      "VERIFICATION: GAPS",
      "GAPS:",
      "- missing tests",
    ].join("\n");
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("GAPS");
    expect(r.gaps).toEqual(["missing tests"]);
  });

  it("filters out a bare '- none' bullet from gaps list", () => {
    const raw = "VERIFICATION: GAPS\nGAPS:\n- none\n";
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("GAPS");
    // Even though verdict is GAPS, the model said "none" — keep gaps empty
    // and let the caller decide whether to treat this as a diagnostic.
    expect(r.gaps).toEqual([]);
  });

  it("tolerates extra whitespace around the verdict line", () => {
    const raw = "   VERIFICATION:   PASS   \n\nGAPS:\n- none\n";
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("PASS");
  });

  it("captures gap text after the dash regardless of indentation", () => {
    const raw = [
      "VERIFICATION: GAPS",
      "GAPS:",
      "-no-space-after-dash",
      "-   triple-space-indented",
      "- normal-bullet",
    ].join("\n");
    const r = parseFeatureVerifierOutput(raw);
    expect(r.verdict).toBe("GAPS");
    expect(r.gaps).toEqual([
      "no-space-after-dash",
      "triple-space-indented",
      "normal-bullet",
    ]);
  });
});

describe("detectBaseBranch", () => {
  it("prefers origin/HEAD when symbolic-ref succeeds", () => {
    const r = detectBaseBranch({
      cwd: "/fake",
      runSpawn: (_cmd, argv) => {
        if (argv.includes("symbolic-ref"))
          return { status: 0, stdout: "origin/main\n" };
        // shouldn't be reached
        return { status: 1, stdout: "" };
      },
    });
    expect(r.baseBranch).toBe("main");
    expect(r.source).toBe("origin/HEAD");
  });

  it("falls back to origin/main when symbolic-ref fails", () => {
    const r = detectBaseBranch({
      cwd: "/fake",
      runSpawn: (_cmd, argv) => {
        if (argv.includes("symbolic-ref")) return { status: 1, stdout: "" };
        if (argv.includes("origin/main")) return { status: 0, stdout: "" };
        return { status: 1, stdout: "" };
      },
    });
    expect(r.baseBranch).toBe("main");
    expect(r.source).toBe("origin/main");
  });

  it("falls back to origin/master when symbolic-ref and origin/main both fail", () => {
    const r = detectBaseBranch({
      cwd: "/fake",
      runSpawn: (_cmd, argv) => {
        if (argv.includes("symbolic-ref")) return { status: 1, stdout: "" };
        if (argv.includes("origin/main")) return { status: 1, stdout: "" };
        if (argv.includes("origin/master")) return { status: 0, stdout: "" };
        return { status: 1, stdout: "" };
      },
    });
    expect(r.baseBranch).toBe("master");
    expect(r.source).toBe("origin/master");
  });

  it("returns empty result when all three fallbacks fail", () => {
    const r = detectBaseBranch({
      cwd: "/fake",
      runSpawn: () => ({ status: 1, stdout: "" }),
    });
    expect(r.baseBranch).toBe("");
    expect(r.source).toBe("");
  });

  it("ignores symbolic-ref success with empty stdout", () => {
    // Edge case: status=0 but ref is empty (shouldn't happen but be defensive).
    const r = detectBaseBranch({
      cwd: "/fake",
      runSpawn: (_cmd, argv) => {
        if (argv.includes("symbolic-ref"))
          return { status: 0, stdout: "   \n" };
        if (argv.includes("origin/main")) return { status: 0, stdout: "" };
        return { status: 1, stdout: "" };
      },
    });
    // Should have fallen through to origin/main rather than picking empty.
    expect(r.baseBranch).toBe("main");
    expect(r.source).toBe("origin/main");
  });
});

describe("runFeatureVerifier", () => {
  function mkTmpdir(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fv-test-"));
    return {
      dir,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("dry-run returns PASS without invoking the dispatcher", async () => {
    const tmp = mkTmpdir();
    try {
      // Pin GSTACK_STATE_DIR so logDir(slug) writes under tmp.
      const prev = process.env.GSTACK_STATE_DIR;
      process.env.GSTACK_STATE_DIR = tmp.dir;
      try {
        let dispatcherCalled = false;
        const dispatcher: RoleTaskDispatcher = async () => {
          dispatcherCalled = true;
          return { exitCode: 0, timedOut: false, logPath: "" };
        };
        const r = await runFeatureVerifier({
          feature: makeFeature(),
          featureState: makeFeatureState(),
          planFile: "/plan.md",
          cwd: tmp.dir,
          slug: "test-slug",
          role: roleStub,
          dryRun: true,
          dispatcher,
        });
        expect(dispatcherCalled).toBe(false);
        expect(r.verdict).toBe("PASS");
        expect(r.gaps).toEqual([]);
        const written = fs.readFileSync(r.outputFilePath, "utf8");
        expect(written).toContain("VERIFICATION: PASS");
        expect(written).toContain("dry-run");
      } finally {
        if (prev === undefined) delete process.env.GSTACK_STATE_DIR;
        else process.env.GSTACK_STATE_DIR = prev;
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("returns UNCLEAR when no base branch can be detected (no git remote)", async () => {
    const tmp = mkTmpdir();
    try {
      const prev = process.env.GSTACK_STATE_DIR;
      process.env.GSTACK_STATE_DIR = tmp.dir;
      // tmp.dir is not a git repo + has no origin → detectBaseBranch falls
      // through all three fallbacks and returns empty.
      try {
        const r = await runFeatureVerifier({
          feature: makeFeature(),
          featureState: makeFeatureState(),
          planFile: "/plan.md",
          cwd: tmp.dir,
          slug: "test-slug-2",
          role: roleStub,
          dryRun: false,
          dispatcher: async () => ({
            exitCode: 0,
            timedOut: false,
            logPath: "",
          }),
        });
        expect(r.verdict).toBe("UNCLEAR");
        expect(r.reason).toMatch(/base branch/i);
      } finally {
        if (prev === undefined) delete process.env.GSTACK_STATE_DIR;
        else process.env.GSTACK_STATE_DIR = prev;
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("parses GAPS verdict + bullet list when dispatcher writes the output file", async () => {
    const tmp = mkTmpdir();
    try {
      const prev = process.env.GSTACK_STATE_DIR;
      process.env.GSTACK_STATE_DIR = tmp.dir;
      try {
        // Set up a real git repo with origin/main so detectBaseBranch works.
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fv-repo-"));
        try {
          const { spawnSync } = await import("node:child_process");
          spawnSync("git", ["init", "-q"], { cwd: repo });
          spawnSync("git", ["config", "user.email", "t@t"], { cwd: repo });
          spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
          spawnSync("git", ["commit", "--allow-empty", "-m", "init"], {
            cwd: repo,
          });
          // Simulate origin/main without a real remote — create the ref
          // directly under refs/remotes/origin/main pointing at HEAD.
          const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: repo,
            encoding: "utf8",
          }).stdout.trim();
          spawnSync(
            "git",
            ["update-ref", "refs/remotes/origin/main", headSha],
            { cwd: repo },
          );
          // symbolic-ref origin/HEAD too, so detection picks the canonical path.
          spawnSync(
            "git",
            ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
            { cwd: repo },
          );

          const dispatcher: RoleTaskDispatcher = async (opts) => {
            // Write a GAPS verdict to the output file the orchestrator passed.
            fs.writeFileSync(
              opts.outputFilePath,
              [
                "VERIFICATION: GAPS",
                "GAPS:",
                "- migration missing for new column",
                "- no entry in CHANGELOG",
              ].join("\n"),
            );
            return { exitCode: 0, timedOut: false, logPath: "/fake/log" };
          };

          const r = await runFeatureVerifier({
            feature: makeFeature(),
            featureState: makeFeatureState(),
            planFile: "/plan.md",
            cwd: repo,
            slug: "test-slug-gaps",
            role: roleStub,
            dryRun: false,
            dispatcher,
          });
          expect(r.verdict).toBe("GAPS");
          expect(r.gaps).toEqual([
            "migration missing for new column",
            "no entry in CHANGELOG",
          ]);
          expect(r.logPath).toBe("/fake/log");

          // Verify the prompt was written with the expected pre-merge framing.
          const promptBody = fs.readFileSync(r.inputFilePath, "utf8");
          expect(promptBody).toContain("PRE-MERGE");
          expect(promptBody).toContain(`Feature number: 1`);
          expect(promptBody).toContain("Base branch: main");
          expect(promptBody).toContain("VERIFICATION:");
        } finally {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      } finally {
        if (prev === undefined) delete process.env.GSTACK_STATE_DIR;
        else process.env.GSTACK_STATE_DIR = prev;
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("returns UNCLEAR when dispatcher reports non-zero exit and output has no sentinel", async () => {
    const tmp = mkTmpdir();
    try {
      const prev = process.env.GSTACK_STATE_DIR;
      process.env.GSTACK_STATE_DIR = tmp.dir;
      try {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fv-repo-"));
        try {
          const { spawnSync } = await import("node:child_process");
          spawnSync("git", ["init", "-q"], { cwd: repo });
          spawnSync("git", ["config", "user.email", "t@t"], { cwd: repo });
          spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
          spawnSync("git", ["commit", "--allow-empty", "-m", "init"], {
            cwd: repo,
          });
          const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: repo,
            encoding: "utf8",
          }).stdout.trim();
          spawnSync(
            "git",
            ["update-ref", "refs/remotes/origin/main", headSha],
            { cwd: repo },
          );
          spawnSync(
            "git",
            ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
            { cwd: repo },
          );

          const dispatcher: RoleTaskDispatcher = async () => {
            // Don't write anything to the output file; report nonzero exit.
            return { exitCode: 1, timedOut: false, logPath: "/fake/log" };
          };

          const r = await runFeatureVerifier({
            feature: makeFeature(),
            featureState: makeFeatureState(),
            planFile: "/plan.md",
            cwd: repo,
            slug: "test-slug-fail",
            role: roleStub,
            dryRun: false,
            dispatcher,
          });
          expect(r.verdict).toBe("UNCLEAR");
          expect(r.reason).toMatch(/exit/);
        } finally {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      } finally {
        if (prev === undefined) delete process.env.GSTACK_STATE_DIR;
        else process.env.GSTACK_STATE_DIR = prev;
      }
    } finally {
      tmp.cleanup();
    }
  });
});
