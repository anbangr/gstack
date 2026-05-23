/**
 * Sub-agent invocation wrappers for gstack-build.
 *
 * Three callable subagents, all spawned as fresh CLI processes (no MCP):
 *   - runRoleTask(opts)     implements a phase via Gemini (renamed from runGemini in v1.40)
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

import {
  spawn as registeredSpawn,
  spawnSync as registeredSpawnSync,
} from "./child-registry";
import * as fs from "node:fs";
import * as path from "node:path";
import { logDir, ensureLogDir, deriveGeminiTmpKey } from "./state";
import type { RoleConfig, RoleProvider, RoleReasoning } from "./role-config";
import {
  BUILD_DEFAULTS,
  envNumberOrDefault,
  TOOL_AWARE_STALL_MS,
  PROGRESS_GAP_MS,
} from "./build-config";
import {
  parseGeminiLine,
  parseCodexLine,
  parseKimiLine,
  parseClaudeLine,
  type ProgressEvent,
} from "./subagent-progress-parser";
import type { DualImplCandidateKey } from "./types";
import {
  attachStallWatchdog,
  killProcessAndGroup,
  type Provider,
} from "./stall-watchdog";
import { computeFaultId, emitHaltEventResolved } from "./halt-events";

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

// ------------------------------------------------------------------
// Auth preflight probes (cached per-process)
// ------------------------------------------------------------------

let _geminiAuthPromise:
  | Promise<{ ok: boolean; reason?: string; skipped?: boolean }>
  | undefined;
let _geminiAuthCache:
  | { ok: boolean; reason?: string; skipped?: boolean }
  | undefined;

let _codexAuthPromise:
  | Promise<{ ok: boolean; reason?: string; skipped?: boolean }>
  | undefined;
let _codexAuthCache:
  | { ok: boolean; reason?: string; skipped?: boolean }
  | undefined;

function resolveBinInPath(bin: string): string {
  if (path.isAbsolute(bin)) return bin;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not executable or not found
    }
  }
  return bin;
}

function probeAuthSync(
  bin: string,
  argv: string[],
  timeoutMs: number,
): { ok: boolean; reason?: string } {
  const resolvedBin = resolveBinInPath(bin);
  try {
    const result = registeredSpawnSync(resolvedBin, argv, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    });
    if (result.status === 0) return { ok: true };
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    return {
      ok: false,
      reason: stdout.trim() || stderr.trim() || `exit ${result.status}`,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function assertGeminiAuth(): Promise<{
  ok: boolean;
  reason?: string;
  skipped?: boolean;
}> {
  if (process.env.GSTACK_DISABLE_AUTH_PREFLIGHT === "1") {
    return { ok: true, skipped: true };
  }
  if (_geminiAuthCache) return _geminiAuthCache;
  if (_geminiAuthPromise) return _geminiAuthPromise;

  _geminiAuthPromise = (async () => {
    const bin = geminiBin();
    const primary = probeAuthSync(bin, ["auth", "status"], 5000);
    if (primary.ok) {
      _geminiAuthCache = primary;
      return primary;
    }
    const fallback = probeAuthSync(bin, ["--version"], 5000);
    if (fallback.ok) {
      _geminiAuthCache = fallback;
      return fallback;
    }
    const result = {
      ok: false,
      reason: `Gemini auth required (${primary.reason || fallback.reason})`,
    };
    _geminiAuthCache = result;
    return result;
  })();

  return _geminiAuthPromise;
}

export function _resetAuthPreflightForTests(): void {
  _geminiAuthCache = undefined;
  _geminiAuthPromise = undefined;
  _codexAuthCache = undefined;
  _codexAuthPromise = undefined;
}

export async function assertCodexAuth(): Promise<{
  ok: boolean;
  reason?: string;
  skipped?: boolean;
}> {
  if (process.env.GSTACK_DISABLE_AUTH_PREFLIGHT === "1") {
    return { ok: true, skipped: true };
  }
  if (_codexAuthCache) return _codexAuthCache;
  if (_codexAuthPromise) return _codexAuthPromise;

  _codexAuthPromise = (async () => {
    const primary = probeAuthSync(CODEX_BIN, ["auth", "status"], 5000);
    if (primary.ok) {
      _codexAuthCache = primary;
      return primary;
    }
    const fallback = probeAuthSync(CODEX_BIN, ["--version"], 5000);
    if (fallback.ok) {
      _codexAuthCache = fallback;
      return fallback;
    }
    const result = {
      ok: false,
      reason: `Codex auth required (${primary.reason || fallback.reason})`,
    };
    _codexAuthCache = result;
    return result;
  })();

  return _codexAuthPromise;
}

/**
 * Cached probe for `ps` availability with the flags cpu-mode needs.
 * Runs the actual command we'll use later (`ps -o pid=,cputime= -g <pid>`)
 * against the current process pid; if it exits 0, the platform supports
 * cpu mode. Memoized — we call this once per spawn at most.
 */
let _psProbeResult: boolean | null = null;
function psAvailableForWatchdog(): boolean {
  if (_psProbeResult !== null) return _psProbeResult;
  if (process.platform === "win32") {
    _psProbeResult = false;
    return false;
  }
  try {
    const result = registeredSpawnSync(
      "ps",
      ["-o", "pid=,cputime=", "-g", String(process.pid)],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
    );
    _psProbeResult = result.status === 0;
  } catch {
    _psProbeResult = false;
  }
  return _psProbeResult;
}

export type ResolvedWatchdogMode = {
  mode: "stream" | "cpu";
  source: "explicit" | "legacy" | "auto" | "invalid";
  warning?: string;
};

export function resolveWatchdogMode(
  env: Record<string, string | undefined> = process.env,
  cpuProbe: () => boolean = psAvailableForWatchdog,
): ResolvedWatchdogMode {
  const explicit = env.GSTACK_BUILD_WATCHDOG_MODE?.trim().toLowerCase();
  const legacy =
    explicit === undefined && env.GSTACK_BUILD_WATCHDOG_CPU === "1"
      ? "cpu"
      : explicit === undefined && env.GSTACK_BUILD_WATCHDOG_CPU === "0"
        ? "stream"
        : undefined;
  const requested = explicit ?? legacy ?? "auto";
  const source = explicit ? "explicit" : legacy ? "legacy" : ("auto" as const);

  if (requested === "stream") return { mode: "stream", source };
  if (requested === "cpu" || requested === "auto") {
    if (cpuProbe()) return { mode: "cpu", source };
    return {
      mode: "stream",
      source,
      warning:
        requested === "cpu"
          ? "cpu watchdog requested but `ps` probe failed; using stream"
          : "auto watchdog selected stream; `ps` probe failed",
    };
  }
  if (cpuProbe()) {
    return {
      mode: "cpu",
      source: "invalid",
      warning: `invalid GSTACK_BUILD_WATCHDOG_MODE=${requested}; using auto/cpu`,
    };
  }
  return {
    mode: "stream",
    source: "invalid",
    warning: `invalid GSTACK_BUILD_WATCHDOG_MODE=${requested}; using auto/stream`,
  };
}

function kimiBin(): string {
  return process.env.KIMI_BIN || KIMI_BIN;
}

/**
 * Resolve effective timeouts for a role under liveness semantics.
 *
 * Precedence for primary timeout: callerTimeoutMs > role.timeoutMs > provider default.
 * Backup timeout: role.backupTimeoutMs > max(60s, floor(primaryMs/2)). The 60s floor
 * keeps backup viable when primary is configured very small (gemini CLI cold start
 * alone is ~3-5s; anything below 60s leaves no room for actual work).
 *
 * Under liveness semantics, these values are STALL WINDOWS (max ms of silence
 * before kill), not wall-clock budgets — a sub-agent that keeps emitting stdout
 * runs as long as it needs.
 *
 * "claude" provider has no key in BUILD_DEFAULTS.timeoutsMs today; we reuse the
 * codex default for parity with existing call sites that fall through to CODEX_TIMEOUT_MS.
 */
