# Subagent Progress Reporting for Watchdog Decisions

**Date:** 2026-05-21
**Status:** Spec — pending review
**Scope:** `build/orchestrator/` — stall-watchdog, sub-agents, halt-events
**Out of scope:** Operator UI, target-loop detection, orchestrator-heartbeat enrichment

## Problem

The stall-watchdog in [build/orchestrator/stall-watchdog.ts](build/orchestrator/stall-watchdog.ts) detects subagent stalls via process-level liveness signals: any non-empty stdout line, CPU delta, or file mtime. This is a single timer per subagent — if `lastActivityAt` falls more than `stallMs` behind `now`, the process gets SIGTERM.

That model has two failure classes today:

1. **False-positive kills.** A legitimately-busy subagent (Codex review, Kimi long-form generation, Gemini editing a large file) can stay silent on stdout for several minutes while the LLM call is mid-flight. With a flat `stallMs`, the watchdog kills it; the same-budget retry kills it again; the operator sees `phase_oversized` or `silent_kill` halt events for work that was actually fine.

2. **Silent-stuck despite noisy stdout.** A subagent can also thrash — emitting tool output, log lines, progress prose — without making any classifiable forward progress. Today's watchdog treats every non-empty line as activity. A subagent stuck looping over the same internal state never trips the stall timer.

The monitor's `recentProcessActivity` check (in [build/orchestrator/monitor.ts](build/orchestrator/monitor.ts)) inherits both failure classes because it reads the same raw mtime signal.

## Goal

Give the stall-watchdog and monitor a structured progress signal from each spawned subagent so they can:

- Apply a longer stall window when the subagent has declared it is mid-tool-call on a known long-running tool (e.g., `WebFetch`, `codex_review`).
- Apply a tighter stall window when the subagent has declared it is mid-tool-call on a known short tool (e.g., `Edit`, `Read`).
- Detect "noisy stdout but no classifiable progress for N minutes" as a stall signal independent of raw stdout activity.
- Emit a human-quotable kill reason in `halt-events` that names the last classified activity, not just `silent for stallMs`.

## Non-goals

- Not a UI / operator visibility surface. A separate plan can layer that on the structured events later.
- Not a target-loop detector ("stuck on `foo.ts` for 4 min"). Deferred.
- Not an orchestrator-heartbeat enrichment that surfaces subagent state into the parent's `heartbeat.json`. Deferred.
- Not a `recentProcessActivity` replacement. The new signal sits alongside the existing one.

## Architecture

Three units with disjoint concerns. Each unit can be understood and tested independently.

### Unit A — `subagent-progress-parser.ts` (new)

Pure-function module. No I/O.

**Interface:**

```ts
export type ToolBucket = "fast" | "slow";

export interface ProgressEvent {
  event: "TOOL_START" | "TOOL_END";
  tool: string;
  bucket: ToolBucket;
  ts: number;
}

export function parseGeminiLine(
  line: string,
  now: number,
): ProgressEvent | null;
export function parseCodexLine(line: string, now: number): ProgressEvent | null;
export function parseKimiLine(line: string, now: number): ProgressEvent | null;
export function parseClaudeLine(
  line: string,
  now: number,
): ProgressEvent | null;
```

**Implementation strategy (hybrid):**

- **Claude:** when stream-json mode is enabled (future flip noted in [stall-watchdog.ts:31-33](build/orchestrator/stall-watchdog.ts)), parse `tool_use` events directly. Until then, pattern-match the prose markers Claude emits today.
- **Gemini / Codex / Kimi:** pattern-match prose markers from each CLI's default output mode. Codex's `apply_patch` invocation lines and `codex review` headers are stable enough to anchor on. Kimi's `--print` mode is silent by design and will return `null` for most lines — that is the expected path; the cpu-mode watchdog covers it.
- Where pattern-match is ambiguous, the parser returns `null`. The watchdog falls back to legacy `stallMs`. Unclassified is never treated as "busy" — it degrades to today's behavior.

The `TOOL_BUCKET` lookup table (defined in `build-config.ts`, see "Constants" below) is consulted to map a tool name to a bucket. Tools not present in the table return `null` from the parser even if pattern-matched, so adding a new tool is a one-line config change rather than a parser edit.

### Unit B — extension to `stall-watchdog.ts`

The existing [`attachStallWatchdog`](build/orchestrator/stall-watchdog.ts) gains tool-awareness as an opt-in mode option.

**New option on `stream` and `cpu` modes:**

```ts
export interface StallWatchdogOptions {
  // ...existing fields...

  /**
   * When provided, the watchdog parses each stdout line through this
   * function. Non-null ProgressEvents update internal state:
   *   - TOOL_START sets currentToolBucket and lastClassifiedActivityAt.
   *   - TOOL_END clears currentToolBucket; lastClassifiedActivityAt updates.
   * The effective stall window per tick depends on currentToolBucket
   * (see windowing rules below).
   */
  parseProgress?: (line: string, now: number) => ProgressEvent | null;

  /** Required when parseProgress is provided. Tool-aware window thresholds. */
  toolStallMs?: { fast: number; slow: number };

  /**
   * Required when parseProgress is provided. Max time the watchdog
   * tolerates noisy stdout with no parsed events before firing.
   */
  progressGapMs?: number;
}
```

