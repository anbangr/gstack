import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { extractCoverageTarget } from "../sub-agents";
import { evaluateMonitorOnce } from "../monitor";
import {
  buildGeminiTestSpecPrompt,
  buildDualImplPromptBody,
  buildCodexReviewBody,
  buildJudgePrompt,
  buildReviewGatePlan,
  isLikelyCodexWorkspaceSandboxFailure,
  isLikelyCodexContextWindowFailure,
  shouldRetryPrimaryImplWithSecondary,
  shouldRetryCodexGateWithDangerFullAccess,
  parseArgs,
  validateRoleProviders,
  resolveProjectRoot,
  validateProjectRootSelection,
  captureGitSnapshot,
  recoverMutableAgentCommit,
  validatePostAgentHygiene,
  validateParentWorkspaceUnchanged,
  hygieneFailureResult,
  archiveLivingPlan,
  archiveOriginPlan,
  buildOriginVerificationBody,
  ensureFeatureBranch,
  ownedFeatureBranch,
  safeBranchPart,
  detectRemoteBaseRef,
  syncLandedBase,
  syncFeatureBranchWithBase,
  validateResumeLaunch,
  restartFeatureFromOriginIssues,
  markPhaseCommittedAfterManualRecovery,
  phaseTableStatus,
  phaseGateProjection,
  featureGateProjection,
  reconcileVisiblePlanState,
  markVisiblePlanArchived,
  _setVisiblePlanProjectionForTests,
  _getVisiblePlanProjectionForTests,
  _saveStateForTests,
  releaseDaemonLaunchCommand,
  releaseDaemonDefaultPath,
  renderLaunchdReleaseDaemonPlist,
  renderSystemdReleaseDaemonService,
  buildReleaseDaemonDoctorReport,
  renderReleaseDaemonDoctorReport,
  runRoleTask,
  buildKindInstructions,
  chooseMergePath,
  extractCoverageTarget,
  resolvePhaseBody,
  maybeAutoCommitTestOnlyDirty,
  runStopRun,
  HELP_TEXT,
} from "../cli";
import { writeActiveRunRecord, activeRunRecordPath } from "../active-runs";
import type {
  BuildState,
  FeatureState,
  Feature,
  Phase,
  PhaseState,
  DualImplTestResult,
} from "../types";
import { lockPath, statePath } from "../state";
import { _testWritePlan } from "../plan-mutator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_ROLE_CONFIGS } from "../role-config";

let tmpDir: string | null = null;
let tmpStateDir: string | null = null;
let tmpGstackHome: string | null = null;
let realStateDir: string | undefined;
let realGstackHome: string | undefined;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-cli-state-"));
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
  // Isolate GSTACK_HOME too — evaluateMonitorOnce can trigger detectSkillFaults,
  // which appends to ${GSTACK_HOME}/analytics/skill-faults.jsonl. Without this,
  // each test run would leak fault entries into the developer's real ~/.gstack/.
  realGstackHome = process.env.GSTACK_HOME;
  tmpGstackHome = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-cli-home-"));
  process.env.GSTACK_HOME = tmpGstackHome;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (realGstackHome !== undefined) process.env.GSTACK_HOME = realGstackHome;
  else delete process.env.GSTACK_HOME;
  if (tmpStateDir && fs.existsSync(tmpStateDir)) {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
  if (tmpGstackHome && fs.existsSync(tmpGstackHome)) {
    fs.rmSync(tmpGstackHome, { recursive: true, force: true });
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpStateDir = null;
  tmpGstackHome = null;
  tmpDir = null;
});

const basePhase: Phase = {
  index: 0,
  number: "1",
  name: "Auth middleware",
  featureIndex: 0,
  featureNumber: "1",
  featureName: "Auth",
  body: "Write tests for the auth middleware.",
  testSpecDone: false,
  testSpecCheckboxLine: 5,
  implementationCheckboxLine: 6,
  reviewCheckboxLine: 7,
  implementationDone: false,
  reviewDone: false,
  dualImpl: false,
  kind: "code",
};

function expectParseArgsExit(argv: string[], message: string): void {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never;
  try {
    expect(() => parseArgs(argv)).toThrow("exit:2");
    expect(errors.join("\n")).toContain(message);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

describe("resolvePhaseBody", () => {
  const base =
    "/Users/anbang/Documents/Antigravity/agnt2-workspace/agnt2-paper";
  const worktree =
    "/Users/anbang/.gstack/build-worktrees/agnt2-paper/run-id-abc123";

  it("replaces base project root with worktree path in body", () => {
    const body = `Write files to ${base}/experiments/E8/e8-replay.json and commit from ${base}.`;
    const result = resolvePhaseBody(body, base, worktree);
    expect(result).toBe(
      `Write files to ${worktree}/experiments/E8/e8-replay.json and commit from ${worktree}.`,
    );
  });

  it("returns body unchanged when baseProjectRoot equals worktreePath", () => {
    const body = `Write files to ${base}/experiments/E8/e8-replay.json`;
    const result = resolvePhaseBody(body, base, base);
    expect(result).toBe(body);
  });

  it("returns body unchanged when baseProjectRoot is undefined", () => {
    const body = `Write files to ${base}/experiments/E8/e8-replay.json`;
    const result = resolvePhaseBody(body, undefined, worktree);
    expect(result).toBe(body);
  });
});

describe("buildGeminiTestSpecPrompt", () => {
  const legacyPhase: Phase = { ...basePhase, testSpecCheckboxLine: -1 };

  it('legacy path (no test spec checkbox): contains "write failing tests"', () => {
    const prompt = buildGeminiTestSpecPrompt(legacyPhase, "plan.md");
    expect(prompt.toLowerCase()).toContain("write failing tests");
  });

  it('contains "do NOT implement" or "do not implement"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt.toLowerCase()).toMatch(/do not implement/);
  });

  it("contains the phase name", () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt).toContain(basePhase.name);
  });

  it("contains the plan file path", () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt).toContain("plan.md");
  });

  it("tells test writers not to substitute submodules for missing components", () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt).toContain("do not edit git submodules");
    expect(prompt).toContain("report a plan mismatch");
  });
});

describe("buildGeminiTestSpecPrompt — spec-aware path", () => {
  const specPhase: Phase = {
    ...basePhase,
    body: [
      "Some prose describing the phase.",
      "",
      "#### Test Spec",
      "**Coverage target: ≥80%**",
      "",
      "| ID | Scenario | Given | When | Then |",
      "|----|----------|-------|------|------|",
      "| T1 | happy path | valid input | call fn | returns result |",
      "| T2 | error case | null input | call fn | throws TypeError |",
      "| T3 | boundary | empty list | call fn | returns [] |",
      "",
      "**Edge cases to cover:**",
      "- Empty input",
    ].join("\n"),
  };

  it('uses floor language "minimum requirement" instead of "write failing tests"', () => {
    const prompt = buildGeminiTestSpecPrompt(specPhase, "plan.md");
    expect(prompt).toContain("minimum requirement");
    expect(prompt.toLowerCase()).not.toContain(
      "write failing tests that cover",
    );
  });

  it("tells test-writer they may add cases beyond the spec", () => {
    const prompt = buildGeminiTestSpecPrompt(specPhase, "plan.md");
    expect(prompt).toContain("MAY add additional cases");
  });

  it("includes the coverage target from the spec", () => {
    const prompt = buildGeminiTestSpecPrompt(specPhase, "plan.md");
    expect(prompt).toContain("≥80%");
  });

  it("passes phase body verbatim (including Test Spec section)", () => {
    const prompt = buildGeminiTestSpecPrompt(specPhase, "plan.md");
    expect(prompt).toContain("#### Test Spec");
    expect(prompt).toContain("T1");
  });

  it("still tells test-writer not to write implementation code", () => {
    const prompt = buildGeminiTestSpecPrompt(specPhase, "plan.md");
    expect(prompt.toLowerCase()).toMatch(
      /do not implement|do not write.*production/,
    );
  });

  it("still enforces red phase (tests must fail before implementation)", () => {
    const prompt = buildGeminiTestSpecPrompt(specPhase, "plan.md");
    expect(prompt.toLowerCase()).toContain("must fail");
  });
});

describe("extractCoverageTarget", () => {
  it("extracts percentage from **Coverage target: ≥80%**", () => {
    expect(extractCoverageTarget("**Coverage target: ≥80%**")).toBe(80);
  });

  it("defaults to 80 when no coverage target line is present", () => {
    expect(extractCoverageTarget("some phase body with no coverage line")).toBe(
      80,
    );
  });

  it("handles >=85% variant (ASCII greater-than-or-equal)", () => {
    expect(extractCoverageTarget("**Coverage target: >=85%**")).toBe(85);
  });

  it("handles plain > variant", () => {
    expect(extractCoverageTarget("**Coverage target: >90%**")).toBe(90);
  });

  it("is case-insensitive", () => {
    expect(extractCoverageTarget("**coverage target: ≥75%**")).toBe(75);
  });

  it("extracts from a multi-line phase body", () => {
    const body = [
      "Some prose",
      "",
      "#### Test Spec",
      "**Coverage target: ≥82%**",
      "",
      "| T1 | ...",
    ].join("\n");
    expect(extractCoverageTarget(body)).toBe(82);
  });

  it("handles decimal coverage targets like ≥90.5%", () => {
    expect(extractCoverageTarget("**Coverage target: ≥90.5%**")).toBe(90.5);
  });
});

describe("safeBranchPart", () => {
  it("returns sanitized input unchanged when under 72 chars", () => {
    const out = safeBranchPart("mitosis-oasis-2026-05-18-b0bf5c19");
    expect(out).toBe("mitosis-oasis-2026-05-18-b0bf5c19");
    expect(out.length).toBeLessThanOrEqual(72);
  });

  it("lowercases and replaces unsafe chars", () => {
    expect(safeBranchPart("Feature/Auth Setup!")).toBe("feature-auth-setup");
  });

  it("returns 'run' for empty or all-unsafe input", () => {
    expect(safeBranchPart("")).toBe("run");
    expect(safeBranchPart("!@#$%^&*")).toBe("run");
  });

  it("preserves the tail hash when input exceeds 72 chars (head+tail strategy)", () => {
    // This is the regression case: the mitosis-oasis Bundle 0 run had a
    // sanitized branchPrefix 80+ chars long, and the old .slice(0, 72)
    // truncation dropped the unique b0bf5c19 hash, breaking recovery
    // branch lookup. See plan: 2026-05-18-build-orchestrator-four-failures.md.
    const long =
      "mitosis-oasis-2026-05-18-bundle-0-bug-fix-20260518-180025-b0bf5c19-extra-padding";
    // Assert the test fixture itself exercises the truncation branch.
    // Otherwise a future edit could shrink it under 72 and silently
    // skip the path it's named for.
    expect(long.length).toBeGreaterThan(72);
    const out = safeBranchPart(long);
    expect(out.length).toBeLessThanOrEqual(72);
    // Head preserved for readability
    expect(out.startsWith("mitosis-oasis-2026-05-18-bundle")).toBe(true);
    // Tail preserved so unique suffix survives — load-bearing for identity
    expect(out.endsWith("padding")).toBe(true);
  });

  it("preserves the b0bf5c19 hash when it's the actual tail", () => {
    const long =
      "mitosis-oasis-mitosis-oasis-2026-05-18-bundle-0-bug-fix-20260518-180025-b0bf5c19";
    const out = safeBranchPart(long);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("b0bf5c19")).toBe(true);
  });

  it("collapses leading/trailing dashes after sanitization", () => {
    expect(safeBranchPart("---foo-bar---")).toBe("foo-bar");
  });

  it("collapses double-dot patterns (git-ref invalid)", () => {
    // git check-ref-format rejects `..` in branch names. Sanitization
    // must produce a valid ref, not a cryptic-error-shaped one.
    expect(safeBranchPart("foo..bar")).toBe("foo.bar");
    expect(safeBranchPart("foo....bar")).toBe("foo.bar");
    // After collapse, also strip leading/trailing dots
    expect(safeBranchPart("..escape..")).toBe("escape");
  });

  it("strips trailing '.lock' suffix (git-ref invalid)", () => {
    // git reserves <ref>.lock for its internal locking.
    expect(safeBranchPart("foo.lock")).toBe("foo");
    expect(safeBranchPart("hash-b0bf5c19.lock")).toBe("hash-b0bf5c19");
  });

  it("does not produce a trailing-dash head when truncation lands on a dash", () => {
    // Adversarial appendix finding: head ending in `-` then `-tail`
    // produces `--` (cosmetically ugly, semantically OK but a smell).
    // After hardening, the head's trailing dash is stripped before join.
    // Pad input so the first 60 chars end on a dash.
    const padTo59 = "a".repeat(59); // 59 chars
    const input = `${padTo59}-tail-hash-padding-extra`; // total 81+
    expect(input.length).toBeGreaterThan(72);
    expect(input[59]).toBe("-");
    const out = safeBranchPart(input);
    // No `--` (double dash) in the output:
    expect(out.includes("--")).toBe(false);
  });
});

describe("--dual-impl flag wiring", () => {
  it("--help text mentions --dual-impl", () => {
    expect(HELP_TEXT).toContain("--dual-impl");
  });

  it("parseArgs([plan, --dual-impl]) sets dualImpl=true when judge is Claude-compatible", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
    ]);
    expect(args.dualImpl).toBe(true);
  });

  it("parseArgs default -> dualImpl=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.dualImpl).toBe(false);
  });
});

describe("--skip-ship flag wiring", () => {
  it("parseArgs default -> skipShip=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.skipShip).toBe(false);
  });

  it("parseArgs([plan, --skip-ship]) sets skipShip=true", () => {
    const args = parseArgs(["plan.md", "--skip-ship"]);
    expect(args.skipShip).toBe(true);
  });

  it("parseArgs default release mode is queued and preserves --skip-ship", () => {
    const args = parseArgs(["plan.md", "--skip-ship"]);
    expect(args.releaseMode).toBe("queued");
    expect(args.skipShip).toBe(true);
  });

  it("parseArgs supports legacy auto-land release mode", () => {
    const args = parseArgs(["plan.md", "--release-mode", "auto-land"]);
    expect(args.releaseMode).toBe("auto-land");
  });

  it("rejects invalid release modes", () => {
    expectParseArgsExit(
      ["plan.md", "--release-mode", "surprise"],
      "--release-mode expects queued or auto-land",
    );
  });
});

describe("--single-branch flag wiring", () => {
  it("parseArgs default -> singleBranch=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.singleBranch).toBe(false);
  });

  it("parseArgs([plan, --single-branch]) sets singleBranch=true", () => {
    const args = parseArgs(["plan.md", "--single-branch"]);
    expect(args.singleBranch).toBe(true);
  });

  it("--single-branch is independent of --skip-ship", () => {
    const args = parseArgs([
      "plan.md",
      "--single-branch",
      "--release-mode",
      "auto-land",
    ]);
    expect(args.singleBranch).toBe(true);
    expect(args.skipShip).toBe(false);
    expect(args.releaseMode).toBe("auto-land");
  });

  it("--single-branch with --dry-run leaves dryRun=true and singleBranch=true", () => {
    const args = parseArgs(["plan.md", "--single-branch", "--dry-run"]);
    expect(args.singleBranch).toBe(true);
    expect(args.dryRun).toBe(true);
  });
});

describe("--ship-on-plan-complete flag wiring", () => {
  it("parseArgs default -> shipOnPlanComplete=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.shipOnPlanComplete).toBe(false);
  });

  it("parseArgs([plan, --ship-on-plan-complete]) sets shipOnPlanComplete=true", () => {
    const args = parseArgs(["plan.md", "--ship-on-plan-complete"]);
    expect(args.shipOnPlanComplete).toBe(true);
  });

  it("--ship-on-plan-complete + --single-branch is rejected as mutually exclusive", () => {
    // Previously the parser accepted both; runtime semantics were
    // undefined (deferred-ship continue fired alongside the
    // single-branch end-of-loop ship). Now parseArgs hard-fails so
    // callers can't synthesize an undefined combination by accident.
    expectParseArgsExit(
      ["plan.md", "--single-branch", "--ship-on-plan-complete"],
      "mutually exclusive",
    );
    // Order doesn't matter.
    expectParseArgsExit(
      ["plan.md", "--ship-on-plan-complete", "--single-branch"],
      "mutually exclusive",
    );
  });

  it("--ship-on-plan-complete is documented in --help", () => {
    expect(HELP_TEXT).toContain("--ship-on-plan-complete");
  });
});

describe("--commit-dirty / --force-dirty flag wiring", () => {
  it("parseArgs defaults -> forceDirty=false, commitDirty=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.forceDirty).toBe(false);
    expect(args.commitDirty).toBe(false);
  });

  it("parseArgs([plan, --force-dirty]) sets forceDirty=true", () => {
    const args = parseArgs(["plan.md", "--force-dirty"]);
    expect(args.forceDirty).toBe(true);
    expect(args.commitDirty).toBe(false);
  });

  it("parseArgs([plan, --commit-dirty]) sets commitDirty=true", () => {
    const args = parseArgs(["plan.md", "--commit-dirty"]);
    expect(args.commitDirty).toBe(true);
    expect(args.forceDirty).toBe(false);
  });

  it("both --force-dirty and --commit-dirty parse but caller enforces mutex", () => {
    // parseArgs allows both — the mutex check lives in
    // markPhaseCommittedAfterManualRecovery (see dirty-tree guard tests).
    const args = parseArgs(["plan.md", "--force-dirty", "--commit-dirty"]);
    expect(args.forceDirty).toBe(true);
    expect(args.commitDirty).toBe(true);
  });

  it("--force-dirty and --commit-dirty are documented in --help", () => {
    expect(HELP_TEXT).toContain("--force-dirty");
    expect(HELP_TEXT).toContain("--commit-dirty");
  });
});

describe("release-daemon CLI", () => {
  it("parses release-daemon run defaults", () => {
    const args = parseArgs(["release-daemon", "run"]);
    expect(args.mode).toBe("release-daemon");
    expect(args.releaseDaemonCommand).toBe("run");
    expect(args.releaseDaemonOnce).toBe(true);
    expect(args.releaseDaemonPollMs).toBe(30_000);
  });

  it("parses release-daemon watch and retry", () => {
    const watch = parseArgs([
      "release-daemon",
      "run",
      "--watch",
      "--poll-ms",
      "5",
    ]);
    expect(watch.releaseDaemonWatch).toBe(true);
    expect(watch.releaseDaemonPollMs).toBe(5);

    const retry = parseArgs(["release-daemon", "retry", "42"]);
    expect(retry.releaseDaemonCommand).toBe("retry");
    expect(retry.releaseDaemonRetryPr).toBe(42);
  });

  it("renders repo-aware daemon install commands for launchd and systemd", () => {
    const command = releaseDaemonLaunchCommand("/Users/alice/project repo");
    expect(command).toContain("--project-root");
    expect(command).toContain("/Users/alice/project repo");

    const plist = renderLaunchdReleaseDaemonPlist(
      command,
      "/Users/alice/project repo",
    );
    expect(plist).toContain(
      "<key>WorkingDirectory</key><string>/Users/alice/project repo</string>",
    );
    expect(plist).toContain("<string>--project-root</string>");

    // The plist must bake in a PATH that finds homebrew + HOME so the daemon
    // can spawn gh/git/bun from the user's tool installs.
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain("/usr/local/bin");
    expect(plist).toContain("<key>HOME</key>");
    // Belt-and-braces: it must NOT be just the launchd default PATH.
    expect(plist).not.toMatch(
      /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/,
    );

    const service = renderSystemdReleaseDaemonService(
      command,
      "/Users/alice/project repo",
    );
    expect(service).toContain("WorkingDirectory=/Users/alice/project\\ repo");
    expect(service).toContain("--project-root /Users/alice/project\\ repo");
    // Systemd unit must declare PATH in [Service] for the same reason.
    expect(service).toContain('Environment="PATH=');
    expect(service).toContain("/opt/homebrew/bin");
  });

  it("parses release-daemon doctor", () => {
    const args = parseArgs(["release-daemon", "doctor"]);
    expect(args.mode).toBe("release-daemon");
    expect(args.releaseDaemonCommand).toBe("doctor");
  });
});

describe("releaseDaemonDefaultPath", () => {
  it("puts homebrew before system defaults", () => {
    const parts = releaseDaemonDefaultPath({ PATH: "" }).split(":");
    expect(parts.indexOf("/opt/homebrew/bin")).toBeLessThan(
      parts.indexOf("/usr/bin"),
    );
    expect(parts.indexOf("/usr/local/bin")).toBeLessThan(
      parts.indexOf("/usr/bin"),
    );
  });

  it("merges inherited PATH after known prefixes", () => {
    const result = releaseDaemonDefaultPath({
      PATH: "/Users/me/.bun/bin:/usr/bin",
    });
    const parts = result.split(":");
    expect(parts).toContain("/Users/me/.bun/bin");
    expect(parts.indexOf("/opt/homebrew/bin")).toBeLessThan(
      parts.indexOf("/Users/me/.bun/bin"),
    );
  });

  it("deduplicates entries appearing in both known prefixes and inherited PATH", () => {
    const result = releaseDaemonDefaultPath({
      PATH: "/opt/homebrew/bin:/usr/bin",
    });
    const parts = result.split(":");
    expect(parts.filter((p) => p === "/opt/homebrew/bin").length).toBe(1);
    expect(parts.filter((p) => p === "/usr/bin").length).toBe(1);
  });

  it("handles undefined PATH gracefully", () => {
    const result = releaseDaemonDefaultPath({ PATH: undefined });
    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/bin");
  });
});