export function resolveRoleTimeouts(
  role: RoleConfig,
  callerTimeoutMs?: number,
): {
  primaryMs: number;
  backupMs: number;
} {
  const providerDefault =
    role.provider === "gemini"
      ? GEMINI_TIMEOUT_MS
      : role.provider === "kimi"
        ? KIMI_TIMEOUT_MS
        : CODEX_TIMEOUT_MS; // codex and claude both fall through here
  const primaryMs = callerTimeoutMs ?? role.timeoutMs ?? providerDefault;
  const backupMs =
    role.backupTimeoutMs ?? Math.max(60000, Math.floor(primaryMs / 2));
  return { primaryMs, backupMs };
}

/**
 * Detect oversized phase prompts before they spawn a sub-agent.
 *
 * Returns ok=false when the prompt exceeds either char-count or file-path-count
 * thresholds (overridable via GSTACK_BUILD_MAX_PROMPT_CHARS / GSTACK_BUILD_MAX_FILES_PER_PHASE).
 * Caller is expected to fail the phase fast with the reason, saving the 15-min
 * primary-impl wait on a prompt that can't fit anyway.
 *
 * Missing inputFilePath returns ok:true — we don't break the caller for a
 * missing file; the spawn path will surface a real error.
 */
export interface PhaseScopeCheck {
  ok: boolean;
  reason?: string;
  promptChars: number;
  filePathMentions: number;
}

const FILE_PATH_RE = /[\w./-]+\.(?:ts|tsx|js|jsx|md|json|cm|yml|yaml|sh|py)\b/g;

export function checkPhaseScope(inputFilePath: string): PhaseScopeCheck {
  let content = "";
  try {
    content = fs.readFileSync(inputFilePath, "utf8");
  } catch {
    return { ok: true, promptChars: 0, filePathMentions: 0 };
  }
  const maxChars = envNumberOrDefault("GSTACK_BUILD_MAX_PROMPT_CHARS", 10000);
  const maxFiles = envNumberOrDefault("GSTACK_BUILD_MAX_FILES_PER_PHASE", 4);
  const promptChars = content.length;
  const matches = content.match(FILE_PATH_RE) ?? [];
  const filePathMentions = new Set(matches).size;
  if (promptChars > maxChars || filePathMentions > maxFiles) {
    return {
      ok: false,
      reason:
        `phase prompt is ${promptChars} chars / ${filePathMentions} distinct file paths; ` +
        `exceeds budget (max ${maxChars} chars or ${maxFiles} files). ` +
        `Decompose this phase, or raise GSTACK_BUILD_MAX_PROMPT_CHARS / GSTACK_BUILD_MAX_FILES_PER_PHASE.`,
      promptChars,
      filePathMentions,
    };
  }
  return { ok: true, promptChars, filePathMentions };
}

/**
 * F3: budget-aware fallback policy.
 *
 * The existing fallback contract (`primaryMs / 2`) assumes the failure mode
 * is a transient model service hiccup. When the primary actually TIMED OUT,
 * the failure mode is more likely "task too big for the budget" — and giving
 * the backup half the time the primary just exhausted produces "blind
 * execution": the backup model runs out of read budget, gives up on
 * `read_file` calls, and writes inferred edits.
 *
 * Policy:
 *   - On primary `error` (exit != 0 without timedOut): keep the half-budget
 *     contract. This is the "model hiccup" case the fallback was designed
 *     for. Caller invokes resolveFallbackForConfigured as before.
 *   - On primary `timeout`: re-check scope with a stricter threshold (half
 *     of GSTACK_BUILD_MAX_PROMPT_CHARS, defaulting to half the default).
 *       - If the input now trips the stricter scope check → return
 *         phase_oversized; no backup spawn. Caller surfaces a clear "split
 *         this phase" verdict instead of producing inferred edits.
 *       - Otherwise → escalate the backup timeout to the primary's budget.
 *         Same prompt, same time, different model — the actual fallback
 *         contract.
 *
 * Pure function: takes the failure kind, the primary's resolved timeout,
 * the input file size in bytes, and a stricter threshold; returns the
 * dispatch verdict. cli.ts/dispatch site is responsible for converting
 * `phase_oversized` into the SubAgentResult shape callers expect.
 */
export type TimeoutFallbackVerdict =
  | { kind: "halved_budget"; timeoutMs: number }
  | { kind: "escalate_budget"; timeoutMs: number }
  | { kind: "phase_oversized"; reason: string };

export function resolveTimeoutFallback(opts: {
  primaryFailureKind: "timeout" | "error";
  primaryTimeoutMs: number;
  inputFileSize: number;
  strictThresholdBytes: number;
}): TimeoutFallbackVerdict {
  // Non-timeout failures: keep existing half-budget contract.
  if (opts.primaryFailureKind === "error") {
    return {
      kind: "halved_budget",
      timeoutMs: Math.max(60000, Math.floor(opts.primaryTimeoutMs / 2)),
    };
  }
  // Timeout: re-check scope with a stricter threshold.
  if (opts.inputFileSize > opts.strictThresholdBytes) {
    return {
      kind: "phase_oversized",
      reason:
        `phase prompt is ${opts.inputFileSize} bytes; ` +
        `exceeds stricter post-timeout threshold of ${opts.strictThresholdBytes} bytes. ` +
        `Primary timed out on this size, so the backup would too. Decompose the phase, ` +
        `or raise GSTACK_BUILD_MAX_PROMPT_CHARS to widen the threshold.`,
    };
  }
  // Timeout but scope re-check passed: same budget the primary had.
  return { kind: "escalate_budget", timeoutMs: opts.primaryTimeoutMs };
}

export type Verdict = "pass" | "fail" | "unclear";

export interface SubAgentResult {
  /** Captured stdout (also written to logPath). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Exit code; null if process was killed by signal. */
  exitCode: number | null;
  /**
   * True if killed by the stall watchdog (no stdout/stderr activity for
   * stallMs). Aliased to `timedOut` for backwards compatibility with
   * call-site code that branches on `timedOut`; both flags carry the
   * same meaning under liveness semantics.
   */
  timedOut: boolean;
  /**
   * Explicit flag set when the stall watchdog fired. Disambiguates a stall
   * kill (no activity) from a transport/crash failure. Always equal to
   * `timedOut` today.
   */
  stallKilled: boolean;
  /**
   * Number of ms of stdout/stderr silence the stall watchdog observed
   * before firing SIGTERM. Zero when stallKilled is false. Populated
   * from the watchdog so renderRoleStepFailure can produce a precise
   * "<role> stalled (no output for Nms, killed by watchdog)" message
   * instead of the misleading raw "exit null" surface. Optional for
   * back-compat with hygieneFailureResult and phase-oversized paths
   * that never invoke the watchdog.
   */
  stallSilenceMs?: number;
  /**
   * The POSIX signal name (SIGTERM/SIGKILL/SIGINT/etc) when the child
   * was killed by signal rather than exiting normally. Null otherwise.
   * Lets renderRoleStepFailure distinguish a signal_killed result from
   * an "exited with null" result of unknown origin. Optional for the
   * same reason as stallSilenceMs.
   */
  exitSignal?: string | null;
  /**
   * Why the stall watchdog killed, when stallKilled is true. Absent
   * otherwise. See stall-watchdog.ts killReason() for the union.
   */
  killReason?: string;
  /**
   * Last classified tool at kill time. Null when never classified or
   * tool-aware path inactive.
   */
  lastTool?: string | null;
  /** Last classified bucket at kill time. */
  lastBucket?: "fast" | "slow" | null;
  /** Absolute path to the log file written for this invocation. */
  logPath: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Number of retries used (0 if first attempt succeeded). */
  retries: number;
  /**
   * True when this result was produced by cli.ts:hygieneFailureResult
   * because the post-agent hygiene gate caught a worktree mutation.
   * Optional for back-compat with existing call sites; set by
   * hygieneFailureResult itself. Distinguishes hygiene rejections from
   * other exitCode=1 outcomes (provider crash, transport failure, etc).
   */
  hygieneFailure?: boolean;
}

/**
 * Map a CLI binary name to a Provider for the stall watchdog's classifier.
 * Falls back to "shell" for anything that isn't a known sub-agent CLI
 * (tests, ship, git ops). The fallback uses any-non-empty-line activity,
 * which is correct for shell-driven workflows that print progress to stdout
 * but don't emit structured tool-use events.
 */
