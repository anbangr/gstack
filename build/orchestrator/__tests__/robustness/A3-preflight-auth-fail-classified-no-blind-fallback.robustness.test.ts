import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTmp, writeExecutable, counterScript } from "./helpers";
import * as subAgents from "../../sub-agents";
import { classifyProviderFailure } from "../../halt-event-helpers";

/**
 * A3 — preflight auth-fail must be auth-classified AND must not blindly
 * fan out to the backup before the auth verdict is recorded. RED.
 *
 * Failure mode (verified):
 *   GEMINI_BIN prints "not authenticated" / exit 1. That phrasing is matched
 *   by AUTH_REQUIRED_RE (sub-agents.ts) — so assertGeminiAuth correctly
 *   classifies it as auth_required and runRoleTask returns exit 1 with the
 *   auth reason in stderr. But runConfiguredRoleTask's fallback gate fires on
 *   any (timedOut || exitCode !== 0) with NO auth-classification step:
 *
 *     1. It blindly spawns the backup provider (invariant b violated — the
 *        backup is invoked before any auth verdict is recorded), and
 *     2. the backup overwrites the primary's stderr, so the auth reason
 *        ("not authenticated") vanishes from the returned result. Worse, even
 *        if it survived, classifyProviderFailure's PROVIDER_AUTH_RE
 *        (halt-event-helpers.ts) does NOT include the "not authenticated"
 *        alternation that AUTH_REQUIRED_RE has — so "not authenticated"
 *        classifies as null (generic), never {kind:"auth"} (invariant a
 *        violated — the auth root cause cannot reach a classifiable auth
 *        verdict and forensics see a generic failure).
 *
 * DESIRED (asserted below, currently failing):
 *   (a) the auth root cause reaches a classifiable auth verdict
 *       (classifyProviderFailure on the surfaced text → {kind:"auth"}),
 *       rather than a generic null/markPhaseFailed; and
 *   (b) the backup provider is NOT spawned before the auth verdict is
 *       recorded (the backup-preflight counter stays at 0).
 *
 * See docs/designs/BUILD_ROBUSTNESS_SUITE.md group A, A3.
 * This is an integration spec: it spawns a real short-lived shell script for
 * the fake provider binaries (bounded, no LLM, no network).
 */

let tmpDir: string;
let origGeminiBin: string | undefined;
let origCodexBin: string | undefined;
let origDisableFlag: string | undefined;
let origStateDir: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = mkTmp("gstack-robustness-a3-");
  origGeminiBin = process.env.GEMINI_BIN;
  origCodexBin = process.env.CODEX_BIN;
  origDisableFlag = process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  origStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  origHome = process.env.GSTACK_HOME;
  // The preflight must actually run, so the kill switch must be OFF.
  delete process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  // Isolate all on-disk state from the developer's real ~/.gstack.
  process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpDir, "state");
  process.env.GSTACK_HOME = path.join(tmpDir, "gstack-home");
  subAgents._resetAuthPreflightForTests();
});

afterEach(() => {
  if (origGeminiBin === undefined) delete process.env.GEMINI_BIN;
  else process.env.GEMINI_BIN = origGeminiBin;
  if (origCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = origCodexBin;
  if (origDisableFlag === undefined)
    delete process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  else process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = origDisableFlag;
  if (origStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
  else process.env.GSTACK_BUILD_STATE_DIR = origStateDir;
  if (origHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = origHome;
  subAgents._resetAuthPreflightForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Stand up the A3 fixture: a Gemini binary that fails the auth probe with the
 * "not authenticated" phrasing, plus a Codex backup binary whose every
 * invocation bumps a counter file. Returns the wired paths.
 */
function setUpAuthFailFixture(): {
  inputFilePath: string;
  outputFilePath: string;
  backupCounterFile: string;
} {
  // Primary (gemini): auth status emits the AUTH_REQUIRED_RE phrasing that
  // PROVIDER_AUTH_RE does NOT cover, then exits 1. assertGeminiAuth catches
  // this as authRequired and runRoleTask returns exit 1 with the reason.
  const geminiBin = path.join(tmpDir, "gemini");
  writeExecutable(
    geminiBin,
    "#!/bin/bash\necho 'not authenticated' >&2\nexit 1\n",
  );
  process.env.GEMINI_BIN = geminiBin;

  // Backup (codex): a counter script. assertCodexAuth (called first thing in
  // runCodexReview) probes codexBin() == process.env.CODEX_BIN, so the counter
  // increments the instant the backup path is entered. Exits 0 so the probe
  // passes — we only care THAT it ran, not its verdict.
  const backupCounterFile = path.join(tmpDir, "codex-backup-count");
  fs.writeFileSync(backupCounterFile, "0");
  const codexBin = path.join(tmpDir, "codex");
  writeExecutable(codexBin, counterScript(backupCounterFile, "exit 0"));
  process.env.CODEX_BIN = codexBin;

  const inputFilePath = path.join(tmpDir, "phase-input.md");
  const outputFilePath = path.join(tmpDir, "phase-output.md");
  fs.writeFileSync(inputFilePath, "Do the requested work.\n");
  fs.writeFileSync(outputFilePath, "");

  return { inputFilePath, outputFilePath, backupCounterFile };
}

describe.skip("[RED] A3 preflight-auth-fail-classified-no-blind-fallback — UNSKIP WHEN A3 IS FIXED", () => {
  it("classifies the auth root cause as {kind:'auth'} (not a generic null verdict)", async () => {
    const { inputFilePath, outputFilePath } = setUpAuthFailFixture();

    const result = await subAgents.runConfiguredRoleTask({
      inputFilePath,
      outputFilePath,
      cwd: tmpDir,
      slug: "a3-auth-classify",
      phaseNumber: "1",
      iteration: 1,
      logPrefix: "a3-primary",
      role: {
        provider: "gemini",
        model: "",
        reasoning: "low",
        backupProvider: "codex",
      },
      timeoutMs: 60000,
    });

    // The text the orchestrator surfaces for this phase MUST let
    // classifyProviderFailure reach an auth verdict — the auth root cause
    // is the thing forensics needs to see. Today this is null because (1)
    // the backup overwrites the primary's auth stderr and (2) even the raw
    // "not authenticated" phrasing isn't in PROVIDER_AUTH_RE.
    const surfacedText = `${result.stdout}\n${result.stderr}`;
    const verdict = classifyProviderFailure({
      text: surfacedText,
      timedOut: result.timedOut,
      stallKilled: result.stallKilled,
    });

    expect(verdict).not.toBeNull();
    expect(verdict?.kind).toBe("auth");
  });

  it("does not blindly spawn the backup before the auth verdict is recorded", async () => {
    const { inputFilePath, outputFilePath, backupCounterFile } =
      setUpAuthFailFixture();

    await subAgents.runConfiguredRoleTask({
      inputFilePath,
      outputFilePath,
      cwd: tmpDir,
      slug: "a3-no-blind-fallback",
      phaseNumber: "1",
      iteration: 1,
      logPrefix: "a3-primary",
      role: {
        provider: "gemini",
        model: "",
        reasoning: "low",
        backupProvider: "codex",
      },
      timeoutMs: 60000,
    });

    // The backup provider must NOT have been invoked: an auth failure won't
    // self-resolve, and a backup spawn per affected phase is wasted budget.
    // Today the counter is 1 — the fallback gate fans out blind on any
    // non-zero exit without classifying the failure as auth first.
    const backupInvocations = Number(
      fs.readFileSync(backupCounterFile, "utf8"),
    );
    expect(backupInvocations).toBe(0);
  });
});