describe("releaseDaemonDoctor", () => {
  it("reports DAEMON_NOT_INSTALLED when plist is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
    try {
      const report = buildReleaseDaemonDoctorReport({
        platform: "darwin",
        queueDir: path.join(tmp, "queue"),
        home: tmp,
        uid: 501,
        spawn: () =>
          ({
            status: 1,
            stdout: "",
            stderr: "",
            signal: null,
            pid: 0,
            output: [],
          }) as any,
        fileExists: () => false,
        readFile: () => {
          throw new Error("not called");
        },
        readQueueRecords: () => [],
      });
      expect(report.verdict).toBe("DAEMON_NOT_INSTALLED");
      expect(report.plistExists).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports HEALTHY when plist loaded, has env vars, tools resolve, queue clean", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
    try {
      const plistPath = path.join(
        tmp,
        "Library",
        "LaunchAgents",
        "com.gstack.release-daemon.plist",
      );
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, "<EnvironmentVariables>contents</...>");

      const report = buildReleaseDaemonDoctorReport({
        platform: "darwin",
        queueDir: path.join(tmp, "queue"),
        home: tmp,
        uid: 501,
        spawn: ((cmd: string, _args: string[]) => {
          if (cmd === "launchctl") {
            return {
              status: 0,
              stdout: "0\t0\tcom.gstack.release-daemon\n",
              stderr: "",
            };
          }
          if (cmd === "/usr/bin/which") {
            return {
              status: 0,
              stdout: "/opt/homebrew/bin/tool\n",
              stderr: "",
            };
          }
          return { status: 1, stdout: "", stderr: "" };
        }) as any,
        readQueueRecords: () => [],
      });
      expect(report.verdict).toBe("HEALTHY");
      expect(report.plistExists).toBe(true);
      expect(report.plistHasEnvironmentVariables).toBe(true);
      expect(report.loaded).toBe(true);
      expect(report.tools.every((t) => t.resolved !== null)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports STALE_PLIST_NEEDS_RELOAD when plist lacks EnvironmentVariables", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
    try {
      const plistPath = path.join(
        tmp,
        "Library",
        "LaunchAgents",
        "com.gstack.release-daemon.plist",
      );
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      // No EnvironmentVariables in content — simulates a plist generated by
      // a gstack version before v1.39.1.0.
      fs.writeFileSync(
        plistPath,
        "<plist><dict><key>Label</key></dict></plist>",
      );

      const report = buildReleaseDaemonDoctorReport({
        platform: "darwin",
        queueDir: path.join(tmp, "queue"),
        home: tmp,
        uid: 501,
        spawn: ((cmd: string) => {
          if (cmd === "launchctl") {
            return {
              status: 0,
              stdout: "0\t0\tcom.gstack.release-daemon\n",
              stderr: "",
            };
          }
          return { status: 0, stdout: "/opt/homebrew/bin/tool\n", stderr: "" };
        }) as any,
        readQueueRecords: () => [],
      });
      expect(report.verdict).toBe("STALE_PLIST_NEEDS_RELOAD");
      expect(report.plistHasEnvironmentVariables).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders a human-readable report", () => {
    const rendered = renderReleaseDaemonDoctorReport({
      platform: "darwin",
      queueDir: "/tmp/queue",
      queueDepth: 3,
      queueByStatus: { queued: 2, blocked: 1 },
      plistPath:
        "/Users/me/Library/LaunchAgents/com.gstack.release-daemon.plist",
      plistExists: true,
      plistHasEnvironmentVariables: true,
      loaded: true,
      loadedPath: "/opt/homebrew/bin:/usr/bin",
      tools: [
        { name: "gh", resolved: "/opt/homebrew/bin/gh" },
        { name: "git", resolved: "/opt/homebrew/bin/git" },
        { name: "bun", resolved: null },
      ],
      recentLogLines: ["error: something failed"],
      verdict: "TOOL_MISSING",
    });
    expect(rendered).toContain("Release daemon doctor");
    expect(rendered).toContain("/opt/homebrew/bin/gh ✓");
    expect(rendered).toContain("MISSING");
    expect(rendered).toContain("Verdict: TOOL_MISSING");
    expect(rendered).toContain("3 record(s)");
  });
});

describe("manual recovery flags", () => {
  it("help text documents manual phase and submodule recovery flags", () => {
    expect(HELP_TEXT).toContain("--allow-submodule-recovery");
    expect(HELP_TEXT).toContain("--mark-phase-committed");
  });

  it("parses --allow-submodule-recovery and --mark-phase-committed", () => {
    const args = parseArgs([
      "plan.md",
      "--allow-submodule-recovery",
      "op-node",
      "--mark-phase-committed",
      "2.3",
    ]);
    expect(args.allowSubmoduleRecovery).toEqual(["op-node"]);
    expect(args.markPhaseCommitted).toBe("2.3");
  });
});

function initGitRepo(prefix: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  spawnSync("git", ["init", "--initial-branch=main"], {
    cwd: tmpDir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpDir,
  });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "app.ts"), "export const ok = true;\n");
  spawnSync("git", ["add", "."], { cwd: tmpDir });
  spawnSync("git", ["commit", "-m", "initial"], {
    cwd: tmpDir,
    stdio: "ignore",
  });
  return tmpDir;
}

function writeBuildPlan(repo: string, name = "plan.md"): string {
  const plan = path.join(repo, name);
  fs.writeFileSync(
    plan,
    `# Plan

## Features

### Feature 1: Lock cleanup

## Phases

### Phase 1: Lock cleanup
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests.
- [ ] **Implementation (Codex Sub-agent)**: Implement the fix.
- [ ] **Review (Codex Review Sub-agent)**: Review the implementation.
`,
  );
  return plan;
}

describe("lock cleanup", () => {
  it("releases the run lock if provisional active-run registration fails before state exists", () => {
    const repo = initGitRepo("gstack-lock-cleanup-");
    const plan = writeBuildPlan(repo);
    const registryParentFile = path.join(tmpDir, "registry-parent");
    fs.writeFileSync(registryParentFile, "not a directory\n");
    const impossibleRegistry = path.join(registryParentFile, "active-runs");

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        plan,
        "--project-root",
        repo,
        "--dry-run",
        "--run-id",
        "lock-cleanup",
        "--branch-prefix",
        "lock-cleanup",
        "--active-run-registry",
        impossibleRegistry,
        "--no-gbrain",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          GSTACK_BUILD_STATE_DIR: tmpStateDir!,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(lockPath("build-lock-cleanup"))).toBe(false);
  });

  it("normal build lock failure explains the lock was not safely verified", () => {
    const repo = initGitRepo("gstack-lock-message-");
    const plan = writeBuildPlan(repo);
    fs.writeFileSync(
      lockPath("build-live-message"),
      `${process.pid}\n2026-05-08T00:00:00.000Z\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        plan,
        "--project-root",
        repo,
        "--dry-run",
        "--run-id",
        "live-message",
        "--branch-prefix",
        "live-message",
        "--no-gbrain",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          GSTACK_BUILD_STATE_DIR: tmpStateDir!,
        },
      },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("cannot be safely verified");
    expect(result.stderr).toContain(lockPath("build-live-message"));
    expect(result.stderr).not.toContain("if stale, remove");
  });

  it("merge lock failure explains the lock was not safely verified", () => {
    const repo = initGitRepo("gstack-merge-lock-message-");
    const slug = `build-merge-${path
      .basename(repo)
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase()}`;
    fs.writeFileSync(
      lockPath(slug),
      `${process.pid}\n2026-05-08T00:00:00.000Z\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "merge",
        "--project-root",
        repo,
        "--skip-clean-check",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          GSTACK_BUILD_STATE_DIR: tmpStateDir!,
        },
      },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("cannot be safely verified");
    expect(result.stderr).toContain(lockPath(slug));
    expect(result.stderr).not.toContain("if stale, remove");
  });
});

describe("merge subcommand wiring", () => {
  it("parseArgs([merge]) selects merge mode without a plan file", () => {
    const args = parseArgs(["merge"]);
    expect(args.mode).toBe("merge");
    expect(args.planFile).toBe("");
  });

  it("--help text documents merge mode", () => {
    expect(HELP_TEXT).toContain("gstack-build merge [flags]");
    expect(HELP_TEXT).toContain(
      "Review/fix/ship/land unmerged feat/* branches",
    );
  });
});

describe("monitor subcommand wiring", () => {
  it("parseArgs([monitor, --manifest, file, --once]) selects monitor mode", () => {
    const manifest = path.join(os.tmpdir(), "manifest.json");
    const args = parseArgs(["monitor", "--manifest", manifest, "--once"]);
    expect(args.mode).toBe("monitor");
    expect(args.monitorManifest).toBe(path.resolve(manifest));
    expect(args.monitorOnce).toBe(true);
  });

  it("parseArgs supports monitor --supervise and monitor-agent role overrides", () => {
    const manifest = path.join(os.tmpdir(), "manifest.json");
    const args = parseArgs([
      "monitor",
      "--manifest",
      manifest,
      "--watch",
      "--supervise",
      "--monitor-agent-provider",
      "codex",
      "--monitor-agent-model",
      "monitor-model-under-test",
      "--monitor-agent-reasoning",
      "medium",
    ]);
    expect(args.mode).toBe("monitor");
    expect(args.monitorWatch).toBe(true);
    expect(args.monitorSupervise).toBe(true);
    expect(args.roles.monitorAgent.provider).toBe("codex");
    expect(args.roles.monitorAgent.model).toBe("monitor-model-under-test");
    expect(args.roles.monitorAgent.reasoning).toBe("medium");
  });

  it("--help text documents monitor mode and exit codes", () => {
    expect(HELP_TEXT).toContain("gstack-build monitor --manifest <path>");
    expect(HELP_TEXT).toContain("--supervise");
    expect(HELP_TEXT).toContain("--monitor-agent-model");
    expect(HELP_TEXT).toContain("HOST_CONTEXT_SAVE_REQUIRED");
    expect(HELP_TEXT).toContain("MONITOR_AGENT_ESCALATION");
    expect(HELP_TEXT).toContain("MONITOR_REENTER");
  });

  it("--watch and --once are mutually exclusive", () => {
    expectParseArgsExit(
      ["monitor", "--manifest", "manifest.json", "--once", "--watch"],
      "only one of --once or --watch",
    );
  });

  it("rejects monitor-only flags outside monitor mode", () => {
    expectParseArgsExit(["plan.md", "--once"], "monitor flags require");
    expectParseArgsExit(["plan.md", "--supervise"], "monitor flags require");
    expectParseArgsExit(
      ["merge", "--manifest", "manifest.json"],
      "monitor flags require",
    );
    expectParseArgsExit(
      ["plan-status", "--gstack-repo", ".", "--supervise"],
      "monitor flags require",
    );
  });

  it("monitor --once emits final JSON and exits with mapped code", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-cli-"));
    const runId = "cli-run";
    const stateSlug = `build-${runId}`;
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktree");
    const livingPlanPath = path.join(tmpDir, "living.md");
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.mkdirSync(worktreePath, { recursive: true });
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    fs.mkdirSync(path.join(tmpStateDir!, stateSlug), { recursive: true });
    fs.writeFileSync(
      path.join(tmpStateDir!, stateSlug, ".host-context-save-count"),
      "1\n",
    );
    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify({
        planFile: livingPlanPath,
        planBasename: "living",
        slug: stateSlug,
        branch: "feat/cli",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        launch: {
          argv: ["/bin/sh", "-c", "echo resume"],
          projectRoot: worktreePath,
          baseProjectRoot: repoPath,
          runId,
          branchPrefix: "repo-cli-run",
          activeRunRegistry,
          stateSlug,
          dryRun: false,
          skipShip: false,
          skipFeatureReview: false,
          launchedAt: "2026-05-08T00:00:00.000Z",
        },
        currentPhaseIndex: 0,
        currentFeatureIndex: -1,
        features: [],
        phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
        completed: true,
      }),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir,
        runs: [
          {
            runId,
            repoPath,
            repoSlug: "repo",
            livingPlanPath,
            worktreePath,
            stateSlug,
            branchPrefix: "repo-cli-run",
            pidFile: path.join(tmpDir, "pid"),
            stdoutLog: path.join(tmpDir, "stdout.log"),
            launchCommand: [
              "/bin/echo",
              "resume",
              "--active-run-registry",
              activeRunRegistry,
            ],
            launchEnv: {},
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "monitor",
        "--manifest",
        manifestPath,
        "--once",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, GSTACK_BUILD_STATE_DIR: tmpStateDir! },
      },
    );

    expect(result.status).toBe(0);
    const lastLine = result.stdout.trim().split("\n").at(-1)!;
    expect(JSON.parse(lastLine).event).toBe("ALL_RUNS_COMPLETE");
  });

  it("monitor --watch exits MONITOR_REENTER at max wall time", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-watch-"));
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir,
        runs: [
          {
            runId: "watch-run",
            repoPath: path.join(tmpDir, "repo"),
            repoSlug: "repo",
            livingPlanPath: path.join(tmpDir, "living.md"),
            worktreePath: path.join(tmpDir, "worktree"),
            stateSlug: "build-watch-run",
            branchPrefix: "repo-watch-run",
            pidFile: path.join(tmpDir, "pid"),
            stdoutLog: path.join(tmpDir, "stdout.log"),
            launchCommand: ["/bin/sh", "-c", "echo resume"],
            launchEnv: {},
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "monitor",
        "--manifest",
        manifestPath,
        "--watch",
        "--poll-ms",
        "1",
        "--max-wall-ms",
        "1",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, GSTACK_BUILD_STATE_DIR: tmpStateDir! },
      },
    );

    expect(result.status).toBe(12);
    expect(result.stdout).toContain("MONITOR_REENTER");
  });

  it("monitor --watch stays in the foreground after auto-resuming a stale run", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-resume-"));
    const runId = "resume-run";
    const stateSlug = `build-${runId}`;
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktree");
    const livingPlanPath = path.join(tmpDir, "living.md");
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify({
        planFile: livingPlanPath,
        planBasename: "living",
        slug: stateSlug,
        branch: "feat/resume",
        startedAt: "2000-01-01T00:00:00.000Z",
        lastUpdatedAt: "2000-01-01T00:00:00.000Z",
        launch: {
          argv: ["/bin/sh", "-c", "echo resume"],
          projectRoot: worktreePath,
          baseProjectRoot: repoPath,
          runId,
          branchPrefix: "repo-resume-run",
          activeRunRegistry: path.join(tmpDir, "active-runs"),
          stateSlug,
          dryRun: false,
          skipShip: false,
          skipFeatureReview: false,
          launchedAt: "2000-01-01T00:00:00.000Z",
        },
        currentPhaseIndex: 0,
        currentFeatureIndex: -1,
        features: [],
        phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
        completed: false,
      }),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir,
        runs: [
          {
            runId,
            repoPath,
            repoSlug: "repo",
            livingPlanPath,
            worktreePath,
            stateSlug,
            branchPrefix: "repo-resume-run",
            pidFile: path.join(tmpDir, "pid"),
            stdoutLog: path.join(tmpDir, "stdout.log"),
            launchCommand: ["/bin/sh", "-c", "echo resume"],
            launchEnv: {},
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "monitor",
        "--manifest",
        manifestPath,
        "--watch",
        "--poll-ms",
        "1",
        "--max-wall-ms",
        "5",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, GSTACK_BUILD_STATE_DIR: tmpStateDir! },
      },
    );

    expect(result.status).toBe(12);
    expect(result.stdout).toContain("RUN_RESUMED");
    expect(result.stdout).toContain("MONITOR_REENTER");
  });
});

describe("plan-status subcommand wiring", () => {
  it("parseArgs([plan-status]) selects read-only plan status mode", () => {
    const repo = path.join(os.tmpdir(), "app-gstack");
    const project = path.join(os.tmpdir(), "app");
    const args = parseArgs([
      "plan-status",
      "--gstack-repo",
      repo,
      "--project-root",
      project,
      "--json",
      "--all",
      "--plan",
      path.join(os.tmpdir(), "source-plan-1.md"),
      "--all-inbox",
      "--resume",
      "run-1",
    ]);
    expect(args.mode).toBe("plan-status");
    expect(args.planStatusGstackRepo).toBe(path.resolve(repo));
    expect(args.projectRoot).toBe(path.resolve(project));
    expect(args.planStatusJson).toBe(true);
    expect(args.planStatusAll).toBe(true);
    expect(args.planStatusPlans).toEqual([
      path.resolve(path.join(os.tmpdir(), "source-plan-1.md")),
    ]);
    expect(args.planStatusAllInbox).toBe(true);
    expect(args.planStatusResumeOnly).toBe(true);
    expect(args.planStatusResumeRunId).toBe("run-1");
  });

  it("--help text documents plan-status mode", () => {
    expect(HELP_TEXT).toContain(
      "gstack-build plan-status --gstack-repo <path>",
    );
    expect(HELP_TEXT).toContain(
      "Read-only /build plan selection and resume status",
    );
    expect(HELP_TEXT).toContain("--json");
    expect(HELP_TEXT).toContain("--all-inbox");
  });

  it("rejects plan-status-only flags outside plan-status mode", () => {
    expectParseArgsExit(["plan.md", "--json"], "plan-status flags require");
    expectParseArgsExit(
      ["merge", "--gstack-repo", "/tmp/app-gstack"],
      "plan-status flags require",
    );
    expectParseArgsExit(
      ["plan.md", "--resume", "run-1"],
      "plan-status flags require",
    );
  });
});

describe("reconcile subcommand wiring", () => {
  it("parseArgs([reconcile]) selects reconcile mode with both file paths and the artifact flag", () => {
    const plan = path.join(os.tmpdir(), "living-plan.md");
    const state = path.join(os.tmpdir(), "state.json");
    const args = parseArgs([
      "reconcile",
      "--plan",
      plan,
      "--state",
      state,
      "--from-artifacts",
    ]);
    expect(args.mode).toBe("reconcile");
    expect(args.reconcilePlanFile).toBe(path.resolve(plan));
    expect(args.reconcileStateFile).toBe(path.resolve(state));
    expect(args.reconcileFromArtifacts).toBe(true);
  });

  it("parseArgs([reconcile]) without --from-artifacts leaves the flag false (legacy checkbox-only mode)", () => {
    const plan = path.join(os.tmpdir(), "plan.md");
    const state = path.join(os.tmpdir(), "state.json");
    const args = parseArgs(["reconcile", "--plan", plan, "--state", state]);
    expect(args.mode).toBe("reconcile");
    expect(args.reconcileFromArtifacts).toBe(false);
  });

  it("reconcile rejects invocation without --plan or --state", () => {
    expectParseArgsExit(
      ["reconcile", "--from-artifacts"],
      "reconcile requires",
    );
    expectParseArgsExit(
      ["reconcile", "--plan", "/tmp/p.md"],
      "reconcile requires",
    );
  });

  it("--help text documents reconcile + doctor", () => {
    expect(HELP_TEXT).toContain(
      "gstack-build reconcile [--from-artifacts] --plan <plan.md> --state <state.json>",
    );
    expect(HELP_TEXT).toContain(
      "gstack-build doctor --plan <plan.md> --state <state.json>",
    );
    expect(HELP_TEXT).toContain("Flip living-plan checkboxes for committed");
    expect(HELP_TEXT).toContain("Read-only audit");
  });
});

describe("review gate planning", () => {
  it("skips reviewSecondary when its command is unset", () => {
    const roles = {
      ...DEFAULT_ROLE_CONFIGS,
      reviewSecondary: {
        ...DEFAULT_ROLE_CONFIGS.reviewSecondary,
        command: undefined,
      },
    };

    const plan = buildReviewGatePlan(roles);

    expect(plan.gates.map((g) => g.name)).toEqual(["review", "qa"]);
    expect(plan.skipped).toEqual([
      {
        name: "reviewSecondary",
        reason:
          "reviewSecondary command unset; skipped optional secondary review",
      },
    ]);
  });

  it("fails required review and QA gates when their commands are unset", () => {
    const roles = {
      ...DEFAULT_ROLE_CONFIGS,
      review: { ...DEFAULT_ROLE_CONFIGS.review, command: undefined },
      reviewSecondary: {
        ...DEFAULT_ROLE_CONFIGS.reviewSecondary,
        command: "/custom second opinion",
      },
      qa: { ...DEFAULT_ROLE_CONFIGS.qa, command: undefined },
    };

    const plan = buildReviewGatePlan(roles);

    expect(plan.gates.map((g) => g.name)).toEqual(["reviewSecondary"]);
    expect(plan.missingRequired).toEqual(["review", "qa"]);
  });
});

describe("Codex review gate sandbox retry classification", () => {
  it("detects local browser/process permission failures from workspace-write", () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout:
          "Chromium failed: mach_port_rendezvous_mac.cc Permission denied (1100). GATE FAIL",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("detects localhost bind permission failures", () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout: "",
        stderr: "grpc server cannot bind localhost:50051: EACCES",
      }),
    ).toBe(true);
  });

  it("does not classify Codex service network disconnects as sandbox failures", () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout: "GATE FAIL",
        stderr:
          "ERROR: stream disconnected before completion: tls handshake eof while sending request to backend-api/codex/responses",
      }),
    ).toBe(false);
  });

  it("only retries Codex gates when sandbox env is not explicit", () => {
    const result = {
      stdout: "Playwright browser launch failed: Operation not permitted",
      stderr: "",
    };

    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: "codex" },
        result,
      }),
    ).toBe(true);
    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: "codex" },
        result,
        reviewSandboxEnv: "workspace-write",
      }),
    ).toBe(false);
    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: "claude" },
        result,
      }),
    ).toBe(false);
  });
});