function pickProviderForBin(bin: string): Provider {
  if (bin === CODEX_BIN) return "codex";
  if (bin === CLAUDE_BIN) return "claude";
  if (bin === KIMI_BIN) return "kimi";
  if (bin === geminiBin()) return "gemini";
  if (bin === process.env.GEMINI_BIN) return "gemini";
  return "shell";
}

/**
 * Pick the parser for a provider, or `null` to disable tool-aware
 * windowing for this subagent. Null is returned when the env-var kill
 * switch is set OR the provider has no useful parser (shell etc.).
 *
 * Exported for tests in __tests__/sub-agents-parser-pick.test.ts.
 */
export function pickParserForProvider(
  provider: Provider,
): ((line: string, now: number) => ProgressEvent | null) | null {
  if (process.env.GSTACK_TOOL_AWARE_WATCHDOG === "0") return null;
  switch (provider) {
    case "gemini":
      return parseGeminiLine;
    case "codex":
      return parseCodexLine;
    case "kimi":
      return parseKimiLine;
    case "claude":
      return parseClaudeLine;
    default:
      return null;
  }
}

/**
 * Spawn a child, capture stdout+stderr to a log file, and resolve with
 * structured result. Closes stdin if `closeStdin` (Codex needs this).
 *
 * Liveness model: instead of passing `timeout` to execFile (which kills the
 * child after N total ms regardless of activity), we attach a StallWatchdog
 * that fires only after `stallMs` of silence on stdout+stderr. Same env-var
 * names (GSTACK_BUILD_*_TIMEOUT), new semantics: the value is now a stall
 * window, not a wall-clock budget. A sub-agent that keeps emitting tool-use
 * or status lines runs as long as it needs.
 *
 * Trust contract for `logPath`: caller is responsible for ensuring the path
 * is bounded to a known state directory. spawnCaptured does NOT normalize
 * or boundary-check the path. Today's callers all pass derived paths under
 * ~/.gstack/build-state/<slug>/; do not pass user-influenced strings here
 * without prior resolveSafe(). The exported surface is for orchestrator
 * subagents only — not a general-purpose spawn helper.
 *
 * Log content is sensitive: child stdio routinely includes secrets in
 * flight. The log file is created with mode 0600 to constrain ACL. The
 * file format itself (header at top, [OUT]/[ERR] channel-tagged live body,
 * footer at end) is documented in build/orchestrator/README.md (per
 * TODOS.md T-FMT) and is not part of the orchestrator's public contract.
 */