**New internal state:**

- `currentToolBucket: "fast" | "slow" | null` — null when no TOOL_START is active.
- `lastClassifiedActivityAt: number | null` — timestamp of the most recent non-null parse result; null until the first event.

**Windowing rules (per tick):**

| `currentToolBucket` | Effective stall window              |
| ------------------- | ----------------------------------- |
| `"slow"`            | `toolStallMs.slow`                  |
| `"fast"`            | `toolStallMs.fast`                  |
| `null`              | legacy `stallMs` (today's behavior) |

**Progress-gap arm:**

After each tick, if `lastClassifiedActivityAt !== null` AND `now - lastClassifiedActivityAt > progressGapMs` AND `lastActivityAt` is fresh (within the effective stall window), fire SIGTERM with `killReason: "progress_gap"`. This is the "babbling but not working" detector. It is gated on `lastClassifiedActivityAt !== null` so a subagent that never emits classifiable events stays on the legacy path.

**Invariant:** every code path in the watchdog must degrade to legacy behavior when `parseProgress` is absent or always returns `null`. No new failure mode introduced for unmigrated providers.

### Unit C — `halt-events.ts` field extension

The existing halt-event schema gains three optional fields. Additive only — existing consumers ignore unknown fields, no migration needed.

```ts
export interface HaltEvent {
  // ...existing fields (silenceMs, faultId, etc.)...

  /** Why the watchdog killed. Optional; absent on non-watchdog halts. */
  killReason?: "silence" | "progress_gap";

  /** Last classified tool at kill time. Null when never classified. */
  lastTool?: string | null;

  /** Last classified bucket at kill time. Null when never classified. */
  lastBucket?: "fast" | "slow" | null;
}
```

Downstream consumers (investigator-dispatch, escalation-streak, drain-faults) can quote `lastTool` and `lastBucket` directly in halt summaries.

### Contracts between units

- Parser knows providers and tool patterns. Knows nothing about timers or kills.
- Watchdog knows timers and kills. Knows nothing about provider patterns or tool names beyond the bucket label.
- Halt-event consumer knows reporting. Knows nothing about parsing or timing.

Each unit can be replaced or extended without touching the others.

## Constants and config

Added to [build/orchestrator/build-config.ts](build/orchestrator/build-config.ts):

```ts
export const BUILD_DEFAULTS = {
  // ...existing...
  toolAwareStallMs: {
    fast: 90_000, // 90s — Edit, Read, Write, Grep, Glob, default Bash
    slow: 600_000, // 10min — WebFetch, codex_review, kimi_print, long Bash
  },
  progressGapMs: 300_000, // 5min
};

export const TOOL_BUCKET: Record<string, "fast" | "slow"> = {
  // Filesystem / search — fast
  Edit: "fast",
  Read: "fast",
  Write: "fast",
  Grep: "fast",
  Glob: "fast",
  Bash: "fast", // most bashes; long bashes have their own watchdog timeout
  apply_patch: "fast", // Codex edit primitive

  // Network / LLM-driven — slow
  WebFetch: "slow",
  WebSearch: "slow",
  codex_review: "slow",
  kimi_print: "slow",
};
```

Numbers chosen against `BUILD_DEFAULTS.timeoutsMs` observations: Gemini 10min, Kimi 25min, Codex 15min, ship 30min. Fast bucket (90s) is tighter than today's flat window because file-edit tools should never legitimately exceed it. Slow bucket (10min) matches the longest legitimate single-tool operation we observe.

Unknown tools — i.e., tools not present in `TOOL_BUCKET` — are intentionally absent rather than mapped to a default bucket. The parser returns `null` for them, which routes through the legacy `stallMs` fallback rather than guessing a window.

## Failure modes

Each row of this table is a known degradation path. The principle is: every failure mode degrades to today's behavior, never worse.

| Failure                                                        | Resulting behavior                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Parser returns `null` for every line                           | Watchdog uses legacy `stallMs`. Exactly today's behavior. No regression possible.                                                   |
| Parser misclassifies `TOOL_END` (stuck in `"slow"` forever)    | After `slowStallMs` of true silence the watchdog still kills. Worst case: one slow-bucket kill instead of fast-bucket kill.         |
| Parser misclassifies `TOOL_START` (sees an Edit as a WebFetch) | Tool runs with `slowStallMs` instead of `fastStallMs`. Same outcome as today's flat window.                                         |
| Subagent emits fake `TOOL_START` to dodge the kill             | Progress-gap detector fires after `progressGapMs` regardless of declared activity. Lying buys at most one extra grace window.       |
| Vendor CLI changes its output format                           | Parser stops matching → all events `null` → watchdog falls back to legacy. Caught by fixture-based parser tests, not by production. |
| New tool we haven't classified                                 | Absent from `TOOL_BUCKET` → parser returns `null` → legacy fallback. Adding the row is the only fix.                                |
| `parseProgress` throws unexpectedly                            | Caught at the watchdog call site; treated as `null`; legacy fallback.                                                               |

## Testing strategy

Three layers matching the three units.

### 1. `subagent-progress-parser.test.ts` (free, sub-100ms)

Fixture-driven. Captured real stdout from recent builds lives in `test/fixtures/subagent-stdout/<provider>.txt` with a sibling `.golden.json` listing the expected `ProgressEvent[]`. Adding a new tool is: add lines to the fixture, add golden rows.

Cases per provider:

- A representative `TOOL_START` line → expected event.
- A representative `TOOL_END` line → expected event.
- An ambiguous prose line → expected `null`.
- An empty / whitespace-only line → expected `null`.
- A known-unmapped tool (not in `TOOL_BUCKET`) → expected `null`.

### 2. `stall-watchdog-tool-aware.test.ts` (free, sub-500ms with fake clock)

Uses the existing `clock` test hook in [stall-watchdog.ts](build/orchestrator/stall-watchdog.ts).

Cases:

- `TOOL_START` (slow) then silence 8min → no kill (slow window is 10min).
- `TOOL_START` (fast) then silence 2min → kill at 90s with `killReason: "silence"`, `lastBucket: "fast"`.
- `TOOL_START` (slow) then `TOOL_END` then silence past legacy `stallMs` → kill at legacy `stallMs` (cleared bucket routes through the legacy path per the windowing rules). The test fixture sets legacy `stallMs` to 60s for determinism.
- Noisy stdout, parser returns `null` every line → identical timing to legacy watchdog (regression guard).
- Noisy stdout, parser returns one event then `null` for 6min → kill at 5min with `killReason: "progress_gap"`, `lastTool` set to the prior event's tool.
- `parseProgress` throws on a line → that line treated as no-op; subsequent ticks unaffected.

### 3. Gate-tier E2E

Extend one existing build E2E that exercises a Gemini phase. Plant a slow operation in the phase prompt (e.g., a `WebFetch` instruction). On the legacy watchdog (env var `GSTACK_TOOL_AWARE_WATCHDOG=0`), the phase is killed at the flat `stallMs`; on the new watchdog the phase completes. The test asserts the second outcome.

Periodic-tier coverage continues to exercise Codex and Kimi paths via the existing E2E set; no new periodic test required at v1.

## Migration / rollout

Single PR. Behind one env-var kill switch:

- `GSTACK_TOOL_AWARE_WATCHDOG=1` (default) enables. `=0` disables and routes through the legacy path.
- For one release cycle, the legacy fields on `StallWatchdogOptions` stay in place so a runtime regression can be undone by flipping the env var.
- After one clean release, the env var is removed and the legacy branch deleted.

`bin/gstack-build` does not require a flag. Operators tuning per-machine can set the env var in `~/.gstack/env` or pass it on the command line.

## Open questions

- Should `parseProgress` receive line-batches (whole `data` chunks from the readable stream) instead of single lines, to handle CLIs that interleave multi-line tool blocks? **Tentative answer:** start with single lines (matches the existing readline-based plumbing). If a real provider needs multi-line context, extend later.
- Should the progress-gap timer reset when `lastActivityAt` resets (any non-empty line) or only when a parsed event arrives? **Tentative answer:** only on parsed events. Otherwise babbling-but-not-working is masked by raw output noise — the failure mode we're explicitly trying to catch.

Both are answered tentatively above; flag during eng review if either needs to flip.

## File map

| File                                                                         | Change                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `build/orchestrator/subagent-progress-parser.ts`                             | New file — Unit A.                                                                          |
| `build/orchestrator/stall-watchdog.ts`                                       | Add `parseProgress`, `toolStallMs`, `progressGapMs` options. New state and decision arms.   |
| `build/orchestrator/sub-agents.ts`                                           | Wire the provider-appropriate parser into each spawnCaptured call site.                     |
| `build/orchestrator/halt-events.ts`                                          | Add `killReason`, `lastTool`, `lastBucket` optional fields.                                 |
| `build/orchestrator/build-config.ts`                                         | Add `BUILD_DEFAULTS.toolAwareStallMs`, `BUILD_DEFAULTS.progressGapMs`, `TOOL_BUCKET` table. |
| `build/orchestrator/__tests__/subagent-progress-parser.test.ts`              | New — Unit A tests.                                                                         |
| `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`             | New — Unit B tests.                                                                         |
| `test/fixtures/subagent-stdout/{gemini,codex,kimi,claude}.{txt,golden.json}` | New fixtures.                                                                               |
| One existing build E2E                                                       | Extended to assert the long-tool case completes.                                            |