describe("Codex primary implementor context overflow fallback", () => {
  const primaryRole = {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    reasoning: "high",
  } as const;
  const secondaryRole = {
    provider: "gemini",
    model: "gemini-2.5-pro",
    reasoning: "high",
  } as const;

  it("detects Codex context-window overflow errors", () => {
    expect(
      isLikelyCodexContextWindowFailure({
        stdout: "",
        stderr:
          "ERROR: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      }),
    ).toBe(true);
  });

  it("retries a clean failed primary implementation with the configured secondary implementor", () => {
    expect(
      shouldRetryPrimaryImplWithSecondary({
        primaryRole,
        secondaryRole,
        result: {
          stdout: "",
          stderr: "ERROR: Codex ran out of room in the model's context window.",
          exitCode: 1,
          timedOut: false,
        },
        hasDirtyChanges: false,
      }),
    ).toBe(true);
  });

  it("does not retry when the failed primary already changed files", () => {
    expect(
      shouldRetryPrimaryImplWithSecondary({
        primaryRole,
        secondaryRole,
        result: {
          stdout: "",
          stderr: "ERROR: Codex ran out of room in the model's context window.",
          exitCode: 1,
          timedOut: false,
        },
        hasDirtyChanges: true,
      }),
    ).toBe(false);
  });
});

describe("--parallel-phases flag wiring", () => {
  it("--help text mentions --parallel-phases", () => {
    expect(HELP_TEXT).toContain("--parallel-phases");
  });

  it("parseArgs default -> parallelPhases=1", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.parallelPhases).toBe(1);
  });

  it("parseArgs([plan, --parallel-phases, 3]) sets parallelPhases=3", () => {
    const args = parseArgs(["plan.md", "--parallel-phases", "3"]);
    expect(args.parallelPhases).toBe(3);
  });

  it("parseArgs rejects --parallel-phases below 1", () => {
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      expect(() => parseArgs(["plan.md", "--parallel-phases", "0"])).toThrow(
        "exit:2",
      );
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  it("parseArgs rejects combining --parallel-phases with --dual-impl", () => {
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      expect(() =>
        parseArgs(["plan.md", "--dual-impl", "--parallel-phases", "2"]),
      ).toThrow("exit:2");
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });
});

describe("--skip-clean-check flag", () => {
  it("parseArgs default -> skipCleanCheck=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.skipCleanCheck).toBe(false);
  });

  it("parseArgs([plan, --skip-clean-check]) -> skipCleanCheck=true", () => {
    const args = parseArgs(["plan.md", "--skip-clean-check"]);
    expect(args.skipCleanCheck).toBe(true);
  });

  it("HELP_TEXT contains --skip-clean-check", () => {
    expect(HELP_TEXT).toContain("--skip-clean-check");
  });

  it("parseArgs rejects removed context-save CLI flags", () => {
    expect(parseArgs(["plan.md"])).not.toHaveProperty("skipContextSave");
    expect(HELP_TEXT).not.toContain("--skip-context-save");
    expect(HELP_TEXT).not.toContain("--context-save-model");
    expectParseArgsExit(
      ["plan.md", "--skip-context-save"],
      "unknown flag: --skip-context-save",
    );
    expectParseArgsExit(
      ["plan.md", "--context-save-model", "model-under-test"],
      "unknown flag: --context-save-model",
    );
  });
});

describe("--gemini-model / --codex-model flag wiring", () => {
  it("--help text mentions --gemini-model", () => {
    expect(HELP_TEXT).toContain("--gemini-model");
  });

  it("--help text mentions --codex-model", () => {
    expect(HELP_TEXT).toContain("--codex-model");
  });

  it("parseArgs with --gemini-model sets geminiModel", () => {
    const args = parseArgs([
      "plan.md",
      "--gemini-model",
      "primary-model-under-test",
    ]);
    expect(args.geminiModel).toBe("primary-model-under-test");
  });
  it("parseArgs accepts manifest run identity flags", () => {
    const registry = path.join(os.tmpdir(), "active-runs");
    const args = parseArgs([
      "plan.md",
      "--run-id",
      "run-1",
      "--base-project-root",
      ".",
      "--branch-prefix",
      "repo-run-1",
      "--active-run-registry",
      registry,
    ]);
    expect(args.runId).toBe("run-1");
    expect(args.baseProjectRoot).toBe(path.resolve("."));
    expect(args.branchPrefix).toBe("repo-run-1");
    expect(args.activeRunRegistry).toBe(path.resolve(registry));
  });

  it("parseArgs with --codex-model sets codexModel", () => {
    const args = parseArgs([
      "plan.md",
      "--codex-model",
      "secondary-model-under-test",
    ]);
    expect(args.codexModel).toBe("secondary-model-under-test");
  });

  it("parseArgs default -> model defaults come from configure.cm (no flags needed)", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(
      DEFAULT_ROLE_CONFIGS.reviewSecondary.model,
    );
    expect(args.roles.testWriter).toEqual(DEFAULT_ROLE_CONFIGS.testWriter);
    expect(args.roles.testFixer).toEqual(DEFAULT_ROLE_CONFIGS.testFixer);
    expect(args.roles.ship).toEqual(DEFAULT_ROLE_CONFIGS.ship);
  });

  it("--codex-review-model overrides the review model default", () => {
    const args = parseArgs([
      "plan.md",
      "--codex-review-model",
      "review-model-under-test",
    ]);
    expect(args.codexReviewModel).toBe("review-model-under-test");
  });

  it("--help text mentions --codex-review-model", () => {
    expect(HELP_TEXT).toContain("--codex-review-model");
  });

  it("parseArgs accepts all three model flags together", () => {
    const args = parseArgs([
      "plan.md",
      "--gemini-model",
      "primary-model-under-test",
      "--codex-model",
      "secondary-model-under-test",
      "--codex-review-model",
      "review-model-under-test",
    ]);
    expect(args.geminiModel).toBe("primary-model-under-test");
    expect(args.codexModel).toBe("secondary-model-under-test");
    expect(args.codexReviewModel).toBe("review-model-under-test");
  });

  it("parseArgs model flags combine correctly with --dual-impl", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
    ]);
    expect(args.dualImpl).toBe(true);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(
      DEFAULT_ROLE_CONFIGS.reviewSecondary.model,
    );
  });

  it("new role flags override defaults", () => {
    const args = parseArgs([
      "plan.md",
      "--review-secondary-model",
      "review-secondary-model-under-test",
      "--review-secondary-command",
      "/custom second opinion",
      "--ship-model",
      "ship-model-under-test",
      "--ship-reasoning",
      "medium",
    ]);
    expect(args.roles.reviewSecondary.model).toBe(
      "review-secondary-model-under-test",
    );
    expect(args.roles.reviewSecondary.command).toBe("/custom second opinion");
    expect(args.roles.ship.model).toBe("ship-model-under-test");
    expect(args.roles.ship.reasoning).toBe("medium");
  });

  it("backup role flags wire through parseArgs", () => {
    const args = parseArgs([
      "plan.md",
      "--ship-backup-provider",
      "gemini",
      "--ship-backup-model",
      "ship-backup-model-under-test",
    ]);
    expect(args.roles.ship.backupProvider).toBe("gemini");
    expect(args.roles.ship.backupModel).toBe("ship-backup-model-under-test");
  });

  it("--project-root resolves to an absolute path", () => {
    const args = parseArgs(["plan.md", "--project-root", "."]);
    expect(path.isAbsolute(args.projectRoot!)).toBe(true);
  });

  it("--allow-workspace-root defaults false and can be enabled explicitly", () => {
    expect(parseArgs(["plan.md"]).allowWorkspaceRoot).toBe(false);
    expect(
      parseArgs(["plan.md", "--allow-workspace-root"]).allowWorkspaceRoot,
    ).toBe(true);
  });

  it("provider validation rejects unsupported slash-command providers but allows model-agnostic dual-impl", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
    ]);
    args.roles.qa.provider = "kimi";
    args.roles.ship.provider = "gemini";
    args.roles.land.provider = "gemini";
    args.roles.primaryImpl.provider = "codex";
    args.roles.secondaryImpl.provider = "claude";
    args.roles.judge.provider = "codex";

    expect(validateRoleProviders(args)).toEqual([
      "--qa-provider kimi is not supported for slash-command gates",
    ]);
  });

  it("provider validation accepts non-Gemini/Codex/Claude dual-impl roles", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "codex",
      "--secondary-impl-provider",
      "claude",
      "--judge-provider",
      "gemini",
    ]);
    expect(validateRoleProviders(args)).toEqual([]);
  });
});

describe("phase table display", () => {
  it("prints completed phases as committed, matching persisted state values", () => {
    expect(
      phaseTableStatus({
        ...basePhase,
        testSpecDone: true,
        implementationDone: true,
        reviewDone: true,
      }),
    ).toBe("committed");
  });
});