export function spawnCaptured(args: {
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
    let stallKilled = false;
    let stallSilenceMs = 0;
    let firstTokenKilled = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // Live log streaming: open the log file when the child spawns so callers
    // can `tail -f` it instead of waiting for child close to see anything.
    // Pre-streaming, finish() did a single fs.writeFileSync at the end, which
    // is why /ship-driven e2e runs appeared frozen for 10+ min while the
    // Kimi subagent produced 100MB+ of stdout that nobody could see.
    let ws: fs.WriteStream | null = null;
    let loggedStreamError = false;
    try {
      // mode 0600: child stdio routinely surfaces secrets in flight (env
      // dumps, API keys in HTTP traces, full prompts). The buffered model
      // had the same exposure but only at close; the streaming model
      // extends the read window to "anytime during the run." Constrain
      // the file ACL to the running user so backup daemons, IDE indexers,
      // and gbrain ingest can't race-read partial dumps.
      ws = fs.createWriteStream(args.logPath, { mode: 0o600 });
      // Use ws.on (not once) so reentrant errors don't crash the process,
      // but gate the user-visible warn behind loggedStreamError so we
      // log it at most once per spawn — a damaged stream can emit
      // multiple 'error' events from subsequent write attempts.
      ws.on("error", (err) => {
        if (loggedStreamError) return;
        loggedStreamError = true;
        console.warn(
          `[spawn] log writer error for ${args.logPath}: ${err.message}; ` +
            `continuing without log streaming`,
        );
      });
      // Header at TOP (preserves existing log-format contract — downstream
      // tooling that greps `# command:` from the head of the file still works).
      // Final result metadata (duration, exit, byte counts) lands in finish()
      // via ws.end(footer) — single fd, no separate appendFileSync race.
      ws.write(
        `# command: ${args.bin} ${args.argv.map(quote).join(" ")}\n` +
          `# cwd: ${args.cwd || process.cwd()}\n` +
          `# started: ${new Date(startedAt).toISOString()}\n` +
          `\n# ---- live output ----\n`,
      );
    } catch {
      // createWriteStream sync-throws on extreme cases (e.g. logPath dir
      // doesn't exist). finish() detects ws === null and skips ws.end().
      loggedStreamError = true;
      ws = null;
    }

    // Use spawn (not execFile) for two reasons:
    //   1. We need real-time stream events for the StallWatchdog. execFile
    //      callback only fires at completion.
    //   2. child-registry.spawn reliably sets `detached: true` so the child
    //      gets its own pgrp — `process.kill(-pid, signal)` then reaches the
    //      full process tree (shell + grandchildren). Bun's execFile shim
    //      doesn't always honor `detached: true`, so group signals miss the
    //      grandchildren (e.g. a `sleep 10` under a shell script).
    const child = registeredSpawn(args.bin, args.argv, {
      cwd: args.cwd,
      shell: args.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const truncate = (buf: string) => {
      // Match execFile's maxBuffer behavior: drop everything past MAX_BUFFER
      // and continue accumulating from the new tail. Keeps memory bounded.
      if (buf.length > MAX_BUFFER) {
        return buf.slice(buf.length - MAX_BUFFER);
      }
      return buf;
    };

    // Channel-prefixed live write with backpressure and per-channel
    // line-start tracking.
    //
    // The naive form (split on /(?<=\n)/, prefix every non-empty slice)
    // corrupts logs in two ways:
    //   1. Chunk split mid-line: child emits "foo " then "bar\n", we'd
    //      write `[OUT] foo [OUT] bar\n` — a spurious mid-line prefix.
    //   2. Cross-channel interleave: OUT "foo " then ERR "warn\n" then
    //      OUT "bar\n" would write `[OUT] foo [ERR] warn\n[OUT] bar\n` —
    //      readers see "foo warn" as a single ERR line, completely wrong.
    //
    // Fix: track per-channel `atLineStart` state. Only prepend a prefix
    // when we're starting a new line. On a channel switch mid-line, inject
    // a synthetic newline first so the new channel's prefix lands at line
    // start. Trailing partials at finish() get flushed with a final
    // newline (see finish() below).
    //
    // Channel terminators: we treat both \n and \r as terminators so
    // \r-driven progress bars (curl, wget, npm, pytest tqdm — common in
    // the e2e subagents this orchestrator runs) don't spill prefixes
    // mid-line.
    let lastChannel: "OUT" | "ERR" | null = null;
    let stdoutAtLineStart = true;
    let stderrAtLineStart = true;
    function writeChannel(channel: "OUT" | "ERR", text: string): void {
      if (!ws) return;
      if (text.length === 0) return;

      // Channel switch mid-line: the previous channel emitted text but
      // did not end with a terminator. Inject a synthetic newline so
      // we don't smear two channels together on one visible line.
      const prevChannelAtLineStart =
        channel === "OUT" ? stdoutAtLineStart : stderrAtLineStart;
      let prelude = "";
      if (
        lastChannel !== null &&
        lastChannel !== channel &&
        !(lastChannel === "OUT" ? stdoutAtLineStart : stderrAtLineStart)
      ) {
        prelude = `[${lastChannel}] (cont)\n`;
        if (lastChannel === "OUT") stdoutAtLineStart = true;
        else stderrAtLineStart = true;
      }

      // Walk the chunk, splitting on \n and \r terminators. Each segment
      // is "everything up to and including the next terminator" (or the
      // tail if no terminator). Prefix when starting a new line.
      let out = prelude;
      let i = 0;
      let atLineStart = prevChannelAtLineStart || prelude.length > 0;
      const len = text.length;
      while (i < len) {
        // Find the next terminator at or after i.
        let j = i;
        while (j < len && text[j] !== "\n" && text[j] !== "\r") j++;
        // Segment text[i..j) is the body up to (but excluding) the
        // terminator; text[j] is either the terminator or end-of-text.
        const hasTerminator = j < len;
        const body = text.slice(i, j);
        const terminator = hasTerminator ? text[j] : "";

        if (atLineStart && (body.length > 0 || hasTerminator)) {
          out += `[${channel}] `;
        }
        out += body + terminator;
        atLineStart = hasTerminator;

        i = j + (hasTerminator ? 1 : 0);
      }

      if (channel === "OUT") stdoutAtLineStart = atLineStart;
      else stderrAtLineStart = atLineStart;
      lastChannel = channel;

      const ok = ws.write(out);
      if (!ok) {
        // Honor backpressure so a high-volume dump can't blow memory.
        // Pause BOTH channels (not just the one that observed the falsy
        // write) — the other channel writes through the same single fd
        // and would otherwise pile up in the writer's internal buffer
        // even after the active channel paused, defeating the bound.
        //
        // F6 mitigation: also stamp the watchdog's activity timer so the
        // forced pause isn't misread as agent silence. The watchdog
        // observes stdio 'data' events; pausing both channels stops
        // those events entirely. Without proactive stamping, a slow disk
        // that takes longer than args.timeoutMs to drain would let the
        // watchdog conclude the child went silent and stall-kill it —
        // even though we paused it. notifyActivity() is wired by
        // attachStallWatchdog later in this function; declare a forward
        // hook on the watchdog handle once it's attached. For now we
        // record the pause time; finish() reads it for diagnostics.
        backpressurePauses++;
        backpressurePausedAt = Date.now();
        child.stdout?.pause();
        child.stderr?.pause();
        ws.once("drain", () => {
          if (backpressurePausedAt) {
            backpressurePausedMs += Date.now() - backpressurePausedAt;
            backpressurePausedAt = 0;
          }
          // Stamp activity on resume so the watchdog's "silence since
          // last data event" counter is reset to NOW, not to whenever
          // the last pre-pause data event fired. The watchdog handle
          // exposes notifyActivity() once attached (added below).
          watchdogActivityHook?.();
          child.stdout?.resume();
          child.stderr?.resume();
        });
      }
    }

    // F6 instrumentation: counters and a hook the watchdog can install
    // to receive proactive activity signals from the backpressure path.
    // The watchdog itself is attached below; the hook stays null until
    // then. Tests can introspect backpressurePauses/Ms via the result
    // object if we ever surface it; for now they're internal.
    let backpressurePauses = 0;
    let backpressurePausedAt = 0;
    let backpressurePausedMs = 0;
    let watchdogActivityHook: (() => void) | null = null;

    let firstTokenTimer: unknown = null;
    let firstTokenKillTimer: unknown = null;
    const firstTokenDeadlineMs = envNumberOrDefault(
      "GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS",
      120000,
    );
    const clearFirstTokenTimers = () => {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer as ReturnType<typeof setTimeout>);
        firstTokenTimer = null;
      }
      if (firstTokenKillTimer) {
        clearTimeout(firstTokenKillTimer as ReturnType<typeof setTimeout>);
        firstTokenKillTimer = null;
      }
    };
    const noteFirstToken = () => {
      if (stdoutBytes + stderrBytes > 0) clearFirstTokenTimers();
    };
    if (firstTokenDeadlineMs > 0) {
      firstTokenTimer = setTimeout(() => {
        if (stdoutBytes + stderrBytes > 0 || stallKilled) return;
        firstTokenKilled = true;
        stallKilled = true;
        stallSilenceMs = firstTokenDeadlineMs;
        if (typeof child.pid === "number") {
          killProcessAndGroup(child.pid, "SIGTERM");
          firstTokenKillTimer = setTimeout(() => {
            if (typeof child.pid === "number") {
              killProcessAndGroup(child.pid, "SIGKILL");
            }
          }, 5000);
        }
      }, firstTokenDeadlineMs);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutBytes += text.length;
      noteFirstToken();
      stdoutBuf = truncate(stdoutBuf + text);
      writeChannel("OUT", text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBytes += text.length;
      noteFirstToken();
      stderrBuf = truncate(stderrBuf + text);
      writeChannel("ERR", text);
    });

    // Watchdog mode: default auto selects CPU liveness when the platform
    // supports process-group CPU sampling, otherwise stream liveness.
    const watchdogMode = resolveWatchdogMode();
    if (watchdogMode.warning) {
      process.stderr.write(`gstack-build: ${watchdogMode.warning}\n`);
    }
    ws?.write(
      `# watchdog_mode: ${watchdogMode.mode} (${watchdogMode.source})\n`,
    );
    const provider = pickProviderForBin(args.bin);
    const parseProgress = pickParserForProvider(provider);
    const watchdog = attachStallWatchdog(
      watchdogMode.mode === "cpu"
        ? { mode: "cpu", child }
        : { mode: "stream", child },
      {
        stallMs: args.timeoutMs,
        provider,
        onStallKill: (silenceMs) => {
          stallKilled = true;
          stallSilenceMs = silenceMs;
        },
        ...(parseProgress
          ? {
              parseProgress,
              toolStallMs: TOOL_AWARE_STALL_MS,
              progressGapMs: PROGRESS_GAP_MS,
            }
          : {}),
      },
    );

    // F6 wire-up: when backpressure pauses both stdio streams, the
    // stream-mode watchdog stops seeing 'data' events even though the
    // child is actually busy producing output. Stamp the watchdog on
    // resume so the silence-since-last-activity counter starts from
    // NOW, not from whenever the last pre-pause data event fired.
    // cpu-mode watchdog reads kernel CPU time directly so it doesn't
    // need this hook; the call is a cheap recordActivity() either way.
    watchdogActivityHook = () => watchdog.notifyActivity();

    if (args.closeStdin) child.stdin?.end();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearFirstTokenTimers();
      watchdog.stop();
      // If the watchdog killed us, treat as timedOut. Otherwise a SIGTERM/
      // SIGKILL signal means an external killer (not the watchdog) — surface
      // as a non-timeout failure.
      const timedOut = stallKilled;

      // Footer goes through the SAME fd as the streamed body. Calling
      // ws.end(footerBytes) on a stream that already wrote the header and
      // body is race-free, unlike the pre-streaming model that did a single
      // fs.writeFileSync on close. If we ever opened a separate fd with
      // appendFileSync after ws.end(), buffered ws writes could land AFTER
      // the appended footer and corrupt the log.
      const footer =
        (loggedStreamError
          ? `\n# WARNING: log writer hit error; body may be truncated\n`
          : "") +
        `\n# ---- result ----\n` +
        `# duration_ms: ${Date.now() - startedAt}\n` +
        `# timed_out: ${timedOut}\n` +
        `# stall_killed: ${stallKilled}\n` +
        `# stall_silence_ms: ${stallSilenceMs}\n` +
        `# exit: ${exitCode ?? signal ?? "unknown"}\n` +
        `# stdout_bytes: ${stdoutBytes}\n` +
        `# stderr_bytes: ${stderrBytes}\n`;

      // Flush any trailing partial lines so the final log doesn't leave a
      // dangling prefix-less segment on either channel. The body terminates
      // with a clean newline before the footer; readers grepping `^\[OUT\]`
      // / `^\[ERR\]` see complete lines.
      let partialFlush = "";
      if (!stdoutAtLineStart && lastChannel === "OUT") partialFlush += "\n";
      if (!stderrAtLineStart && lastChannel === "ERR") partialFlush += "\n";

      // Build a promise that resolves when the log file is fully flushed
      // to disk. This matters because callers (and tests) often read
      // logPath immediately after awaiting spawnCaptured — if we resolve
      // before ws.end()'s flush completes, the reader sees a partial file
      // missing the footer (and possibly the last few stdout/stderr
      // chunks too). The 'finish' event fires after all buffered writes
      // are flushed to the OS write buffer (close to but not identical
      // to fsync; close enough for the post-close read pattern in
      // practice).
      //
      // If the stream already errored before finish(), do NOT await
      // another event — the stream is destroyed and no further events
      // will fire. loggedStreamError tracks this so we resolve
      // immediately rather than hanging on a stream that won't emit.
      //
      // No flush ceiling: the previous implementation had a 1s setTimeout
      // safety net that silently truncated legitimate slow flushes on NFS
      // / encrypted / CI disks. The 'finish'/'close'/'error' events from
      // Node's WritableStream are guaranteed to fire (one of them always
      // does); awaiting them as long as they need is correct. The only
      // failure shape where none fire is a Node bug, and we'd rather
      // surface that as a hang the operator notices than a silent
      // truncated log shipped through detectBlindExecution.
      const logFlushed: Promise<void> =
        ws && !loggedStreamError
          ? new Promise<void>((resolveFlush) => {
              let settled = false;
              const settle = () => {
                if (settled) return;
                settled = true;
                resolveFlush();
              };
              ws!.once("finish", settle);
              ws!.once("close", settle);
              ws!.once("error", settle);
              try {
                ws!.end(partialFlush + footer);
              } catch {
                // ws already in error state. settle() will fire via the
                // 'error' listener registered above. If for some reason
                // it doesn't, force-destroy and settle so we don't hang.
                try {
                  ws!.destroy();
                } catch {
                  // destroy errors are swallowed; we're already on the
                  // failure path.
                }
                settle();
              }
            })
          : (() => {
              // No live stream (createWriteStream sync-threw at spawn time).
              // Fall back to a single best-effort sync write so the log
              // file at least exists.
              try {
                fs.writeFileSync(
                  args.logPath,
                  `# command: ${args.bin} ${args.argv.map(quote).join(" ")}\n` +
                    `# cwd: ${args.cwd || process.cwd()}\n` +
                    `# started: ${new Date(startedAt).toISOString()}\n` +
                    `# WARNING: live log stream unavailable\n` +
                    footer +
                    `\n# ---- stdout (post-mortem) ----\n${stdoutBuf}\n` +
                    `# ---- stderr (post-mortem) ----\n${stderrBuf}\n`,
                );
              } catch {
                // Log file write failures shouldn't sink the orchestrator.
              }
              return Promise.resolve();
            })();

      logFlushed.then(() => {
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode,
          timedOut,
          stallKilled,
          stallSilenceMs,
          exitSignal,
          killReason: firstTokenKilled
            ? "first_token_timeout"
            : watchdog.killReason(),
          lastTool: watchdog.lastTool(),
          lastBucket: watchdog.lastBucket(),
          logPath: args.logPath,
          durationMs: Date.now() - startedAt,
          retries: 0,
        });
      });
    };

    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    // Resolve on 'close', not 'exit'. Node fires 'exit' as soon as the child
    // process ends, but stdio pipes may still have buffered data not yet
    // delivered via 'data' events. 'close' fires only after all stdio
    // streams have been fully drained. Resolving on 'exit' truncates the
    // final stdout/stderr chunk (final tool-use JSON, Codex 403/429 line,
    // test failure summary) and corrupts the captured log. The old execFile
    // callback waited for close internally.
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once("close", () => {
      if (settled) return;
      settled = true;
      finish(exitCode, exitSignal);
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      // Spawn failure (ENOENT, EACCES, etc.) — close may not fire.
      stderrBuf += `\n# spawn error: ${err.message}\n`;
      finish(null, null);
    });
  });
}

