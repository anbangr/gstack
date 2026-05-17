/**
 * Sub-agent invocation wrappers for gstack-build.
 *
 * Three callable subagents, all spawned as fresh CLI processes (no MCP):
 *   - runGemini(opts)       implements a phase
 *   - runCodexReview(opts)  reviews an implementation
 *   - runShip(opts)         final ship + land-and-deploy
 *
 * Each invocation:
 *   - Streams stdout+stderr to a log file under ~/.gstack/build-state/<slug>/
 *   - Returns a SubAgentResult with the captured output, exit code, timeout flag
 *   - Has a configurable timeout via env var (sensible 10/15/30 min defaults)
 *   - Retries ONCE on timeout. Non-timeout failures bubble up immediately so
 *     the caller can decide.
 *
 * Idioms borrowed from ~/mcp-llm-bridge/src/server.ts:
 *   - Codex needs stdin closed or `codex exec` hangs forever
 *   - 20MB max buffer for stdout
 *   - --yolo on Gemini for autonomous file edits
 */

import { execFile } from "./child-registry";
import * as fs from "node:fs";
import * as path from "node:path";
import { logDir, ensureLogDir } from "./state";
import type { RoleConfig, RoleProvider, RoleReasoning } from "./role-config";
import { BUILD_DEFAULTS, envNumberOrDefault } from "./build-config";
import type { DualImplCandidateKey } from "./types";

export type CodexSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

const MAX_BUFFER = 20 * 1024 * 1024;

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const KIMI_BIN = process.env.KIMI_BIN || "kimi";

const GEMINI_TIMEOUT_MS = envNumberOrDefault(
  "GSTACK_BUILD_GEMINI_TIMEOUT",
  BUILD_DEFAULTS.timeoutsMs.gemini,
);
const KIMI_TIMEOUT_MS = envNumberOrDefault(
  "GSTACK_BUILD_KIMI_TIMEOUT",
  BUILD_DEFAULTS.timeoutsMs.kimi,
);
const CODEX_TIMEOUT_MS = envNumberOrDefault(
  "GSTACK_BUILD_CODEX_TIMEOUT",
  BUILD_DEFAULTS.timeoutsMs.codex,
);
const SHIP_TIMEOUT_MS = envNumberOrDefault(
  "GSTACK_BUILD_SHIP_TIMEOUT",
  BUILD_DEFAULTS.timeoutsMs.ship,
);

function geminiBin(): string {
  return process.env.GEMINI_BIN || "gemini";
}

function kimiBin(): string {
  return process.env.KIMI_BIN || KIMI_BIN;
}

export type Verdict = "pass" | "fail" | "unclear";

export interface SubAgentResult {
  /** Captured stdout (also written to logPath). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Exit code; null if process was killed by signal. */
  exitCode: number | null;
  /** True if killed by the timeout, not a real exit. */
  timedOut: boolean;
  /** Absolute path to the log file written for this invocation. */
  logPath: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Number of retries used (0 if first attempt succeeded). */
  retries: number;
}

/**
 * Spawn a child, capture stdout+stderr to a log file, and resolve with
 * structured result. Closes stdin if `closeStdin` (Codex needs this).
 */
function spawnCaptured(args: {
  bin: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  logPath: string;
  closeStdin: boolean;
  shell?: boolean;
}): Promise<SubAgentResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    const child = execFile(
      args.bin,
      args.argv,
      {
        maxBuffer: MAX_BUFFER,
        timeout: args.timeoutMs,
        cwd: args.cwd,
        shell: args.shell,
      },
      (err, stdout, stderr) => {
        // Detect timeout via Node's own kill flag (fires before our +1000ms setTimeout).
        if (err?.killed) timedOut = true;

        // Persist captured output regardless of success.
        try {
          fs.writeFileSync(
            args.logPath,
            `# command: ${args.bin} ${args.argv.map(quote).join(" ")}\n` +
              `# cwd: ${args.cwd || process.cwd()}\n` +
              `# started: ${new Date(startedAt).toISOString()}\n` +
              `# duration_ms: ${Date.now() - startedAt}\n` +
              `# timed_out: ${timedOut}\n` +
              `# exit: ${err ? ((err as any).code ?? "killed") : 0}\n` +
              `\n# ---- stdout ----\n${stdout}\n# ---- stderr ----\n${stderr}\n`,
          );
        } catch {
          // Log file write failures shouldn't sink the orchestrator.
        }

        const exitCode = err
          ? (((err as any).code as number | null) ?? null)
          : 0;
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          exitCode,
          timedOut,
          logPath: args.logPath,
          durationMs: Date.now() - startedAt,
          retries: 0,
        });
      },
    );

    if (args.closeStdin) child.stdin?.end();
  });
}