describe("post-agent hygiene helpers", () => {
  function git(args: string[], cwd: string) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return r.stdout.trim();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-hygiene-"));
    git(["init", "--initial-branch=main"], tmpDir);
    git(["config", "user.email", "test@test.com"], tmpDir);
    git(["config", "user.name", "Test User"], tmpDir);
    fs.writeFileSync(path.join(tmpDir, "README.md"), "init\n");
    git(["add", "."], tmpDir);
    git(["commit", "-m", "init"], tmpDir);
  });

  it("rejects a successful implementor run with an empty summary", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, "");
    fs.writeFileSync(path.join(tmpDir!, "change.txt"), "change\n");
    git(["add", "."], tmpDir!);
    git(["commit", "-m", "change"], tmpDir!);

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/empty output summary/);
  });

  it("rejects a successful implementor run that leaves an untracked file and no commit", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, "done\n");
    fs.writeFileSync(path.join(tmpDir!, "rewrite.py"), 'print("oops")\n');

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/did not create a new commit/);
    expect(verdict.errors.join("\n")).toMatch(/\?\? rewrite\.py/);
  });

  it("recovers a sandboxed implementor by host-committing summary-listed files and cleaning cache noise", () => {
    fs.mkdirSync(path.join(tmpDir!, "pkg", "__pycache__"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir!, "pkg", "__pycache__", "mod.pyc"),
      "old-cache\n",
    );
    git(["add", "pkg/__pycache__/mod.pyc"], tmpDir!);
    git(["commit", "-m", "track cache fixture"], tmpDir!);

    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.mkdirSync(path.join(tmpDir!, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, "README.md"), "changed\n");
    fs.writeFileSync(
      path.join(tmpDir!, "src", "feature.ts"),
      "export const x = 1;\n",
    );
    fs.writeFileSync(
      path.join(tmpDir!, "pkg", "__pycache__", "mod.pyc"),
      "new-cache\n",
    );
    fs.writeFileSync(
      summary,
      [
        "# Primary implementor summary",
        "",
        "## Files changed",
        "- `README.md` — update docs.",
        "- `src/feature.ts` — add feature code.",
        "",
        "## Commit",
        "- Conventional commit message: `feat: add recovered feature`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(recovery.recovered).toBe(true);
    expect(git(["rev-list", "--count", `${before.head}..HEAD`], tmpDir!)).toBe(
      "1",
    );
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat: add recovered feature",
    );
    const committedFiles = git(
      ["show", "--name-only", "--pretty=", "HEAD"],
      tmpDir!,
    ).split("\n");
    expect(committedFiles).toContain("README.md");
    expect(committedFiles).toContain("src/feature.ts");
    expect(committedFiles).not.toContain("pkg/__pycache__/mod.pyc");

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("cleans a stale .git/index.lock (>10s old) before host-committing summary-listed files", () => {
    // Reproduces F0+F1 from AGNT2 run: a concurrent gstack-build process or a
    // crashed git op leaves .git/index.lock around; the host-commit recovery
    // step's `git add` fails with "Unable to create '.../.git/index.lock':
    // File exists." Pre-fix this surfaces as "QA agent couldn't git add."
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, "README.md"), "changed\n");
    fs.writeFileSync(
      summary,
      [
        "# Primary implementor summary",
        "",
        "## Files changed",
        "- `README.md` — update docs.",
        "",
        "## Commit",
        "- Conventional commit message: `feat: stale-lock survivor`",
      ].join("\n"),
    );

    // Plant a stale .git/index.lock with mtime 60s in the past. A fresh
    // lock (< 10s) must NOT be cleaned — that belongs to an active git op.
    const lockPath = path.join(tmpDir!, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const staleMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleMtime, staleMtime);

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(recovery.recovered).toBe(true);
    expect(recovery.errors).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat: stale-lock survivor",
    );
  });

  it("leaves a fresh .git/index.lock (<10s old) in place and surfaces a clear error", () => {
    // Negative case: a lock that's < 10s old belongs to a concurrent active
    // git op. Removing it would corrupt that op's transaction. The recovery
    // must NOT clean fresh locks; instead, surface the git error so the
    // operator knows to retry.
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, "README.md"), "changed\n");
    fs.writeFileSync(
      summary,
      [
        "# Primary implementor summary",
        "",
        "## Files changed",
        "- `README.md` — update docs.",
        "",
        "## Commit",
        "- Conventional commit message: `feat: fresh-lock-blocked`",
      ].join("\n"),
    );

    const lockPath = path.join(tmpDir!, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    // mtime = now (fresh); fs.writeFileSync already set this, but be explicit.
    const freshMtime = new Date(Date.now() - 1_000);
    fs.utimesSync(lockPath, freshMtime, freshMtime);

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(recovery.recovered).toBe(false);
    expect(recovery.errors.join("\n")).toMatch(/index\.lock|File exists/);
    // Fresh lock survives: we did not clobber a concurrent op's transaction.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("recovers uncommitted files listed as markdown links in agent summaries", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.mkdirSync(path.join(tmpDir!, "sequencer", "rpc"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir!, "sequencer", "rpc", "rpc_test.go"),
      "package rpc\n",
    );
    git(["add", "sequencer/rpc/rpc_test.go"], tmpDir!);
    git(["commit", "-m", "test fixture"], tmpDir!);
    const beforeImpl = captureGitSnapshot(tmpDir!);
    fs.writeFileSync(
      path.join(tmpDir!, "sequencer", "rpc", "server.go"),
      "package rpc\n",
    );
    fs.writeFileSync(
      summary,
      [
        "# Phase 1.2 primary-impl output",
        "",
        "## Files changed",
        `- [sequencer/rpc/server.go](${path.join(tmpDir!, "sequencer", "rpc", "server.go")}): add RPC server.`,
        "",
        "## Tests run",
        "- `sequencer/rpc/rpc_test.go`: not run.",
        "",
        "## Commit SHA",
        "- Conventional commit message: `feat(sequencer/rpc): add json-rpc ingress handlers`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before: beforeImpl,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(before.head).not.toBe(beforeImpl.head);
    expect(recovery.recovered).toBe(true);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat(sequencer/rpc): add json-rpc ingress handlers",
    );
    const committedFiles = git(
      ["show", "--name-only", "--pretty=", "HEAD"],
      tmpDir!,
    ).split("\n");
    expect(committedFiles).toContain("sequencer/rpc/server.go");
    expect(committedFiles).not.toContain("sequencer/rpc/rpc_test.go");
  });

  it("fails closed when recovery sees submodule-internal summary paths without explicit allowlist", () => {
    const subRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-submodule-src-"),
    );
    git(["init", "--initial-branch=main"], subRepo);
    git(["config", "user.email", "test@test.com"], subRepo);
    git(["config", "user.name", "Test User"], subRepo);
    fs.writeFileSync(path.join(subRepo, "lib.go"), "package lib\n");
    git(["add", "lib.go"], subRepo);
    git(["commit", "-m", "submodule init"], subRepo);

    git(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        subRepo,
        "vendor/lib",
      ],
      tmpDir!,
    );
    git(["commit", "-am", "add submodule"], tmpDir!);
    const before = captureGitSnapshot(tmpDir!);
    const subPath = path.join(tmpDir!, "vendor", "lib");
    git(["config", "user.email", "test@test.com"], subPath);
    git(["config", "user.name", "Test User"], subPath);
    fs.writeFileSync(
      path.join(subPath, "lib.go"),
      "package lib\nconst X = 1\n",
    );
    git(["add", "lib.go"], subPath);
    git(["commit", "-m", "change submodule"], subPath);

    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(
      summary,
      [
        "# Summary",
        "- `vendor/lib/lib.go` — changed submodule code.",
        "- Conventional commit message: `feat: recover submodule pointer`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(recovery.recovered).toBe(false);
    expect(recovery.errors.join("\n")).toContain(
      "Refusing to stage submodule vendor/lib",
    );
    expect(git(["rev-parse", "HEAD"], tmpDir!)).toBe(before.head);
  });

  it("stages only an explicitly allowed clean submodule gitlink during recovery", () => {
    const subRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-submodule-src-"),
    );
    git(["init", "--initial-branch=main"], subRepo);
    git(["config", "user.email", "test@test.com"], subRepo);
    git(["config", "user.name", "Test User"], subRepo);
    fs.writeFileSync(path.join(subRepo, "lib.go"), "package lib\n");
    git(["add", "lib.go"], subRepo);
    git(["commit", "-m", "submodule init"], subRepo);

    git(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        subRepo,
        "vendor/lib",
      ],
      tmpDir!,
    );
    git(["commit", "-am", "add submodule"], tmpDir!);
    const before = captureGitSnapshot(tmpDir!);
    const subPath = path.join(tmpDir!, "vendor", "lib");
    git(["config", "user.email", "test@test.com"], subPath);
    git(["config", "user.name", "Test User"], subPath);
    fs.writeFileSync(
      path.join(subPath, "lib.go"),
      "package lib\nconst X = 1\n",
    );
    git(["add", "lib.go"], subPath);
    git(["commit", "-m", "change submodule"], subPath);

    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(
      summary,
      [
        "# Summary",
        "- `vendor/lib/lib.go` — changed submodule code.",
        "- Conventional commit message: `feat: recover submodule pointer`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
      allowSubmoduleRecovery: ["vendor/lib"],
    });

    expect(recovery.recovered).toBe(true);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat: recover submodule pointer",
    );
    const committedFiles = git(
      ["show", "--name-only", "--pretty=", "HEAD"],
      tmpDir!,
    ).split("\n");
    expect(committedFiles).toEqual(["vendor/lib"]);
  });

  it("accepts a committed clean implementor run with a non-empty summary", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, "changed README and committed\n");
    fs.writeFileSync(path.join(tmpDir!, "README.md"), "changed\n");
    git(["add", "README.md"], tmpDir!);
    git(["commit", "-m", "change readme"], tmpDir!);

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });

    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("writes hygiene failures to a dedicated sibling log", () => {
    const originalLog = path.join(
      tmpDir!,
      ".llm-tmp",
      "phase-1-primary-impl-1.log",
    );
    fs.mkdirSync(path.dirname(originalLog), { recursive: true });
    fs.writeFileSync(originalLog, "original agent output\n");

    const result = hygieneFailureResult(
      "primary implementor did not create a new commit",
      originalLog,
    );
    const expectedLog = path.join(
      tmpDir!,
      ".llm-tmp",
      "phase-1-primary-impl-1-hygiene.log",
    );

    expect(result.exitCode).toBe(1);
    expect(result.logPath).toBe(expectedLog);
    expect(result.stdout).toContain("# Post-agent hygiene failure");
    expect(result.stdout).toContain(
      "primary implementor did not create a new commit",
    );
    expect(result.stdout).toContain(`Original agent log: ${originalLog}`);
    expect(fs.readFileSync(expectedLog, "utf8")).toBe(result.stdout);
  });

  it("detects parent workspace root HEAD and status changes", () => {
    const workspace = path.join(tmpDir!, "parent-workspace");
    const child = path.join(workspace, "app");
    fs.mkdirSync(child, { recursive: true });
    git(["init", "--initial-branch=main"], workspace);
    git(["config", "user.email", "test@test.com"], workspace);
    git(["config", "user.name", "Test User"], workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root init"], workspace);
    git(["init", "--initial-branch=main"], child);

    const before = captureGitSnapshot(workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root changed\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root change"], workspace);
    fs.writeFileSync(path.join(workspace, "root-scratch.txt"), "dirty\n");

    const verdict = validateParentWorkspaceUnchanged({
      before,
      workspaceRoot: workspace,
      label: "primary implementor",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("changed workspace root HEAD");
    expect(verdict.errors.join("\n")).toContain(
      "changed workspace root status",
    );
  });

  it("allows parent workspace changes that happened before the role snapshot", () => {
    const workspace = path.join(tmpDir!, "parent-window");
    fs.mkdirSync(workspace, { recursive: true });
    git(["init", "--initial-branch=main"], workspace);
    git(["config", "user.email", "test@test.com"], workspace);
    git(["config", "user.name", "Test User"], workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root init"], workspace);

    fs.writeFileSync(path.join(workspace, "README.md"), "root changed\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "orchestrator-owned parent move"], workspace);

    const beforeRole = captureGitSnapshot(workspace);
    const verdict = validateParentWorkspaceUnchanged({
      before: beforeRole,
      workspaceRoot: workspace,
      label: "primary implementor",
    });

    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("keeps the first gate parent snapshot across sandbox retry hygiene", () => {
    const workspace = path.join(tmpDir!, "parent-retry-window");
    fs.mkdirSync(workspace, { recursive: true });
    git(["init", "--initial-branch=main"], workspace);
    git(["config", "user.email", "test@test.com"], workspace);
    git(["config", "user.name", "Test User"], workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root init"], workspace);

    const parentBeforeGate = captureGitSnapshot(workspace);

    // Mirrors the runReviewGates retry path: the first gate attempt can fail
    // before applyGateHygiene checks parentWorkspace, but any parent mutation
    // it caused must still be caught when a later sandbox retry is checked.
    fs.writeFileSync(path.join(workspace, "README.md"), "mutated by gate\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "gate mutated parent"], workspace);

    const retryVerdict = validateParentWorkspaceUnchanged({
      before: parentBeforeGate,
      workspaceRoot: workspace,
      label: "codex sandbox retry gate",
    });

    expect(retryVerdict.ok).toBe(false);
    expect(retryVerdict.errors.join("\n")).toContain(
      "codex sandbox retry gate changed workspace root HEAD",
    );

    // If the retry re-baselined here instead of reusing parentBeforeGate, the
    // mutation above would be hidden and the retry could incorrectly pass.
    const incorrectlyRefreshedBeforeRetry = captureGitSnapshot(workspace);
    const hiddenVerdict = validateParentWorkspaceUnchanged({
      before: incorrectlyRefreshedBeforeRetry,
      workspaceRoot: workspace,
      label: "codex sandbox retry gate",
    });
    expect(hiddenVerdict).toEqual({ ok: true, errors: [] });
  });

  // ------------------------------------------------------------------
  // Audit-only phase hygiene (no commit required)
  // ------------------------------------------------------------------

  it("audit-only: requireNewCommit=false passes on a clean, unchanged tree", () => {
    const before = captureGitSnapshot(tmpDir!);
    // Agent did nothing — no commit, no dirty files. This is the audit-clean case.
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: false,
      label: "primary implementor",
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("audit-only: requireNewCommit=false still fails on a dirty tree", () => {
    const before = captureGitSnapshot(tmpDir!);
    // Agent left an untracked file — must still fail hygiene.
    fs.writeFileSync(path.join(tmpDir!, "scratch.txt"), "leftover\n");
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: false,
      label: "primary implementor",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/left the working tree dirty/);
    expect(verdict.errors.join("\n")).toMatch(/\?\? scratch\.txt/);
  });

  it("guardrail: requireNewCommit=true still fails on a clean, unchanged tree", () => {
    // Pins behavior for test-fixer (cli.ts ~4971) and merge-fixer (cli.ts ~9135)
    // call sites that intentionally stay strict — a no-commit there means the
    // agent failed at its job.
    const before = captureGitSnapshot(tmpDir!);
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: true,
      label: "test fixer",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/did not create a new commit/);
  });

  it("audit-only: passes when the audit found problems and DID produce a commit", () => {
    // An audit-only phase that found a problem and fixed it in place. The
    // "no commit" assertion is moot because HEAD moved; the dirty-tree check
    // still applies and passes because the agent committed cleanly.
    const before = captureGitSnapshot(tmpDir!);
    fs.writeFileSync(path.join(tmpDir!, "fix.txt"), "audit fix\n");
    git(["add", "."], tmpDir!);
    git(["commit", "-m", "fix(audit): correct missing thing"], tmpDir!);
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: false,
      label: "primary implementor",
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  // ------------------------------------------------------------------
  // Fix B: review-gate hygiene whitelist (Codex scratch tolerance)
  // ------------------------------------------------------------------
  // Codex CLI's review subagent runs under workspace-write sandbox and
  // writes session metadata to `.codex/` in the worktree. Pre-fix this
  // tripped the post-review hygiene check, the gate failed, and the
  // operator ran --mark-phase-committed manually because the actual code
  // was fine. Fix B: for the REVIEW gate only, ignore the known Codex
  // scratch dir. The existing `contentHashDelta` already handles same-
  // content rewrites (snapshot-diff fallback), and `.llm-tmp/` is already
  // whitelisted broadly. Only `.codex/` was the gap.

  it("review gate: ignores .codex/ scratch dir created during review", () => {
    const before = captureGitSnapshot(tmpDir!);
    fs.mkdirSync(path.join(tmpDir!, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir!, ".codex", "session.json"),
      '{"id": "x"}',
    );
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: false,
      label: "review",
      reviewGate: true,
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("review gate: STILL trips on real source-file drift (not over-permissive)", () => {
    // Guardrail: review gate must NOT become a no-op. Real source changes
    // a read-only review left behind are real problems.
    const before = captureGitSnapshot(tmpDir!);
    fs.writeFileSync(
      path.join(tmpDir!, "src.ts"),
      "// review should not have written this\n",
    );
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: false,
      label: "review",
      reviewGate: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/src\.ts/);
  });

  it("review gate: default mode (no reviewGate flag) keeps strict scrutiny", () => {
    // Backwards-compat guard: callers that don't opt in get the old
    // semantics. Only when the call site explicitly passes reviewGate:true
    // does the Codex scratch whitelist engage.
    const before = captureGitSnapshot(tmpDir!);
    fs.mkdirSync(path.join(tmpDir!, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir!, ".codex", "session.json"),
      '{"id": "x"}',
    );
    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      requireNewCommit: false,
      label: "primary implementor",
      // no reviewGate flag — strict default.
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/\.codex/);
  });
});

describe("plan storage helpers", () => {
  it("uses explicit --project-root when plan lives outside the product repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const project = path.join(tmpDir, "app");
    const mirror = path.join(tmpDir, "app-gstack", "inbox", "living-plan");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(mirror, { recursive: true });
    const plan = path.join(mirror, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(resolveProjectRoot({ planFile: plan, projectRoot: project })).toBe(
      project,
    );
  });

  it("rejects a workspace root with child repos unless explicitly allowed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-workspace-"));
    const child = path.join(tmpDir, "app");
    fs.mkdirSync(child, { recursive: true });
    spawnSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    spawnSync("git", ["init"], { cwd: child, stdio: "ignore" });

    expect(() => validateProjectRootSelection(tmpDir, false)).toThrow(
      /workspace root/i,
    );
    expect(validateProjectRootSelection(tmpDir, true)).toBe(tmpDir);
  });

  it("requires --project-root when invoked from an ambiguous *-gstack repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const mirror = path.join(tmpDir, "app-gstack");
    const living = path.join(mirror, "living-plans");
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: mirror, stdio: "ignore" });
    const plan = path.join(living, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() => resolveProjectRoot({ planFile: plan, cwd: mirror })).toThrow(
      /--project-root/,
    );
  });

  it("does not bind a sibling living plan to the current product repo implicitly", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const mirror = path.join(tmpDir, "app-a-gstack");
    const living = path.join(mirror, "living-plans");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    spawnSync("git", ["init"], { cwd: mirror, stdio: "ignore" });
    const plan = path.join(living, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("requires --project-root for living plans in an uninitialized *-gstack directory too", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const living = path.join(tmpDir, "app-a-gstack", "living-plans");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(living, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("requires --project-root for inbox plans in a sibling *-gstack repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const inbox = path.join(tmpDir, "app-a-gstack", "inbox");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(inbox, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(inbox, "app-a-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("requires --project-root for inbox living plans in a sibling *-gstack repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const living = path.join(tmpDir, "app-a-gstack", "inbox", "living-plan");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(living, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("prefers the plan repo over the current cwd repo for in-repo plans", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const planProject = path.join(tmpDir, "app-a");
    const currentProject = path.join(tmpDir, "app-b");
    const plans = path.join(planProject, "plans");
    fs.mkdirSync(plans, { recursive: true });
    fs.mkdirSync(currentProject, { recursive: true });
    spawnSync("git", ["init"], { cwd: planProject, stdio: "ignore" });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(plans, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(resolveProjectRoot({ planFile: plan, cwd: currentProject })).toBe(
      planProject,
    );
  });

  it("archives completed living plans into the sibling archived dir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-archive-"));
    const living = path.join(tmpDir, "app-gstack", "living-plans");
    fs.mkdirSync(living, { recursive: true });
    const plan = path.join(living, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    const archived = archiveLivingPlan(plan);
    expect(archived).toBe(
      path.join(tmpDir, "app-gstack", "archived", "app-impl-plan-20260430.md"),
    );
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it("archives completed inbox living plans into the sibling archived dir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-archive-"));
    const living = path.join(tmpDir, "app-gstack", "inbox", "living-plan");
    fs.mkdirSync(living, { recursive: true });
    const plan = path.join(living, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    const archived = archiveLivingPlan(plan);
    expect(archived).toBe(
      path.join(tmpDir, "app-gstack", "archived", "app-impl-plan-20260430.md"),
    );
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it("archives completed origin plans from the sibling inbox into archived", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-archive-"));
    const inbox = path.join(tmpDir, "app-gstack", "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const plan = path.join(inbox, "app-plan-20260430.md");
    fs.writeFileSync(plan, "# source plan\n");

    const archived = archiveOriginPlan(plan);
    expect(archived).toBe(
      path.join(tmpDir, "app-gstack", "archived", "app-plan-20260430.md"),
    );
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it("does not archive origin plans outside a gstack inbox/plans dir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-archive-"));
    const dir = path.join(tmpDir, "app", "plans");
    fs.mkdirSync(dir, { recursive: true });
    const plan = path.join(dir, "app-plan-20260430.md");
    fs.writeFileSync(plan, "# source plan\n");

    expect(archiveOriginPlan(plan)).toBeNull();
    expect(fs.existsSync(plan)).toBe(true);
  });
});

describe("remote base detection", () => {
  function git(args: string[], cwd: string) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout.trim();
  }

  function setupOriginHeadRepo() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-head-"));
    const repo = path.join(tmpDir, "repo");
    const bare = path.join(tmpDir, "origin.git");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(bare, { recursive: true });
    git(["init", "--bare", "--initial-branch=develop"], bare);
    git(["symbolic-ref", "HEAD", "refs/heads/develop"], bare);
    git(["init", "--initial-branch=main"], repo);
    git(["config", "user.email", "test@test.com"], repo);
    git(["config", "user.name", "Test User"], repo);
    git(["remote", "add", "origin", bare], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "main\n");
    git(["add", "."], repo);
    git(["commit", "-m", "main init"], repo);
    git(["push", "-u", "origin", "main"], repo);
    git(["checkout", "-b", "develop"], repo);
    fs.writeFileSync(path.join(repo, "default.txt"), "develop default\n");
    git(["add", "."], repo);
    git(["commit", "-m", "develop default"], repo);
    git(["push", "-u", "origin", "develop"], repo);
    git(["fetch", "origin"], repo);
    git(["remote", "set-head", "origin", "-a"], repo);
    return repo;
  }

  it("resolves origin/HEAD before main or master", () => {
    const repo = setupOriginHeadRepo();
    expect(detectRemoteBaseRef(repo)).toBe("origin/develop");
  });

  it("syncFeatureBranchWithBase merges the origin/HEAD default branch", () => {
    const repo = setupOriginHeadRepo();
    git(["checkout", "main"], repo);
    git(["checkout", "-b", "feat/work"], repo);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
    git(["add", "."], repo);
    git(["commit", "-m", "feature work"], repo);

    const result = syncFeatureBranchWithBase(repo, "feat/work");

    expect(result.ok).toBe(true);
    expect(result.baseRef).toBe("origin/develop");
    expect(fs.readFileSync(path.join(repo, "default.txt"), "utf8")).toBe(
      "develop default\n",
    );
  });

  it("syncLandedBase fetches origin and returns the base branch name without checking it out", () => {
    const repo = setupOriginHeadRepo();
    git(["checkout", "main"], repo);

    const result = syncLandedBase(repo);

    expect(result).toEqual({ ok: true, branch: "develop" });
    // Must NOT have switched branches — worktree-safe behaviour.
    expect(git(["branch", "--show-current"], repo)).toBe("main");
    // The tracking ref must be up-to-date after the fetch.
    const refExists = spawnSync(
      "git",
      ["rev-parse", "--verify", "origin/develop"],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(refExists.status).toBe(0);
  });

  it("syncLandedBase succeeds in a linked worktree where base is checked out in the primary clone", () => {
    const repo = setupOriginHeadRepo();
    // Simulate a linked worktree: the primary clone has `develop` checked out,
    // but we run syncLandedBase inside it. Previously this would have tried
    // `git checkout develop` which fails in the primary clone itself if some
    // worktree already has it, or is a no-op if we're already on it. The new
    // behaviour just fetches and reads the tracking ref — no checkout needed.
    git(["checkout", "develop"], repo);

    const result = syncLandedBase(repo);

    expect(result.ok).toBe(true);
    expect(result.branch).toBe("develop");
    // Still on develop, not moved anywhere.
    expect(git(["branch", "--show-current"], repo)).toBe("develop");
  });

  it("syncLandedBase returns ok:false when fetch fails (no remote configured)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-sync-noremote-"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-b", "main"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "x");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
    // No remote configured — fetch must fail.
    const result = syncLandedBase(repo);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("buildOriginVerificationBody", () => {
  it("asks for a GATE PASS / GATE FAIL origin-plan check", () => {
    const body = buildOriginVerificationBody({
      feature: {
        index: 0,
        number: "1",
        name: "Auth",
        phaseIndexes: [0, 1],
        status: "origin_verifying",
      },
      livingPlanFile: "living.md",
      originPlanFile: "origin.md",
    });
    expect(body).toContain("Origin plan: origin.md");
    expect(body).toContain("GATE PASS");
    expect(body).toContain("GATE FAIL");
  });
});

describe("buildDualImplPromptBody (dual-impl implementation prompt)", () => {
  it('contains "implement"', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: "plan.md",
      candidate: "primary",
      opponent: "secondary",
    });
    expect(body.toLowerCase()).toMatch(/implement/);
  });

  it('contains "do NOT change test assertions"', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: "plan.md",
      candidate: "primary",
      opponent: "secondary",
    });
    expect(body).toMatch(/do NOT change test assertions/i);
  });

  it("contains the phase name, plan file, and candidate labels", () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: "plan.md",
      candidate: "primary",
      opponent: "secondary",
    });
    expect(body).toContain(basePhase.name);
    expect(body).toContain("plan.md");
    expect(body).toContain("primary implementor");
    expect(body).toContain("secondary implementor");
  });
});

describe("buildCodexReviewBody (configured review gate context)", () => {
  it("does not hardcode /gstack-review so configured commands stay authoritative", () => {
    const body = buildCodexReviewBody(
      basePhase,
      "plan.md",
      "feat/test",
      1,
      null,
    );
    expect(body).toContain("slash command specified by the runner prompt");
    expect(body).not.toContain("/gstack-review");
  });

  it("includes origin-plan issue reports when restarting a feature loop", () => {
    const body = buildCodexReviewBody(
      basePhase,
      "plan.md",
      "feat/test",
      1,
      null,
      undefined,
      "/tmp/origin-issues.md",
    );
    expect(body).toContain("Origin-plan verification issues");
    expect(body).toContain("/tmp/origin-issues.md");
    expect(body).toContain("Fix every concrete gap");
  });
});

describe("restartFeatureFromOriginIssues", () => {
  function stateAndFeature(): { state: BuildState; feature: FeatureState } {
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [0, 1],
      status: "origin_verifying",
      featureReview: {
        iterations: 1,
        outputLogPaths: ["/tmp/feature-review.log"],
        outputFilePaths: ["/tmp/feature-review.md"],
        finalVerdict: "FEATURE_PASS",
      },
    };
    return {
      feature,
      state: {
        planFile: "plan.md",
        planBasename: "plan",
        slug: "plan",
        branch: "feat/auth",
        startedAt: "2026-04-30T00:00:00.000Z",
        lastUpdatedAt: "2026-04-30T00:00:00.000Z",
        currentPhaseIndex: 0,
        currentFeatureIndex: 0,
        features: [feature],
        phases: [
          { index: 0, number: "1.1", name: "Tests", status: "committed" },
          {
            index: 1,
            number: "1.2",
            name: "Implementation",
            status: "committed",
            codexReview: {
              iterations: 2,
              finalVerdict: "GATE PASS",
              outputLogPaths: ["/tmp/review.md"],
            },
          },
        ],
        completed: false,
        geminiModel: "gemini",
        codexModel: "codex",
        codexReviewModel: "codex-review",
      },
    };
  }

  it("records origin issues and resets the feature to its review loop", () => {
    const { state, feature } = stateAndFeature();
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "missing acceptance behavior",
    });
    expect(restart).toEqual({ restarted: true, phaseIndex: 1 });
    expect(feature.status).toBe("running");
    expect(feature.originVerificationAttempts).toBe(1);
    expect(feature.originIssueLogPaths).toEqual(["/tmp/origin-issues.md"]);
    expect(feature.featureReview).toBeUndefined();
    expect(state.phases[1].status).toBe("tests_green");
    expect(state.phases[1].codexReview).toBeUndefined();
    expect(state.phases[1].originIssueLogPath).toBe("/tmp/origin-issues.md");
  });

  it("pauses after the origin verification retry cap is exhausted", () => {
    const { state, feature } = stateAndFeature();
    feature.originVerificationAttempts = 1;
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "still missing behavior",
      maxAttempts: 1,
    });
    expect(restart.restarted).toBe(false);
    expect(feature.status).toBe("paused");
    expect(feature.error).toContain("still failing after 1 auto-fix attempts");
  });

  it("un-flips plan checkboxes when rewinding a committed phase (PREMATURE_COMPLETION defense)", () => {
    // Repro for the 2026-05-18 mitosis PREMATURE_COMPLETION faults: when
    // restartFeatureFromOriginIssues rewinds a phase from `committed` to
    // `tests_green`, the plan checkboxes (flipped during markCommitted) must
    // be un-flipped too. Without this, a subsequent failure on the re-run
    // leaves checkboxes [x][x][x] while status is `failed` — the exact
    // PREMATURE_COMPLETION signature.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-restart-rewind-"),
    );
    const planFile = path.join(tmpDir, "plan.md");
    const planMd = [
      "# Plan",
      "",
      "## Feature 1: Auth",
      "",
      "### Phase 1.1: Tests",
      "- [x] **Test Specification (test-writer role)**: spec",
      "- [x] **Implementation (primary-impl role)**: impl",
      "- [x] **Review & QA (review roles)**: review",
      "",
      "### Phase 1.2: Implementation",
      "- [x] **Test Specification (test-writer role)**: spec",
      "- [x] **Implementation (primary-impl role)**: impl",
      "- [x] **Review & QA (review roles)**: review",
      "",
    ].join("\n");
    fs.writeFileSync(planFile, planMd);

    const { state, feature } = stateAndFeature();
    state.planFile = planFile;

    const phases: Phase[] = [
      {
        ...basePhase,
        index: 0,
        number: "1.1",
        name: "Tests",
        testSpecCheckboxLine: 6,
        implementationCheckboxLine: 7,
        reviewCheckboxLine: 8,
      },
      {
        ...basePhase,
        index: 1,
        number: "1.2",
        name: "Implementation",
        testSpecCheckboxLine: 11,
        implementationCheckboxLine: 12,
        reviewCheckboxLine: 13,
      },
    ];

    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "missing acceptance behavior",
      phases,
    });

    expect(restart).toEqual({ restarted: true, phaseIndex: 1 });
    expect(state.phases[1].status).toBe("tests_green");

    // Phase 1.2 (the rewound phase) checkboxes should be back to [ ].
    const after = fs.readFileSync(planFile, "utf8").split(/\r?\n/);
    expect(after[10]).toContain("[ ] **Test Specification");
    expect(after[11]).toContain("[ ] **Implementation");
    expect(after[12]).toContain("[ ] **Review & QA");

    // Phase 1.1 (NOT rewound) checkboxes must stay [x].
    expect(after[5]).toContain("[x] **Test Specification");
    expect(after[6]).toContain("[x] **Implementation");
    expect(after[7]).toContain("[x] **Review & QA");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("FAIL-CLOSED: pauses feature when unflipPhaseCheckboxes errors (no state advance)", () => {
    // Codex adversarial review finding: the original implementation
    // console.warn'd on un-flip errors but still advanced state, recreating
    // the exact PREMATURE_COMPLETION bug class (state rewound, markdown
    // still [x][x][x]). Fix: if un-flip errors, return without state
    // advance, pause the feature, surface the markdown drift to the user.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-restart-failclosed-"),
    );
    const planFile = path.join(tmpDir, "plan.md");
    // Plan was hand-edited: the impl checkbox marker is wrong (someone
    // renamed it from **Implementation to **Wrong Marker mid-flight).
    const planMd = [
      "# Plan",
      "",
      "## Feature 1: Auth",
      "",
      "### Phase 1.1: Tests",
      "- [x] **Test Specification (test-writer role)**: spec",
      "- [x] **Implementation (primary-impl role)**: impl",
      "- [x] **Review & QA (review roles)**: review",
      "",
      "### Phase 1.2: Implementation",
      "- [x] **Test Specification (test-writer role)**: spec",
      "- [x] **Wrong Marker (someone renamed this)**: impl",
      "- [x] **Review & QA (review roles)**: review",
      "",
    ].join("\n");
    fs.writeFileSync(planFile, planMd);

    const { state, feature } = stateAndFeature();
    state.planFile = planFile;

    const phases: Phase[] = [
      {
        ...basePhase,
        index: 0,
        number: "1.1",
        name: "Tests",
        testSpecCheckboxLine: 6,
        implementationCheckboxLine: 7,
        reviewCheckboxLine: 8,
      },
      {
        ...basePhase,
        index: 1,
        number: "1.2",
        name: "Implementation",
        testSpecCheckboxLine: 11,
        implementationCheckboxLine: 12, // Marker doesn't match!
        reviewCheckboxLine: 13,
      },
    ];

    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "missing acceptance behavior",
      phases,
    });

    // Restart must be REJECTED, not silently advance.
    expect(restart.restarted).toBe(false);
    expect(restart.reason).toContain("plan markdown drift");
    expect(restart.reason).toContain("1.2");
    expect(feature.status).toBe("paused");
    expect(feature.error).toContain("plan markdown drift");

    // CRITICAL: phase status MUST stay `committed` — no rewind happened
    // because the markdown couldn't follow. This is the fail-closed
    // guarantee that prevents PREMATURE_COMPLETION recreation.
    expect(state.phases[1].status).toBe("committed");

    // Plan markdown is unchanged (atomic un-flip refused, atomic write
    // didn't happen).
    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toBe(planMd);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("does not un-flip when phases arg is omitted (preserves existing callers)", () => {
    // Existing tests that pre-date the un-flip wiring must still pass —
    // when `phases` is omitted, the function falls back to the pre-fix
    // behavior (rewind status, leave plan markdown alone).
    const { state, feature } = stateAndFeature();
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "missing acceptance behavior",
      // phases intentionally omitted
    });
    expect(restart).toEqual({ restarted: true, phaseIndex: 1 });
    expect(state.phases[1].status).toBe("tests_green");
    // No fs.readFileSync — proves the function didn't try to touch a
    // non-existent plan file. If un-flip ran unguarded it would throw ENOENT.
  });
});

