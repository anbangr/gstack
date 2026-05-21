import type { BuildState, PhaseStatus } from "./types";
import {
  emitHaltEvent,
  severityFor,
  buildHaltSnapshot,
  type HaltEvent,
  type HaltEventKind,
} from "./halt-events";

export interface HelperContext {
  runId: string;
  stateSlug: string;
  pointers: HaltEvent["pointers"];
  queueDir?: string;
}

function emit(
  kind: HaltEventKind,
  message: string,
  ctx: HelperContext,
  state: BuildState | null,
  phaseIndex?: number,
  featureIndex?: number,
  failureReason?: string,
): string {
  return emitHaltEvent(
    {
      kind,
      runId: ctx.runId,
      stateSlug: ctx.stateSlug,
      severity: severityFor(kind),
      message,
      pointers: ctx.pointers,
      snapshot: buildHaltSnapshot({
        state,
        stdoutLogPath: ctx.pointers.stdoutLog,
        worktreePath: ctx.pointers.worktreePath,
        phaseIndex,
        featureIndex,
        failureReason,
      }),
    },
    { queueDir: ctx.queueDir },
  );
}

export function markPhaseFailed(
  state: BuildState,
  phaseIdx: number,
  reason: string,
  ctx: HelperContext,
): string {
  if (state.phases[phaseIdx]) {
    state.phases[phaseIdx].status = "failed";
    state.phases[phaseIdx].error = reason;
  }
  return emit("PHASE_FAILED", reason, ctx, state, phaseIdx, undefined, reason);
}

export function markFeatureFailed(
  state: BuildState,
  featureIdx: number,
  reason: string,
  ctx: HelperContext,
): string {
  const f = state.features?.[featureIdx];
  if (f) {
    f.status = "failed";
    f.error = reason;
  }
  return emit(
    "FEATURE_FAILED",
    reason,
    ctx,
    state,
    undefined,
    featureIdx,
    reason,
  );
}

export function rewindPhase(
  state: BuildState,
  phaseIdx: number,
  toStatus: PhaseStatus,
  ctx: HelperContext,
): string {
  if (state.phases[phaseIdx]) {
    state.phases[phaseIdx].status = toStatus;
  }
  return emit(
    "PHASE_REWIND",
    `phase ${phaseIdx} rewound to ${toStatus}`,
    ctx,
    state,
    phaseIdx,
  );
}

export function recordRetryCapHit(
  state: BuildState,
  phaseIdx: number,
  capKind: "codex" | "testfix" | "dualimpl",
  iterations: number,
  ctx: HelperContext,
): string {
  return emit(
    "RETRY_CAP_HIT",
    `${capKind} hit cap after ${iterations} iterations`,
    ctx,
    state,
    phaseIdx,
  );
}

/**
 * Emit a MANUAL_RECOVERY_INVOKED audit event with investigate:false.
 *
 * Every manual-recovery cli entry point (drain-faults, mark-shipped,
 * --mark-phase-committed) calls this helper instead of emitting a raw
 * HaltEvent. Centralizing the emit ensures investigate:false is set in
 * exactly one place — the consumer's short-circuit will move every event
 * straight to processed/ without paying codex.
 *
 * Why no BuildState parameter: the drain-faults entry point fires before
 * any plan is loaded, so it has no state object. Callers that DO have
 * state can pass it via a future overload if a snapshot becomes useful;
 * today the audit event needs no per-phase context.
 */
// ------------------------------------------------------------------
// Provider-failure halt kinds
// ------------------------------------------------------------------

export const PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT" as const;
export const PROVIDER_QUOTA_EXHAUSTED = "PROVIDER_QUOTA_EXHAUSTED" as const;
export const PROVIDER_OVERLOADED = "PROVIDER_OVERLOADED" as const;
export const PROVIDER_TRANSPORT_ERROR = "PROVIDER_TRANSPORT_ERROR" as const;
export const PROVIDER_AUTH_REQUIRED = "PROVIDER_AUTH_REQUIRED" as const;

export function recordProviderTimeout(
  state: BuildState,
  phaseIdx: number,
  role: string,
  evidence: string,
  ctx: HelperContext,
): string {
  return emit("PROVIDER_TIMEOUT", `${role}: ${evidence}`, ctx, state, phaseIdx);
}

export function recordProviderQuotaExhausted(
  state: BuildState,
  phaseIdx: number,
  role: string,
  evidence: string,
  ctx: HelperContext,
  resetAt?: string,
): string {
  const msg = resetAt
    ? `${role}: ${evidence} · resets at ${resetAt}`
    : `${role}: ${evidence}`;
  return emit("PROVIDER_QUOTA_EXHAUSTED", msg, ctx, state, phaseIdx);
}

