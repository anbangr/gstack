import {
  emitHaltEvent,
  type HaltEvent,
  type HaltEventKind,
  type HaltSeverity,
} from "./halt-events";

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
          snapshot: { stdoutTail: "" },
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
          snapshot: { stdoutTail: "" },
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