function quote(s: string): string {
  if (/^[a-zA-Z0-9_\/\.\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Stage Gemini I/O files in ~/.gemini/tmp/<deriveGeminiTmpKey(cwd)>/ —
 * Gemini's `--yolo` sandbox auto-whitelists that path based on the spawned
 * process's working directory.
 *
 * Why deriveGeminiTmpKey(cwd), not basename(cwd) or opts.slug:
 * Gemini stores its tmp allowlist in ~/.gemini/projects.json under a
 * SANITIZED form of `basename(cwd)` — lowercase, non-alphanumeric runs
 * collapsed to single `-`, leading/trailing `-` trimmed (see
 * state.ts:deriveGeminiTmpKey). PR #49 used `basename(opts.cwd)` raw,
 * which still diverges from Gemini's allowlist for worktrees with `_`,
 * `.`, or uppercase in the basename. The mitosis-prototype-socc26-v022a-
 * schema-v3_1 worktree on this machine is a real example: orchestrator
 * was writing to `~/.gemini/tmp/...v3_1.../`, Gemini allowed
 * `~/.gemini/tmp/...v3-1.../`. deriveGeminiTmpKey closes that gap.
 *
 * Why opts.slug IS in the staged filename:
 * Dual-impl runs (build/orchestrator/worktree.ts) always produce
 * worktrees named `primary` and `secondary`, so two concurrent builds
 * of different plans would collide on ~/.gemini/tmp/primary/ if the
 * filename only carried phase/iteration/suffix. The slug disambiguates
 * parallel runs sharing a sanitized basename(cwd).
 *
 * Why process.pid is ALSO in the staged filename:
 * Two concurrent runs that happen to derive the same slug (e.g. retry
 * loops, replay-style debugging) would still collide at the filename
 * level. The pid is a per-process discriminator that catches this finer
 * shape without changing directory semantics.
 *
 * History:
 *   - ~/.gemini/tmp/gstack/<slug>/ — broken: T111646, fixed 2026-05-17
 *     (67480efe).
 *   - ~/.gemini/tmp/<slug>/ where slug = `build-<runId>` — still broken:
 *     `build-` prefix divergence. Fixed 2026-05-18.
 *   - ~/.gemini/tmp/<basename(cwd)>/ — still broken: dual-impl + raw
 *     basename divergence on worktrees with `_`/`.`/uppercase. Fixed in
 *     two commits, PR #49 (cwd-derivation + slug-in-filename) and this
 *     one (full sanitization via deriveGeminiTmpKey + pid discriminator).
 *
 * Exported so build/orchestrator/__tests__/sub-agents.test.ts can pin
 * the cross-system invariants (sanitized basename(cwd) equals Gemini's
 * whitelist key; opts.slug + pid appear in the filename to disambiguate
 * parallel runs).
 *
 * Returns { stagedInput, stagedOutput, cleanup }.
 * Call cleanup() after spawnCaptured returns; it copies the output back to
 * outputFilePath and deletes both staged files. The copy and the delete are
 * in separate try/catch blocks so a copy failure surfaces (instead of being
 * swallowed) and the delete still runs regardless.
 */
export function stageGeminiIO(opts: {
  cwd: string;
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
    deriveGeminiTmpKey(opts.cwd),
  );
  fs.mkdirSync(stagingDir, { recursive: true });

  const slugSegment = opts.slug.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const base = `gstack-gemini-${slugSegment}-${opts.phaseNumber}-${opts.iteration}-${opts.suffix}-${process.pid}`;
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

  const result = await spawnCaptured({
    bin: kimiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? KIMI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  // Under liveness semantics, a stall-kill means the agent went silent —
  // retrying with the same stall window is provably no improvement. Stalls
  // surface to the caller's fallback path; transport failures (handled
  // elsewhere) still retry.
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

  const codexAuth = await assertCodexAuth();
  if (!codexAuth.ok) {
    return {
      stdout: "",
      stderr: codexAuth.reason ?? "Codex auth preflight failed",
      exitCode: 1,
      timedOut: false,
      stallKilled: false,
      logPath: "",
      durationMs: 0,
      retries: 0,
    };
  }

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

  // Stall kills are NOT retried — same stall window will stall again.
  // Transport-failure retry below is a separate failure mode (Codex 403/429/
  // stream-disconnect / TLS reset) and stays enabled.
  //
  // Broad "no-verdict" retry: any non-zero exit where the staged output
  // file has no GATE PASS/FAIL marker is treated as a transient. Catches
  // 403/429/5xx, stream disconnects (already matched by
  // isLikelyCodexTransportFailure), and any future transport-layer
  // failure that doesn't get a chance to write the verdict line. A real
  // review failure writes GATE FAIL into the output and is NOT retried.
  // One-shot retry; if the second attempt also dies without a verdict,
  // fail honestly.
  if (result.exitCode !== 0) {
    let stagedOutputContent = "";
    try {
      stagedOutputContent = fs.readFileSync(stagedOutput, "utf8");
    } catch {
      // Empty path counts as no verdict.
    }
    const noVerdict = parseVerdict(stagedOutputContent) === "unclear";
    const transportShape = isLikelyCodexTransportFailure(result);
    if (noVerdict || transportShape) {
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
  allowedTools?: readonly string[];
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
  return [
    ...(opts.model ? ["--model", opts.model] : []),
    "-p",
    prompt,
    ...(opts.allowedTools && opts.allowedTools.length > 0
      ? ["--allowedTools", ...opts.allowedTools]
      : []),
  ];
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

  const geminiAuth = await assertGeminiAuth();
  if (!geminiAuth.ok) {
    return {
      stdout: "",
      stderr: geminiAuth.reason ?? "Gemini auth preflight failed",
      exitCode: 1,
      timedOut: false,
      stallKilled: false,
      logPath: "",
      durationMs: 0,
      retries: 0,
    };
  }

  const {
    stagedInput,
    stagedOutput,
    cleanup: cleanupStaged,
  } = stageGeminiIO({
    cwd: opts.cwd,
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

  const result = await spawnCaptured({
    bin: geminiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: true,
    ...(process.env.GSTACK_KEEP_GEMINI_STDIN_OPEN === "1"
      ? { closeStdin: false }
      : {}),
  });

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
  const result = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? CODEX_TIMEOUT_MS,
    logPath,
    closeStdin: true,
  });
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
    timeoutMs?: number;
    backupTimeoutMs?: number;
  };
  land: {
    provider: RoleProvider;
    model: string;
    reasoning: RoleReasoning;
    command: string;
    backupProvider?: RoleProvider;
    backupModel?: string;
    timeoutMs?: number;
    backupTimeoutMs?: number;
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
    // role.timeoutMs (set by configure.cm or env) takes precedence inside
    // runConfiguredRoleTask via resolveRoleTimeouts; caller default stays SHIP_TIMEOUT_MS.
    timeoutMs: opts.ship.timeoutMs ?? SHIP_TIMEOUT_MS,
    gate: false,
  });

  // Bail out before /land-and-deploy if /ship failed.
  if (shipResult.timedOut || shipResult.exitCode !== 0) {
    return shipResult;
  }

  // Ship contract: the sub-agent MUST write its report to shipOutput. An empty
  // file means the inner /ship slash command skipped the write step (Kimi's
  // --final-message-only just echoed the path) or the staging-dir copy-back
  // silently dropped a zero-byte file. Treat that as a hard failure so cli.ts
  // doesn't propagate it as phantom success and run the verified-PR gate
  // against an empty transcript.
  const shipText = (() => {
    try {
      return fs.readFileSync(shipOutput, "utf8");
    } catch {
      return "";
    }
  })();
  if (shipText.trim() === "") {
    return {
      ...shipResult,
      exitCode: 1,
      stderr:
        `# ship output file ${shipOutput} is empty — sub-agent did not write a report. ` +
        `Original captured streams preserved in ${shipResult.logPath}.\n${shipResult.stderr}`,
    };
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
    timeoutMs: opts.land.timeoutMs ?? SHIP_TIMEOUT_MS,
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
    timeoutMs?: number;
    backupTimeoutMs?: number;
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

export interface RunConfiguredRoleTaskOpts {
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
  /**
   * Run identifier matching wrap-console.ts's keying
   * (`state.launch?.runId ?? state.slug`). Threaded from cli.ts call sites
   * that have access to state.launch.runId so the Class 4 RESOLVED emit's
   * pair key matches the DETECTED row wrap-console wrote. When undefined
   * (older callers, direct test fixtures), fall back to opts.slug — same
   * default helperCtxFor uses.
   */
  runId?: string;
}

/**
 * Build the recursive runConfiguredRoleTask opts for the backup fallback path.
 *
 * Explicitly clears codexDefaultCommand (caller-specific). Backup uses
 * resolved.backupMs as its stall window (half of effective primary, floored
 * at 60s) — caller-passed opts.timeoutMs is intentionally NOT propagated;
 * the backup gets its own budget.
 */
export function resolveFallbackForConfigured(
  parentOpts: RunConfiguredRoleTaskOpts,
  resolved: ReturnType<typeof resolveRoleTimeouts>,
): RunConfiguredRoleTaskOpts {
  const backupProvider = parentOpts.role.backupProvider!;
  return {
    ...parentOpts,
    timeoutMs: resolved.backupMs,
    logPrefix: `${parentOpts.logPrefix}-backup-${backupProvider}`,
    codexDefaultCommand: undefined,
    role: {
      provider: backupProvider,
      // Empty string when backupModel is absent: argv builders use falsy check
      // (e.g. `opts.model ? ["-m", opts.model] : []`), so "" suppresses the flag
      // and the provider uses its configured default.
      model: parentOpts.role.backupModel ?? "",
      reasoning: parentOpts.role.reasoning,
      command: parentOpts.role.command,
    },
  };
}

// Roles whose prompts span multiple files and benefit from oversized-phase
// fail-fast. Matched on opts.logPrefix because that's the canonical role tag
// the orchestrator passes through (kimi-impl, primary-impl, test-fixer, etc.).
const ENFORCE_SCOPE_ROLES = new Set(["primary-impl", "test-fixer"]);

/**
 * Opts shape for the CLI's internal phase dispatcher (cli.ts::runRoleTask).
 * Mirrors RunConfiguredRoleTaskOpts but without codexDefaultCommand/sandbox —
 * the CLI dispatcher uses runCodexImpl (not runCodexReview), so codex-specific
 * review opts don't apply.
 */
export interface RunRoleTaskOpts {
  role: RoleConfig;
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  logPrefix: string;
  timeoutMs?: number;
  /**
   * Run identifier matching wrap-console.ts's keying
   * (`state.launch?.runId ?? state.slug`). Threaded so the Class 4 RESOLVED
   * emit's pair key matches the DETECTED row wrap-console wrote for the
   * fallback warn. When undefined, defaults to opts.slug.
   */
  runId?: string;
}

/**
 * Build the recursive cli.ts::runRoleTask opts for the backup fallback path.
 * Parallel to resolveFallbackForConfigured but for cli.ts::runRoleTask's narrower
 * opts shape (no codexDefaultCommand, no sandbox).
 */
export function resolveFallbackForRoleTask(
  parentOpts: RunRoleTaskOpts,
  resolved: ReturnType<typeof resolveRoleTimeouts>,
): RunRoleTaskOpts {
  const backupProvider = parentOpts.role.backupProvider!;
  return {
    ...parentOpts,
    timeoutMs: resolved.backupMs,
    logPrefix: `${parentOpts.logPrefix}-backup-${backupProvider}`,
    role: {
      provider: backupProvider,
      model: parentOpts.role.backupModel ?? "",
      reasoning: parentOpts.role.reasoning,
      command: parentOpts.role.command,
    },
  };
}

export async function runConfiguredRoleTask(
  opts: RunConfiguredRoleTaskOpts,
): Promise<SubAgentResult> {
  const resolved = resolveRoleTimeouts(opts.role, opts.timeoutMs);
  const effectiveTimeoutMs = resolved.primaryMs;

  // Oversized-phase fail-fast for implementation roles. Saves a wasted
  // primary spawn when the prompt obviously can't fit. Operator overrides via
  // GSTACK_BUILD_MAX_PROMPT_CHARS / GSTACK_BUILD_MAX_FILES_PER_PHASE.
  if (ENFORCE_SCOPE_ROLES.has(opts.logPrefix)) {
    const check = checkPhaseScope(opts.inputFilePath);
    if (!check.ok) {
      fs.writeFileSync(opts.outputFilePath, "");
      return {
        stdout: "",
        stderr: `phase_oversized: ${check.reason}`,
        exitCode: 1,
        timedOut: false,
        stallKilled: false,
        logPath: "",
        durationMs: 0,
        retries: 0,
      };
    }
  }

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
      timeoutMs: effectiveTimeoutMs,
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
      timeoutMs: effectiveTimeoutMs,
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
      timeoutMs: effectiveTimeoutMs,
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
      timeoutMs: effectiveTimeoutMs,
    });
  }

  // MIRROR: cli.ts::runRoleTask runs an identical fallback via
  // resolveFallbackForRoleTask. The two functions exist because the CLI's
  // internal phase dispatcher and this slash-command dispatcher accept
  // different opt shapes (codexDefaultCommand, sandbox).
  if ((result.timedOut || result.exitCode !== 0) && opts.role.backupProvider) {
    // F3: budget-aware fallback. On primary.timedOut, re-check scope with
    // a stricter threshold. If the input is too big, surface phase_oversized
    // directly instead of letting Gemini run on half-budget and produce
    // blind-execution edits. If scope passes, escalate the backup timeout
    // to match the primary so the fallback runs on the same budget the
    // primary just exhausted.
    const inputFileSize = (() => {
      try {
        return fs.statSync(opts.inputFilePath).size;
      } catch {
        return 0;
      }
    })();
    const maxChars = envNumberOrDefault("GSTACK_BUILD_MAX_PROMPT_CHARS", 10000);
    const verdict = resolveTimeoutFallback({
      primaryFailureKind: result.timedOut ? "timeout" : "error",
      primaryTimeoutMs: resolved.primaryMs,
      inputFileSize,
      strictThresholdBytes: Math.floor(maxChars / 2),
    });

    if (verdict.kind === "phase_oversized") {
      console.warn(
        `[gstack-build] ${opts.logPrefix}: primary ${opts.role.provider} timed out; ` +
          `${verdict.reason} Skipping backup spawn.`,
      );
      fs.writeFileSync(opts.outputFilePath, "");
      return {
        stdout: "",
        stderr: `phase_oversized: ${verdict.reason}`,
        exitCode: 1,
        timedOut: false,
        logPath: result.logPath,
        durationMs: result.durationMs,
        retries: result.retries,
      };
    }

    // Build the warn message once so we can re-key the paired RESOLVED on
    // success. The DETECTED row is written by wrap-console.ts when console.warn
    // fires below; computeFaultId hashes (kind, idx, message) and wrap-console
    // emits with kind=SOFT_HALT_WARN, idx="all" (no phase/feature on its
    // snapshot), message=msg.slice(0,500). Our string is well under 500 chars
    // in practice so the slice is a no-op, and computeFaultId here will
    // produce the exact same faultId wrap-console computes for the DETECTED.
    const fallbackMsg =
      `[gstack-build] ${opts.logPrefix}: primary ${opts.role.provider} failed ` +
      `(exit=${result.exitCode ?? "null"}, timedOut=${result.timedOut}); ` +
      `falling back to ${opts.role.backupProvider} with timeout ${verdict.timeoutMs}ms (single-shot, ${verdict.kind})`;
    // runId MUST match what wrap-console.ts keys on for the DETECTED row
    // (`state.launch?.runId ?? state.slug`). Otherwise pair-collapse keys
    // diverge and the RESOLVED never matches its DETECTED twin. Resolution
    // order: opts.runId (explicit), GSTACK_BUILD_RUN_ID (set by cli.ts at
    // launch), opts.slug (back-compat default).
    const fallbackRunId =
      opts.runId ?? process.env.GSTACK_BUILD_RUN_ID ?? opts.slug;
    const fallbackFaultId = computeFaultId({
      kind: "SOFT_HALT_WARN",
      runId: fallbackRunId,
      stateSlug: opts.slug,
      severity: "LOW",
      message: fallbackMsg.slice(0, 500),
      pointers: {
        stateFile: "",
        stdoutLog: "",
        livingPlan: "",
        worktreePath: opts.cwd,
      },
      snapshot: { stdoutTail: "" },
    });
    console.warn(fallbackMsg);
    // Zero stale primary output before backup runs. If backup also fails, the
    // caller gets an empty outputFilePath plus the backup's non-zero exit code.
    fs.writeFileSync(opts.outputFilePath, "");
    // Pass the verdict's budget through resolved so the recursive call's
    // resolveRoleTimeouts honors it. We override resolved.backupMs only when
    // escalate_budget fired; halved_budget keeps the existing math.
    const fallbackResolved = {
      ...resolved,
      backupMs: verdict.timeoutMs,
    };
    const backupResult = await runConfiguredRoleTask(
      resolveFallbackForConfigured(opts, fallbackResolved),
    );
    // Class 4 fix: pair the DETECTED warn with a RESOLVED marker when the
    // backup succeeded. The queue consumer (drain-faults pair-collapse pass)
    // drops both rows pre-dispatch, saving the cost of investigating a
    // transient primary failure that already recovered via backup. On backup
    // failure, leave the DETECTED in pending/ — the warning IS real audit
    // signal in that case.
    if (backupResult.exitCode === 0 && !backupResult.timedOut) {
      emitHaltEventResolved(fallbackFaultId, fallbackRunId);
    }
    return backupResult;
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
 *   Priority 1b — JS framework configs in subdirectories (beats Priority 1
 *   pytest-only signals like `pyproject.toml [tool.pytest.ini_options]` or
 *   `setup.cfg [tool:pytest]`, but NOT an explicit `pytest.ini` at cwd):
 *     BFS subdir walk, depth 3, 100ms budget, ignores node_modules/.git/
 *     vendor/etc. Shallowest hit wins. Mirrors the monorepo case where a
 *     parent repo has a pytest tooling block at root but the feature under
 *     test lives in a TS package (e.g. mitosis-prototype/openclaw/).
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
/**
 * Read `gstack.testCmd: <command>` from CLAUDE.md at the project root.
 * Returns the trimmed command string, or null when:
 *   - CLAUDE.md does not exist
 *   - the line is missing
 *   - the value side is empty / whitespace only
 *
 * This is Priority 0 in inspectProject: a project-level escape hatch that
 * beats every heuristic. CLAUDE.md's "Platform-agnostic design" rule says
 * the project owns its config; gstack reads it.
 */
export function readClaudeMdTestCmd(cwd: string): string | null {
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  let body: string;
  try {
    body = fs.readFileSync(claudeMdPath, "utf8");
  } catch {
    return null;
  }
  // Match "gstack.testCmd: <value>" at the start of a line. Value ends at
  // newline. Allow horizontal whitespace around the colon, but NOT newlines
  // (so an empty value on its own line doesn't slurp the next paragraph).
  const match = body.match(/^gstack\.testCmd[ \t]*:[ \t]*([^\n]*)$/m);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

export function inspectProject(
  cwd: string,
  opts: { now?: () => number } = {},
): ProjectInspection {
  const now = opts.now ?? (() => Date.now());
  const evidence: string[] = [];

  // Priority 0 — explicit CLAUDE.md override. Beats every heuristic. Per
  // CLAUDE.md "Platform-agnostic design": the project owns its config;
  // gstack reads it. This is the escape hatch for multi-language repos
  // (Go service with Node tooling sidecar, etc.) where the tie-break
  // heuristic flips to the wrong runner.
  const override = readClaudeMdTestCmd(cwd);
  if (override) {
    evidence.push("CLAUDE.md gstack.testCmd override");
    return { runner: override, framework: null, evidence };
  }

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

  // Priority 1b — JS framework config in subdirectory. Beats the pytest
  // tooling-block signals below (pyproject.toml / setup.cfg) because those
  // are weak/conventional and a monorepo can legitimately carry both. An
  // explicit `pytest.ini` at cwd above is treated as a hard override.
  const subdirHit = findFrameworkConfigInSubdirs(cwd, now);
  if (subdirHit) {
    evidence.push(`framework-config: ${subdirHit.relativePath}`);
    return {
      runner: frameworkToRunner(subdirHit.framework, cwd),
      framework: subdirHit.framework,
      evidence,
    };
  }

  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    const toml = safeReadFile(path.join(cwd, "pyproject.toml"));
    if (toml.includes("[tool.pytest.ini_options]")) {
      evidence.push(
        "framework-config: pyproject.toml [tool.pytest.ini_options]",
      );
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
      if (hasGo) return { runner: "go test ./...", framework: "go", evidence };
      if (hasCargo)
        return { runner: "cargo test", framework: "cargo", evidence };
      if (hasPyproject)
        return { runner: "pytest", framework: "pytest", evidence };
    }
    const winner = pickMajority(counts);
    if (winner === "ts") {
      // Bias the runner toward whatever the JS project would use.
      const runner = resolveJsPkgManagerTest(cwd) ?? "npx vitest run";
      // Framework stays null — we know it's a JS project but not which
      // framework. The LLM falls back to repo-inspection.
      return { runner, framework: null, evidence };
    }
    if (winner === "py")
      return { runner: "pytest", framework: "pytest", evidence };
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

// Bounded BFS for JS framework configs in subdirectories. Shallowest hit
// wins; same-depth ties resolve in priority order (vitest > jest >
// playwright). Skips the same ignore set the tie-break walker uses
// (TIE_BREAK_IGNORE) plus dotdirs.
const SUBDIR_CONFIG_DEPTH = 3;
const SUBDIR_CONFIG_BUDGET_MS = 100;
const SUBDIR_CONFIG_CANDIDATES: Array<{
  framework: Extract<Framework, "vitest" | "jest" | "playwright">;
  files: string[];
}> = [
  {
    framework: "vitest",
    files: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
  },
  {
    framework: "jest",
    files: [
      "jest.config.ts",
      "jest.config.js",
      "jest.config.cjs",
      "jest.config.mjs",
    ],
  },
  {
    framework: "playwright",
    files: ["playwright.config.ts", "playwright.config.js"],
  },
];

export function findFrameworkConfigInSubdirs(
  cwd: string,
  now: () => number,
): { framework: Framework; relativePath: string } | null {
  const start = now();
  // BFS so shallow hits beat deep ones. We only descend into dirs whose
  // names pass the ignore filter, and we keep depth <= SUBDIR_CONFIG_DEPTH.
  // Depth 0 (cwd itself) is excluded — that's already covered by the
  // cwd-only Priority 1 checks above.
  type QueueItem = { dir: string; depth: number };
  const queue: QueueItem[] = [];

  // Seed the queue with the immediate children of cwd.
  let cwdEntries: fs.Dirent[];
  try {
    cwdEntries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of cwdEntries) {
    if (!e.isDirectory()) continue;
    if (TIE_BREAK_IGNORE.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    queue.push({ dir: path.join(cwd, e.name), depth: 1 });
  }

  while (queue.length > 0) {
    if (now() - start > SUBDIR_CONFIG_BUDGET_MS) return null;
    const { dir, depth } = queue.shift()!;

    // Check for any framework config at this directory.
    for (const candidate of SUBDIR_CONFIG_CANDIDATES) {
      for (const file of candidate.files) {
        if (fs.existsSync(path.join(dir, file))) {
          const rel = path
            .relative(cwd, path.join(dir, file))
            .split(path.sep)
            .join("/");
          return { framework: candidate.framework, relativePath: rel };
        }
      }
    }

    if (depth >= SUBDIR_CONFIG_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (TIE_BREAK_IGNORE.has(e.name)) continue;
      if (e.name.startsWith(".")) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
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
  const arr: Array<["ts" | "py" | "go" | "rs", number]> = [
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
        (/\.test\.tsx?$/.test(name) ||
          /\.test\.js$/.test(name) ||
          /\.spec\.tsx?$/.test(name))
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
    cwd: opts.cwd,
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

  const result = await spawnCaptured({
    bin: geminiBin(),
    argv,
    cwd: opts.cwd,
    timeoutMs: GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  // Stall kills aren't retried under liveness semantics — same stall window
  // would just stall again. Caller can surface this via result.stallKilled.
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
 * Mirrors runRoleTask's structure: file-path I/O, captured output, single retry
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
  timeoutMs?: number;
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

  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;

  const result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs,
    logPath,
    closeStdin: true,
  });

  cleanup();
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * Build the argv for the feature-level review (not a phase review and not an
 * implementation pass). Two things this gets right that buildCodexImplArgv
 * gets wrong when it's misused for feature-review:
 *
 *  1. The prompt tells codex it is a REVIEWER. It must read the prepared
 *     review prompt from inputFilePath verbatim, then write a verdict-shaped
 *     report with `## VERDICT\n<FEATURE_PASS|FEATURE_NEEDS_PHASES|FEATURE_REDO>`
 *     to outputFilePath. The prompt explicitly forbids editing any other file.
 *
 *  2. Sandbox = `workspace-write` (default). NOT `read-only`. Under codex
 *     CLI v0.128+, `-s read-only` blocks ALL filesystem writes including the
 *     reviewer's own output file → empty staged output → MISSING_VERDICT
 *     every iteration → false halt-with-BLOCKED after 2 iterations. This was
 *     the failure mode independent adversarial reviews flagged before ship.
 *
 *     The defense-in-depth model is now:
 *       a) Prompt instruction: "Do NOT edit any file in the worktree"
 *          (deterministic for compliant reviewers, advisory for adversarial)
 *       b) Hygiene gate at cli.ts:applyMutableAgentHygiene catches any
 *          worktree mutation post-spawn and converts it to HYGIENE_FAULT
 *       c) Same-shape repeat detector halts the loop after 2 identical
 *          HYGIENE_FAULTs (cli.ts outer loop)
 *
 *     Override via `GSTACK_BUILD_CODEX_FEATURE_REVIEW_SANDBOX` if you need a
 *     stricter or looser sandbox.
 */
export function buildCodexFeatureReviewArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  sandbox?: CodexSandbox;
  reasoning?: RoleReasoning;
  model?: string;
}): string[] {
  const codexPrompt = [
    `You are the feature-level reviewer for gstack-build.`,
    `Read the review brief at ${opts.inputFilePath} verbatim — it contains the feature body, phase summaries, commit log, and the EXACT verdict template you must emit.`,
    `Do NOT edit any file in the worktree. Do NOT run git commit. Your only write target is ${opts.outputFilePath}.`,
    `When done, write your report to ${opts.outputFilePath} starting with a section literally headed "## VERDICT" followed by one of FEATURE_PASS, FEATURE_NEEDS_PHASES, or FEATURE_REDO on the next non-blank line, then a "## Findings" section.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(" ");

  const sandbox =
    opts.sandbox ||
    (process.env.GSTACK_BUILD_CODEX_FEATURE_REVIEW_SANDBOX as
      | CodexSandbox
      | undefined) ||
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
 * Run a single feature-review iteration via Codex. Companion to runCodexImpl
 * but for the reviewer role: reviewer prompt + read-only sandbox + the
 * `## VERDICT` sentinel contract that parseFeatureReviewVerdict requires.
 *
 * Why this exists: feature-review previously routed through runCodexImpl
 * (designed for the implementor half of a dual-impl tournament). The
 * implementor prompt tells codex to "implement changes autonomously" and
 * write a "files changed / tests run / what's verified" summary — which
 * never contains the VERDICT sentinel, so the parser sees UNCLEAR every
 * time, and the outer loop maps UNCLEAR onto TIMEOUT for the dashboard.
 * Combined with workspace-write letting the reviewer mutate the tree
 * (tripping post-agent hygiene), this produces an infinite loop of TIMEOUT
 * verdicts that never converge. See plans/this-issue-is-the-streamed-stream.md
 * for the full root-cause writeup.
 */
export async function runCodexFeatureReview(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  /** Feature identifier, e.g. "feature-1". Used for log filenames. */
  phaseNumber: string;
  iteration: number;
  reasoning?: RoleReasoning;
  model?: string;
  logPrefix?: string;
  timeoutMs?: number;
  sandbox?: CodexSandbox;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const { stagedInput, stagedOutput, cleanup } = stageCodexIO({
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    suffix: opts.logPrefix ?? "feature-review",
    cwd: opts.cwd,
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
  });

  const argv = buildCodexFeatureReviewArgv({
    inputFilePath: stagedInput,
    outputFilePath: stagedOutput,
    cwd: opts.cwd,
    sandbox: opts.sandbox,
    reasoning: opts.reasoning,
    model: opts.model,
  });

  const logName = opts.logPrefix ?? "feature-review";
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${logName}-${opts.iteration}.log`,
  );

  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;

  const result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs,
    logPath,
    closeStdin: true,
  });

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

  const result = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: JUDGE_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  // Stall kills aren't retried under liveness semantics — same stall window
  // would just stall again. The judge caller flags timedOut in the result.
  return mergeOutputFile(result, opts.outputFilePath, {
    emptyFileIsError: true,
  });
}