describe("markPhaseCommittedAfterManualRecovery", () => {
  it("marks a failed phase committed without deleting test artifacts or rerunning the phase", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-manual-recovery-"));
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "## Feature 1: Auth",
        "",
        "### Phase 1.1: Middleware",
        "- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests.",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
      ].join("\n"),
    );
    const phase: Phase = {
      ...basePhase,
      number: "1.1",
      name: "Middleware",
      testSpecCheckboxLine: 6,
      implementationCheckboxLine: 7,
      reviewCheckboxLine: 8,
    };
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [0],
      status: "paused",
      error: "old phase failure",
    };
    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "build-plan",
      branch: "feat/auth",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [feature],
      phases: [
        {
          index: 0,
          number: "1.1",
          name: "Middleware",
          status: "failed",
          error: "old hygiene failure",
          geminiTestSpec: {
            startedAt: "2026-05-08T00:00:00.000Z",
            outputLogPath: "/tmp/testspec.log",
            outputFilePath: "/tmp/testspec.md",
            retries: 0,
          },
        },
      ],
      failedAtPhase: 0,
      failureReason: "old hygiene failure",
      completed: false,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases: [phase],
      phaseNumber: "1.1",
      planFile,
    });

    expect(result).toEqual({ ok: true, phaseIndex: 0 });
    expect(state.phases[0].status).toBe("committed");
    expect(state.phases[0].error).toBeUndefined();
    expect(state.phases[0].geminiTestSpec).toBeDefined();
    expect(state.failedAtPhase).toBeUndefined();
    expect(state.failureReason).toBeUndefined();
    expect(feature.status).toBe("running");
    expect(feature.error).toBeUndefined();
    const updatedPlan = fs.readFileSync(planFile, "utf8");
    expect(updatedPlan).toContain("- [x] **Test Specification");
    expect(updatedPlan).toContain("- [x] **Implementation");
    expect(updatedPlan).toContain("- [x] **Review");
  });

  it("does not clear an unrelated recorded failure when marking a different phase", () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-manual-recovery-other-"),
    );
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "### Phase 1.1: First",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
        "### Phase 1.2: Second",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
      ].join("\n"),
    );
    const phases: Phase[] = [
      {
        ...basePhase,
        index: 0,
        number: "1.1",
        name: "First",
        testSpecCheckboxLine: -1,
        implementationCheckboxLine: 4,
        reviewCheckboxLine: 5,
      },
      {
        ...basePhase,
        index: 1,
        number: "1.2",
        name: "Second",
        testSpecCheckboxLine: -1,
        implementationCheckboxLine: 8,
        reviewCheckboxLine: 9,
      },
    ];
    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "build-plan",
      branch: "feat/auth",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [
        {
          index: 0,
          number: "1",
          name: "Full plan",
          phaseIndexes: [0, 1],
          status: "paused",
          error: "phase 1.2 failed",
        },
      ],
      phases: [
        { index: 0, number: "1.1", name: "First", status: "review_clean" },
        { index: 1, number: "1.2", name: "Second", status: "failed" },
      ],
      failedAtPhase: 1,
      failureReason: "phase 1.2 failed",
      completed: false,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases,
      phaseNumber: "1.1",
      planFile,
    });

    expect(result).toEqual({ ok: true, phaseIndex: 0 });
    expect(state.failedAtPhase).toBe(1);
    expect(state.failureReason).toBe("phase 1.2 failed");
    expect(state.features[0].status).toBe("paused");
    expect(state.features[0].error).toBe("phase 1.2 failed");
  });

  it("fails closed when the parsed plan phase no longer matches persisted state at that index", () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-manual-recovery-mismatch-"),
    );
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "### Phase 1.1: First",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
      ].join("\n"),
    );
    const phase: Phase = {
      ...basePhase,
      index: 0,
      number: "1.1",
      name: "First",
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 4,
      reviewCheckboxLine: 5,
    };
    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "build-plan",
      branch: "feat/auth",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [
        {
          index: 0,
          number: "1",
          name: "Full plan",
          phaseIndexes: [0],
          status: "paused",
        },
      ],
      phases: [
        { index: 0, number: "9.9", name: "Stale phase", status: "failed" },
      ],
      failedAtPhase: 0,
      failureReason: "old failure",
      completed: false,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases: [phase],
      phaseNumber: "1.1",
      planFile,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "state/plan phase mismatch at index 0: plan has 1.1, state has 9.9",
    });
    expect(state.phases[0].status).toBe("failed");
    const unchangedPlan = fs.readFileSync(planFile, "utf8");
    expect(unchangedPlan).toContain("- [ ] **Implementation");
    expect(unchangedPlan).toContain("- [ ] **Review");
  });

  describe("dirty-tree guard", () => {
    // Stand up a real git repo so captureGitSnapshot can run. The dirty-tree
    // guard was the recovery anti-pattern the 2026-05-18 mitosis faults all
    // triggered: --mark-phase-committed silently force-marked over the dirty
    // tree, leaving the next phase to start on an inconsistent state.
    function setupDirtyWorktreeFixture(): {
      tmpDir: string;
      planFile: string;
      phase: Phase;
      state: BuildState;
    } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-dirty-guard-"));
      // Init a real git repo so `git status --porcelain` runs.
      spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
      spawnSync("git", ["-C", dir, "config", "user.email", "t@t"], {
        encoding: "utf8",
      });
      spawnSync("git", ["-C", dir, "config", "user.name", "t"], {
        encoding: "utf8",
      });
      spawnSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], {
        encoding: "utf8",
      });
      // Write the plan file BEFORE seed commit so it's tracked and doesn't
      // show up as untracked in the "clean tree" tests.
      const planFile = path.join(dir, "plan.md");
      fs.writeFileSync(
        planFile,
        [
          "# Plan",
          "",
          "### Phase 1.1: Foo",
          "- [ ] **Implementation**: impl",
          "- [ ] **Review**: review",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      spawnSync("git", ["-C", dir, "add", "seed.txt", "plan.md"], {
        encoding: "utf8",
      });
      spawnSync("git", ["-C", dir, "commit", "-q", "-m", "seed"], {
        encoding: "utf8",
      });
      const phase: Phase = {
        ...basePhase,
        number: "1.1",
        name: "Foo",
        testSpecCheckboxLine: -1,
        implementationCheckboxLine: 4,
        reviewCheckboxLine: 5,
      };
      const state: BuildState = {
        planFile,
        planBasename: "plan",
        slug: "build-plan",
        branch: "main",
        startedAt: "2026-05-19T00:00:00.000Z",
        lastUpdatedAt: "2026-05-19T00:00:00.000Z",
        currentPhaseIndex: 0,
        currentFeatureIndex: 0,
        features: [],
        phases: [
          {
            index: 0,
            number: "1.1",
            name: "Foo",
            status: "failed",
            error: "old hygiene failure",
          },
        ],
        completed: false,
      };
      return { tmpDir: dir, planFile, phase, state };
    }

    it("refuses to mark when worktree is dirty and no flag is passed", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      // Dirty the tree.
      fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: dir,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("worktree is dirty");
        expect(result.error).toContain("--commit-dirty");
        expect(result.error).toContain("--force-dirty");
        expect(result.dirtyFiles).toBeDefined();
        expect(result.dirtyFiles?.some((f) => f.includes("dirty.txt"))).toBe(
          true,
        );
      }
      // State must NOT have advanced.
      expect(state.phases[0].status).toBe("failed");
      const unchangedPlan = fs.readFileSync(planFile, "utf8");
      expect(unchangedPlan).toContain("- [ ] **Implementation");

      fs.rmSync(dir, { recursive: true });
    });

    it("--force-dirty marks anyway, preserves the dirty state (warn-only)", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: dir,
        forceDirty: true,
      });
      expect(result).toEqual({ ok: true, phaseIndex: 0 });
      expect(state.phases[0].status).toBe("committed");
      // Dirty file must still be on disk and uncommitted.
      expect(fs.existsSync(path.join(dir, "dirty.txt"))).toBe(true);
      const statusAfter = spawnSync(
        "git",
        ["-C", dir, "status", "--porcelain"],
        { encoding: "utf8" },
      );
      expect(statusAfter.stdout).toContain("dirty.txt");

      fs.rmSync(dir, { recursive: true });
    });

    it("--commit-dirty stages + commits dirty files before marking", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: dir,
        commitDirty: true,
      });
      expect(result).toEqual({ ok: true, phaseIndex: 0 });
      expect(state.phases[0].status).toBe("committed");
      // `dirty.txt` (agent-left) must be committed and out of the dirty list.
      // The orchestrator's subsequent checkbox flip dirties plan.md — that's
      // expected and not the guard's responsibility.
      const statusAfter = spawnSync(
        "git",
        ["-C", dir, "status", "--porcelain"],
        { encoding: "utf8" },
      );
      expect(statusAfter.stdout).not.toContain("dirty.txt");
      // The auto-commit must exist with the recovery message prefix.
      const logAfter = spawnSync(
        "git",
        ["-C", dir, "log", "-1", "--format=%s"],
        { encoding: "utf8" },
      );
      expect(logAfter.stdout).toContain("fix(recovery): 1.1 auto-commit");
      // dirty.txt must be part of the committed tree now.
      const showAfter = spawnSync(
        "git",
        ["-C", dir, "show", "--stat", "--format=", "HEAD"],
        { encoding: "utf8" },
      );
      expect(showAfter.stdout).toContain("dirty.txt");

      fs.rmSync(dir, { recursive: true });
    });

    it("--force-dirty and --commit-dirty are mutually exclusive", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: dir,
        forceDirty: true,
        commitDirty: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("mutually exclusive");
      }
      expect(state.phases[0].status).toBe("failed");
      fs.rmSync(dir, { recursive: true });
    });

    it("clean tree marks without invoking the guard (no flags needed)", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      // No dirty file — tree is clean from setup.

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: dir,
      });
      expect(result).toEqual({ ok: true, phaseIndex: 0 });
      expect(state.phases[0].status).toBe("committed");
      fs.rmSync(dir, { recursive: true });
    });

    it("skips the dirty-tree guard when cwd is omitted (legacy callers)", () => {
      // No cwd passed → no git inspection → no refusal. This preserves
      // backward compat for existing tests that exercise the state-only
      // transition without setting up a real git fixture.
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        // cwd intentionally omitted
      });
      expect(result).toEqual({ ok: true, phaseIndex: 0 });
      expect(state.phases[0].status).toBe("committed");
      fs.rmSync(dir, { recursive: true });
    });

    it("fails closed when captureGitSnapshot reports a git error (index.lock held, etc)", () => {
      // Adversarial review finding: a non-zero `git status` exit encodes as
      // `<git error: ...>` in snapshot.status. Filtering those out treats
      // them as "clean" → silent guard bypass. Now we surface the error
      // and refuse, unless --force-dirty is passed.
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      // Point cwd at a non-git directory so captureGitSnapshot fails.
      const nonGitDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gstack-not-a-git-repo-"),
      );

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: nonGitDir,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("git status failed");
        expect(result.error).toContain("--force-dirty");
      }
      // State must NOT have advanced.
      expect(state.phases[0].status).toBe("failed");

      fs.rmSync(dir, { recursive: true });
      fs.rmSync(nonGitDir, { recursive: true });
    });

    it("--force-dirty bypasses git-error fail-closed (operator accepts unknown state)", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      const nonGitDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gstack-not-a-git-repo-"),
      );

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: nonGitDir,
        forceDirty: true,
      });
      // With --force-dirty, snapshot failure is logged-and-skipped (the
      // operator already accepted that the worktree state may be dirty;
      // an unknown state is no worse). State advances.
      expect(result).toEqual({ ok: true, phaseIndex: 0 });
      expect(state.phases[0].status).toBe("committed");

      fs.rmSync(dir, { recursive: true });
      fs.rmSync(nonGitDir, { recursive: true });
    });

    it("dryRun skips the dirty-tree guard (preview mode never inspects worktree)", () => {
      const {
        tmpDir: dir,
        planFile,
        phase,
        state,
      } = setupDirtyWorktreeFixture();
      fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

      const result = markPhaseCommittedAfterManualRecovery({
        state,
        phases: [phase],
        phaseNumber: "1.1",
        planFile,
        cwd: dir,
        dryRun: true,
      });
      // Dry-run preview must succeed even on dirty trees; the operator can
      // see what would happen before deciding whether to add --commit-dirty.
      expect(result).toEqual({ ok: true, phaseIndex: 0 });
      // No state mutation in dry-run.
      expect(state.phases[0].status).toBe("failed");
      fs.rmSync(dir, { recursive: true });
    });
  });
});

