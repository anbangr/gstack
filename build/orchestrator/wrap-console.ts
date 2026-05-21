import {
  buildHaltSnapshot,
  emitHaltEvent,
  type HaltEvent,
  type HaltEventKind,
  type HaltSeverity,
} from "./halt-events";

/**
 * Patterns that match KNOWN-BENIGN warnings the orchestrator already
 * handles in-band. When console.warn matches one of these, wrap-console
 * skips the emit entirely — the orchestrator's existing logic owns the
 * recovery (e.g., state.ts:542 logs "local JSON is canonical" when the
 * gbrain put fails but the local JSON write already succeeded).
 *
 * The bar for inclusion: the warning itself documents that nothing is
 * broken. Don't add patterns where the warning hides a real problem.
 */
const KNOWN_BENIGN_WARN_PATTERNS: RegExp[] = [
  // state.ts:542 — gbrain put is best-effort; the local JSON write is
  // canonical so this is purely a cross-machine-sync miss, not a fault.
  /local JSON is canonical/,
  // state.ts migrateState — STATE_DRIFT is an operator warning with an
  // explicit recovery command, not an investigation-worthy halt event.
  /STATE_DRIFT:/,
];

export interface WrapConsoleContext {
  runId: string;
  stateSlug: string;
  pointers: HaltEvent["pointers"];
  queueDir?: string;
}

export interface Classification {
  kind: HaltEventKind;
  severity: HaltSeverity;
}

/**
 * Pattern table. Ordered: SILENT_STATE_MUTATION first (most specific),
 * then SOFT_HALT_WARN patterns. Unmatched lines fall through to the
 * default in classifyConsoleLine.
 *
 * These patterns deliberately echo the strings the orchestrator already
 * emits via console.warn / console.error. Updates should match real
 * production output, not theoretical strings.
 */
const PATTERNS: Array<{
  re: RegExp;
  kind: HaltEventKind;
  severity: HaltSeverity;
}> = [
  // SILENT_STATE_MUTATION: the polis hand-merged-feature class.
  // Also explicitly emitted at cli.ts:9548 in PR 2; the wrap-console
  // shim catches the same string from any other code path that prints
  // it via console.warn without going through the explicit emit.
  {
    re: /Re-processing the feature/i,
    kind: "SILENT_STATE_MUTATION",
    severity: "HIGH",
  },
  // Worktree cleanup failures — typically post-deploy housekeeping that
  // didn't crash anything but left orphans.
  { re: /worktree cleanup failed/i, kind: "SOFT_HALT_WARN", severity: "LOW" },
  // PR checks unsettled / not yet mergeable — usually transient, but
  // worth logging in case it correlates with downstream failures.
  {
    re: /PR check unsettled|PR not yet mergeable/i,
    kind: "SOFT_HALT_WARN",
    severity: "LOW",
  },
  // Branch deletion failures during ship cleanup.
  { re: /branch deletion failed/i, kind: "SOFT_HALT_WARN", severity: "LOW" },
];

export function classifyConsoleLine(
  level: "warn" | "error",
  msg: string,
): Classification {
  for (const p of PATTERNS) {
    if (p.re.test(msg)) return { kind: p.kind, severity: p.severity };
  }
  if (level === "error") {
    // The orchestrator's own error sigil: leading "✗ ".
    if (msg.startsWith("✗ ")) {
      return { kind: "SOFT_HALT_ERROR", severity: "MEDIUM" };
    }
    return { kind: "SOFT_HALT_ERROR", severity: "MEDIUM" };
  }
  return { kind: "SOFT_HALT_WARN", severity: "LOW" };
}

/**
 * Install a console.warn / console.error wrapper that classifies each line
 * into a halt-event kind and emits it to the queue. Original console
 * behavior is preserved (the wrapped function calls the original first,
 * then attempts emit).
 *
 * Env knob: GSTACK_HALT_EVENTS_OFF=1 short-circuits installation. Use
 * during debugging when you want stdout/stderr noise without queue churn.
 *
 * NODE_ENV=test guard: when running under bun:test without an explicit
 * queueDir, installation is a no-op so test runs don't spam the user's
 * real ~/.gstack/skill-faults/pending-investigations/.
 *
 * Returns an uninstall function. The wrapper rejects emit failures
 * silently so a broken queue dir never crashes the orchestrator.
 */
export function installWrapConsole(ctx: WrapConsoleContext): () => void {
  if (process.env.GSTACK_HALT_EVENTS_OFF === "1") return () => {};
  if (process.env.NODE_ENV === "test" && !ctx.queueDir) {
    return () => {};
  }

  const origWarn = console.warn;
  const origError = console.error;

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args as any);
    const msg = args.map(String).join(" ");
    if (KNOWN_BENIGN_WARN_PATTERNS.some((re) => re.test(msg))) return;
    const c = classifyConsoleLine("warn", msg);
    try {
      emitHaltEvent(
        {
          kind: c.kind,
          runId: ctx.runId,
          stateSlug: ctx.stateSlug,
          severity: c.severity,
          message: msg.slice(0, 500),
          pointers: ctx.pointers,
          snapshot: buildHaltSnapshot({
            state: null,
            stdoutLogPath: ctx.pointers.stdoutLog,
            worktreePath: ctx.pointers.worktreePath,
          }),
        },
        { queueDir: ctx.queueDir },
      );
    } catch {
      // Never let the wrapper crash the orchestrator.
    }
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args as any);
    const msg = args.map(String).join(" ");
    const c = classifyConsoleLine("error", msg);
    try {
      emitHaltEvent(
        {
          kind: c.kind,
          runId: ctx.runId,
          stateSlug: ctx.stateSlug,
          severity: c.severity,
          message: msg.slice(0, 500),
          pointers: ctx.pointers,
          snapshot: buildHaltSnapshot({
            state: null,
            stdoutLogPath: ctx.pointers.stdoutLog,
            worktreePath: ctx.pointers.worktreePath,
          }),
        },
        { queueDir: ctx.queueDir },
      );
    } catch {
      // ignore
    }
  };

  return () => {
    console.warn = origWarn;
    console.error = origError;
  };
}