export function recordProviderOverloaded(
  state: BuildState,
  phaseIdx: number,
  role: string,
  evidence: string,
  ctx: HelperContext,
): string {
  return emit(
    "PROVIDER_OVERLOADED",
    `${role}: ${evidence}`,
    ctx,
    state,
    phaseIdx,
  );
}

export function recordProviderTransportError(
  state: BuildState,
  phaseIdx: number,
  role: string,
  evidence: string,
  ctx: HelperContext,
): string {
  return emit(
    "PROVIDER_TRANSPORT_ERROR",
    `${role}: ${evidence}`,
    ctx,
    state,
    phaseIdx,
  );
}

export function recordProviderAuthRequired(
  state: BuildState,
  phaseIdx: number,
  role: string,
  evidence: string,
  ctx: HelperContext,
): string {
  return emit(
    "PROVIDER_AUTH_REQUIRED",
    `${role}: ${evidence}`,
    ctx,
    state,
    phaseIdx,
  );
}

// ------------------------------------------------------------------
// FailureRender — structured view of why a role step failed
// ------------------------------------------------------------------

export type FailureRender =
  | { kind: "stalled"; summary: string; stallSilenceMs: number }
  | { kind: "timed_out"; summary: string }
  | { kind: "signal_killed"; signal: string }
  | { kind: "exited"; exitCode: number }
  | { kind: "auth_required"; summary: string };

/**
 * Convert a sub-agent result into a structured FailureRender.
 *
 * Precedence (first match wins):
 *   1. stallKilled  → stalled
 *   2. timedOut     → timed_out
 *   3. killReason   → auth_required (when "auth_required")
 *   4. exitSignal   → signal_killed
 *   5. exitCode     → exited
 */
export function renderRoleStepFailure(
  role: string,
  result: {
    stallKilled?: boolean;
    stallSilenceMs?: number;
    timedOut?: boolean;
    durationMs?: number;
    totalMs?: number;
    exitCode?: number | null;
    exitSignal?: string | null;
    killReason?: string;
  },
): FailureRender {
  if (result.stallKilled) {
    const ms = result.stallSilenceMs ?? 0;
    return {
      kind: "stalled",
      summary: `${role} stalled (no output for ${ms}ms, killed by watchdog)`,
      stallSilenceMs: ms,
    };
  }
  if (result.timedOut) {
    const ms = result.totalMs ?? result.durationMs ?? 0;
    return {
      kind: "timed_out",
      summary: `${role} timed out after ${ms}ms wall clock`,
    };
  }
  if (result.killReason === "auth_required") {
    return {
      kind: "auth_required",
      summary: `${role} halted: authentication required (try \`gemini auth login\` or \`codex auth login\`)`,
    };
  }
  if (result.exitCode === null && result.exitSignal) {
    return {
      kind: "signal_killed",
      signal: result.exitSignal,
    };
  }
  return {
    kind: "exited",
    exitCode: result.exitCode ?? 0,
  };
}

/**
 * Convenience: format a FailureRender as a single-line human-readable
 * message suitable for state.error / phase.error / failureReason. Wraps
 * `renderRoleStepFailure` so call sites in phase-runner.ts can replace
 * the legacy `\`<role> step failed: exit ${result.exitCode}\`` pattern
 * with one helper call. Critical for fixing the R4 cluster of stale
 * "exit null" / "exit 0" messages that hide stall kills, signal kills,
 * and interactive auth prompts.
 */
export function renderRoleStepFailureMessage(
  role: string,
  result: Parameters<typeof renderRoleStepFailure>[1],
): string {
  const fr = renderRoleStepFailure(role, result);
  switch (fr.kind) {
    case "stalled":
    case "timed_out":
    case "auth_required":
      return fr.summary;
    case "signal_killed":
      return `${role} killed by signal ${fr.signal}`;
    case "exited":
      return `${role} exited ${fr.exitCode}`;
  }
}

export function emitManualRecoveryInvoked(opts: {
  runId: string;
  stateSlug: string;
  message: string;
  pointers: HaltEvent["pointers"];
  /** Optional richer snapshot for sites that have BuildState context. */
  snapshot?: HaltEvent["snapshot"];
  queueDir?: string;
}): string {
  return emitHaltEvent(
    {
      kind: "MANUAL_RECOVERY_INVOKED",
      runId: opts.runId,
      stateSlug: opts.stateSlug,
      severity: severityFor("MANUAL_RECOVERY_INVOKED"),
      message: opts.message,
      investigate: false,
      pointers: opts.pointers,
      snapshot: opts.snapshot ?? { stdoutTail: "" },
    },
    { queueDir: opts.queueDir },
  );
}