describe("ensureFeatureBranch", () => {
  function stateForBranchTest(
    slug: string,
    feature: FeatureState,
    branch = "feat/other",
  ): BuildState {
    return {
      planFile: "plan.md",
      planBasename: "plan",
      slug,
      branch,
      startedAt: "2026-04-30T00:00:00.000Z",
      lastUpdatedAt: "2026-04-30T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [feature],
      phases: [],
      completed: false,
      geminiModel: "gemini",
      codexModel: "codex",
      codexReviewModel: "codex-review",
    };
  }

  it("checks out a saved feature branch when resuming from another branch", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-feature-branch-"));
    const repo = tmpDir;
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["checkout", "-b", "feat/auth"], { cwd: repo }).status,
    ).toBe(0);
    expect(spawnSync("git", ["checkout", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["checkout", "-b", "feat/other"], { cwd: repo }).status,
    ).toBe(0);

    const slug = `test-branch-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
      branch: "feat/auth",
    };
    const state = stateForBranchTest(slug, feature);

    expect(
      ensureFeatureBranch({
        cwd: repo,
        state,
        feature,
        dryRun: false,
        noGbrain: true,
      }),
    ).toBe(true);
    const current = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    expect(current).toBe("feat/auth");
    fs.rmSync(statePath(slug), { force: true });
  });

  it("creates a follow-up branch from base for landed origin-verification retries", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-retry-"));
    const bare = path.join(tmpDir, "origin.git");
    const repo = path.join(tmpDir, "repo");
    expect(spawnSync("git", ["init", "--bare", bare]).status).toBe(0);
    expect(spawnSync("git", ["clone", bare, repo]).status).toBe(0);
    expect(
      spawnSync("git", ["checkout", "-b", "main"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["checkout", "-b", "feat/auth"], { cwd: repo }).status,
    ).toBe(0);
    expect(spawnSync("git", ["checkout", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["branch", "-D", "feat/auth"], { cwd: repo }).status,
    ).toBe(0);

    const slug = `test-origin-retry-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
      branch: "feat/auth",
      landedAt: "2026-04-30T00:00:00.000Z",
      originVerificationAttempts: 1,
    };
    const state = stateForBranchTest(slug, feature, "main");

    expect(
      ensureFeatureBranch({
        cwd: repo,
        state,
        feature,
        dryRun: false,
        noGbrain: true,
      }),
    ).toBe(true);
    const current = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    expect(current).toBe("feat/auth-followup-1");
    expect(feature.branch).toBe("feat/auth-followup-1");
    expect(state.branch).toBe("feat/auth-followup-1");
    fs.rmSync(statePath(slug), { force: true });
  });

  it("uses branchPrefix for owned feature branches", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-prefix-branch-"));
    const repo = tmpDir;
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    const slug = `test-prefix-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    const state = stateForBranchTest(slug, feature);
    state.launch = {
      argv: ["plan.md"],
      projectRoot: "/repo",
      runId: "run-1",
      branchPrefix: "repo-run-1",
      activeRunRegistry: path.join(os.tmpdir(), "active-runs"),
      dryRun: true,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: "2026-04-30T00:00:00.000Z",
      stateSlug: slug,
    };

    expect(
      ensureFeatureBranch({
        cwd: repo,
        state,
        feature,
        dryRun: true,
        noGbrain: true,
      }),
    ).toBe(true);
    expect(feature.branch).toBe("feat/repo-run-1-1-auth");
    expect(state.branch).toBe("feat/repo-run-1-1-auth");
    fs.rmSync(statePath(slug), { force: true });
  });

  it("creates new feature branch from origin/<base> without checking out the local base branch", () => {
    // Regression test for worktree-safe branch creation. Previously the code did
    // `git checkout <base>` then `git checkout -b feat/...`, which fails in a
    // linked worktree where <base> is already checked out somewhere else.
    // The fixed path does `git fetch origin <base>` then
    // `git checkout -b feat/... origin/<base>`, requiring no local checkout of base.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-feature-origin-"));
    const bare = path.join(tmpDir, "origin.git");
    const repo = path.join(tmpDir, "repo");
    spawnSync("git", ["init", "--bare", bare]);
    spawnSync("git", ["clone", bare, repo]);
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
    spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo });

    // Now switch to a different branch (simulates: primary worktree on a feature branch
    // while the base branch is only reachable via origin tracking ref).
    spawnSync("git", ["checkout", "-b", "feat/other"], { cwd: repo });

    const slug = `test-origin-new-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    const state = stateForBranchTest(slug, feature, "feat/other");

    const result = ensureFeatureBranch({
      cwd: repo,
      state,
      feature,
      dryRun: false,
      noGbrain: true,
    });

    expect(result).toBe(true);
    // The feature branch was created directly from origin/main — no checkout of main needed.
    const current = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    // Branch name includes plan basename ("plan") + feature number + slugified name.
    expect(current).toBe("feat/plan-1-auth");
    expect(feature.branch).toBe("feat/plan-1-auth");
    // Confirm the feature branch tracks origin/main (branched from it, not a local checkout).
    const trackingRef = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    });
    const originMain = spawnSync("git", ["rev-parse", "origin/main"], {
      cwd: repo,
      encoding: "utf8",
    });
    // HEAD should be at same commit as origin/main since we branched from it.
    expect(trackingRef.stdout.trim()).toBe(originMain.stdout.trim());
    fs.rmSync(statePath(slug), { force: true });
  });

  // Regression for the orchestrator state-caching bug observed during the
  // implementor-hygiene-hardening build (2026-05-18): when `git fetch origin
  // <base>` failed (broken `origin/main 2` ref), `ensureFeatureBranch`
  // returned false BUT had already assigned `feature.branch = <planned-name>`
  // to state. On next CLI restart, the saved-branch path tried to
  // `git checkout <planned-name>` — which never existed in git — and the
  // build entered a permanent "failed to checkout saved feature branch" loop.
  //
  // Fix: only assign `feature.branch` AFTER `git checkout -b` succeeds. On
  // failure, `feature.branch` MUST remain null so the next attempt re-derives
  // it from scratch.
  it("does NOT save feature.branch when the fetch base step fails (state-caching regression)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fetch-fail-"));
    const repo = tmpDir;
    // Init repo with no origin remote at all — `git fetch origin <base>` will fail.
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);

    const slug = `test-fetch-fail-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
      // CRITICAL: feature.branch starts unset so ensureFeatureBranch takes
      // the create path (not the saved-branch checkout path).
    };
    const state = stateForBranchTest(slug, feature, "main");

    const result = ensureFeatureBranch({
      cwd: repo,
      state,
      feature,
      dryRun: false,
      noGbrain: true,
    });

    // The fetch must fail (no origin remote) and the function must return false.
    expect(result).toBe(false);
    // The bug: feature.branch was assigned before the fetch and survived the
    // failure. After the fix, it MUST be undefined/null so the next attempt
    // re-derives the branch name fresh.
    expect(feature.branch ?? null).toBeNull();
    // state.branch should also be unaffected by the failed create attempt
    // (it was pointing at the existing test branch "main" before the call).
    // We don't assert state.branch reverts to the original here because the
    // original implementation set it before the fetch; the relevant invariant
    // is that feature.branch (the persisted one) stays unset on failure.
    // The failure should be recorded in feature.error.
    expect(feature.status).toBe("failed");
    expect(feature.error).toBeTruthy();
    expect(feature.error).toContain("failed to fetch");

    fs.rmSync(statePath(slug), { force: true });
  });

  // Same regression class, different failure site: when `git checkout -b
  // <branch> origin/<base>` fails (e.g. the branch name collides with an
  // existing ref the function can't recover via the fallback `git checkout
  // <branch>` path), feature.branch must also remain unset.
  it("does NOT save feature.branch when the checkout step fails", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-checkout-fail-"));
    const bare = path.join(tmpDir, "origin.git");
    const repo = path.join(tmpDir, "repo");
    expect(spawnSync("git", ["init", "--bare", bare]).status).toBe(0);
    expect(spawnSync("git", ["clone", bare, repo]).status).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);
    // After `git clone`, the working branch already matches the remote
    // HEAD; just ensure it's named "main" and pushed.
    spawnSync("git", ["branch", "-M", "main"], { cwd: repo });
    expect(
      spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status,
    ).toBe(0);
    // Pre-create a branch that will collide AND has uncommitted work to
    // block the fallback `git checkout <branch>` path. We achieve this by
    // creating the would-be feature branch from a different commit, then
    // dirtying the worktree so the fallback checkout fails.
    expect(
      spawnSync("git", ["checkout", "-b", "feat/plan-1-auth"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "blocker.txt"), "uncommitted\n");
    // Stay on main so `createFeatureBranch` is true (existing.startsWith
    // "feat/" would route differently).
    expect(spawnSync("git", ["checkout", "main"], { cwd: repo }).status).toBe(
      0,
    );

    const slug = `test-checkout-fail-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    const state = stateForBranchTest(slug, feature, "main");

    // This may pass or fail depending on git's exact behavior with the
    // pre-existing branch + dirty worktree. The test's invariant is that
    // IF the function returns false (some failure path), feature.branch
    // is null. If it returns true (recovery succeeded), feature.branch
    // is set to a real branch — both are acceptable.
    const result = ensureFeatureBranch({
      cwd: repo,
      state,
      feature,
      dryRun: false,
      noGbrain: true,
    });
    if (result === false) {
      expect(feature.branch ?? null).toBeNull();
      expect(feature.status).toBe("failed");
    } else {
      // Recovery succeeded; feature.branch should match a real git branch.
      expect(typeof feature.branch).toBe("string");
      const branchExists = spawnSync(
        "git",
        ["rev-parse", "--verify", feature.branch!],
        { cwd: repo, encoding: "utf8" },
      );
      expect(branchExists.status).toBe(0);
    }
    fs.rmSync(statePath(slug), { force: true });
  });
});

describe("validateResumeLaunch", () => {
  function launch(projectRoot = "/repo") {
    return {
      argv: ["/plans/plan.md"],
      projectRoot,
      baseProjectRoot: "/base",
      runId: "run-1",
      branchPrefix: "repo-run-1",
      activeRunRegistry: "/registry",
      dryRun: false,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: "2026-04-30T00:00:00.000Z",
      stateSlug: "build-run-1",
    };
  }

  it("refuses mismatched plan path or project root", () => {
    const state: BuildState = {
      planFile: "/plans/plan.md",
      planBasename: "plan",
      slug: "build-run-1",
      branch: "main",
      startedAt: "2026-04-30T00:00:00.000Z",
      lastUpdatedAt: "2026-04-30T00:00:00.000Z",
      currentPhaseIndex: 0,
      features: [],
      phases: [],
      completed: false,
    };
    state.launch = launch();

    expect(() =>
      validateResumeLaunch(state, launch(), "/plans/other.md"),
    ).toThrow(/wrong-plan\/wrong-repo/);
    expect(() =>
      validateResumeLaunch(state, launch("/other-repo"), "/plans/plan.md"),
    ).toThrow(/projectRoot/);
  });
});

describe("buildJudgePrompt (tournament judge prompt)", () => {
  function pass(): DualImplTestResult {
    return {
      worktreePath: "/tmp/wt",
      testExitCode: 0,
      testLogPath: "/tmp/wt/test.log",
      timedOut: false,
      failureCount: 0,
    };
  }

  function promptWith(
    overrides: Partial<
      Parameters<typeof buildJudgePrompt>[0]["candidates"]
    > = {},
  ) {
    return buildJudgePrompt({
      phase: basePhase,
      candidates: {
        primary: {
          label: "Primary",
          provider: "codex",
          model: "primary-model-under-test",
          diff: "PRIMARY_DIFF_MARKER",
          testResult: pass(),
          ...overrides.primary,
        },
        secondary: {
          label: "Secondary",
          provider: "claude",
          model: "secondary-model-under-test",
          diff: "SECONDARY_DIFF_MARKER",
          testResult: pass(),
          ...overrides.secondary,
        },
      },
    });
  }

  it("contains the WINNER format instructions", () => {
    const prompt = promptWith();
    expect(prompt).toContain("WINNER:");
    expect(prompt).toContain("WINNER: primary");
    expect(prompt).toContain("REASONING:");
  });

  it("contains primary and secondary sections with provider/model metadata and diffs", () => {
    const prompt = promptWith();
    expect(prompt).toMatch(
      /Primary implementor \(codex:primary-model-under-test\)[\s\S]*PRIMARY_DIFF_MARKER/,
    );
    expect(prompt).toMatch(
      /Secondary implementor \(claude:secondary-model-under-test\)[\s\S]*SECONDARY_DIFF_MARKER/,
    );
  });

  it("reflects test exit codes for each implementor", () => {
    const prompt = promptWith({
      primary: { testResult: { ...pass(), testExitCode: 0 } },
      secondary: {
        testResult: { ...pass(), testExitCode: 1, failureCount: 3 },
      },
    });
    expect(prompt).toMatch(/exit/i);
    expect(prompt.toLowerCase()).toMatch(/0/);
    expect(prompt.toLowerCase()).toMatch(/1/);
  });

  it("truncates diffs longer than 40000 chars with a [truncated] marker", () => {
    const hugeDiff = "x".repeat(40001);
    const prompt = promptWith({
      primary: { diff: hugeDiff },
      secondary: { diff: "short" },
    });
    expect(prompt).toContain("[...truncated");
    expect(prompt).toContain("x".repeat(40000));
    expect(prompt).not.toContain("x".repeat(40001));
  });

  it("fmtFixIter: undefined omits fix iteration text from prompt", () => {
    const prompt = promptWith();
    expect(prompt).not.toContain("Fix iterations:");
    expect(prompt).not.toContain("Fix loop:");
  });

  it("fmtFixIter: null emits fix loop not run message", () => {
    const prompt = promptWith({
      primary: { fixIterations: null },
      secondary: { fixIterations: null },
    });
    expect(prompt).toContain("Fix loop: not run");
  });

  it("fmtFixIter: 0 emits passed on first try", () => {
    const prompt = promptWith({
      primary: { fixIterations: 0 },
      secondary: { fixIterations: 0 },
    });
    expect(prompt).toContain("passed on first try");
  });

  it("fmtFixIter: N>0 emits required N fix passes", () => {
    const prompt = promptWith({
      primary: { fixIterations: 3 },
      secondary: { fixIterations: 1 },
    });
    expect(prompt).toContain("required 3 fix passes");
    expect(prompt).toContain("required 1 fix pass");
  });

  it("injects primary fix history section into prompt when provided", () => {
    const history = "--- Fix iteration 1 ---\nTestFailed: expected x got y";
    const prompt = promptWith({
      primary: { fixIterations: 1, fixHistory: history },
    });
    expect(prompt).toContain("Primary fix history");
    expect(prompt).toContain("TestFailed");
  });

  it("injects secondary fix history section into prompt when provided", () => {
    const history = "--- Fix iteration 1 ---\nAssertionError: expected 0 got 1";
    const prompt = promptWith({
      secondary: { fixIterations: 1, fixHistory: history },
    });
    expect(prompt).toContain("Secondary fix history");
    expect(prompt).toContain("AssertionError");
  });

  it("omits fix history section heading when fix history is absent", () => {
    const prompt = promptWith();
    expect(prompt).not.toContain("## Primary fix history");
    expect(prompt).not.toContain("## Secondary fix history");
  });

  it("includes HARDENING format instruction in verdict section", () => {
    const prompt = promptWith();
    expect(prompt).toContain("HARDENING:");
  });
});

describe("phaseGateProjection", () => {
  it("returns empty for pending status", () => {
    expect(phaseGateProjection("pending")).toEqual({});
  });

  it("returns empty for test_spec_running", () => {
    expect(phaseGateProjection("test_spec_running")).toEqual({});
  });

  it("marks test_spec done after test_spec_done", () => {
    const p = phaseGateProjection("test_spec_done");
    expect(p.test_spec).toBe(true);
    expect(p.verify_red).toBeUndefined();
  });

  it("marks test_spec and verify_red done after tests_red", () => {
    const p = phaseGateProjection("tests_red");
    expect(p.test_spec).toBe(true);
    expect(p.verify_red).toBe(true);
    expect(p.implementation).toBeUndefined();
  });

  it("marks impl gates done for gemini_running and dual phases", () => {
    for (const s of [
      "gemini_running",
      "dual_impl_running",
      "dual_impl_done",
      "dual_tests_running",
      "dual_judge_pending",
      "dual_judge_running",
      "dual_winner_pending",
    ] as const) {
      const p = phaseGateProjection(s);
      expect(p.test_spec).toBe(true);
      expect(p.verify_red).toBe(true);
      expect(p.implementation).toBeUndefined();
    }
  });

  it("marks implementation done for impl_done and test_fix_running", () => {
    for (const s of ["impl_done", "test_fix_running"] as const) {
      const p = phaseGateProjection(s);
      expect(p.implementation).toBe(true);
      expect(p.green_tests).toBeUndefined();
    }
  });

  it("marks green_tests done for tests_green", () => {
    const p = phaseGateProjection("tests_green");
    expect(p.green_tests).toBe(true);
    expect(p.review_qa).toBeUndefined();
  });

  it("marks all gates done for committed", () => {
    const p = phaseGateProjection("committed");
    expect(p.test_spec).toBe(true);
    expect(p.verify_red).toBe(true);
    expect(p.implementation).toBe(true);
    expect(p.green_tests).toBe(true);
    expect(p.review_qa).toBe(true);
  });

  it("marks all gates done for codex_running and review_clean", () => {
    for (const s of ["codex_running", "review_clean"] as const) {
      const p = phaseGateProjection(s);
      expect(p.review_qa).toBe(true);
    }
  });

  it("returns undefined for failed (Bug 1: no-opinion semantics)", () => {
    // Bug 1 fix: `failed` now means "I have no opinion, leave the plan alone"
    // (returns undefined) rather than "no gates are done" (returned {}).
    // The reconciler in reconcilePhaseVisibleGates treats undefined as a
    // no-op, which is what stops the reconciler from un-checking [x] when
    // a phase is in `failed` and the user is mid-recovery.
    expect(phaseGateProjection("failed")).toBeUndefined();
  });

  it("returns undefined for featureGateProjection('failed') too (Bug 1 mirror)", () => {
    // Bug 1 mirror: same fix applied to featureGateProjection so the
    // feature-level reconciler is consistent with the phase-level one.
    expect(featureGateProjection("failed")).toBeUndefined();
  });
});

describe("reconcileVisiblePlanState", () => {
  function makePhase(overrides: Partial<Phase> = {}): Phase {
    return {
      index: 0,
      number: "1",
      name: "Skeleton",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Auth",
      implementationDone: false,
      reviewDone: false,
      testSpecDone: false,
      body: "",
      implementationCheckboxLine: 3,
      reviewCheckboxLine: 4,
      testSpecCheckboxLine: 2,
      dualImpl: false,
      kind: "code",
      ...overrides,
    };
  }

  function makeFeature(overrides: Partial<Feature> = {}): Feature {
    return {
      index: 0,
      number: "1",
      name: "Auth",
      body: "",
      phaseIndexes: [0],
      ...overrides,
    };
  }

  function makeState(
    phaseStatus: PhaseState["status"],
    featureStatus: FeatureState["status"] = "running",
  ): BuildState {
    return {
      planFile: "plan.md",
      planBasename: "plan",
      slug: "test",
      branch: "main",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      completed: false,
      phases: [
        {
          index: 0,
          number: "1",
          name: "Skeleton",
          status: phaseStatus,
        },
      ],
      features: [
        {
          index: 0,
          number: "1",
          name: "Auth",
          phaseIndexes: [0],
          status: featureStatus,
        },
      ],
    };
  }

  it("flips verify_red and test_spec checkboxes when phase reaches tests_red", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification (Gemini)**",
        "- [ ] **Verify Red (runner)**",
        "- [ ] **Implementation (Gemini)**",
        "- [ ] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      testSpecCheckboxLine: 3,
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: false, line: 5 },
        review_qa: { done: false, line: 6 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("tests_red");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: false,
      dryRun: false,
    });

    const updated = fs.readFileSync(planFile, "utf8");
    const lines = updated.split("\n");
    expect(lines[2]).toMatch(/\[x\].*Test Specification/);
    expect(lines[3]).toMatch(/\[x\].*Verify Red/);
    expect(lines[4]).toMatch(/\[ \].*Implementation/);
    expect(lines[5]).toMatch(/\[ \].*Review/);
  });

  it("flips all phase gates to [x] for committed status", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Verify Red**",
        "- [ ] **Implementation**",
        "- [ ] **Green Tests**",
        "- [ ] **Review & QA**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: false, line: 5 },
        green_tests: { done: false, line: 6 },
        review_qa: { done: false, line: 7 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);

    const updated = fs.readFileSync(planFile, "utf8");
    for (const line of updated.split("\n").slice(2, 7)) {
      expect(line).toMatch(/\[x\]/);
    }
  });

  it("is idempotent — second call makes no additional changes", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Verify Red**",
        "- [ ] **Implementation**",
        "- [ ] **Review & QA**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: false, line: 5 },
        review_qa: { done: false, line: 6 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("impl_done");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);
    const afterFirst = fs.readFileSync(planFile, "utf8");
    // Sync the in-memory gate state from what was written.
    phase.gates!.test_spec!.done = true;
    phase.gates!.verify_red!.done = true;
    phase.gates!.implementation!.done = true;
    reconcileVisiblePlanState(planFile, [feature], [phase], state);
    const afterSecond = fs.readFileSync(planFile, "utf8");

    expect(afterFirst).toBe(afterSecond);
  });

  it("skips phases with no gates object", () => {
    const planFile = _testWritePlan(
      "## Feature 1: Auth\n### Phase 1: Skeleton\n",
    );
    const phase = makePhase({ gates: undefined });
    const feature = makeFeature({ gates: {} });
    const state = makeState("committed");

    // Should not throw — phases without gates are silently skipped.
    expect(() =>
      reconcileVisiblePlanState(planFile, [feature], [phase], state),
    ).not.toThrow();
  });

  it("skips reconcile when dryRun is true", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Implementation**",
      ].join("\n") + "\n";
    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        implementation: { done: false, line: 4 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      dryRun: true,
    });

    // Plan must not be modified in dry-run mode.
    const content = fs.readFileSync(planFile, "utf8");
    expect(content).not.toContain("[x]");
  });

  it("flips feature-level gates via featureGateProjection when feature reaches shipping", () => {
    // Feature gates (feature_review, ship_land, origin_verification) appear in the
    // feature body between the heading and the first phase heading.
    const plan =
      [
        "## Feature 1: Auth",
        "- [ ] **Feature Review (Gemini)**",
        "- [ ] **Ship & Land**",
        "- [ ] **Origin Verification**",
        "### Phase 1: Skeleton",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: true,
      reviewDone: true,
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: false, line: 2 },
        ship_land: { done: false, line: 3 },
        origin_verification: { done: false, line: 4 },
      },
    });
    // "shipping" status → featureGateProjection returns { feature_review: true }
    const state = makeState("committed", "shipping");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: false,
    });

    const lines = fs.readFileSync(planFile, "utf8").split("\n");
    expect(lines[1]).toMatch(/\[x\].*Feature Review/);
    expect(lines[2]).toMatch(/\[ \].*Ship & Land/);
    expect(lines[3]).toMatch(/\[ \].*Origin Verification/);
  });

  it("flips all three feature gates when feature reaches committed without skipShip", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "- [ ] **Feature Review (Gemini)**",
        "- [ ] **Ship & Land**",
        "- [ ] **Origin Verification**",
        "### Phase 1: Skeleton",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: true,
      reviewDone: true,
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: false, line: 2 },
        ship_land: { done: false, line: 3 },
        origin_verification: { done: false, line: 4 },
      },
    });
    // "committed" status → featureGateProjection returns all three gates
    const state = makeState("committed", "committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: false,
    });

    const lines = fs.readFileSync(planFile, "utf8").split("\n");
    expect(lines[1]).toMatch(/\[x\].*Feature Review/);
    expect(lines[2]).toMatch(/\[x\].*Ship & Land/);
    expect(lines[3]).toMatch(/\[x\].*Origin Verification/);
  });

  it("suppresses ship_land and origin_verification when skipShip=true", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "- [ ] **Feature Review (Gemini)**",
        "- [ ] **Ship & Land**",
        "- [ ] **Origin Verification**",
        "### Phase 1: Skeleton",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: true,
      reviewDone: true,
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: false, line: 2 },
        ship_land: { done: false, line: 3 },
        origin_verification: { done: false, line: 4 },
      },
    });
    // skipShip=true + origin_verified → only feature_review checked
    // (committed always shows all gates; origin_verified respects skipShip)
    const state = makeState("committed", "origin_verified");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: true,
    });

    const lines = fs.readFileSync(planFile, "utf8").split("\n");
    expect(lines[1]).toMatch(/\[x\].*Feature Review/);
    expect(lines[2]).toMatch(/\[ \].*Ship & Land/);
    expect(lines[3]).toMatch(/\[ \].*Origin Verification/);
  });

  it("does not throw when state.features is missing", () => {
    const planFile = _testWritePlan(
      "## Feature 1: Auth\n### Phase 1: Skeleton\n",
    );
    const phase = makePhase({ gates: undefined });
    const feature = makeFeature({
      gates: { feature_review: { done: false, line: 1 } },
    });
    // Build state without a features array — the null-safety guard
    // `(state.features ?? [])[feature.index]` must not throw.
    const stateNoFeatures: BuildState = {
      ...makeState("pending", "pending"),
      features: undefined as any,
    };

    expect(() =>
      reconcileVisiblePlanState(planFile, [feature], [phase], stateNoFeatures),
    ).not.toThrow();
  });

  // Regression tests for the recovery-scenario bug (plan
  // ~/.claude/plans/this-issue-smooth-coral.md Bugs 1 + 2). REGRESSION RULE
  // applies — these are mandatory.

  it("Bug 1+2: reconciler does NOT un-check [x] when phase is failed", () => {
    // The recovery-scenario bug: user manually edited [x] on a phase whose
    // runtime status is `failed`; the reconciler then flipped them back to
    // [ ] on every saveState tick. After Bug 1 fix (projection returns
    // undefined) + Bug 2 fix (reconciler early-returns on undefined), the
    // plan content stays bit-identical to its pre-call content.
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [x] **Test Specification (COMPLETE)**",
        "- [x] **Verify Red (COMPLETE)**",
        "- [x] **Implementation (COMPLETE)**",
        "- [x] **Review & QA (COMPLETE)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const before = fs.readFileSync(planFile, "utf8");
    const phase = makePhase({
      gates: {
        test_spec: { done: true, line: 3 },
        verify_red: { done: true, line: 4 },
        implementation: { done: true, line: 5 },
        review_qa: { done: true, line: 6 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("failed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);

    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toBe(before);
  });

  it("Bug 2 mirror: feature reconciler does NOT un-check [x] when feature is failed", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "- [x] **Feature Review (COMPLETE)**",
        "- [x] **Ship/Land (COMPLETE)**",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const before = fs.readFileSync(planFile, "utf8");
    const phase = makePhase({
      testSpecCheckboxLine: 5,
      gates: {},
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: true, line: 2 },
        ship_land: { done: true, line: 3 },
      },
    });
    const state = makeState("pending", "failed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);

    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toBe(before);
  });

  it("Bug 2 defense: reconciler never un-checks even when projection wants false", () => {
    // The blanket "never un-check" defense kicks in for any non-failed
    // status whose projection legitimately returns false for some gate.
    // We construct a tests_red phase whose plan shows [x] on the
    // implementation gate — the projection wants implementation=false
    // (tests_red hasn't passed yet), but the reconciler must NOT un-check
    // the [x] the user manually placed.
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Verify Red**",
        "- [x] **Implementation (manually marked)**",
        "- [ ] **Review & QA**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: true, line: 5 },
        review_qa: { done: false, line: 6 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("tests_red");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);

    const after = fs.readFileSync(planFile, "utf8").split("\n");
    // test_spec + verify_red should flip up (projection wants them true).
    expect(after[2]).toMatch(/\[x\].*Test Specification/);
    expect(after[3]).toMatch(/\[x\].*Verify Red/);
    // implementation MUST stay [x] (defense-in-depth never-un-check).
    expect(after[4]).toMatch(/\[x\].*Implementation/);
    expect(after[5]).toMatch(/\[ \].*Review/);
  });
});

describe("--mark-phase-committed feature-relative notation (Bug 3)", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("resolves '<feat>.<phase>' against per-feature-numbered plans", () => {
    // Mitosis plan style: phase.number is just the within-feature stem,
    // featureNumber is separate. The old lookup phases.find(p =>
    // p.number === input) errored "phase not found: 2.1" because no phase
    // has number = "2.1". After Bug 3 fix, the input is split as
    // <feat>="2", <phase>="1" and matched via featureNumber+number.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-bug3-relnum-"));
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "## Feature 2: Backend",
        "### Phase 1: Schema",
        "- [ ] **Test Specification (Codex)**: tests",
        "- [ ] **Implementation (Codex)**: impl",
        "- [ ] **Review (Codex)**: review",
        "",
      ].join("\n"),
    );

    const feature: Feature = {
      index: 0,
      number: "2",
      name: "Backend",
      body: "",
      phaseIndexes: [0],
    };
    const phase: Phase = {
      index: 0,
      number: "1",
      name: "Schema",
      featureIndex: 0,
      featureNumber: "2",
      featureName: "Backend",
      implementationDone: false,
      reviewDone: false,
      testSpecDone: false,
      body: "",
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      testSpecCheckboxLine: 5,
      dualImpl: false,
      kind: "code",
    };

    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "test",
      branch: "main",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      completed: false,
      phases: [
        {
          index: 0,
          number: "1",
          name: "Schema",
          status: "failed",
          error: "old hygiene failure",
        },
      ],
      features: [feature as any],
      failedAtPhase: 0,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases: [phase],
      phaseNumber: "2.1", // feature-relative form — the previously-broken case
      planFile,
    });

    expect(result).toEqual({ ok: true, phaseIndex: 0 });
    expect(state.phases[0].status).toBe("committed");
    expect(state.phases[0].error).toBeUndefined();
    expect(state.failedAtPhase).toBeUndefined();
  });
});

describe("--mark-phase-committed --dry-run is actually dry (Bug 4)", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("dry-run does NOT mutate state.phases, state.failedAtPhase, or the plan file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-bug4-dryrun-"));
    const planFile = path.join(tmpDir, "plan.md");
    const planContent = [
      "# Plan",
      "",
      "### Phase 1.1: First",
      "- [ ] **Test Specification (Codex Sub-agent)**: tests",
      "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
      "- [ ] **Review (Codex Sub-agent)**: Review.",
      "",
    ].join("\n");
    fs.writeFileSync(planFile, planContent);
    const planMtimeBefore = fs.statSync(planFile).mtimeMs;

    const feature: Feature = {
      index: 0,
      number: "1",
      name: "F1",
      body: "",
      phaseIndexes: [0],
    };
    const phase: Phase = {
      index: 0,
      number: "1.1",
      name: "First",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "F1",
      implementationDone: false,
      reviewDone: false,
      testSpecDone: false,
      body: "",
      implementationCheckboxLine: 5,
      reviewCheckboxLine: 6,
      testSpecCheckboxLine: 4,
      dualImpl: false,
      kind: "code",
    };

    const stateBefore = {
      planFile,
      planBasename: "plan",
      slug: "test",
      branch: "main",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      completed: false,
      phases: [
        {
          index: 0,
          number: "1.1",
          name: "First",
          status: "failed" as const,
          error: "old hygiene failure",
        },
      ],
      features: [feature as any],
      failedAtPhase: 0,
      failureReason: "old hygiene failure",
    };
    const stateSnapshot = JSON.parse(JSON.stringify(stateBefore));

    const result = markPhaseCommittedAfterManualRecovery({
      state: stateBefore as any as BuildState,
      phases: [phase],
      phaseNumber: "1.1",
      planFile,
      dryRun: true,
    });

    expect(result).toEqual({ ok: true, phaseIndex: 0 });

    // State must NOT be mutated.
    expect(stateBefore).toEqual(stateSnapshot);
    expect(stateBefore.phases[0].status).toBe("failed");
    expect(stateBefore.phases[0].error).toBe("old hygiene failure");
    expect(stateBefore.failedAtPhase).toBe(0);

    // Plan file must NOT be touched.
    const planMtimeAfter = fs.statSync(planFile).mtimeMs;
    expect(planMtimeAfter).toBe(planMtimeBefore);
    expect(fs.readFileSync(planFile, "utf8")).toBe(planContent);
  });
});

describe("runRoleTask backup fallback", () => {
  it("falls back from a failing kimi primary to a gemini backup", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-role-backup-"));
    const slug = `cli-role-backup-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(fakeKimi, `#!/bin/sh\nexit 1\n`);
      fs.chmodSync(fakeKimi, 0o755);

      // runGemini uses staged I/O: the prompt says "...write your output summary
      // ...to <stagedOutput>." The cleanup step copies stagedOutput → outputFilePath.
      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/to (\\/.+?\\.md)\\./);