function quote(s: string): string {
  if (/^[a-zA-Z0-9_\/\.\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Stage Gemini I/O files in ~/.gemini/tmp/gstack/<slug>/ — a path Gemini's
 * --yolo file tools accept, and one that never lives inside the user's project
 * repo (so crash-surviving leftovers can't be accidentally committed).
 *
 * Returns { stagedInput, stagedOutput, cleanup }.
 * Call cleanup() after spawnCaptured returns; it copies the output back to
 * outputFilePath and deletes both staged files. The copy and the delete are
 * in separate try/catch blocks so a copy failure surfaces (instead of being
 * swallowed) and the delete still runs regardless.
 */
function stageGeminiIO(opts: {
  slug: string;
  phaseNumber: string;
  iteration: number;
  suffix: string;
  inputFilePath: string;
  outputFilePath: string;
}): { stagedInput: string; stagedOutput: string; cleanup: () => void } {
  const stagingDir = path.join(
    process.env.HOME ?? "~",
    ".gemini",
    "tmp",
    "gstack",
    opts.slug,
  );
  fs.mkdirSync(stagingDir, { recursive: true });

  const base = `gstack-gemini-${opts.phaseNumber}-${opts.iteration}-${opts.suffix}`;
  const stagedInput = path.join(stagingDir, `${base}-input.md`);
  const stagedOutput = path.join(stagingDir, `${base}-output.md`);

  fs.copyFileSync(opts.inputFilePath, stagedInput);
  fs.writeFileSync(stagedOutput, "");

  const cleanup = () => {
    try {
      fs.unlinkSync(stagedInput);
    } catch {}
    try {
      if (fs.existsSync(stagedOutput) && fs.statSync(stagedOutput).size > 0) {
        fs.copyFileSync(stagedOutput, opts.outputFilePath);
      }
    } catch {}
    try {
      fs.unlinkSync(stagedOutput);
    } catch {}
  };

  return { stagedInput, stagedOutput, cleanup };
}

/**
 * Stage Kimi I/O outside the project repo, then grant the staging directory via
 * `--add-dir`. This mirrors Gemini's repo-safe staging while using Kimi's
 * workspace-scoping flags.
 */
function stageKimiIO(opts: {
  slug: string;
  phaseNumber: string;
  iteration: number;
  suffix: string;
  inputFilePath: string;
  outputFilePath: string;
}): {
  stagingDir: string;
  stagedInput: string;
  stagedOutput: string;
  cleanup: () => void;
} {
  const stagingDir = path.join(
    process.env.HOME ?? "~",
    ".kimi",
    "tmp",
    "gstack",
    opts.slug,
  );
  fs.mkdirSync(stagingDir, { recursive: true });

  const base = `gstack-kimi-${opts.phaseNumber}-${opts.iteration}-${opts.suffix}`;
  const stagedInput = path.join(stagingDir, `${base}-input.md`);
  const stagedOutput = path.join(stagingDir, `${base}-output.md`);

  fs.copyFileSync(opts.inputFilePath, stagedInput);
  fs.writeFileSync(stagedOutput, "");

  const cleanup = () => {
    try {
      fs.unlinkSync(stagedInput);
    } catch {}
    try {
      if (fs.existsSync(stagedOutput) && fs.statSync(stagedOutput).size > 0) {
        fs.copyFileSync(stagedOutput, opts.outputFilePath);
      }
    } catch {}
    try {
      fs.unlinkSync(stagedOutput);
    } catch {}
  };

  return { stagingDir, stagedInput, stagedOutput, cleanup };
}

/**
 * Stage Codex I/O inside the workspace cwd (.llm-tmp/) so the workspace-write
 * sandbox can write the output file. The real outputFilePath (typically inside
 * ~/.gstack/build-state/) is outside the sandbox boundary and is silently
 * blocked, leaving an empty output file and an UNCLEAR verdict.
 */
function stageCodexIO(opts: {
  slug: string;
  phaseNumber: string;
  iteration: number;
  suffix: string;
  cwd: string;
  inputFilePath: string;
  outputFilePath: string;
}): { stagedInput: string; stagedOutput: string; cleanup: () => void } {
  const stagingDir = path.join(opts.cwd, ".llm-tmp");
  fs.mkdirSync(stagingDir, { recursive: true });

  const base = `gstack-codex-${opts.phaseNumber}-${opts.iteration}-${opts.suffix}`;
  const stagedInput = path.join(stagingDir, `${base}-input.md`);
  const stagedOutput = path.join(stagingDir, `${base}-output.md`);

  fs.copyFileSync(opts.inputFilePath, stagedInput);
  fs.writeFileSync(stagedOutput, "");

  const cleanup = () => {
    try {
      fs.unlinkSync(stagedInput);
    } catch {}
    try {
      if (fs.existsSync(stagedOutput) && fs.statSync(stagedOutput).size > 0) {
        fs.copyFileSync(stagedOutput, opts.outputFilePath);
      }
    } catch {}
    try {
      fs.unlinkSync(stagedOutput);
    } catch {}
  };

  return { stagedInput, stagedOutput, cleanup };
}

/**
 * Run a Gemini implementation pass via FILE-PATH I/O.
 *
 * The caller writes the full instruction body to `inputFilePath` BEFORE calling
 * this function. We construct a short shell-prompt that just tells Gemini where
 * to read instructions and where to write output. Pass `--yolo` for autonomous
 * file edits (without it Gemini drops to plan mode for multi-file tasks).
 *
 * After Gemini exits, we read `outputFilePath` and put its content into the
 * returned `stdout` field — so callers (like phase-runner) can parse output
 * the same way they always have. The shell stdout becomes status-only.
 *
 * Universal rule: never pass content inline. Always file paths in, file paths
 * out. See ~/.claude/projects/.../memory/feedback_llm_file_io.md.
 */
export async function runGemini(opts: {
  /** Path to the file containing the full prompt body. Caller must write it first. */
  inputFilePath: string;
  /** Path where Gemini will write its output summary. Caller decides the path. */
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  model?: string;
  logPrefix?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const {
    stagedInput,
    stagedOutput,
    cleanup: cleanupStaged,
  } = stageGeminiIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    suffix: opts.logPrefix ?? "impl",
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });

  const shellPrompt = [
    `Read instructions at ${stagedInput}.`,
    `Do the work autonomously using your --yolo file tools.`,
    `When done, write your output summary (what files changed, what tests pass, what was committed) to ${stagedOutput}.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(" ");

  const argv = ["-p", shellPrompt];
  if (opts.model) argv.push("-m", opts.model);
  argv.push("--yolo");

  const prefix = opts.logPrefix ?? "gemini";
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${prefix}-${opts.iteration}.log`,
  );

  let result = await spawnCaptured({
    bin: geminiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  // Single retry on timeout only.
  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-gemini-${opts.iteration}-retry.log`,
    );
    const retryResult = await spawnCaptured({
      bin: geminiBin(),
      argv,
      cwd: opts.cwd,
      timeoutMs: GEMINI_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    cleanupStaged();
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  cleanupStaged();
  return mergeOutputFile(result, opts.outputFilePath);
}

export function buildKimiTaskArgv(opts: {
  workDir: string;
  addDir: string;
  inputFilePath: string;
  outputFilePath: string;
  command?: string;
  model?: string;
  gate?: boolean;
}): string[] {
  const commandLine = opts.command
    ? `Run ${opts.command}.`
    : "Do the requested work.";
  const gateLine = opts.gate
    ? `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`
    : "";
  const prompt = [
    `Read instructions at ${opts.inputFilePath}.`,
    commandLine,
    `Do the work autonomously using your --yolo file tools.`,
    `Write your complete output to ${opts.outputFilePath}.`,
    gateLine,
    `Return ONLY the output file path. No narrative.`,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    "--work-dir",
    opts.workDir,
    "--add-dir",
    opts.addDir,
    "-p",
    prompt,
    ...(opts.model ? ["-m", opts.model] : []),
    "--yolo",
    "--print",
    "--final-message-only",
  ];
}

export async function runKimi(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  model?: string;
  logPrefix?: string;
  command?: string;
  gate?: boolean;
  timeoutMs?: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const {
    stagingDir,
    stagedInput,
    stagedOutput,
    cleanup: cleanupStaged,
  } = stageKimiIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    suffix: opts.logPrefix ?? "impl",
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });

  const argv = buildKimiTaskArgv({
    workDir: opts.cwd,
    addDir: stagingDir,
    inputFilePath: stagedInput,
    outputFilePath: stagedOutput,
    command: opts.command,
    model: opts.model,
    gate: opts.gate,
  });

  const prefix = opts.logPrefix ?? "kimi";
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${prefix}-${opts.iteration}.log`,
  );

  let result = await spawnCaptured({
    bin: kimiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? KIMI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-kimi-${opts.iteration}-retry.log`,
    );
    const retryResult = await spawnCaptured({
      bin: kimiBin(),
      argv,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? KIMI_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    cleanupStaged();
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  cleanupStaged();
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * After a sub-agent exits, read the file it was supposed to write and put
 * its content into the result's `stdout` field. Callers (parseVerdict,
 * phase-runner) keep working with `stdout` as the work-product source —
 * they just don't know whether it came from shell stdout or a file.
 *
 * If the output file is missing or unreadable, the sub-agent didn't follow
 * the protocol. We synthesize a clear error message into stdout so verdict
 * parsing fails the way it should ("unclear"), and surface the original
 * shell stdout in stderr for forensics.
 */
export function mergeOutputFile(
  result: SubAgentResult,
  outputFilePath: string,
  opts?: { emptyFileIsError?: boolean; emptyFileErrorLabel?: string },
): SubAgentResult {
  try {
    const fileContent = fs.readFileSync(outputFilePath, "utf8");
    if (fileContent.trim() === "") {
      if (opts?.emptyFileIsError) {
        // For strict file-output calls the artifact is the only authoritative
        // source. Do NOT embed original stdout in returned stdout: parsers scan
        // stdout for sentinels like WINNER:/GATE PASS and tool chatter can
        // create a false verdict. All debugging content goes to stderr only.
        const label = opts?.emptyFileErrorLabel ?? "output file";
        return {
          ...result,
          stderr: `# ${label} ${outputFilePath} was empty — treating as parse failure; original stdout/stderr preserved in ${result.logPath}`,
          stdout: "",
        };
      }
      // Sub-agent left the output file empty (e.g. Codex applied edits inline but
      // skipped writing the report). Preserve captured streams so parseVerdict can
      // still find GATE PASS / GATE FAIL — Codex writes its verdict to stderr.
      return {
        ...result,
        stdout: [result.stdout, result.stderr].filter(Boolean).join("\n"),
      };
    }
    return {
      ...result,
      stderr:
        result.stderr +
        (result.stdout ? `\n# original stdout:\n${result.stdout}` : ""),
      stdout: fileContent,
    };
  } catch (err) {
    if (opts?.emptyFileIsError) {
      const label = opts?.emptyFileErrorLabel ?? "output file";
      return {
        ...result,
        stderr: `# ${label} ${outputFilePath} was not readable: ${(err as Error).message}; original stdout/stderr preserved in ${result.logPath}`,
        stdout: "",
      };
    }
    return {
      ...result,
      stderr:
        result.stderr +
        `\n# expected output file ${outputFilePath} not readable: ${(err as Error).message}`,
      stdout: `Sub-agent did not write expected output file ${outputFilePath}. Original shell stdout:\n${result.stdout}`,
    };
  }
}

export function buildCodexReviewArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  command?: string;
  sandbox?: CodexSandbox;
  reasoning?: RoleReasoning;
  model?: string;
  gate?: boolean;
}): string[] {
  const command = opts.command || "/gstack-review";
  const reasoning = opts.reasoning || "high";
  // Default sandbox is workspace-write. Git worktrees share .git/remotes with
  // the parent repo — danger-full-access would let the review agent push or
  // delete remote branches. Override via GSTACK_BUILD_CODEX_REVIEW_SANDBOX
  // only in environments where that risk is accepted.
  const sandbox =
    opts.sandbox ||
    (process.env.GSTACK_BUILD_CODEX_REVIEW_SANDBOX as
      | CodexSandbox
      | undefined) ||
    "workspace-write";

  const codexPrompt = [
    `Read review context at ${opts.inputFilePath}.`,
    `Run ${command}.`,
    `Write your full review report to ${opts.outputFilePath}.`,
    opts.gate === false
      ? `Report whether the command completed successfully.`
      : `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(" ");

  return [
    "exec",
    codexPrompt,
    ...(opts.model ? ["-m", opts.model] : []),
    "-s",
    sandbox,
    "-c",
    `model_reasoning_effort="${reasoning}"`,
    "-C",
    opts.cwd,
  ];
}

const CODEX_TRANSPORT_FAILURE_RE =
  /stream disconnected before completion|tls handshake eof|failed to connect to websocket|error sending request for url.*backend-api\/codex\/responses/i;

export function isLikelyCodexTransportFailure(
  result: Pick<SubAgentResult, "stdout" | "stderr">,
): boolean {
  return CODEX_TRANSPORT_FAILURE_RE.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * Run one iteration of Codex review (i.e. `codex exec /gstack-review`).
 * Caller checks the verdict via parseVerdict(stdout) and decides whether
 * to loop again.
 */
export async function runCodexReview(opts: {
  /** Path to file with full review context (which phase, what changed, what to verify). Caller writes it first. */
  inputFilePath: string;
  /** Path where Codex will write its review report including the GATE PASS/FAIL line. */
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  /** Which slash-command to run, e.g. `/gstack-review` or `/gstack-qa`. */
  command?: string;
  /** Reasoning effort: low | medium | high | xhigh. Default xhigh for reviews (thinking mode). */
  reasoning?: RoleReasoning;
  /** Sandbox mode. `workspace-write` lets the review loop fix bugs;
   * `read-only` makes it report-only. Default workspace-write because the
   * recursive loop expects fix-and-rereview. */
  sandbox?: CodexSandbox;
  model?: string;
  gate?: boolean;
  logPrefix?: string;
  timeoutMs?: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const { stagedInput, stagedOutput, cleanup } = stageCodexIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    suffix: opts.logPrefix ?? "review",
    cwd: opts.cwd,
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });

  const argv = buildCodexReviewArgv({
    inputFilePath: stagedInput,
    outputFilePath: stagedOutput,
    cwd: opts.cwd,
    command: opts.command,
    sandbox: opts.sandbox,
    reasoning: opts.reasoning,
    model: opts.model,
    gate: opts.gate,
  });

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${opts.logPrefix ?? "codex"}-${opts.iteration}.log`,
  );

  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;

  let result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs,
    logPath,
    closeStdin: true, // codex exec hangs without this
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-${opts.logPrefix ?? "codex"}-${opts.iteration}-retry.log`,
    );
    const retryResult = await spawnCaptured({
      bin: CODEX_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs,
      logPath: retryLog,
      closeStdin: true,
    });
    retryResult.retries = 1;
    cleanup();
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  if (result.exitCode !== 0 && isLikelyCodexTransportFailure(result)) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-${opts.logPrefix ?? "codex"}-${opts.iteration}-transport-retry.log`,
    );
    fs.writeFileSync(stagedOutput, "");
    const retryResult = await spawnCaptured({
      bin: CODEX_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs,
      logPath: retryLog,
      closeStdin: true,
    });
    retryResult.retries = 1;
    cleanup();
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  cleanup();
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * Build the argv for a Claude file-path task. Claude does not expose the same
 * reasoning flag shape as Codex here, so reasoning is carried as an explicit
 * instruction in the prompt.
 */
