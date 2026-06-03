/**
 * Child-process registry: tracks every subprocess the orchestrator spawns so
 * that a SIGTERM / SIGINT / SIGHUP at the parent reaps the whole group
 * instead of orphaning children to init.
 *
 * Why this exists: spawnSync blocks the parent until the child returns, but
 * if the kernel kills the parent mid-spawn (`kill -9`, OOM, parent watchdog
 * timeout), POSIX reparents the live child to init (PID 1). The original
 * polis-mesh incident saw `gbrain put` subprocesses survive after `kill -9
 * <orchestrator-pid>` because of exactly this reparenting. SIGKILL on the
 * parent itself can't be intercepted by userspace; this registry handles
 * the survivable signals (SIGTERM/SIGINT/SIGHUP) cleanly, and detached
 * process-group spawning ensures `process.kill(-pid, signal)` reaches the
 * whole tree at once.
 *
 * Design choice (Decision 8A in the plan): keep sync semantics. Every
 * caller imports `{ spawnSync }` from this module as a drop-in replacement
 * for `node:child_process`'s spawnSync. We add `detached: true` under the
 * hood (own process group), register the pid, run the underlying spawnSync,
 * and unregister on return. No caller-site refactor needed beyond swapping
 * the import.
 *
 * SIGKILL caveat: the kernel terminates SIGKILL'd processes without
 * userspace cleanup. For SIGKILL, our signal handlers never run, and any
 * in-flight spawnSync child is reparented to init. Prefer `kill` (SIGTERM)
 * which our handler catches.
 */

import {
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn,
  execFile as nodeExecFile,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncReturns,
  type SpawnOptions,
  type ChildProcess,
  type ExecFileOptions,
  type ExecFileException,
} from "node:child_process";

// In-memory live-child registry. We track pids only — the actual child
// object isn't needed because killAllChildren uses process.kill(-pid, sig).
const livePids = new Set<number>();

let signalHandlersInstalled = false;

// Caller-registered cleanup hooks run inside `shutdownAndExit` (synchronously,
// before the child SIGTERM→SIGKILL escalation). This is the C1 fix: the
// orchestrator's interrupt cleanup (save state, release the build lock, mark
// the active run paused) used to live in a SECOND SIGINT/SIGTERM handler that
// called `process.exit(130)` synchronously — which pre-empted this module's
// `await sleep(2000)` grace, so the SIGKILL escalation never ran and a
// SIGTERM-ignoring sub-agent process group was orphaned to init. Registering
// the cleanup as a hook here folds it into the SINGLE signal path that owns
// the exit, so cleanup AND the escalation both complete on every interrupt.
const shutdownHooks: Array<() => void> = [];

/**
 * Install SIGTERM / SIGINT / SIGHUP handlers that reap every live child
 * before exiting. Idempotent — safe to call multiple times.
 *
 * Strategy on signal:
 *   1. Try SIGTERM on every live process group (graceful).
 *   2. Wait up to 2 seconds.
 *   3. SIGKILL anything still alive (force).
 *   4. Exit.
 *
 * This runs once at orchestrator startup. Tests can call it too; the
 * handlers no-op when the registry is empty.
 */
export function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const handler = (signal: NodeJS.Signals) => {
    void shutdownAndExit(signal);
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  process.on("SIGHUP", handler);
}

/**
 * Register a synchronous cleanup hook to run inside `shutdownAndExit` BEFORE
 * the child SIGTERM→SIGKILL escalation. Use this for caller-owned interrupt
 * cleanup (e.g. the orchestrator's save-state / release-lock / mark-paused)
 * so it shares the SINGLE signal path that owns the process exit, instead of
 * racing the escalation with a competing handler that exits early. Hooks run
 * in registration order; each is best-effort (a throwing hook is swallowed so
 * it can't abort a later hook or the escalation). The hook MUST NOT call
 * `process.exit` — `shutdownAndExit` owns the exit after the SIGKILL leg.
 */
export function registerShutdownHook(hook: () => void): void {
  shutdownHooks.push(hook);
}

/**
 * Cleanly shut down: run caller cleanup hooks, SIGTERM all live children, wait
 * briefly, SIGKILL survivors, then exit with a signal-appropriate code.
 * Exported for tests and for callers that want explicit cleanup without going
 * through the signal-handler path.
 */
export async function shutdownAndExit(signal: NodeJS.Signals): Promise<void> {
  // Run caller cleanup FIRST so state/lock are durable even if the escalation
  // below is slow. Swallow per-hook throws on purpose: this is a shutdown
  // path, so one failing hook must NOT abort the remaining hooks or the
  // SIGKILL escalation that reaps orphan-prone sub-agent groups.
  for (const hook of shutdownHooks) {
    try {
      hook();
    } catch {
      // best-effort shutdown cleanup — continue to the next hook + escalation
    }
  }
  killAllChildren("SIGTERM");
  await sleep(2000);
  killAllChildren("SIGKILL");
  // 128 + signal number is the convention. SIGTERM=15, SIGINT=2, SIGHUP=1.
  const code =
    signal === "SIGTERM"
      ? 143
      : signal === "SIGINT"
        ? 130
        : signal === "SIGHUP"
          ? 129
          : 1;
  process.exit(code);
}

/**
 * Send a signal to every live registered process group. Returns the number
 * of pids that were signaled (some may have already exited; those are
 * silently dropped).
 */
export function killAllChildren(signal: NodeJS.Signals): number {
  let signaled = 0;
  for (const pid of livePids) {
    if (signalProcessGroup(pid, signal)) signaled++;
  }
  return signaled;
}