if (!match) { console.error("missing staged output path in prompt"); process.exit(2); }
fs.writeFileSync(match[1], "cli backup ok");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);

      process.env.KIMI_BIN = fakeKimi;
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "impl context");
      fs.writeFileSync(outputFilePath, "stale-primary-output");

      const result = await runRoleTask({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        phaseNumber: "1",
        iteration: 1,
        logPrefix: "cli-primary-impl",
        role: {
          provider: "kimi",
          model: "kimi-model-under-test",
          reasoning: "high",
          backupProvider: "gemini",
          backupModel: "gemini-3.1-pro-preview",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("cli backup ok");
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
});

// ---------------------------------------------------------------------------
// Phase 1.4: buildKindInstructions tests
// ---------------------------------------------------------------------------

describe("buildKindInstructions", () => {
  const makePhaseWithKind = (kind: Phase["kind"]): Phase => ({
    ...basePhase,
    kind,
  });

  const joinInstructions = (instructions: string[]): string =>
    instructions.join("\n");

  // Shared requirements — all kinds
  it("all kinds: contains 'Commit'", () => {
    for (const kind of [
      "code",
      "writing",
      "experiment",
      "research",
      "manual",
    ] as const) {
      const result = joinInstructions(
        buildKindInstructions(makePhaseWithKind(kind)),
      );
      expect(result).toContain("Commit");
    }
  });

  it("all kinds: contains 'Do NOT run /review'", () => {
    for (const kind of [
      "code",
      "writing",
      "experiment",
      "research",
      "manual",
    ] as const) {
      const result = joinInstructions(
        buildKindInstructions(makePhaseWithKind(kind)),
      );
      expect(result).toContain("Do NOT run /review");
    }
  });

  it("all kinds: contains 'Do NOT update the plan file'", () => {
    for (const kind of [
      "code",
      "writing",
      "experiment",
      "research",
      "manual",
    ] as const) {
      const result = joinInstructions(
        buildKindInstructions(makePhaseWithKind(kind)),
      );
      expect(result).toContain("Do NOT update the plan file");
    }
  });

  // code phase
  it("code phase: contains 'Make all failing tests pass'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("code")),
    );
    expect(result).toContain("Make all failing tests pass");
  });

  it("code phase: contains 'Fail forward'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("code")),
    );
    expect(result).toContain("Fail forward");
  });

  // writing phase
  it("writing phase: contains 'Quality bar: a reader'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("writing")),
    );
    expect(result).toContain("Quality bar: a reader");
  });

  it("writing phase: does NOT contain 'write failing tests'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("writing")),
    );
    expect(result).not.toContain("write failing tests");
    expect(result).not.toContain("Make all failing tests pass");
  });

  // experiment phase
  it("experiment phase: contains 'Commit raw results'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("experiment")),
    );
    expect(result).toContain("Commit raw results");
  });

  // research phase
  it("research phase: contains 'Cite primary sources'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("research")),
    );
    expect(result).toContain("Cite primary sources");
  });

  // manual phase
  it("manual phase: contains 'human action'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("manual")),
    );
    expect(result).toContain("human action");
  });

  it("manual phase: contains 'Do NOT attempt to automate'", () => {
    const result = joinInstructions(
      buildKindInstructions(makePhaseWithKind("manual")),
    );
    expect(result).toContain("Do NOT attempt to automate");
  });

  it("returns an array of strings (one per instruction line)", () => {
    for (const kind of [
      "code",
      "writing",
      "experiment",
      "research",
      "manual",
    ] as const) {
      const result = buildKindInstructions(makePhaseWithKind(kind));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(6);
      for (const line of result) {
        expect(typeof line).toBe("string");
      }
    }
  });
});

describe("findOpenPRForBranch", () => {
  let tmpBin: string;
  let ghBin: string;
});

// ---------------------------------------------------------------------------
// ship failure paths: state.failureReason is set at all 4 paused locations
// ---------------------------------------------------------------------------

describe("ship failure sets state.failureReason at paused paths", () => {
  function git(args: string[], cwd: string): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }

  function initRepo(): string {
    const dir = path.join(tmpDir!, "repo");
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "t@t.com"], dir);
    git(["config", "user.name", "T"], dir);
    fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
  }

  function initRepoWithOrigin(): string {
    const repo = path.join(tmpDir!, "repo");
    const bare = path.join(tmpDir!, "origin.git");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(bare, { recursive: true });
    git(["init", "--bare", "-b", "main"], bare);
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.com"], repo);
    git(["config", "user.name", "T"], repo);
    git(["remote", "add", "origin", bare], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
    git(["push", "-u", "origin", "main"], repo);
    git(["fetch", "origin"], repo);
    return repo;
  }

  function committedPlanFile(): string {
    const p = path.join(tmpDir!, "plan.md");
    fs.writeFileSync(
      p,
      [
        "## Feature 1: Test Ship",
        "",
        "### Phase 1: Phase 1",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
        "",
      ].join("\n"),
    );
    return p;
  }

  function seedShipState(
    repoPath: string,
    planFile: string,
    runId: string,
  ): void {
    const stateSlug = `build-${runId}`;
    const registryDir = path.join(tmpDir!, "registry");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(path.join(tmpStateDir!, stateSlug), { recursive: true });
    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify({
        planFile,
        planBasename: "plan",
        slug: stateSlug,
        branch: "main",
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        launch: {
          argv: [planFile],
          projectRoot: repoPath,
          runId,
          stateSlug,
          activeRunRegistry: registryDir,
          dryRun: false,
          skipShip: false,
          skipFeatureReview: true,
          launchedAt: new Date().toISOString(),
        },
        currentPhaseIndex: 0,
        currentFeatureIndex: 0,
        features: [
          {
            index: 0,
            number: "1",
            name: "Test Ship",
            phaseIndexes: [0],
            status: "phases_done",
            branch: "main",
          },
        ],
        phases: [
          { index: 0, number: "1", name: "Phase 1", status: "committed" },
        ],
        completed: false,
      }),
    );
  }

  function runShipCli(
    planFile: string,
    repoPath: string,
    runId: string,
    extraEnv: Record<string, string> = {},
  ) {
    const registryDir = path.join(tmpDir!, "registry");
    return spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        planFile,
        "--project-root",
        repoPath,
        "--run-id",
        runId,
        "--active-run-registry",
        registryDir,
        "--release-mode",
        "queued",
        "--skip-feature-review",
        "--skip-pre-merge-verify",
        "--no-plan-review",
        "--skip-clean-check",
        "--no-gbrain",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          GSTACK_BUILD_STATE_DIR: tmpStateDir!,
          ...extraEnv,
        },
        timeout: 30_000,
      },
    );
  }

  function loadSavedState(runId: string): BuildState {
    const stateSlug = `build-${runId}`;
    return JSON.parse(
      fs.readFileSync(path.join(tmpStateDir!, `${stateSlug}.json`), "utf8"),
    ) as BuildState;
  }

  it("Location A: base sync conflict → state.failureReason contains Feature + base sync", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-ship-loc-a-"));
    const runId = `ship-loc-a-${process.pid}`;
    const repo = initRepo(); // no remote — git fetch origin fails
    const planFile = committedPlanFile();
    seedShipState(repo, planFile, runId);

    const result = runShipCli(planFile, repo, runId);

    expect(result.status).toBe(1);
    const state = loadSavedState(runId);
    expect(state.failureReason).toMatch(/Feature 1: base sync/);
  }, 30_000);

  it("Location B: ship non-zero exit → state.failureReason contains Feature + ship failed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-ship-loc-b-"));
    const runId = `ship-loc-b-${process.pid}`;
    const repo = initRepoWithOrigin();
    const planFile = committedPlanFile();
    seedShipState(repo, planFile, runId);

    const fakeKimi = path.join(tmpDir!, "kimi");
    const fakeGemini = path.join(tmpDir!, "gemini");
    fs.writeFileSync(fakeKimi, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(fakeKimi, 0o755);
    fs.writeFileSync(fakeGemini, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(fakeGemini, 0o755);

    const result = runShipCli(planFile, repo, runId, {
      KIMI_BIN: fakeKimi,
      GEMINI_BIN: fakeGemini,
    });

    expect(result.status).toBe(1);
    const state = loadSavedState(runId);
    expect(state.failureReason).toMatch(/Feature 1: ship failed/);
  }, 30_000);

  it("Location C: unparseable PR + no open PR on remote → state.failureReason names the branch", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-ship-loc-c-"));
    const runId = `ship-loc-c-${process.pid}`;
    const repo = initRepoWithOrigin();
    const planFile = committedPlanFile();
    seedShipState(repo, planFile, runId);

    // exits 0 without writing to staged output → mergeOutputFile returns empty stdout
    const fakeKimi = path.join(tmpDir!, "kimi");
    fs.writeFileSync(fakeKimi, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeKimi, 0o755);

    // fake gh that always fails: parser-fallback path is also a dead end,
    // so resolveShipPr returns the "no open PR exists on remote" error.
    const fakeGhDir = path.join(tmpDir!, "fake-gh");
    fs.mkdirSync(fakeGhDir, { recursive: true });
    fs.writeFileSync(path.join(fakeGhDir, "gh"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(fakeGhDir, "gh"), 0o755);

    const result = runShipCli(planFile, repo, runId, {
      KIMI_BIN: fakeKimi,
      PATH: `${fakeGhDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    const state = loadSavedState(runId);
    expect(state.failureReason).toMatch(/no open PR exists on remote/);
  }, 30_000);

  it("Location D: markPrQueued failure → state.failureReason contains could not be marked queued", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-ship-loc-d-"));
    const runId = `ship-loc-d-${process.pid}`;
    const repo = initRepoWithOrigin();
    const planFile = committedPlanFile();
    seedShipState(repo, planFile, runId);

    // writes "PR #123" to the staged output path extracted from the -p prompt
    const fakeKimi = path.join(tmpDir!, "kimi");
    fs.writeFileSync(
      fakeKimi,
      `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const m = prompt.match(/Write your complete output to (.+?)\\. Return ONLY/);
if (m) fs.writeFileSync(m[1], "PR #123\\nship complete\\n");
process.exit(0);
`,
    );
    fs.chmodSync(fakeKimi, 0o755);

    // fake gh that always fails — markPrQueued calls "gh pr edit"
    const fakeGhDir = path.join(tmpDir!, "fake-gh");
    fs.mkdirSync(fakeGhDir, { recursive: true });
    fs.writeFileSync(path.join(fakeGhDir, "gh"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(fakeGhDir, "gh"), 0o755);

    const result = runShipCli(planFile, repo, runId, {
      KIMI_BIN: fakeKimi,
      PATH: `${fakeGhDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    const state = loadSavedState(runId);
    expect(state.failureReason).toMatch(/could not be marked queued/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// monitor regression: RUN_FAILED vs RUN_RESUMED based on failureReason
// ---------------------------------------------------------------------------

describe("monitor emits RUN_FAILED when failureReason set (regression)", () => {
  function buildMonitorFixture(runId: string, failureReason?: string) {
    const stateSlug = `build-${runId}`;
    const worktreePath = path.join(tmpDir!, "worktree");
    const repoPath = worktreePath;
    const livingPlanPath = path.join(tmpDir!, "plan.md");
    const manifestPath = path.join(tmpDir!, "manifest.json");
    const registryDir = path.join(tmpDir!, "registry");
    const pidFile = path.join(tmpDir!, "pid"); // does not exist → dead process
    const stdoutLog = path.join(tmpDir!, "stdout.log");

    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(path.join(tmpStateDir!, stateSlug), { recursive: true });
    // context-save count matches committed phase count so HOST_CONTEXT_SAVE_REQUIRED doesn't fire
    fs.writeFileSync(
      path.join(tmpStateDir!, stateSlug, ".host-context-save-count"),
      "1\n",
    );

    const staleTs = new Date(Date.now() - 5_000).toISOString();
    const stateData: Record<string, unknown> = {
      planFile: livingPlanPath,
      planBasename: "plan",
      slug: stateSlug,
      branch: "main",
      startedAt: staleTs,
      lastUpdatedAt: staleTs,
      launch: {
        argv: [livingPlanPath],
        projectRoot: worktreePath,
        baseProjectRoot: repoPath,
        runId,
        stateSlug,
        activeRunRegistry: registryDir,
        dryRun: false,
        skipShip: false,
        skipFeatureReview: true,
        launchedAt: staleTs,
      },
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [
        {
          index: 0,
          number: "1",
          name: "Test",
          phaseIndexes: [0],
          status: "paused",
          branch: "main",
          error:
            "ship reported success but no open PR exists on remote for branch main",
        },
      ],
      phases: [{ index: 0, number: "1", name: "Phase 1", status: "committed" }],
      completed: false,
    };
    if (failureReason !== undefined) stateData.failureReason = failureReason;

    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify(stateData),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir: tmpDir!,
        runs: [
          {
            runId,
            repoPath,
            repoSlug: "repo",
            livingPlanPath,
            worktreePath,
            stateSlug,
            branchPrefix: `repo-${runId}`,
            pidFile,
            stdoutLog,
            launchCommand: [
              "/bin/sh",
              "-c",
              "echo resume",
              "--active-run-registry",
              registryDir,
            ],
            launchEnv: {},
          },
        ],
      }),
    );
    return manifestPath;
  }

  it("pre-fix: dead process + paused + no failureReason → RUN_RESUMED (documents old bug)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-t5-"));
    const runId = `monitor-t5-${process.pid}`;
    const manifestPath = buildMonitorFixture(
      runId,
      /* no failureReason */ undefined,
    );

    const result = evaluateMonitorOnce({
      manifestPath,
      pollMs: 1,
      now: new Date(),
      spawnResume: false,
    });

    // This assertion documents the pre-fix bug. When the TODOS.md
    // "dead process + paused state = terminal" invariant is moved to
    // readRunSnapshot in monitor.ts, this expectation must flip to RUN_FAILED.
    expect(result.terminalEvent?.event).toBe("RUN_RESUMED");
  });

  it("post-fix: dead process + paused + failureReason set → RUN_FAILED", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-t6-"));
    const runId = `monitor-t6-${process.pid}`;
    const reason =
      "Feature 1: ship reported success but no open PR exists on remote for branch main; see /tmp/ship.log";
    const manifestPath = buildMonitorFixture(runId, reason);

    const result = evaluateMonitorOnce({
      manifestPath,
      pollMs: 1,
      now: new Date(),
      spawnResume: false,
    });

    expect(result.terminalEvent?.event).toBe("RUN_FAILED");
  });
});

// ---------------------------------------------------------------------------
// monitor regression: stale failedAtPhase after manual recovery must NOT
// re-emit RUN_FAILED while the run is alive and progressing past it.
// Spec: docs/orchestrator-state-machine.md §1.3 says `failed` is recoverable,
// not terminal. Inv A pairs failedAtPhase with phases[N].status === "failed".
// ---------------------------------------------------------------------------

describe("monitor does NOT emit RUN_FAILED on stale failedAtPhase (Bug 7)", () => {
  function buildRecoveredRunFixture(runId: string) {
    const stateSlug = `build-${runId}`;
    const worktreePath = path.join(tmpDir!, "worktree");
    const repoPath = worktreePath;
    const livingPlanPath = path.join(tmpDir!, "plan.md");
    const manifestPath = path.join(tmpDir!, "manifest.json");
    const registryDir = path.join(tmpDir!, "registry");
    const pidFile = path.join(tmpDir!, "pid");
    const stdoutLog = path.join(tmpDir!, "stdout.log");

    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(path.join(tmpStateDir!, stateSlug), { recursive: true });
    // committedPhaseCount(state) will be 2 (phases[0] and phases[1]).
    // Match so the HOST_CONTEXT_SAVE_REQUIRED short-circuit doesn't fire
    // before the snapshot.failed check we're actually testing.
    fs.writeFileSync(
      path.join(tmpStateDir!, stateSlug, ".host-context-save-count"),
      "2\n",
    );

    // Live process: use the test runner's own PID. isPidAlive(process.pid) is true.
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    // Recent stdout activity so the monitor doesn't treat the run as stale.
    fs.writeFileSync(stdoutLog, "phase 2 running\n");

    const freshTs = new Date().toISOString();
    const stateData: Record<string, unknown> = {
      planFile: livingPlanPath,
      planBasename: "plan",
      slug: stateSlug,
      branch: "main",
      startedAt: freshTs,
      lastUpdatedAt: freshTs,
      launch: {
        argv: [livingPlanPath],
        projectRoot: worktreePath,
        baseProjectRoot: repoPath,
        runId,
        stateSlug,
        activeRunRegistry: registryDir,
        dryRun: false,
        skipShip: false,
        skipFeatureReview: true,
        launchedAt: freshTs,
      },
      // Recovery happened: currentPhaseIndex advanced past the failed phase.
      currentPhaseIndex: 2,
      currentFeatureIndex: 0,
      features: [
        {
          index: 0,
          number: "1",
          name: "Test",
          phaseIndexes: [0, 1, 2],
          status: "running",
          branch: "main",
        },
      ],
      // Phase 1 is committed (recovered via --mark-phase-committed or manual
      // edit). Per Inv A, this means failedAtPhase=1 is now stale metadata.
      phases: [
        { index: 0, number: "1", name: "Phase 1", status: "committed" },
        {
          index: 1,
          number: "2",
          name: "Phase 2",
          status: "committed",
          committedAt: freshTs,
        },
        { index: 2, number: "3", name: "Phase 3", status: "tests_red" },
      ],
      completed: false,
      // Stale recovery metadata that the buggy predicate trips on.
      failedAtPhase: 1,
      failureReason:
        "phase 2 failed earlier; recovered by --mark-phase-committed",
    };

    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify(stateData),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir: tmpDir!,
        runs: [
          {
            runId,
            repoPath,
            repoSlug: "repo",
            livingPlanPath,
            worktreePath,
            stateSlug,
            branchPrefix: `repo-${runId}`,
            pidFile,
            stdoutLog,
            launchCommand: [
              "/bin/sh",
              "-c",
              "echo resume",
              "--active-run-registry",
              registryDir,
            ],
            launchEnv: {},
          },
        ],
      }),
    );

    // Active-run registry entry so registryRunInfo reports the run as live.
    // Must match ActiveRunRecord shape: readActiveRunRecords drops records
    // missing runId, stateSlug, or branches (array). normalizeRepoIdentity
    // is invoked on baseProjectRoot/repoPath, so both must resolve to
    // run.repoPath for identityOk to be true.
    fs.writeFileSync(
      path.join(registryDir, `${runId}.json`),
      JSON.stringify({
        runId,
        stateSlug,
        repoPath,
        worktreePath,
        baseProjectRoot: repoPath,
        planFile: livingPlanPath,
        branchPrefix: `repo-${runId}`,
        pid: process.pid,
        status: "running",
        startedAt: freshTs,
        lastUpdatedAt: freshTs,
        branches: ["main"],
      }),
    );

    return manifestPath;
  }

  it("Bug 7: alive process + currentPhaseIndex past stale failedAtPhase → NOT RUN_FAILED", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-bug7-"));
    const runId = `monitor-bug7-${process.pid}`;
    const manifestPath = buildRecoveredRunFixture(runId);

    const result = evaluateMonitorOnce({
      manifestPath,
      pollMs: 1,
      now: new Date(),
      spawnResume: false,
    });

    // The run is alive (live PID), progressing past the failed phase
    // (currentPhaseIndex=2, phases[1].status=committed). failedAtPhase=1 is
    // stale recovery metadata. Per spec, this is NOT a terminal failure;
    // the monitor must not emit RUN_FAILED.
    expect(result.terminalEvent?.event).not.toBe("RUN_FAILED");
  });
});

describe("buildKindInstructions — non-code phase prompts", () => {
  function makePhase(kind: Phase["kind"]): Phase {
    return {
      ...basePhase,
      kind,
      testSpecDone: true,
      testSpecCheckboxLine: -1,
    };
  }

  it("writing phase: prompt contains quality bar and no test instructions", () => {
    const lines = buildKindInstructions(makePhase("writing"));
    const joined = lines.join("\n");
    expect(joined).toContain("Quality bar: a reader with domain expertise");
    expect(joined).not.toContain("write failing tests");
    expect(joined).not.toContain("Make all failing tests pass");
  });

  it("experiment phase: prompt contains raw results and no test instructions", () => {
    const lines = buildKindInstructions(makePhase("experiment"));
    const joined = lines.join("\n");
    expect(joined).toContain("Commit raw results");
    expect(joined).not.toContain("Make all failing tests pass");
    expect(joined).not.toContain("write failing tests");
  });

  it("research phase: prompt contains cite primary sources and no test instructions", () => {
    const lines = buildKindInstructions(makePhase("research"));
    const joined = lines.join("\n");
    expect(joined).toContain("Cite primary sources");
    expect(joined).not.toContain("Make all failing tests pass");
  });

  it("manual phase: prompt mentions human gate and no automation", () => {
    const lines = buildKindInstructions(makePhase("manual"));
    const joined = lines.join("\n");
    expect(joined).toContain("human action");
    expect(joined).toContain("Do NOT attempt to automate");
    expect(joined).not.toContain("Make all failing tests pass");
  });

  it("code phase: prompt contains standard TDD instructions", () => {
    const lines = buildKindInstructions(makePhase("code"));
    const joined = lines.join("\n");
    expect(joined).toContain("Make all failing tests pass");
    expect(joined).toContain("Fail forward");
  });

  it("all kinds include commit and boundary instructions", () => {
    for (const kind of [
      "code",
      "writing",
      "experiment",
      "research",
      "manual",
    ] as const) {
      const lines = buildKindInstructions(makePhase(kind));
      const joined = lines.join("\n");
      expect(joined).toContain("Commit");
      expect(joined).toContain("Do NOT run /review");
      expect(joined).toContain("Do NOT update the plan file");
    }
  });

  it("returns 'ship-and-deploy' when no open PR exists", () => {
    expect(chooseMergePath(null)).toBe("ship-and-deploy");
  });
});

describe("featureGateProjection with singleBranch", () => {
  it("suppresses ship_land and origin_verification for origin_verified when singleBranch", () => {
    const result = featureGateProjection("origin_verified", {
      singleBranch: true,
    });
    expect(result).toEqual({ feature_review: true });
  });

  it("shows all gates for committed regardless of singleBranch", () => {
    const result = featureGateProjection("committed", { singleBranch: true });
    expect(result).toEqual({
      feature_review: true,
      ship_land: true,
      origin_verification: true,
    });
  });
});