export function buildClaudeTaskArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  command?: string;
  model?: string;
  reasoning?: RoleReasoning;
  gate?: boolean;
}): string[] {
  const commandLine = opts.command
    ? `Run ${opts.command}.`
    : "Do the requested work.";
  const gateLine = opts.gate
    ? `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`
    : "";
  const prompt = [
    `Use ${opts.reasoning || "high"} thinking.`,
    `Read instructions at ${opts.inputFilePath}.`,
    commandLine,
    `Write your complete output to ${opts.outputFilePath}.`,
    `Do not print the report to stdout; stdout is only for the output file path.`,
    `If you cannot write ${opts.outputFilePath}, exit non-zero.`,
    gateLine,
    `Return ONLY the output file path. No narrative.`,
  ]
    .filter(Boolean)
    .join(" ");
  return [...(opts.model ? ["--model", opts.model] : []), "-p", prompt];
}

/**
 * Build argv for a file-path role task. Used for configured slash-command
 * roles while preserving the same input/output protocol as Claude and Codex
 * role invocations.
 */
export function buildRoleTaskArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  command?: string;
  model?: string;
  gate?: boolean;
}): string[] {
  const commandLine = opts.command
    ? `Run ${opts.command}.`
    : "Do the requested work.";
  const gateLine = opts.gate
    ? `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`
    : "";
  const prompt = [
    `Read instructions at ${opts.inputFilePath}.`,
    commandLine,
    `Do the work autonomously using your --yolo file tools.`,
    `Write your complete output to ${opts.outputFilePath}.`,
    gateLine,
    `Return ONLY the output file path. No narrative.`,
  ]
    .filter(Boolean)
    .join(" ");
  return ["-p", prompt, ...(opts.model ? ["-m", opts.model] : []), "--yolo"];
}

