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

// ------------------------------------------------------------------
// classifyProviderFailure — decide if a halt was actually a provider
// failure (capacity/quota/overloaded/transport/auth/stall) and should
// be re-classified rather than counted as a convergence/retry-cap
// failure. PR1b core.
// ------------------------------------------------------------------

export type ProviderFailureKind =
  | "capacity"
  | "quota"
  | "overloaded"
  | "transport"
  | "auth"
  | "stall";

export interface ProviderFailureVerdict {
  kind: ProviderFailureKind;
  evidence: string;
  resetAt?: string;
}

const PROVIDER_CAPACITY_RE =
  /MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available for model|API Error: 529 Overloaded/i;
const PROVIDER_OVERLOADED_RE =
  /\b529\b.*(?:Overloaded|overloaded)|provider (?:is )?overloaded/i;
const PROVIDER_QUOTA_RE =
  /You've hit your (?:weekly )?limit|usage limit reached|quota exceeded|insufficient quota/i;
const PROVIDER_TRANSPORT_RE =
  /ECONNRESET|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN|socket hang up|read ECONNRESET|HTTP\/2 stream .* refused/i;
const PROVIDER_AUTH_RE =
  /authentication required|please (?:log in|sign in|re-?authenticate)|invalid (?:api )?key|401 Unauthorized|token expired/i;
const PROVIDER_RESET_AT_RE =
  /resets? at ([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i;

/**
 * Classify halt evidence (concatenated stdout/stderr/log text plus
 * sub-agent timing flags) into a provider-failure kind, or null when
 * the failure looks like genuine convergence/code failure.
 *
 * Pure function so it's unit-testable without filesystem. Callers read
 * the log file (or sub-agent result) and pass the text plus flags.
 */
export function classifyProviderFailure(input: {
  text: string;
  stallKilled?: boolean;
  timedOut?: boolean;
}): ProviderFailureVerdict | null {
  const text = input.text ?? "";

  // Auth wins over everything: it'll never self-resolve.
  if (PROVIDER_AUTH_RE.test(text)) {
    return {
      kind: "auth",
      evidence: firstMatchSnippet(text, PROVIDER_AUTH_RE),
    };
  }
  // Quota: account out of credits; don't retry.
  if (PROVIDER_QUOTA_RE.test(text)) {
    const evidence = firstMatchSnippet(text, PROVIDER_QUOTA_RE);
    const resetMatch = text.match(PROVIDER_RESET_AT_RE);
    return {
      kind: "quota",
      evidence,
      resetAt: resetMatch ? resetMatch[1] : undefined,
    };
  }
  // Capacity / overloaded: transient server-side.
  if (PROVIDER_CAPACITY_RE.test(text)) {
    return {
      kind: "capacity",
      evidence: firstMatchSnippet(text, PROVIDER_CAPACITY_RE),
    };
  }
  if (PROVIDER_OVERLOADED_RE.test(text)) {
    return {
      kind: "overloaded",
      evidence: firstMatchSnippet(text, PROVIDER_OVERLOADED_RE),
    };
  }
  // Transport-layer error before a verdict could land.
  if (PROVIDER_TRANSPORT_RE.test(text)) {
    return {
      kind: "transport",
      evidence: firstMatchSnippet(text, PROVIDER_TRANSPORT_RE),
    };
  }
  // Watchdog kill / wall-clock kill — last in precedence so explicit
  // banners win over the silent-stall heuristic.
  if (input.stallKilled || input.timedOut) {
    return {
      kind: "stall",
      evidence: input.stallKilled
        ? "sub-agent stdout silent past watchdog threshold"
        : "sub-agent exceeded wall-clock timeout",
    };
  }
  return null;
}

function firstMatchSnippet(text: string, re: RegExp): string {
  const m = text.match(re);
  if (!m) return "";
  // Return a short window around the match so the halt event has context
  // without dumping the entire log.
  const idx = m.index ?? 0;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + m[0].length + 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Emit the right halt kind for a classified provider failure. Returns
 * the halt-event id so callers can record it in state or halt-event
 * queue forensics.
 */
export function recordProviderFailureVerdict(
  state: BuildState,
  phaseIdx: number,
  role: string,
  verdict: ProviderFailureVerdict,
  ctx: HelperContext,
): string {
  switch (verdict.kind) {
    case "capacity":
    case "overloaded":
      return recordProviderOverloaded(
        state,
        phaseIdx,
        role,
        verdict.evidence,
        ctx,
      );
    case "quota":
      return recordProviderQuotaExhausted(
        state,
        phaseIdx,
        role,
        verdict.evidence,
        ctx,
        verdict.resetAt,
      );
    case "transport":
      return recordProviderTransportError(
        state,
        phaseIdx,
        role,
        verdict.evidence,
        ctx,
      );
    case "auth":
      return recordProviderAuthRequired(
        state,
        phaseIdx,
        role,
        verdict.evidence,
        ctx,
      );
    case "stall":
      return recordProviderTimeout(
        state,
        phaseIdx,
        role,
        verdict.evidence,
        ctx,
      );
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
