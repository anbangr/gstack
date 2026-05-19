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