export async function runRoleTask(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  command?: string;
  model?: string;
  gate?: boolean;
  timeoutMs?: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const {
    stagedInput,
    stagedOutput,
    cleanup: cleanupStaged,
  } = stageGeminiIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber ?? "ship",
    iteration: opts.iteration ?? 1,
    suffix: opts.logPrefix,
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });
  const argv = buildRoleTaskArgv({
    inputFilePath: stagedInput,
    outputFilePath: stagedOutput,
    command: opts.command,
    model: opts.model,
    gate: opts.gate,
  });
  const logPath = path.join(
    logDir(opts.slug),
    opts.phaseNumber
      ? `phase-${opts.phaseNumber}-${opts.logPrefix}-${opts.iteration ?? 1}.log`
      : `${opts.logPrefix}.log`,
  );

  let result = await spawnCaptured({
    bin: geminiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  if (result.timedOut) {
    const retryLog = logPath.replace(/\.log$/, "-retry.log");
    const retryResult = await spawnCaptured({
      bin: geminiBin(),
      argv,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? GEMINI_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    cleanupStaged();
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  cleanupStaged();
  return mergeOutputFile(result, opts.outputFilePath);
}

export async function runClaudeTask(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  command?: string;
  model?: string;
  reasoning?: RoleReasoning;
  gate?: boolean;
  timeoutMs?: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const argv = buildClaudeTaskArgv(opts);
  const logPath = path.join(
    logDir(opts.slug),
    opts.phaseNumber
      ? `phase-${opts.phaseNumber}-${opts.logPrefix}-${opts.iteration ?? 1}.log`
      : `${opts.logPrefix}.log`,
  );
  let result = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? CODEX_TIMEOUT_MS,
    logPath,
    closeStdin: true,
  });
  if (result.timedOut) {
    const retryLog = logPath.replace(/\.log$/, "-retry.log");
    const retryResult = await spawnCaptured({
      bin: CLAUDE_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? CODEX_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: true,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath, {
      emptyFileIsError: true,
      emptyFileErrorLabel: "Claude output file",
    });
  }
  return mergeOutputFile(result, opts.outputFilePath, {
    emptyFileIsError: true,
    emptyFileErrorLabel: "Claude output file",
  });
}

/**
 * Final ship step: run the configurable ship command, then land command.
 * Returns the FIRST failure, or the final land result on full success.
 */
export async function runShip(opts: {
  cwd: string;
  slug: string;
  ship: {
    provider: RoleProvider;
    model: string;
    reasoning: RoleReasoning;
    command: string;
    backupProvider?: RoleProvider;
    backupModel?: string;
  };
  land: {
    provider: RoleProvider;
    model: string;
    reasoning: RoleReasoning;
    command: string;
    backupProvider?: RoleProvider;
    backupModel?: string;
  };
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shipInput = path.join(logDir(opts.slug), "ship-input.md");
  const shipOutput = path.join(logDir(opts.slug), "ship-output.md");
  fs.writeFileSync(
    shipInput,
    `Run ${opts.ship.command} for this repository. Report exactly what happened.`,
  );
  fs.writeFileSync(shipOutput, "");
  const shipResult = await runSlashCommand({
    inputFilePath: shipInput,
    outputFilePath: shipOutput,
    cwd: opts.cwd,
    slug: opts.slug,
    logPrefix: "ship",
    role: opts.ship,
    timeoutMs: SHIP_TIMEOUT_MS,
    gate: false,
  });

  // Bail out before /land-and-deploy if /ship failed.
  if (shipResult.timedOut || shipResult.exitCode !== 0) {
    return shipResult;
  }

  const landInput = path.join(logDir(opts.slug), "land-and-deploy-input.md");
  const landOutput = path.join(logDir(opts.slug), "land-and-deploy-output.md");
  fs.writeFileSync(
    landInput,
    `Run ${opts.land.command} for this repository. Report exactly what happened.`,
  );
  fs.writeFileSync(landOutput, "");
  return runSlashCommand({
    inputFilePath: landInput,
    outputFilePath: landOutput,
    cwd: opts.cwd,
    slug: opts.slug,
    logPrefix: "land-and-deploy",
    role: opts.land,
    timeoutMs: SHIP_TIMEOUT_MS,
    gate: false,
  });
}

export async function runSlashCommand(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  role: {
    provider: RoleProvider;
    model: string;
    reasoning: RoleReasoning;
    command: string;
    backupProvider?: RoleProvider;
    backupModel?: string;
  };
  timeoutMs?: number;
  gate?: boolean;
  sandbox?: CodexSandbox;
}): Promise<SubAgentResult> {
  return runConfiguredRoleTask({
    ...opts,
    codexDefaultCommand: "/gstack-review",
  });
}

export async function runConfiguredRoleTask(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  role: RoleConfig;
  timeoutMs?: number;
  gate?: boolean;
  sandbox?: CodexSandbox;
  codexDefaultCommand?: string;
}): Promise<SubAgentResult> {
  let result: SubAgentResult;

  if (opts.role.provider === "claude") {
    result = await runClaudeTask({
      inputFilePath: opts.inputFilePath,
      outputFilePath: opts.outputFilePath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: opts.phaseNumber,
      iteration: opts.iteration,
      logPrefix: opts.logPrefix,
      command: opts.role.command,
      model: opts.role.model,
      reasoning: opts.role.reasoning,
      gate: opts.gate,
      timeoutMs: opts.timeoutMs,
    });
  } else if (opts.role.provider === "gemini") {
    result = await runRoleTask({
      inputFilePath: opts.inputFilePath,
      outputFilePath: opts.outputFilePath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: opts.phaseNumber,
      iteration: opts.iteration,
      logPrefix: opts.logPrefix,
      command: opts.role.command,
      model: opts.role.model,
      gate: opts.gate,
      timeoutMs: opts.timeoutMs,
    });
  } else if (opts.role.provider === "kimi") {
    result = await runKimi({
      inputFilePath: opts.inputFilePath,
      outputFilePath: opts.outputFilePath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: opts.phaseNumber ?? "ship",
      iteration: opts.iteration ?? 1,
      logPrefix: opts.logPrefix,
      command: opts.role.command,
      model: opts.role.model,
      gate: opts.gate,
      timeoutMs: opts.timeoutMs,
    });
  } else {
    result = await runCodexReview({
      inputFilePath: opts.inputFilePath,
      outputFilePath: opts.outputFilePath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: opts.phaseNumber ?? "ship",
      iteration: opts.iteration ?? 1,
      command:
        opts.role.command ??
        opts.codexDefaultCommand ??
        "the requested task described in the input file",
      model: opts.role.model,
      reasoning: opts.role.reasoning,
      gate: opts.gate,
      sandbox: opts.sandbox,
      logPrefix: opts.logPrefix,
      timeoutMs: opts.timeoutMs,
    });
  }

  // MIRROR: cli.ts::runRoleTask contains an identical fallback block for the
  // CLI's internal phase dispatcher. Any change to this logic (log format,
  // clear-before-backup, role shape) must also be applied there.
  if ((result.timedOut || result.exitCode !== 0) && opts.role.backupProvider) {
    console.warn(
      `[gstack-build] ${opts.logPrefix}: primary ${opts.role.provider} failed ` +
        `(exit=${result.exitCode ?? "null"}, timedOut=${result.timedOut}); ` +
        `falling back to ${opts.role.backupProvider}`,
    );
    // Zero stale primary output before backup runs. If backup also fails, the
    // caller gets an empty outputFilePath plus the backup's non-zero exit code.
    fs.writeFileSync(opts.outputFilePath, "");
    return runConfiguredRoleTask({
      ...opts,
      logPrefix: `${opts.logPrefix}-backup-${opts.role.backupProvider}`,
      // codexDefaultCommand must not propagate — it is caller-specific (e.g.
      // runSlashCommand passes "/gstack-review"). An implementation-role backup
      // with provider "codex" and no command must not inherit a review command.
      codexDefaultCommand: undefined,
      role: {
        provider: opts.role.backupProvider,
        // Empty string when backupModel is absent: all argv builders use a falsy
        // check (e.g. `opts.model ? ["-m", opts.model] : []`), so "" suppresses
        // the flag and lets the provider use its configured default.
        model: opts.role.backupModel ?? "",
        reasoning: opts.role.reasoning,
        command: opts.role.command,
      },
    });
  }

  return result;
}

/**
 * Strip ANSI escape sequences so verdict parsing isn't fooled by colored
 * output from codex.
 */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Parse Codex review output for the GATE PASS / GATE FAIL keyword.
 * Case-sensitive on the keyword (matches the convention used in real plans
 * — see ~/Documents/Antigravity/agnt2-workspace/.../agnt2-impl-plan-...md).
 *
 * Strategy: strip ANSI, then look for the LAST occurrence of either
 * keyword (last verdict wins, in case Codex iterated mid-output).
 */
export function parseVerdict(stdout: string): Verdict {
  const clean = stripAnsi(stdout);
  const passIdx = clean.lastIndexOf("GATE PASS");
  const failIdx = clean.lastIndexOf("GATE FAIL");
  if (passIdx < 0 && failIdx < 0) return "unclear";
  if (passIdx > failIdx) return "pass";
  return "fail";
}

// Known test frameworks we explicitly disambiguate. The set is intentionally
// small — the goal is to break ties when filesystem markers are ambiguous and
// to hint the testspec LLM at the right assertion library. Unrecognised values
// from `--test-framework` are rejected at the CLI flag parser.
export type Framework =
  | "vitest"
  | "jest"
  | "playwright"
  | "bun"
  | "pytest"
  | "go"
  | "cargo";

const KNOWN_FRAMEWORKS: ReadonlyArray<Framework> = [
  "vitest",
  "jest",
  "playwright",
  "bun",
  "pytest",
  "go",
  "cargo",
];

export function isKnownFramework(s: string): s is Framework {
  return (KNOWN_FRAMEWORKS as ReadonlyArray<string>).includes(s);
}

// Canonical run command for a framework. Used both when the caller has only
// the framework name (e.g. --test-framework override) and when inspectProject
// picks a framework via config-file detection.
export function frameworkToRunner(framework: Framework, cwd: string): string {
  switch (framework) {
    case "vitest":
      return resolveJsPkgManagerTest(cwd) ?? "npx vitest run";
    case "jest":
      return resolveJsPkgManagerTest(cwd) ?? "npx jest";
    case "playwright":
      return "npx playwright test";
    case "bun":
      return "bun test";
    case "pytest":
      return "pytest";
    case "go":
      return "go test ./...";
    case "cargo":
      return "cargo test";
  }
}

// When a JS framework is detected but the caller asks for the runner, prefer
// the project's package-manager script wiring if it already has one. Returns
// null when no package.json exists (then fall back to npx invocation).
function resolveJsPkgManagerTest(cwd: string): string | null {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const scriptsRaw = (pkg as { scripts?: unknown })?.scripts;
  const scripts =
    scriptsRaw && typeof scriptsRaw === "object"
      ? (scriptsRaw as Record<string, unknown>)
      : null;
  const testScript =
    scripts && typeof scripts.test === "string" ? scripts.test.trim() : "";
  if (!testScript) {
    const packageManager = detectPackageManager(cwd, pkg as { name?: string });
    return packageManager === "bun" ? "bun run test" : `${packageManager} test`;
  }
  if (/^(bun|npm|pnpm|yarn)\s+(run\s+)?test\b/.test(testScript)) {
    return testScript;
  }
  const packageManager = detectPackageManager(cwd, pkg as { name?: string });
  return packageManager === "bun" ? "bun run test" : `${packageManager} test`;
}

interface ProjectInspection {
  runner: string | null; // the test command to invoke
  framework: Framework | null; // for prompt hints; may be null even when runner is non-null (wrapper scripts)
  evidence: string[]; // human-readable trail for logging
}

/**
 * Internal source of truth for test-runner and framework detection.
 *
 * Detection order (first match wins within each priority band):
 *
 *   Priority 1 — framework-config files (most reliable signal):
 *     vitest.config.{ts,js,mjs}        → vitest
 *     jest.config.{ts,js,cjs,mjs}      → jest
 *     playwright.config.{ts,js}        → playwright
 *     pytest.ini                       → pytest
 *     pyproject.toml [tool.pytest...]  → pytest
 *     setup.cfg [tool:pytest]          → pytest
 *
 *   Priority 2 — package.json scripts.test (only if Priority 1 missed):
 *     scripts.test matches known runner verb → use as-is, inherit framework
 *     scripts.test is a wrapper (make, bash, …) → runner=wrapper, framework=null
 *     no scripts.test → use `<pkgmgr> test`, framework=null
 *
 *   Priority 3 — build-system markers (only if Priority 1+2 missed):
 *     go.mod      → go test ./...
 *     Cargo.toml  → cargo test
 *     bun.lockb   → bun test
 *
 *   Priority 4 — source-file tie-break (only when multiple language markers
 *   exist at cwd AND Priorities 1+2+3 left framework ambiguous):
 *     bounded walk (depth 4, cap 50 per language, 250ms time budget) counts
 *     *.test.{ts,tsx,js} vs *_test.py / test_*.py vs *_test.go vs *_test.rs.
 *     Majority wins. Aborts to first-marker on time budget exceeded.
 *
 * When nothing matches: { runner: null, framework: null }.
 */
export function inspectProject(
  cwd: string,
  opts: { now?: () => number } = {},
): ProjectInspection {
  const now = opts.now ?? (() => Date.now());
  const evidence: string[] = [];

  // Priority 1 — framework-config files.
  const vitestConfig = firstExisting(cwd, [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
  ]);
  if (vitestConfig) {
    evidence.push(`framework-config: ${vitestConfig}`);
    return {
      runner: frameworkToRunner("vitest", cwd),
      framework: "vitest",
      evidence,
    };
  }
  const jestConfig = firstExisting(cwd, [
    "jest.config.ts",
    "jest.config.js",
    "jest.config.cjs",
    "jest.config.mjs",
  ]);
  if (jestConfig) {
    evidence.push(`framework-config: ${jestConfig}`);
    return {
      runner: frameworkToRunner("jest", cwd),
      framework: "jest",
      evidence,
    };
  }
  const playwrightConfig = firstExisting(cwd, [
    "playwright.config.ts",
    "playwright.config.js",
  ]);
  if (playwrightConfig) {
    evidence.push(`framework-config: ${playwrightConfig}`);
    return {
      runner: frameworkToRunner("playwright", cwd),
      framework: "playwright",
      evidence,
    };
  }
  if (fs.existsSync(path.join(cwd, "pytest.ini"))) {
    evidence.push("framework-config: pytest.ini");
    return { runner: "pytest", framework: "pytest", evidence };
  }
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    const toml = safeReadFile(path.join(cwd, "pyproject.toml"));
    if (toml.includes("[tool.pytest.ini_options]")) {
      evidence.push("framework-config: pyproject.toml [tool.pytest.ini_options]");
      return { runner: "pytest", framework: "pytest", evidence };
    }
  }
  if (fs.existsSync(path.join(cwd, "setup.cfg"))) {
    const cfg = safeReadFile(path.join(cwd, "setup.cfg"));
    if (cfg.includes("[tool:pytest]")) {
      evidence.push("framework-config: setup.cfg [tool:pytest]");
      return { runner: "pytest", framework: "pytest", evidence };
    }
  }

  // Priority 2 — package.json scripts.test.
  const pkgPath = path.join(cwd, "package.json");
  let pkg: unknown = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      evidence.push("package.json present");
    } catch {
      console.warn(
        "  ⚠ package.json is not valid JSON; skipping npm/bun test detection",
      );
    }
  }
  if (pkg) {
    const scriptsRaw = (pkg as { scripts?: unknown }).scripts;
    const scripts =
      scriptsRaw && typeof scriptsRaw === "object"
        ? (scriptsRaw as Record<string, unknown>)
        : null;
    const testScript =
      scripts && typeof scripts.test === "string" ? scripts.test.trim() : "";

    if (testScript) {
      evidence.push(`package.json scripts.test=${JSON.stringify(testScript)}`);
      const framework = frameworkFromScript(testScript);
      if (/^(bun|npm|pnpm|yarn)\s+(run\s+)?test\b/.test(testScript)) {
        return { runner: testScript, framework, evidence };
      }
      const packageManager = detectPackageManager(
        cwd,
        pkg as { name?: string },
      );
      const runner =
        packageManager === "bun" ? "bun run test" : `${packageManager} test`;
      return { runner, framework, evidence };
    }
    // package.json present but no scripts.test — fall through; later
    // priorities (or tie-break) may still pick a runner. We do NOT default
    // to `<pkgmgr> test` here because that would mask a Python/Go signal
    // sitting alongside.
  }

  // Priority 3 — build-system markers (single-language signals).
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    evidence.push("marker: go.mod");
    // If there's also a package.json, this is ambiguous — defer to Priority 4.
    if (!pkg) {
      return { runner: "go test ./...", framework: "go", evidence };
    }
  }
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    evidence.push("marker: Cargo.toml");
    if (!pkg) {
      return { runner: "cargo test", framework: "cargo", evidence };
    }
  }
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) {
    evidence.push("marker: bun.lockb");
    if (!pkg && !fs.existsSync(path.join(cwd, "go.mod"))) {
      return { runner: "bun test", framework: "bun", evidence };
    }
  }

  // Priority 4 — source-file tie-break for ambiguous repos (e.g., package.json
  // with no scripts.test plus go.mod, or package.json plus pyproject.toml with
  // no pytest section).
  const hasGo = fs.existsSync(path.join(cwd, "go.mod"));
  const hasCargo = fs.existsSync(path.join(cwd, "Cargo.toml"));
  const hasPyproject = fs.existsSync(path.join(cwd, "pyproject.toml"));
  const hasJs = pkg !== null;
  const langSignalCount =
    (hasGo ? 1 : 0) +
    (hasCargo ? 1 : 0) +
    (hasPyproject ? 1 : 0) +
    (hasJs ? 1 : 0);

  if (langSignalCount >= 2) {
    const counts = countTestFiles(cwd, 250, now);
    evidence.push(
      `tie-break counts: ts=${counts.ts} py=${counts.py} go=${counts.go} rs=${counts.rs}` +
        (counts.aborted ? " (aborted)" : ""),
    );
    if (counts.aborted) {
      // Fall back to first-match priority order from the legacy detector.
      if (hasJs)
        return {
          runner: resolveJsPkgManagerTest(cwd) ?? "npx vitest run",
          framework: null,
          evidence,
        };
      if (hasGo)
        return { runner: "go test ./...", framework: "go", evidence };
      if (hasCargo) return { runner: "cargo test", framework: "cargo", evidence };
      if (hasPyproject) return { runner: "pytest", framework: "pytest", evidence };
    }
    const winner = pickMajority(counts);
    if (winner === "ts") {
      // Bias the runner toward whatever the JS project would use.
      const runner = resolveJsPkgManagerTest(cwd) ?? "npx vitest run";
      // Framework stays null — we know it's a JS project but not which
      // framework. The LLM falls back to repo-inspection.
      return { runner, framework: null, evidence };
    }
    if (winner === "py") return { runner: "pytest", framework: "pytest", evidence };
    if (winner === "go")
      return { runner: "go test ./...", framework: "go", evidence };
    if (winner === "rs")
      return { runner: "cargo test", framework: "cargo", evidence };
    // No clear winner (all zero) — fall through to one-signal logic below.
  }

  // Single language signal but no scripts.test — produce a sensible default.
  if (hasJs) {
    const runner = resolveJsPkgManagerTest(cwd);
    return { runner, framework: null, evidence };
  }
  if (hasGo) return { runner: "go test ./...", framework: "go", evidence };
  if (hasCargo) return { runner: "cargo test", framework: "cargo", evidence };
  if (hasPyproject) {
    // pyproject.toml exists but no [tool.pytest.ini_options] — best-effort.
    return { runner: "pytest", framework: "pytest", evidence };
  }
  evidence.push("no markers detected");
  return { runner: null, framework: null, evidence };
}

