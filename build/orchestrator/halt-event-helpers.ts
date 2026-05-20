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