describe("ownedFeatureBranch", () => {
  function makeStateForBranch(
    overrides: { branchPrefix?: string; planBasename?: string } = {},
  ): BuildState {
    return {
      planFile: "plan.md",
      planBasename: overrides.planBasename ?? "my-plan",
      slug: "test",
      branch: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [],
      phases: [],
      completed: false,
      geminiModel: "gemini",
      codexModel: "codex",
      codexReviewModel: "codex-review",
      launch: overrides.branchPrefix
        ? {
            argv: ["plan.md"],
            projectRoot: "/repo",
            runId: "run-1",
            branchPrefix: overrides.branchPrefix,
            activeRunRegistry: "/tmp/ar",
            dryRun: false,
            skipShip: false,
            skipFeatureReview: false,
            launchedAt: "2026-01-01T00:00:00.000Z",
            stateSlug: "test",
          }
        : undefined,
    } as BuildState;
  }

  it("returns feat/<prefix>-<slug> by default (multi-branch)", () => {
    const state = makeStateForBranch({ planBasename: "my-plan" });
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    expect(ownedFeatureBranch(state, feature)).toBe("feat/my-plan-1-auth");
  });

  it("returns feat/<prefix> with no slug when singleBranch", () => {
    const state = makeStateForBranch({ planBasename: "my-plan" });
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    expect(ownedFeatureBranch(state, feature, { singleBranch: true })).toBe(
      "feat/my-plan",
    );
  });

  it("uses branchPrefix from state.launch when available", () => {
    const state = makeStateForBranch({ branchPrefix: "my-prefix" });
    const feature: FeatureState = {
      index: 0,
      number: "2",
      name: "Billing",
      phaseIndexes: [],
      status: "running",
    };
    expect(ownedFeatureBranch(state, feature, { singleBranch: true })).toBe(
      "feat/my-prefix",
    );
  });
});

// ---------------------------------------------------------------------------
// T8 — Bug 5: QA hygiene gate auto-commits test-only dirty trees
// ---------------------------------------------------------------------------

describe("maybeAutoCommitTestOnlyDirty (Bug 5)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-bug5-"));
    // Init a real git repo so the auto-commit's `git add -A` + `git commit`
    // can run end-to-end.
    spawnSync("git", ["init", "-q"], { cwd: repoDir });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: repoDir },
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  it("auto-commits when ALL dirty paths match test-path globs", () => {
    // Write a new test file under __tests__/ (matches default globs).
    fs.mkdirSync(path.join(repoDir, "server", "__tests__"), {
      recursive: true,
    });
    const testPath = "server/__tests__/foo.test.ts";
    fs.writeFileSync(path.join(repoDir, testPath), "// new coverage test\n");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = maybeAutoCommitTestOnlyDirty({
      cwd: repoDir,
      label: "qa gate",
      dirtyLines: [`?? ${testPath}`],
    });

    expect(result.committed).toBe(true);
    expect(result.reason).toMatch(/committed 1 test path/);
    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(headAfter).not.toBe(headBefore);
    const lastMsg = spawnSync("git", ["log", "-1", "--pretty=%B"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout;
    expect(lastMsg).toContain("chore(qa): expand coverage via qa gate");
    expect(lastMsg).toContain("(auto-committed)");
  });

  it("auto-splits mixed test+production diff into two commits (default behavior)", () => {
    // Failure 3 from the mitosis-oasis incident: a review/qa role
    // produced a mixed diff. Previously the gate refused entirely and
    // required manual --mark-phase-committed recovery. The auto-split
    // path puts test changes in one commit and production fixes in a
    // second, both attributed to gstack-build (qa auto-commit).
    fs.mkdirSync(path.join(repoDir, "server", "__tests__"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, "server", "__tests__", "bar.test.ts"),
      "// new coverage\n",
    );
    fs.writeFileSync(path.join(repoDir, "server", "routes.ts"), "// fix\n");

    const result = maybeAutoCommitTestOnlyDirty({
      cwd: repoDir,
      label: "Codex review",
      dirtyLines: ["?? server/__tests__/bar.test.ts", "?? server/routes.ts"],
    });

    expect(result.committed).toBe(true);
    expect(result.reason).toContain("auto-split");
    expect(result.reason).toContain("1 test path");
    expect(result.reason).toContain("1 production path");

    // Verify two commits landed with the right messages, in the right
    // order. The test-only commit should be FIRST (older), production
    // SECOND (newer/HEAD).
    const log = spawnSync(
      "git",
      ["log", "-2", "--pretty=format:%s%n%b%n---END---"],
      { cwd: repoDir, encoding: "utf8" },
    ).stdout;
    expect(log).toContain("chore(qa): expand coverage via Codex review");
    expect(log).toContain("chore(qa): production fixes from Codex review");
    expect(log).toContain("(auto-split)");

    // HEAD~1 should be the test-only commit (older).
    const head1Msg = spawnSync("git", ["log", "-1", "--pretty=%s", "HEAD~1"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout;
    expect(head1Msg).toContain("expand coverage");
    // HEAD should be the production commit (newer).
    const headMsg = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout;
    expect(headMsg).toContain("production fixes");
  });

  it("GSTACK_QA_NO_AUTO_SPLIT=1 disables auto-split, falls back to manual recovery on mixed diff", () => {
    const old = process.env.GSTACK_QA_NO_AUTO_SPLIT;
    process.env.GSTACK_QA_NO_AUTO_SPLIT = "1";
    try {
      fs.mkdirSync(path.join(repoDir, "server", "__tests__"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(repoDir, "server", "__tests__", "bar.test.ts"),
        "// test\n",
      );
      fs.writeFileSync(path.join(repoDir, "server", "routes.ts"), "// src\n");
      const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      }).stdout.trim();

      const result = maybeAutoCommitTestOnlyDirty({
        cwd: repoDir,
        label: "qa gate",
        dirtyLines: ["?? server/__tests__/bar.test.ts", "?? server/routes.ts"],
      });

      expect(result.committed).toBe(false);
      expect(result.reason).toContain("non-test paths present");
      expect(result.reason).toContain("server/routes.ts");
      const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      }).stdout.trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      if (old === undefined) delete process.env.GSTACK_QA_NO_AUTO_SPLIT;
      else process.env.GSTACK_QA_NO_AUTO_SPLIT = old;
    }
  });

  it("refuses to commit when ALL paths are production (no test paths to split with)", () => {
    // The auto-split path requires BOTH layers to fire. A pure
    // production-only diff from a review/qa role still bails to manual
    // recovery — we never auto-commit production-only changes.
    fs.mkdirSync(path.join(repoDir, "server"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "server", "routes.ts"), "// src\n");
    fs.writeFileSync(path.join(repoDir, "server", "auth.ts"), "// src\n");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = maybeAutoCommitTestOnlyDirty({
      cwd: repoDir,
      label: "qa gate",
      dirtyLines: ["?? server/routes.ts", "?? server/auth.ts"],
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toContain("non-test paths present");
    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(headAfter).toBe(headBefore);
  });

  it("GSTACK_QA_NO_AUTO_COMMIT=1 reverts to old behavior (no auto-commit)", () => {
    const old = process.env.GSTACK_QA_NO_AUTO_COMMIT;
    process.env.GSTACK_QA_NO_AUTO_COMMIT = "1";
    try {
      fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, "tests", "baz.test.ts"), "// t\n");
      const result = maybeAutoCommitTestOnlyDirty({
        cwd: repoDir,
        label: "qa gate",
        dirtyLines: ["?? tests/baz.test.ts"],
      });
      expect(result.committed).toBe(false);
      expect(result.reason).toContain("GSTACK_QA_NO_AUTO_COMMIT");
    } finally {
      if (old === undefined) delete process.env.GSTACK_QA_NO_AUTO_COMMIT;
      else process.env.GSTACK_QA_NO_AUTO_COMMIT = old;
    }
  });

  it("GSTACK_QA_NO_AUTO_COMMIT accepts true / yes / TRUE (case-insensitive)", () => {
    // Regression: pre-fix code did literal `=== "1"` equality, so
    // GSTACK_QA_NO_AUTO_COMMIT=true silently failed to disable.
    const old = process.env.GSTACK_QA_NO_AUTO_COMMIT;
    fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
    try {
      for (const v of ["true", "yes", "TRUE", "1", "True"]) {
        process.env.GSTACK_QA_NO_AUTO_COMMIT = v;
        fs.writeFileSync(
          path.join(repoDir, "tests", `tv-${v}.test.ts`),
          "// t\n",
        );
        const result = maybeAutoCommitTestOnlyDirty({
          cwd: repoDir,
          label: "qa gate",
          dirtyLines: [`?? tests/tv-${v}.test.ts`],
        });
        expect(result.committed).toBe(false);
        expect(result.reason).toContain("GSTACK_QA_NO_AUTO_COMMIT");
      }
    } finally {
      if (old === undefined) delete process.env.GSTACK_QA_NO_AUTO_COMMIT;
      else process.env.GSTACK_QA_NO_AUTO_COMMIT = old;
    }
  });

  it("auto-split rollback: if production commit fails, test commit is undone (HEAD restored)", () => {
    // Regression test for the CRITICAL adversarial finding: without
    // rollback, a failing prod commit leaves the test commit stranded.
    // Simulate the failure via a pre-commit hook that rejects any
    // path that is NOT under __tests__. This simulates a realistic
    // hook (e.g., a Jira-id-on-src/-only hook or a lint-only-on-prod
    // hook): the test-only commit passes; the production commit fails.
    const hooksDir = path.join(repoDir, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(
      hookPath,
      "#!/bin/sh\n" +
        "# Reject staged paths under src/ that are NOT under __tests__.\n" +
        "if git diff --cached --name-only | grep -E '^src/' | grep -v '__tests__' | grep -q .; then\n" +
        '  echo "hook: production path rejected" >&2\n' +
        "  exit 1\n" +
        "fi\n" +
        "exit 0\n",
    );
    fs.chmodSync(hookPath, 0o755);

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src", "__tests__"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src", "__tests__", "x.test.ts"),
      "// t\n",
    );
    fs.writeFileSync(path.join(repoDir, "src", "x.ts"), "// p\n");

    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = maybeAutoCommitTestOnlyDirty({
      cwd: repoDir,
      label: "qa gate",
      dirtyLines: ["?? src/__tests__/x.test.ts", "?? src/x.ts"],
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toContain("auto-split production commit failed");
    expect(result.reason).toMatch(/rolled back test commit [0-9a-f]{7}/);
    expect(result.nonTestPaths).toContain("src/x.ts");

    // HEAD must be back where it started — no stranded test commit.
    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(headAfter).toBe(headBefore);
  });

  it("aborts cleanly on porcelain-parse-unsafe paths (quoted special chars / escapes)", () => {
    // Adversarial 2b/2c: porcelain v1 quotes paths containing
    // newlines, tabs, or non-ASCII. The bare parser leaves backslash
    // escapes literal and can mishandle internal " -> " in rename
    // names. The gate must refuse rather than pass a misparsed path
    // to `git add --` and risk half-shipping.
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = maybeAutoCommitTestOnlyDirty({
      cwd: repoDir,
      label: "qa gate",
      // Path with a backslash escape (porcelain quoting for non-ASCII):
      dirtyLines: ["?? tests/caf\\303\\251.test.ts"],
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toContain("porcelain parse unsafe");
    expect(result.nonTestPaths).toBeDefined();
    expect(result.nonTestPaths?.length).toBeGreaterThan(0);

    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(headAfter).toBe(headBefore);
  });
});

// ---------------------------------------------------------------------------
// T8 — Bug 6: --stop-run subcommand
// ---------------------------------------------------------------------------

describe("runStopRun (Bug 6)", () => {
  let registryDir: string;
  let spawnedPids: number[] = [];

  beforeEach(() => {
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-bug6-runs-"));
    spawnedPids = [];
  });

  afterEach(() => {
    // Best-effort: kill any sleep processes we left running.
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    try {
      fs.rmSync(registryDir, { recursive: true, force: true });
    } catch {}
  });

  it("reports already-stopped (exit 0) when the registered PID is dead", async () => {
    const record = {
      runId: "fake-run",
      stateSlug: "fake-run",
      repoPath: "/tmp/repo",
      planFile: "/tmp/plan.md",
      pid: 999999, // very unlikely to be alive
      status: "running" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      branches: [],
    };
    writeActiveRunRecord(registryDir, record);
    const exitCode = await runStopRun("fake-run", registryDir);
    expect(exitCode).toBe(0);
  });

  it("exits 1 when the active-run record doesn't exist", async () => {
    const exitCode = await runStopRun("missing-run", registryDir);
    expect(exitCode).toBe(1);
  });

  it("refuses to signal a PID whose command line is not gstack-build (PID-reuse guard)", async () => {
    // Spawn a long-running sleep — its command line is "sleep 600",
    // NOT gstack-build. runStopRun must refuse to signal it (exit 2).
    const child = spawnSync("sh", ["-c", "sleep 600 & echo $!"], {
      encoding: "utf8",
    });
    const pidStr = (child.stdout || "").trim();
    const pid = Number(pidStr);
    expect(Number.isInteger(pid)).toBe(true);
    spawnedPids.push(pid);

    const record = {
      runId: "guard-run",
      stateSlug: "guard-run",
      repoPath: "/tmp/repo",
      planFile: "/tmp/plan.md",
      pid,
      status: "running" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      branches: [],
    };
    writeActiveRunRecord(registryDir, record);

    const exitCode = await runStopRun("guard-run", registryDir);
    expect(exitCode).toBe(2);

    // Confirm the sleep was NOT killed.
    const stillAlive = spawnSync("ps", ["-p", String(pid)], {
      encoding: "utf8",
    });
    expect(stillAlive.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T8 — help text + skill-md sentinel updates
// ---------------------------------------------------------------------------

describe("HELP_TEXT mentions --stop-run (Bug 6)", () => {
  it("includes --stop-run <run-id> documentation", () => {
    expect(HELP_TEXT).toContain("--stop-run <run-id>");
    expect(HELP_TEXT).toContain("PID reuse");
  });

  it("--mark-phase-committed help mentions feature-relative form (Bug 3)", () => {
    expect(HELP_TEXT).toContain("<feature>.<phase>");
  });
});

// ---------------------------------------------------------------------------
// B-T1 (REGRESSION) — gate-visibility reconcile must not ENOENT after
// archiveLivingPlan moves the plan file
// ---------------------------------------------------------------------------
//
// Before this fix, the orchestrator shutdown sequence (cli.ts:~11183) did:
//   1. archiveLivingPlan(state.planFile)  → moves inbox/X.md → archived/X.md
//   2. state.planFile = archivedPath
//   3. saveState(...)                     → triggers reconcileVisiblePlanState
//                                            with the STALE inbox path stored
//                                            in visiblePlanProjection.planFile
//   4. ENOENT warning every time
//
// The fix is two lines: `visiblePlanProjection = null` before step 1, and a
// defensive null in the finally block. This test pins the property the fix
// relies on: reconcileVisiblePlanState requires the file to exist, so the
// only safe path after archive is to skip the reconcile entirely.
describe("B-T1: gate-visibility reconcile ENOENT race", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-enoent-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("archiveLivingPlan moves the file (the ENOENT precondition)", () => {
    // Build the minimum inbox/living-plan/ scaffold that archiveLivingPlan
    // recognizes: it requires the basename of the parent directory of the
    // plan to be 'living-plan' and its parent to be 'inbox'.
    const inboxDir = path.join(tmpDir, "inbox", "living-plan");
    fs.mkdirSync(inboxDir, { recursive: true });
    const planPath = path.join(inboxDir, "demo.md");
    fs.writeFileSync(planPath, "# demo plan\n");
    expect(fs.existsSync(planPath)).toBe(true);

    const archived = archiveLivingPlan(planPath);
    expect(archived).not.toBeNull();
    expect(archived).toContain("/archived/");
    // The original inbox path no longer exists — this is the failure mode
    // the gate-visibility race used to trip on.
    expect(fs.existsSync(planPath)).toBe(false);
    expect(fs.existsSync(archived as string)).toBe(true);
  });

  it("reconcileVisiblePlanState throws ENOENT when called with a missing planFile + gates needing flip (proves the race)", () => {
    const missing = path.join(tmpDir, "does-not-exist.md");
    const state = {
      slug: "test",
      planFile: missing,
      branch: "test",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [
        {
          number: "1",
          status: "committed" as const,
          phaseIndices: [0],
        },
      ],
      // Phase status `committed` triggers a non-empty projection from
      // phaseGateProjection, so the reconciler will try to flip a gate
      // checkbox — which calls setCheckboxState → fs.readFileSync, which
      // is where ENOENT lands.
      phases: [
        {
          index: 0,
          number: "1.1",
          name: "test",
          status: "committed" as const,
        },
      ],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    } as unknown as Parameters<typeof reconcileVisiblePlanState>[3];
    const features = [
      { index: 0, number: "1", name: "test", phaseIndices: [0] },
    ] as unknown as Parameters<typeof reconcileVisiblePlanState>[1];
    // A phase with at least one gate that the projection thinks should be
    // done. The reconciler tries to flip the checkbox, hits readFileSync
    // on the missing path, and ENOENTs. The fix makes this entire call
    // path unreachable after archive (visiblePlanProjection = null).
    const phases = [
      {
        index: 0,
        number: "1.1",
        name: "test",
        kind: "code",
        gates: {
          // Gate keys MUST match phaseGateProjection's output. For status
          // 'committed' the projection wants test_spec/verify_red/
          // implementation/green_tests/review_qa = true. With our gate
          // state of done=false, the reconciler tries to flip → calls
          // setCheckboxState → fs.readFileSync(planFile) → ENOENT.
          test_spec: { line: 1, done: false },
          verify_red: { line: 2, done: false },
          implementation: { line: 3, done: false },
          green_tests: { line: 4, done: false },
          review_qa: { line: 5, done: false },
        },
      },
    ] as unknown as Parameters<typeof reconcileVisiblePlanState>[2];
    expect(() =>
      reconcileVisiblePlanState(missing, features, phases, state),
    ).toThrow(/ENOENT|no such file/);
  });

  // B-T1 PART 3 — the regression test that actually covers the fix.
  // The two tests above prove the bug exists (archiveLivingPlan moves the
  // file; reconcileVisiblePlanState throws ENOENT on a missing path).
  // This test drives the FULL shutdown path: set visiblePlanProjection to
  // a non-null projection pointing at an inbox plan file, archive the
  // file (production move), call markVisiblePlanArchived() (the production
  // fix), then invoke saveState (which would otherwise trigger reconcile).
  // The assertion: no ENOENT warning fires and the projection is null.
  // Reverting markVisiblePlanArchived() (i.e. removing the production fix)
  // makes this test fail with the ENOENT warning.
  it("PART 3 (REGRESSION): markVisiblePlanArchived + saveState is a no-op (covers the actual fix)", async () => {
    // Build a real inbox/living-plan/<plan>.md so archiveLivingPlan accepts it.
    const inboxDir = path.join(tmpDir, "inbox", "living-plan");
    fs.mkdirSync(inboxDir, { recursive: true });
    const planPath = path.join(inboxDir, "demo.md");
    fs.writeFileSync(planPath, "# demo plan\n");

    // Capture warnings so we can assert no ENOENT line fires.
    const warnings: string[] = [];
    const oldWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    try {
      // Step 1: set the projection as production main() would, after parsePlan.
      _setVisiblePlanProjectionForTests({
        planFile: planPath,
        features: [
          {
            number: "1",
            status: "committed",
            phaseIndices: [0],
          },
        ] as unknown as Parameters<typeof reconcileVisiblePlanState>[1],
        phases: [
          {
            index: 0,
            number: "1.1",
            name: "test",
            kind: "code",
            gates: {
              test_spec: { line: 1, done: false },
            },
          },
        ] as unknown as Parameters<typeof reconcileVisiblePlanState>[2],
      });
      expect(_getVisiblePlanProjectionForTests()).not.toBeNull();

      // Step 2: production sequence — mark archived, then archiveLivingPlan,
      // then saveState. Without markVisiblePlanArchived(), saveState would
      // hit reconcileVisiblePlanState with the now-deleted inbox path and
      // log the ENOENT warning that the original bug produced.
      markVisiblePlanArchived();
      const archived = archiveLivingPlan(planPath);
      expect(archived).not.toBeNull();
      expect(fs.existsSync(planPath)).toBe(false);

      // Step 3: minimal BuildState that lets saveState run far enough to
      // reach the reconcile callsite. persistBuildState writes to
      // ~/.gstack/build-state/<slug>.json — point it at a tmp slug so we
      // don't pollute the real state dir, and clean up after.
      const stateSlug = `b-t1-part3-${Date.now()}`;
      const stateFile = path.join(
        process.env.HOME ?? "/tmp",
        ".gstack",
        "build-state",
        `${stateSlug}.json`,
      );
      const state = {
        slug: stateSlug,
        planFile: archived as string,
        branch: "test",
        currentPhaseIndex: 0,
        currentFeatureIndex: 0,
        features: [
          {
            number: "1",
            status: "committed",
            phaseIndices: [0],
            completedAt: new Date().toISOString(),
          },
        ],
        phases: [
          {
            index: 0,
            number: "1.1",
            name: "test",
            status: "committed",
          },
        ],
        completed: true,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      } as unknown as Parameters<typeof _saveStateForTests>[0];

      try {
        _saveStateForTests(state);
      } finally {
        // Best-effort cleanup of the state file.
        try {
          fs.unlinkSync(stateFile);
        } catch {
          // ignore
        }
      }

      // Step 4: assert the fix worked.
      // (a) projection is null
      expect(_getVisiblePlanProjectionForTests()).toBeNull();
      // (b) no ENOENT warning fired during saveState
      const enoentWarning = warnings.find((w) =>
        /gate visibility reconcile failed.*ENOENT/.test(w),
      );
      expect(enoentWarning).toBeUndefined();
    } finally {
      console.warn = oldWarn;
      // Always clean projection so test isolation holds.
      _setVisiblePlanProjectionForTests(null);
    }
  });
});
