# CPU-aware startup-hang watchdog (unify first-token deadline into stall-watchdog)

**Date:** 2026-05-25
**Status:** Approved (design phase) — pending implementation plan
**Author:** anbang + Claude

## Problem

The build orchestrator currently runs two parallel watchdogs against every
sub-agent spawn in `build/orchestrator/sub-agents.ts`:

1. **First-token deadline** ([sub-agents.ts:770-803](../../../build/orchestrator/sub-agents.ts#L770-L803)) —
   `setTimeout(120_000)` that fires SIGTERM when `stdoutBytes + stderrBytes === 0`
   after 120 seconds. Stream-only check; ignores CPU activity.
2. **Stall watchdog** ([stall-watchdog.ts](../../../build/orchestrator/stall-watchdog.ts),
   attached at [sub-agents.ts:832](../../../build/orchestrator/sub-agents.ts#L832))
   — CPU-aware liveness monitor that runs in `cpu` mode by default and uses the
   per-role `stallMs` (15-25 min for LLM bins) as its silence window.

The bug: the first-token timer fires regardless of whether the CPU-aware stall
watchdog can see the process is alive. Long-reasoning LLM CLIs (Claude with
`reasoning=xhigh`, Codex with `reasoning=high`, large judge or planSynthesizer
prompts) can legitimately go >120s between bytes while the model reasons
server-side. The CLI subprocess still burns CPU keeping the TLS connection
open, ticking the event loop, and pinging HTTP/2 — the stall watchdog records
that as activity and would never kill it. The first-token timer kills it
anyway.

Symptom: "long and complicated tasks are killed prematurely." Kill reason in
halt logs is `first_token_timeout`. Two watchdogs disagreeing — one wins.

## Goal

Unify into a single watchdog with one liveness story: a process is hung iff
**both** stream and CPU are silent. Replace the dual-watchdog conflict with one
two-phase watchdog inside `stall-watchdog.ts`.

## Non-goals

- Per-bin or per-provider deadline tiering. (Considered as option A in
  brainstorming; rejected as a shift-the-cliff fix that doesn't address the
  failure mode.)
- Interactive "ask before killing" prompts. (Considered in upstream investigation;
  rejected because it breaks unattended `/build` execution, the whole point of
  the orchestrator.)
- Changes to the auth-prompt fast-kill detector in `stall-watchdog.ts` —
  separate, well-targeted, already correct.
- Changes to tool-aware windows (`TOOL_AWARE_STALL_MS`), progress-gap detection
  (`PROGRESS_GAP_MS`), or per-role `timeoutMs` (`BUILD_DEFAULTS.timeoutsMs`).

## Design

### Architecture: two phases inside one watchdog

```
spawnCaptured → attachStallWatchdog (cpu mode by default)
  ├─ Phase A: startup
  │   - Active when firstActivityAt === null (no activity ever observed)
  │   - Silence window = startupHangMs (default 120s)
  │   - Kills only when CPU == 0 AND stream == 0 for the full window
  │
  ├─ Phase B: steady state
  │   - Active once any activity recorded (CPU tick or stream byte)
  │   - Silence window = legacy stallMs (per-role: 15-25 min for LLMs)
  │   - Tool-aware windows (90s fast / 10min slow) apply once parser classifies
  │
  └─ Auth-prompt regex always wins (immediate SIGTERM, existing behavior)
```

Both phases use the same `recordActivity()` and `lastActivityAt` plumbing. The
distinction is which silence-window constant applies. The transition from A → B
happens the instant any activity is recorded — including CPU ticks, which is
what makes long-reasoning subagents safe.

### Component changes

**File 1: `build/orchestrator/stall-watchdog.ts`** (additions)

- New optional `StallWatchdogOptions.startupHangMs?: number`. Default 120_000.
  Zero disables Phase A entirely (falls through to legacy `stallMs` from
  spawn).
- New internal state `firstActivityAt: number | null = null`. Set the first
  time `recordActivity()` fires.
- Augment `recordActivity()`:
  ```ts
  const recordActivity = () => {
    lastActivityAt = clock.now();
    if (firstActivityAt === null) firstActivityAt = lastActivityAt;
  };
  ```
- In `poll()`, before the existing `effectiveStallMs` computation, compute:
  ```ts
  const inStartupPhase = firstActivityAt === null;
  const startupWindow = opts.startupHangMs ?? 120_000;
  if (inStartupPhase && startupWindow > 0) {
    // Phase A: use startupHangMs as the silence window.
    // CPU mode: if CPU > 0 anywhere this tick, recordActivity() above already
    // set firstActivityAt and we won't enter this branch on the next poll.
    // Stream mode: any byte sets firstActivityAt the same way.
    effectiveStallMs = startupWindow;
  } else {
    // Phase B: existing logic. effectiveStallMs computed from stallMs
    // and tool-aware overrides as today.
  }
  ```
- New `killReason: "startup_hang"` value in the existing union. Add the case to
  the type and any switch statements consuming `killReason`.
- All other Phase B logic untouched: tool-aware windows, progress-gap, auth-prompt
  regex, mtime mode for drain-faults investigators.

**File 2: `build/orchestrator/sub-agents.ts`** (deletions + one wiring change)

- Delete lines 770-804: `firstTokenDeadlineMs` constant, `firstTokenTimer`,
  `firstTokenKillTimer`, `clearFirstTokenTimers()`, `noteFirstToken()`, the
  `setTimeout(firstTokenDeadlineMs)` block, and the SIGKILL escalation timer
  inside it.
- Delete the `noteFirstToken()` calls in the `stdout.on("data")` and
  `stderr.on("data")` handlers (current lines 809 and 816).
- Delete the `clearFirstTokenTimers()` call in the child `close` handler.
- Delete `let firstTokenKilled = false;` (current line 576) and every read of
  it. Result-object fields that today derive from `firstTokenKilled` now derive
  from `killReason === "startup_hang"`:
  ```ts
  // Old:
  killReason: firstTokenKilled ? "first_token_timeout" : <watchdog kill reason>,
  // New:
  killReason: <watchdog kill reason>, // includes "startup_hang"
  ```
- In the `attachStallWatchdog` call (line 832), add the new option:
  ```ts
  const watchdog = attachStallWatchdog(
    watchdogMode.mode === "cpu"
      ? { mode: "cpu", child }
      : { mode: "stream", child },
    {
      stallMs: args.timeoutMs,
      startupHangMs: envNumberOrDefault(
        "GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS", // historical name, kept
        120_000,
      ),
      // ... existing opts unchanged
    },
  );
  ```

**File 3: `build/orchestrator/halt-event-helpers.ts`** (small extension)

- Switch statements that map `killReason` to halt-event summaries must handle
  `"startup_hang"`. Add a case alongside the existing `"stall"`, `"silence"`,
  `"progress_gap"`, `"auth_required"`. Summary text:
  `"${role} hung at startup (no CPU and no output past ${windowMs}ms)"`.

**File 4: `build/orchestrator/cli.ts`** (small extension)

- The `_metricsEndedBy = "watchdog"` assignment around line 6993 already covers
  every watchdog kill. No change needed for metrics. Grep for any switch on
  `killReason` and add the new case where it appears.

### Env var

**Kept as `GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS`.** Renaming would silently
revert operator overrides set in shell profiles or CI configs. The name is
historical; the source-side docstring will note: "Despite the historical name,
this controls the Phase A startup-hang window in stall-watchdog. Process is
killed when both CPU == 0 AND stream == 0 for this duration. Set to 0 to
disable Phase A entirely."

### Kill-reason vocabulary

| Today                                                    | Tomorrow                           |
| -------------------------------------------------------- | ---------------------------------- |
| `first_token_timeout` (sub-agents.ts only)               | `startup_hang` (stall-watchdog.ts) |
| `stall` (legacy stallMs trip)                            | unchanged                          |
| `silence` (tool-aware trip after first classified event) | unchanged                          |
| `progress_gap`                                           | unchanged                          |
| `auth_required`                                          | unchanged                          |

Halt-event logs and CHANGELOG entry must mention the rename so consumers
parsing killReason strings update.

## Edge cases

1. **`ps` probe fails at spawn** → `resolveWatchdogMode` falls back to `stream`
   mode. Phase A still works: only stream activity sets `firstActivityAt`,
   identical to today's first-token deadline. No regression.

2. **Backpressure pause** — existing `watchdogActivityHook` (sub-agents.ts:768)
   already stamps activity on resume. Naturally chains into the new
   `firstActivityAt` if not already set. No additional wiring needed.

3. **First byte arrives at exactly the deadline boundary** — poll runs at 250ms.
   Worst case: kill fires 250ms before stream byte would have arrived. Same
   tolerance as today's timer.

4. **`startupHangMs=0`** — Phase A short-circuits; watchdog goes straight to
   Phase B using legacy `stallMs` from spawn. Matches today's
   `GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS=0` disable behavior.

5. **Child forks and exits immediately with no output** (binary-not-found shim)
   — process group CPU drops to zero quickly. Phase A fires at
   `startupHangMs`. Preserved behavior.

6. **CLI prints banner then reasons silently for 5 min** (e.g. Codex
   `Codex v0.2.0\n` then API call) — first byte sets `firstActivityAt`, Phase B
   uses 15-min `stallMs` for codex. The exact failure mode that broke today's
   design is fixed automatically.

7. **CLI burns CPU but emits nothing for full per-role stallMs** (extremely
   silent worker) — Phase A passes (CPU > 0), Phase B kills at `stallMs`.
   Behavior matches today's stall watchdog.

8. **Pathological process: one CPU tick then total hang** — Phase A → Phase B
   transition on the single tick. Phase B uses long `stallMs`. Process lives
   15+ min. Same as today's stall watchdog; not a new failure surface.

## Failure modes introduced

- **Phase A → B transition on a noisy single-tick** (item 8 above) — pre-existing
  in stall watchdog; this design doesn't worsen it.
- **Test flakiness from real CPU sampling.** Mitigation: all tests injecting
  watchdog behavior must use the existing `opts.sampleCpuFn` seam
  ([stall-watchdog.ts:388](../../../build/orchestrator/stall-watchdog.ts#L388)).
  No `ps` calls in unit tests.

## Testing

| Test (new or modified)                                                 | What it proves                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startup-hang-fires-on-silent-zerocpu` (new, stall-watchdog)           | Phase A kills when CPU and stream both 0 for startupHangMs                                                                                                                                                                                                         |
| `startup-hang-survives-cpu-active` (new, stall-watchdog)               | Phase A does NOT kill when CPU > 0, even with zero stream output — the main bug fix                                                                                                                                                                                |
| `startup-hang-survives-stream-active` (new, stall-watchdog)            | Phase A does NOT kill when stream emits bytes, even with zero CPU                                                                                                                                                                                                  |
| `startup-hang-transitions-to-stallMs` (new, stall-watchdog)            | After firstActivityAt set, kill window switches to legacy stallMs                                                                                                                                                                                                  |
| `startup-hang-zero-disables-phase-a` (new, stall-watchdog)             | `startupHangMs: 0` skips Phase A; legacy stallMs applies from spawn                                                                                                                                                                                                |
| `startup-hang-stream-mode-fallback` (new, stall-watchdog)              | In stream mode (no CPU signal), Phase A behavior identical to legacy first-token deadline                                                                                                                                                                          |
| `kills zero-output child at first-token deadline` (modify, sub-agents) | Renamed to `kills-zero-cpu-zero-output-child-at-startup-hang`. Test now uses `sleep 10` (deliberately zero-CPU) to trigger; asserts `killReason === "startup_hang"`. A second variant with `bash -c 'while true; do :; done'` must complete normally without kill. |
| `spawnCaptured-no-firsttoken-timer-leak` (new, sub-agents)             | After close, no stale timer holds the event loop open. Bun's open-handle detection in the test harness catches regressions.                                                                                                                                        |
| `halt-event-killReason-startup-hang` (new, halt-event-helpers)         | Halt-event summary for `startup_hang` killReason renders correctly                                                                                                                                                                                                 |

All tests use injected `clock` and `sampleCpuFn` from `StallWatchdogOptions` to
remain deterministic.

## Operational rollout

1. **Single PR.** Three core files (stall-watchdog, sub-agents, halt-event-helpers)
   plus tests, plus a cli.ts touch only if the grep finds an existing switch on
   `killReason` that needs the new case. Diff target: under 400 lines.
2. **Env var unchanged.** Existing `GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS`
   overrides keep working with new semantics.
3. **CHANGELOG entry** frames the change as: "Sub-agent startup-hang detection
   is now CPU-aware. Long-reasoning LLM subagents that consume CPU between
   tokens are no longer killed prematurely. Processes that are truly hung at
   startup (zero CPU AND zero output for 120s) are still killed promptly.
   killReason string changed from `first_token_timeout` to `startup_hang` in
   halt-event logs."
4. **No `configure.cm` migration.** Internal watchdog behavior; no user-facing
   config schema changes.
5. **No deprecation path** for the old killReason string — it was never part of
   a documented external API. Internal consumers update in the same PR.

## Alternatives considered

- **A) Per-bin tiered first-token deadlines.** Codex/Claude 10 min, Kimi/Gemini
  5 min, shell 3 min. Rejected because it shifts the cliff without fixing the
  failure mode — an 11-minute Codex run still dies at 10:01.
- **B) CPU-aware first-token deadline kept as separate timer in sub-agents.ts.**
  Implements the same liveness logic but leaves two watchdogs in the code.
  Rejected in favor of full unification (C) — the additional refactor cost was
  smaller than initially scoped because the stall watchdog already has all the
  primitives.
- **D) Hybrid (ship A now, B later).** Rejected because A doesn't relieve the
  real pain enough to justify shipping a stopgap that creates churn cost.
- **E) Interactive "ask before killing" prompts** for all auto-kills. Rejected
  upstream of this design because it breaks unattended `/build` execution.

## Open follow-ups (out of scope here)

- The fork-versioning rule in CLAUDE.md says only bump the skill's
  `version:` frontmatter, not top-level VERSION. This change is in the build
  orchestrator (not a skill), so the question of versioning is the
  implementation plan's call. Likely: a MINOR bump on a feature branch with a
  release-summary entry.
- Whether to surface `firstActivityAt` in metrics/observability is a separate
  question; today's metrics flow does not need it.