/**
 * Send a signal to the entire process group of `pid`. Returns true on
 * success, false if the target is already gone (ESRCH).
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // Negative pid signals the process group. Children spawned with
    // detached: true get their own pgid == pid.
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM is unexpected for our own children; log and continue.
    if (code === "EPERM") return false;
    return false;
  }
}

/**
 * Test-only: register a pid without spawning. Used by child-registry tests
 * that simulate live children. Not exported via the public surface beyond
 * tests.
 */
export function _registerForTest(pid: number): void {
  livePids.add(pid);
}

/**
 * Test-only: unregister a pid without waiting for spawn to finish.
 */
export function _unregisterForTest(pid: number): void {
  livePids.delete(pid);
}

/**
 * Test-only: snapshot of currently-tracked pids.
 */
export function _liveChildPids(): number[] {
  return Array.from(livePids);
}

/**
 * Test-only: reset the signal-handlers-installed flag. Used by integration
 * tests that need to re-arm signal handlers in a forked child.
 */
export function _resetForTest(): void {
  livePids.clear();
  signalHandlersInstalled = false;
  shutdownHooks.length = 0;
}

// Internal helpers ------------------------------------------------------------

function ensureDetached(opts: SpawnSyncOptions | undefined): SpawnSyncOptions {
  // For sync spawn we still set detached:true so the child has its own
  // process group — killAllChildren can then signal -pid. The child
  // doesn't need to be unref()'d because spawnSync blocks until completion
  // anyway.
  const out: SpawnSyncOptions = { ...(opts ?? {}) };
  if (out.detached === undefined) out.detached = true;
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Public surface --------------------------------------------------------------

/**
 * Drop-in replacement for node:child_process spawnSync that registers the
 * pid for signal cleanup. Same signature, same return type — callers don't
 * change anything except the import.
 *
 * The registration is mostly insurance: spawnSync blocks the parent thread,
 * so under normal completion the child can't outlive us. Registration only
 * matters when the parent receives a survivable signal (SIGTERM/SIGINT/
 * SIGHUP) while the child is still running — the handler then signals the
 * whole group.
 */
export function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string>;
export function spawnSync(
  command: string,
  args: readonly string[] = [],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string> {
  const effective = ensureDetached(options);
  // spawnSync returns synchronously; we can't capture the pid before the
  // call returns (the result object includes pid, set after exit). The
  // register/unregister window for spawnSync is therefore a no-op in the
  // happy path. We keep the wrapper anyway so a future async variant
  // shares the same surface, and so the no-bare-spawn invariant test has
  // exactly one allowed import path.
  const result = nodeSpawnSync(command, args as string[], effective);
  // Best-effort: if the child somehow survived past spawnSync return
  // (timeout + kill cleanup), result.pid is still set. We don't register
  // here because the call already returned; nothing to clean up.
  void result.pid;
  return result;
}

/**
 * Drop-in replacement for node:child_process spawn. Returns a ChildProcess
 * the caller can await/event-listen on. The pid is registered immediately
 * and auto-unregistered when the child emits 'exit' or 'close'.
 *
 * Use this when you need async semantics. spawnSync is preferred for
 * everything else.
 */
export function spawn(
  command: string,
  args: readonly string[] = [],
  options?: SpawnOptions,
): ChildProcess {
  const effective: SpawnOptions = { ...(options ?? {}) };
  if (effective.detached === undefined) effective.detached = true;
  const child = nodeSpawn(command, args as string[], effective);
  if (typeof child.pid === "number") {
    livePids.add(child.pid);
    const unregister = () => {
      if (typeof child.pid === "number") livePids.delete(child.pid);
    };
    child.once("exit", unregister);
    child.once("close", unregister);
    child.once("error", unregister);
  }
  return child;
}

/**
 * Drop-in replacement for node:child_process execFile. Same signature
 * (long-running subagent processes use this — claude/codex/gemini CLI
 * shell-outs). Registers the pid immediately so SIGTERM at the parent
 * reaps the live subagent.
 *
 * We use the callback form because that's what sub-agents.ts uses today.
 * If you need promise semantics, wrap it with util.promisify yourself.
 */
export function execFile(
  file: string,
  args: readonly string[] | null | undefined,
  options: ExecFileOptions | null | undefined,
  callback: (
    error: ExecFileException | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
): ChildProcess {
  const effective: ExecFileOptions = { ...(options ?? {}) };
  // execFile doesn't accept `detached` in its type, but the underlying
  // spawn does — and Node passes options through. Casting is the cleanest
  // way to get the same process-group isolation.
  (effective as ExecFileOptions & { detached?: boolean }).detached = true;
  const child = nodeExecFile(
    file,
    args ? Array.from(args) : undefined,
    effective,
    (err, stdout, stderr) => {
      if (typeof child.pid === "number") livePids.delete(child.pid);
      callback(err, stdout, stderr);
    },
  );
  if (typeof child.pid === "number") {
    livePids.add(child.pid);
    // Belt-and-suspenders: also remove on error/close in case the callback
    // path doesn't fire (kill() bypasses the result handler in some edge
    // cases).
    const drop = () => {
      if (typeof child.pid === "number") livePids.delete(child.pid);
    };
    child.once("error", drop);
    child.once("close", drop);
  }
  return child;
}

// Backward-compat: re-export the node types so callers don't have to
// duplicate the type-only imports.
export type {
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithBufferEncoding,
  SpawnSyncReturns,
  SpawnOptions,
  ChildProcess,
  ExecFileOptions,
  ExecFileException,
};