function firstExisting(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(path.join(cwd, c))) return c;
  }
  return null;
}

function safeReadFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Map a scripts.test string to a Framework, where recognisable.
// Returns null for wrapper scripts (`make test`, `bash …`, `./run-tests.sh`).
function frameworkFromScript(testScript: string): Framework | null {
  const s = testScript.toLowerCase();
  if (/\bvitest\b/.test(s)) return "vitest";
  if (/\bjest\b/.test(s)) return "jest";
  if (/\bplaywright\b/.test(s)) return "playwright";
  // "bun test" or "bun run test" is the bun runner; "bun run vitest" was
  // already caught by the vitest match above.
  if (/^bun\s+(run\s+)?test\b/.test(testScript)) return "bun";
  return null;
}

function pickMajority(counts: {
  ts: number;
  py: number;
  go: number;
  rs: number;
}): "ts" | "py" | "go" | "rs" | null {
  const arr: Array<[("ts" | "py" | "go" | "rs"), number]> = [
    ["ts", counts.ts],
    ["py", counts.py],
    ["go", counts.go],
    ["rs", counts.rs],
  ];
  arr.sort((a, b) => b[1] - a[1]);
  if (arr[0][1] === 0) return null;
  if (arr[1][1] === arr[0][1]) return null; // tied
  return arr[0][0];
}

// Bounded directory walk that counts test files per language. Stops when:
//   (a) every language hits the per-language cap (50),
//   (b) the recursion reaches depth 4, OR
//   (c) elapsed time > budgetMs.
const TIE_BREAK_PER_LANG_CAP = 50;
const TIE_BREAK_DEPTH = 4;
const TIE_BREAK_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  "vendor",
  "vendored",
  ".worktrees",
  ".next",
  ".cache",
  "coverage",
  "target",
]);

export function countTestFiles(
  cwd: string,
  budgetMs: number,
  now: () => number,
): { ts: number; py: number; go: number; rs: number; aborted: boolean } {
  const start = now();
  const counts = { ts: 0, py: 0, go: 0, rs: 0, aborted: false };
  const allCapped = () =>
    counts.ts >= TIE_BREAK_PER_LANG_CAP &&
    counts.py >= TIE_BREAK_PER_LANG_CAP &&
    counts.go >= TIE_BREAK_PER_LANG_CAP &&
    counts.rs >= TIE_BREAK_PER_LANG_CAP;

  function walk(dir: string, depth: number): void {
    if (counts.aborted) return;
    if (depth > TIE_BREAK_DEPTH) return;
    if (now() - start > budgetMs) {
      counts.aborted = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (counts.aborted) return;
      if (allCapped()) return;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (TIE_BREAK_IGNORE.has(name)) continue;
        if (name.startsWith(".")) continue;
        walk(path.join(dir, name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        counts.ts < TIE_BREAK_PER_LANG_CAP &&
        (/\.test\.tsx?$/.test(name) || /\.test\.js$/.test(name) || /\.spec\.tsx?$/.test(name))
      ) {
        counts.ts += 1;
        continue;
      }
      if (
        counts.py < TIE_BREAK_PER_LANG_CAP &&
        (/^test_.*\.py$/.test(name) || /_test\.py$/.test(name))
      ) {
        counts.py += 1;
        continue;
      }
      if (counts.go < TIE_BREAK_PER_LANG_CAP && /_test\.go$/.test(name)) {
        counts.go += 1;
        continue;
      }
      if (counts.rs < TIE_BREAK_PER_LANG_CAP && /^lib\.rs$/.test(name)) {
        // Rust doesn't have a canonical *_test.rs pattern; tests are typically
        // inside #[cfg(test)] modules. Use lib.rs / main.rs presence as a
        // weak Rust signal. Cargo.toml at root is the strong signal.
        counts.rs += 1;
        continue;
      }
    }
  }

  walk(cwd, 0);
  return counts;
}

// Public wrappers — preserve the legacy API surface for the 6 call sites in
// cli.ts. `inspectProject` is the single source of truth.

export function detectTestCmd(cwd: string): string | null {
  return inspectProject(cwd).runner;
}

export function detectTestFramework(cwd: string): Framework | null {
  return inspectProject(cwd).framework;
}

/**
 * Parse the overall coverage percentage from test runner stdout.
 *
 * Framework detection uses `testCmd` (the command string, e.g. "jest --watch"):
 *   jest / vitest  → "Statements: N.NN%" line
 *   bun test       → "coverage: N.NN%" line
 *   pytest         → "TOTAL ... N%" terminal line
 *   go test        → "coverage: N.N% of statements"
 *   cargo test     → advisory only (tarpaulin not guaranteed installed) → null
 *   unknown        → null (advisory-only; caller should not fail the phase)
 */
export function parseCoveragePercent(
  stdout: string,
  testCmd: string,
): number | null {
  const clean = stripAnsi(stdout);
  const cmd = testCmd.toLowerCase();

  if (/\bvitest\b/.test(cmd) || /\bjest\b/.test(cmd)) {
    // "Statements   : 87.5% ( 70/80 )" or "Statements: 87.5%"
    const m = clean.match(/statements\s*:?\s*([\d.]+)%/i);
    if (m) return parseFloat(m[1]);
    return null;
  }

  if (/\bbun\s+test\b/.test(cmd) || /\bbun\s+run\s+test\b/.test(cmd)) {
    // "coverage: 82.3%"
    const m = clean.match(/\bcoverage:\s*([\d.]+)%/i);
    if (m) return parseFloat(m[1]);
    return null;
  }

  if (/\bpytest\b/.test(cmd)) {
    // "TOTAL   1000   200   80%"
    const m = clean.match(/^TOTAL\s+\d+\s+\d+\s+([\d.]+)%/im);
    if (m) return parseFloat(m[1]);
    return null;
  }

  if (/\bgo\s+test\b/.test(cmd)) {
    // "ok  ./...  coverage: 72.3% of statements"
    const m = clean.match(/coverage:\s*([\d.]+)%\s+of\s+statements/i);
    if (m) return parseFloat(m[1]);
    return null;
  }

  // cargo test / tarpaulin: not guaranteed installed, return null (advisory only)
  return null;
}

export function extractCoverageTarget(phaseBody: string): number {
  const m = phaseBody.match(
    /\*\*Coverage target:\s*(?:>=|[≥>])\s*([\d.]+)%\*\*/i,
  );
  return m ? parseFloat(m[1]) : 80;
}

/**
 * Append coverage flags to a test command for the GREEN gate run.
 * Idempotent — if the flag is already present, the command is returned unchanged.
 * Returns the command unchanged for unknown frameworks (caller logs advisory).
 */
export function injectCoverageFlags(testCmd: string): string {
  const cmd = testCmd.toLowerCase();
  if (/\bvitest\b/.test(cmd)) {
    return testCmd.includes("--coverage") ? testCmd : `${testCmd} --coverage`;
  }
  if (/\bjest\b/.test(cmd)) {
    return testCmd.includes("--coverage")
      ? testCmd
      : `${testCmd} --coverage --coverageReporters text`;
  }
  if (/\bbun\s+test\b/.test(cmd) || /\bbun\s+run\s+test\b/.test(cmd)) {
    return testCmd.includes("--coverage") ? testCmd : `${testCmd} --coverage`;
  }
  if (/\bpytest\b/.test(cmd)) {
    return testCmd.includes("--cov")
      ? testCmd
      : `${testCmd} --cov --cov-report term-missing`;
  }
  if (/\bgo\s+test\b/.test(cmd)) {
    return testCmd.includes("-cover") ? testCmd : `${testCmd} -cover`;
  }
  return testCmd;
}

function detectPackageManager(
  cwd: string,
  pkg: any,
): "bun" | "pnpm" | "yarn" | "npm" {
  const pm = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  if (pm.startsWith("bun@")) return "bun";
  if (pm.startsWith("pnpm@")) return "pnpm";
  if (pm.startsWith("yarn@")) return "yarn";
  if (pm.startsWith("npm@")) return "npm";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(cwd, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export async function runGeminiTestSpec(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  model?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const {
    stagedInput,
    stagedOutput,
    cleanup: cleanupStaged,
  } = stageGeminiIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    suffix: "testspec",
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });

  const shellPrompt = [
    `Read instructions at ${stagedInput}.`,
    `Do the work autonomously using your --yolo file tools.`,
    `When done, write your output summary (what files changed, what tests pass, what was committed) to ${stagedOutput}.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(" ");

  const argv = ["-p", shellPrompt];
  if (opts.model) argv.push("-m", opts.model);
  argv.push("--yolo");

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-gemini-testspec-${opts.iteration}.log`,
  );

  let result = await spawnCaptured({
    bin: geminiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-gemini-testspec-${opts.iteration}-retry.log`,
    );
    const retryResult = await spawnCaptured({
      bin: geminiBin(),
      argv,
      cwd: opts.cwd,
      timeoutMs: GEMINI_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    cleanupStaged();
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  cleanupStaged();
  return mergeOutputFile(result, opts.outputFilePath);
}

export async function runTests(opts: {
  testCmd: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  /** Optional suffix to disambiguate parallel runs (dual-impl: 'gemini' / 'codex'). */
  logSuffix?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const cmd = opts.testCmd.trim();

  const suffix = opts.logSuffix ? `-${opts.logSuffix}` : "";
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-tests-${opts.iteration}${suffix}.log`,
  );

  return spawnCaptured({
    bin: cmd,
    argv: [],
    cwd: opts.cwd,
    timeoutMs: envNumberOrDefault(
      "GSTACK_BUILD_TEST_TIMEOUT",
      BUILD_DEFAULTS.timeoutsMs.test,
    ),
    logPath,
    closeStdin: true,
    shell: true,
  });
}

// ---------------------------------------------------------------------------
// Dual-implementor (--dual-impl) sub-agents
// ---------------------------------------------------------------------------

/**
 * Count failing test cases in a test runner's stdout.
 *
 * Returns `undefined` when no signal is detectable — phase-runner uses
 * undefined as "no signal" and falls back to fail-closed if BOTH impls
 * lack a count. Returning 0 here was misleading: a compile-error or
 * "no tests ran" output would beat a real "1 test failed" output in
 * tie-breaking. (Codex Phase 3 review, MEDIUM.)
 *
 * Tries multiple signals in priority order:
 *   1. Explicit summary line: `N failed`, `N fail` (bun, jest, vitest, pytest)
 *   2. ✗ marker count (bun-style)
 *   3. ^FAIL line count (jest/pytest-style)
 */
export function parseFailureCount(output: string): number | undefined {
  if (!output) return undefined;
  const clean = stripAnsi(output);

  // Priority 1: pytest summary like "===== 2 failed in 0.10s =====" or "===== 2 failed, 3 passed".
  // Pytest decorates with `=` and `_` chars before/around the summary line.
  const pytestMatch = clean.match(/^=+\s*(\d+)\s+failed\b/im);
  if (pytestMatch) return Number(pytestMatch[1]);

  // Priority 2: bun/jest/vitest/cargo summary at start of line, like "3 failed" / "3 fail".
  // Anchored to ^\s* so it doesn't match "✗ test 1 failed" mid-line.
  const summaryMatch = clean.match(/^\s*(\d+)\s+fail(?:ed|ing)?\b/im);
  if (summaryMatch) return Number(summaryMatch[1]);

  // Priority 3: per-test marker counts as fallback.
  // ✗ (bun-style), FAIL or FAILED at start of line (jest=FAIL, pytest=FAILED).
  const cross = (clean.match(/✗/g) || []).length;
  const fail = (clean.match(/^FAIL(?:ED)?\b/gm) || []).length;
  const markerMax = Math.max(cross, fail);
  return markerMax > 0 ? markerMax : undefined;
}

/**
 * Parse the tournament judge's output for a verdict + reasoning.
 *
 * Expected format (anchored to start-of-line; case-insensitive on the value):
 *   WINNER: primary|secondary
 *   REASONING: <one paragraph>
 *
 * Returns `verdict: null` when no anchored WINNER line is found. Caller
 * (Phase 4 CLI handler) MUST treat null as a hard failure — passing a fake
 * verdict here would defeat the fail-closed semantics in phase-runner where
 * dual_winner_pending without selectedImplementor → FAIL.
 *
 * (Codex Phase 3 review, HIGH — silent fallback to gemini was the original
 * defect; null surfaces it instead.)
 */
export function parseJudgeVerdict(output: string): {
  verdict: DualImplCandidateKey | null;
  reasoning: string;
  hardeningNotes: string;
} {
  const clean = stripAnsi(output || "").replace(/\r/g, "");
  // Anchored: WINNER must be at start of line. Avoids false matches like
  // "I think the WINNER: primary is better" embedded in narrative prose.
  const winnerMatch = clean.match(/^\s*WINNER:\s*(primary|secondary)\b/im);
  if (!winnerMatch) {
    return {
      verdict: null,
      reasoning:
        "no anchored WINNER line found in judge output — caller must fail-closed",
      hardeningNotes: "",
    };
  }
  const verdict = winnerMatch[1].toLowerCase() as DualImplCandidateKey;

  // REASONING: runs from marker to next anchored HARDENING section or EOS.
  // Lookahead on HARDENING: captures any inline value (e.g. "HARDENING: none"),
  // not just standalone lines, so prose that contains "HARDENING:" mid-sentence
  // still requires it to be at the start of a line before truncating.
  const reasoningMatch = clean.match(
    /^\s*REASONING:\s*([\s\S]*?)(?=^\s*HARDENING:\s|$(?![\s\S]))/im,
  );
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : "";

  // HARDENING: runs from its marker to the next known section keyword or EOS.
  // Non-greedy so trailing prose / section order variations don't bleed in.
  const hardeningMatch = clean.match(
    /^\s*HARDENING:\s*([\s\S]*?)(?=^\s*WINNER:|^\s*REASONING:|$(?![\s\S]))/im,
  );
  const hardeningNotes = hardeningMatch ? hardeningMatch[1].trim() : "";

  return { verdict, reasoning, hardeningNotes };
}

/**
 * Build the argv that runCodexImpl passes to the codex CLI. Extracted as a pure
 * helper so tests can verify the invocation shape without spawning the binary.
 *
 * Sandbox defaults to `workspace-write` — `danger-full-access` was unsafe
 * because linked git worktrees share the .git dir, remotes, and credentials
 * with the main cwd, so a destructive command in Codex (e.g. `git push --delete
 * origin main`) would damage the parent repo. Override via GSTACK_BUILD_CODEX_IMPL_SANDBOX
 * for environments where that risk is accepted. (Codex Phase 3 review, HIGH.)
 */
export function buildCodexImplArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  sandbox?: CodexSandbox;
  reasoning?: RoleReasoning;
  model?: string;
}): string[] {
  const codexPrompt = [
    `Read implementation instructions at ${opts.inputFilePath}.`,
    `Implement the changes autonomously using your edit tools.`,
    `Do NOT change test assertions — only make tests pass.`,
    `When done, write your output summary (files changed, tests run, what's verified) to ${opts.outputFilePath}.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(" ");

  const sandbox =
    opts.sandbox ||
    (process.env.GSTACK_BUILD_CODEX_IMPL_SANDBOX as CodexSandbox | undefined) ||
    "workspace-write";

  const reasoning = opts.reasoning || "high";

  return [
    "exec",
    codexPrompt,
    ...(opts.model ? ["-m", opts.model] : []),
    "-s",
    sandbox,
    "-c",
    `model_reasoning_effort="${reasoning}"`,
    "-C",
    opts.cwd,
  ];
}

/**
 * Run the Codex implementation pass for one half of a dual-impl tournament.
 * Mirrors runGemini's structure: file-path I/O, captured output, single retry
 * on timeout. Default sandbox is workspace-write because git worktrees share
 * .git/remotes with the parent repo — danger-full-access would allow Codex to
 * push or delete remote branches. Override via GSTACK_BUILD_CODEX_IMPL_SANDBOX.
 */
export async function runCodexImpl(opts: {
  inputFilePath: string;
  outputFilePath: string;
  /** The worktree cwd Codex should operate in (e.g. /tmp/gstack-dual-.../secondary). */
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  reasoning?: RoleReasoning;
  model?: string;
  /** Optional prefix for log filenames — used by fix-loop passes to avoid overwriting the initial impl log. */
  logPrefix?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  // Stage I/O inside the cwd so the workspace-write sandbox can write the
  // output file. The real outputFilePath is typically in ~/.gstack/build-state/
  // which is outside the sandbox boundary — writes there are silently rejected,
  // leaving an empty output file and an UNCLEAR verdict.
  const { stagedInput, stagedOutput, cleanup } = stageCodexIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    suffix: opts.logPrefix ?? "impl",
    cwd: opts.cwd,
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });

  const argv = buildCodexImplArgv({
    ...opts,
    inputFilePath: stagedInput,
    outputFilePath: stagedOutput,
  });

  const logName = opts.logPrefix ?? "codex-impl";
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${logName}-${opts.iteration}.log`,
  );

  let result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: CODEX_TIMEOUT_MS,
    logPath,
    closeStdin: true,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-${logName}-${opts.iteration}-retry.log`,
    );
    const retryResult = await spawnCaptured({
      bin: CODEX_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: CODEX_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: true,
    });
    cleanup();
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  cleanup();
  return mergeOutputFile(result, opts.outputFilePath);
}

const JUDGE_TIMEOUT_MS = envNumberOrDefault(
  "GSTACK_BUILD_JUDGE_TIMEOUT",
  BUILD_DEFAULTS.timeoutsMs.judge,
);

/**
 * Run the legacy Claude judge wrapper. Caller writes the full judge prompt
 * (task + tests + both diffs + both test results) to inputFilePath BEFORE calling.
 * The judge reads it, picks a winner, and writes verdict to outputFilePath.
 *
 * Caller should call parseJudgeVerdict on the returned result.stdout to extract
 * { verdict, reasoning }.
 */
export async function runJudge(opts: {
  inputFilePath: string;
  outputFilePath: string;
  /** Main cwd (judge is read-only — doesn't matter much, but stay in main). */
  cwd: string;
  slug: string;
  phaseNumber: string;
  model?: string;
  reasoning?: RoleReasoning;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shellPrompt = [
    `Use ${opts.reasoning || "xhigh"} thinking.`,
    `Read judge prompt at ${opts.inputFilePath}.`,
    `Pick the better of the two implementations described inside.`,
    `Write your verdict to ${opts.outputFilePath} in this exact format:`,
    `WINNER: primary|secondary`,
    `REASONING: <one paragraph, concrete reasons>`,
    `Return ONLY the output file path. No narrative.`,
  ].join(" ");

  const argv = [
    "--model",
    opts.model ||
      process.env.GSTACK_BUILD_JUDGE_MODEL ||
      BUILD_DEFAULTS.roles.judge.model,
    "-p",
    shellPrompt,
  ];

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-judge.log`,
  );

  let result = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: JUDGE_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-judge-retry.log`,
    );
    const retryResult = await spawnCaptured({
      bin: CLAUDE_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: JUDGE_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath, {
      emptyFileIsError: true,
    });
  }
  return mergeOutputFile(result, opts.outputFilePath, {
    emptyFileIsError: true,
  });
}
