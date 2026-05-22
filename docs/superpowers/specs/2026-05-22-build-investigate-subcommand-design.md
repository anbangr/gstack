# /build investigate subcommand — design

**Status:** Approved, ready for implementation plan.
**Date:** 2026-05-22
**Author:** Anbang + Claude (brainstorming session)

## Problem

The gstack `/build` orchestrator has automatic fault investigation: when a build run
hits a recognized failure pattern, `drain-faults.ts` builds a briefing via
`investigator-dispatch.ts`, runs an LLM (codex by default), parses the report, and
files HIGH/CRITICAL findings to `inbox/<date>-halt-<faultId>.md`.

What's missing is a **manual** trigger. Two situations recur:

1. **Past-fault re-investigation.** An auto investigation produced a thin or
   "no-context" outcome and we want a richer pass with the full `/investigate`
   methodology. Or a newly-learned fault pattern means old halt events deserve
   re-analysis.
2. **Ad-hoc from current chat.** A build is breaking right now and the user has the
   symptoms in their Claude session. They want to run the four-phase investigation
   discipline and end up with a curated `BUGREPORT-*.md` in `inbox/` for later
   triage.

Neither flow exists today. The user has to either wait for `drain-faults` to fire or
hand-write a bug report.

## Goals

- A single `gstack-build investigate` subcommand serves both modes.
- Reuses the existing fault storage convention so downstream consumers (analytics,
  `learn-fault-patterns`, the inbox triage flow) work unchanged.
- Runs the richer `/investigate` skill methodology (four-phase root-cause discipline)
  instead of the lighter `investigator-dispatch` prompt — manual runs should be
  noticeably better than auto ones.
- Uses the current Claude session as the investigator. No subprocess, no MCP bridge,
  no model-choice flag.
- Auto-detects context when possible. Falls back to `AskUserQuestion` only when
  auto-detect fails.

## Non-goals

- Replacing the auto `drain-faults` pipeline. It stays as-is; this is additive.
- Investigating non-build issues. Generic `/investigate` already covers that.
- Supporting non-Claude investigator models for the manual path. The user explicitly
  picked Claude-in-session; cross-model investigation stays in the auto pipeline.
- Re-running `learn-fault-patterns` automatically. The subcommand prints a
  one-line hint when a `learnedPatternProposal` is present; absorbing it remains a
  separate user-initiated step.

## Decisions made during brainstorming

1. **Two modes, one subcommand.** Manual past-fault re-investigation AND ad-hoc
   current-chat investigation share one CLI entry point.
2. **Upgrade to the richer `/investigate` methodology.** Manual runs use the
   four-phase discipline (investigate → analyze → hypothesize → implement), not
   the lighter `buildInvestigatorPrompt`.
3. **Dual artifact output.** Machine report to
   `~/.gstack/skill-faults/<runId>/<faultId>.md` (matches drain-faults convention);
   human bug report to `inbox/BUGREPORT-<date>-<slug>.md` for HIGH/CRITICAL only.
4. **Auto-detect with fallback.** When no args are given, locate the most recent
   active build run via `active-runs.ts`. Fall back to `AskUserQuestion` (or exit 3
   in non-TTY mode) if nothing is found.
5. **Claude in-session as the investigator.** The CLI emits a structured briefing
   block to stdout; the running Claude session performs the investigation and writes
   a report file; a sister subcommand `investigate-finalize` validates and persists
   it. No subprocess.

## Subcommand surface

```
gstack-build investigate [<faultId>] [flags]

  No args                Auto-detect most recent active build run; investigate
                         its latest unresolved halt event.
  <faultId>              Re-investigate a specific stored fault by id
                         (e.g. CODEX_CONVERGENCE:3:phase-runner.ts).
  --run-id <id>          Investigate the latest fault from a specific run.
  --state <path>         Use this state file as context (overrides auto-detect).
  --run-dir <path>       Use this run directory as context.
  --symptoms <text>      Free-form symptom prose; no run files required.
  --severity-override <CRITICAL|HIGH|MEDIUM>
                         Override detected severity (affects inbox filing).
  --no-inbox             Skip the inbox/BUGREPORT-*.md output.
  --json                 Emit InvestigationReport JSON to stdout (no markdown).

gstack-build investigate-finalize \
  --run-id <id> --fault-id <id> --report <path> [--no-inbox]

  Internal subcommand the Claude session calls after writing its report file.
  Validates the JSON, writes both artifacts, appends analytics, releases the lock.
```

**Resolution order when context is ambiguous:**

1. Explicit flag (`--state`, `--run-dir`, `--symptoms`) wins.
2. Positional `<faultId>` next.
3. Auto-detect via `active-runs.ts` → most recent run with an unresolved halt event.
4. If still nothing, `AskUserQuestion` (TTY) or exit 3 (non-TTY).

**Exit codes:**

- `0` — investigation completed, report written, root cause identified (or duplicate-of).
- `1` — investigation completed but outcome is `needs-human` or `no-context`.
- `2` — bad arguments / unreadable state / parse error / faultId mismatch.
- `3` — auto-detect found nothing AND user cancelled the fallback prompt (or non-TTY).

## Architecture

```
build/orchestrator/
├── cli.ts                          # +50 LOC: parseArgs case + main dispatch
├── investigate-mode.ts             # NEW: runInvestigateMode, runInvestigateFinalize
├── investigate-context.ts          # NEW: resolveInvestigationContext + helpers
├── investigate-report-writer.ts    # NEW: writeMachineReport, writeBugReport
├── investigator-dispatch.ts        # REUSED: parseInvestigationReport, types
├── skill-fault-detector.ts         # REUSED: SkillFault, faultId(), severity
├── active-runs.ts                  # REUSED: discoverActiveRuns()
├── halt-events.ts                  # REUSED: HaltEvent type
└── release-lock.ts                 # REUSED: per-fault lockfile pattern

build/
└── SKILL.md.tmpl                   # +30 lines: subcommand docs + in-session
                                    # methodology block the Claude session follows

scripts/resolvers/
└── investigate-build.ts            # OPTIONAL: emit the four-phase methodology
                                    # block into SKILL.md at gen-skill-docs time
```

**Module boundaries:**

- **`investigate-mode.ts`** — orchestrator. Parses args, calls context resolver,
  emits briefing block, returns control to the Claude session. Also exposes
  `runInvestigateFinalize` which validates the report file and writes artifacts.
  ~200 LOC total.
- **`investigate-context.ts`** — pure functions:
  `resolveInvestigationContext(args): Promise<InvestigationContext>`. Handles
  flag-override, positional faultId lookup, auto-detect, AskUserQuestion fallback,
  and stdout-log tailing. ~200 LOC.
- **`investigate-report-writer.ts`** — pure functions: `writeMachineReport`,
  `writeBugReport`, slug generation, numeric-suffix collision handling. ~150 LOC.

### Briefing block contract

`runInvestigateMode` emits exactly one delimited block to stdout, then exits 0:

```
<<<GSTACK_INVESTIGATE_BRIEFING>>>
{
  "runId": "abc123",
  "faultId": "CODEX_CONVERGENCE:3:phase-runner.ts",
  "severity": "HIGH",
  "statePath": "/path/to/state.json",
  "stdoutTailPath": "/tmp/gstack-investigate-stdout-tail-<runId>.txt",
  "livingPlanPath": "/path/to/living-plan.md",
  "worktreePath": "/path/to/worktree",
  "recentLearnings": [...],
  "symptoms": "...optional prose..."
}
<<<END>>>
```

The SKILL.md template tells the Claude session: when you see this block, execute
the four `/investigate` phases against these files, write your report as JSON to
a tmp path, then call `gstack-build investigate-finalize` with that path.

The structured-block pattern (not a subprocess) means:

- No model-choice flag needed.
- The investigator runs in the user's already-authenticated session.
- The CLI stays deterministic and easy to unit test.

## Data flow

```
User: /build investigate
  │
  ▼
SKILL.md → shells out: gstack-build investigate [args]
  │
  ▼
runInvestigateMode:
  1. resolveInvestigationContext(args)
       a. explicit flag? → use it
       b. positional faultId? → look up halt event in pending-investigations/
          and processed/ dirs
       c. active-runs.ts → most recent active run with unresolved halt event
       d. nothing? → emit AskUserQuestion JSON block (TTY) or exit 3 (non-TTY)
  2. Tail stdout: last 500 lines + ±50 lines around each timestamp in
     state.recentErrors. Write to /tmp/gstack-investigate-stdout-tail-<runId>.txt
  3. Acquire fault lock at ~/.gstack/skill-faults/<runId>/.<faultId>.lock
  4. Emit briefing block to stdout. Exit 0.
  │
  ▼
Claude session (SKILL.md directs):
  5. Parse briefing block
  6. Run /investigate four phases:
       ① Investigate — Read state, stdout tail, living plan
       ② Analyze     — Trace candidate code paths
       ③ Hypothesize — State testable root-cause claim
       ④ Implement   — Propose 1–3 fix options with blast_radius labels
  7. Write InvestigationReport JSON to <tmp>/investigation-report.json
  8. Shell out: gstack-build investigate-finalize \
       --run-id <id> --fault-id <id> --report <tmp-path>
  │
  ▼
runInvestigateFinalize:
  9. parseInvestigationReport(content, expectedFaultId)
       └── invalid? → release lock, exit 2 with parse errors
 10. writeMachineReport → ~/.gstack/skill-faults/<runId>/<faultId>.md
 11. If severity ∈ {CRITICAL, HIGH} AND !--no-inbox:
       writeBugReport → inbox/BUGREPORT-<YYYY-MM-DD>-<slug>.md
 12. Append row to ~/.gstack/analytics/skill-faults.jsonl
 13. If report.learnedPatternProposal present:
       Print "Run gstack-build learn-fault-patterns to absorb this proposal."
 14. Release lock. Print one-line summary + paths. Exit 0/1.
```

## Side-effect locations

All paths match existing drain-faults conventions — no new directories.

| Artifact                      | Path                                              |
| ----------------------------- | ------------------------------------------------- |
| Machine report                | `~/.gstack/skill-faults/<runId>/<faultId>.md`     |
| Human bug report (HIGH/CRIT)  | `inbox/BUGREPORT-<YYYY-MM-DD>-<slug>.md`          |
| Analytics row                 | `~/.gstack/analytics/skill-faults.jsonl`          |
| Source halt event (read-only) | `~/.gstack/skill-faults/pending-investigations/`  |
| Fault lock                    | `~/.gstack/skill-faults/<runId>/.<faultId>.lock`  |
| Stdout tail (temp)            | `/tmp/gstack-investigate-stdout-tail-<runId>.txt` |

**Idempotency:** Re-running overwrites the machine report. The inbox bug report
appends a numeric suffix (`-2`, `-3`, ...) when a same-slug file already exists,
preserving prior investigations.

## Bug report format

Mirrors the existing `inbox/BUGREPORT-build-merge-sweeper-halts-on-first-failure.md`:

```markdown
# Bug: <one-line title>

**Severity:** HIGH — <one-line impact statement>
**Discovered:** 2026-05-22
**Reporter:** /build investigate (manual, run <runId>)
**Repro rate:** <from report.evidence>

## Symptom

<observable behavior, 2-4 sentences>

## Repro from field

<state file path, stdout tail excerpt with line numbers, living plan section>

## Root cause (hypothesis)

<report.rootCause prose, with inline file:line citations from report.evidence>

## Why <severity>

<impact analysis: what breaks for users, what fails silently>

## Fix sketch

<for each report.proposedFix option:>
### Option N: <label> (blast_radius: <minimal|moderate|broad>)

<description, pseudocode>

## Tests to add (optional section)

Emitted only when `report.proposedFix[*].testsToAdd` or `report.evidence`
explicitly names test files/cases. Source: the in-session Claude is asked
to include test suggestions inside each `proposedFix` block. Skip the
section if nothing test-shaped surfaces.

## Status

Filed by `/build investigate`. Not implementing — see fix options above.
```

The slug is derived from the fault category + a short hash of the root-cause text:
`build-<category-lowercase>-<6-char-hash>`. Example:
`BUGREPORT-2026-05-22-build-codex-convergence-a4f2b1.md`.

## Error handling

| Scenario                                             | Behavior                                                                                           | Exit |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- |
| `--state <path>` doesn't exist                       | stderr: `error: state file not found: <path>`                                                      | 2    |
| `<faultId>` given but not found                      | stderr: `error: fault not found: <faultId>` + nearest-match suggestions (levenshtein on fault ids) | 2    |
| Auto-detect finds no active runs AND no `--symptoms` | TTY: emit AskUserQuestion JSON block, wait on stdin. Non-TTY: exit 3.                              | 3    |
| Multiple active runs, no `--run-id`                  | Emit AskUserQuestion listing runs by id + last-activity timestamp; user picks one.                 | —    |
| Report file unreadable / invalid JSON                | stderr: parse errors with line numbers. Lock released. No artifacts written.                       | 2    |
| Report's `faultId` doesn't match `--fault-id` arg    | stderr: `error: report faultId mismatch (expected X, got Y)`. Lock released. No artifacts.         | 2    |
| `outcome: "no-context"` or `"needs-human"`           | Write both artifacts. The negative result IS the artifact.                                         | 1    |
| `outcome: "duplicate-of"`                            | Write a one-line stub at machine-report path pointing to canonical. Skip inbox bug report.         | 0    |
| Inbox bug report write fails (permission, disk full) | Machine report still written. Print warning, NOT error.                                            | 0    |
| Concurrent finalize on same fault                    | Second caller sees lockfile, exits 0 with "already finalized".                                     | 0    |

### Edge cases

1. **Symptoms-only mode** (no state file, no fault id). Synthetic fault:
   - `runId = "manual-<timestamp>"`
   - `faultId = "MANUAL_INVESTIGATION:0:<short-slug-of-symptoms>"`
   - `severity = "MEDIUM"` unless `--severity-override` is set
   - Intentionally does not auto-file to inbox.

2. **In-session Claude doesn't reach finalize** (session interrupted). The lock
   remains held until either: (a) the user reruns and the in-session methodology
   tells them about the stale lock, with a one-command release; or (b) drain-faults
   detects the lock is older than 1 hour and reclaims it. The lock-age threshold is
   borrowed from `release-lock.ts`.

3. **Concurrent with drain-faults** on the same fault. Lockfile arbitrates.
   Whichever acquires first wins; the other exits 0 with "already finalized".

4. **Briefing context exceeds Claude's window.** `resolveInvestigationContext`
   tails stdout to last 500 lines + ±50 around each `state.recentErrors` timestamp.
   Living plan read in full (typically <50KB). Worktree path is just a string.

5. **`AskUserQuestion` in non-interactive mode** (CI). If `!process.stdin.isTTY`,
   skip the prompt and exit 3 with `error: no context auto-detected and stdin is
not a TTY. Pass --state, --run-id, or --symptoms explicitly.`

## Testing

### Unit tests (free, <1s each)

| File                                         | Coverage                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `investigate-context.test.ts`                | `resolveInvestigationContext()` resolution order (flag > positional > auto-detect > fallback). |
| `investigate-context-tail.test.ts`           | stdout tail: last 500 lines + ±50 around `recentErrors` timestamps.                            |
| `investigate-report-writer.test.ts`          | Machine report path format. Bug report slug + date prefix. Numeric-suffix collision handling.  |
| `investigate-report-writer-severity.test.ts` | Inbox filing only for CRITICAL/HIGH. MEDIUM and symptoms-only stay out.                        |
| `investigate-finalize-validation.test.ts`    | `parseInvestigationReport` rejection: bad JSON, faultId mismatch, missing required fields.     |
| `investigate-mode-exit-codes.test.ts`        | 0/1/2/3 exit codes for each documented outcome.                                                |
| `investigate-lock.test.ts`                   | Concurrent finalize: second caller exits 0 with "already finalized".                           |

### Integration tests (free, <5s each)

| File                                      | Coverage                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investigate-end-to-end.test.ts`          | Fake halt event → `investigate <faultId>` → assert briefing block on stdout → write canned report → `investigate-finalize` → assert both artifacts on disk with correct content. |
| `investigate-auto-detect.test.ts`         | Stub `active-runs.ts`; assert context resolved to that run's latest halt event.                                                                                                  |
| `investigate-no-context-fallback.test.ts` | TTY: `AskUserQuestion` JSON emitted. Non-TTY: exit 3 with stderr message.                                                                                                        |

### E2E test (paid, periodic tier)

`test/skill-e2e-build-investigate.test.ts` — full Claude session driving
`/build investigate` against a planted fault in a fixture build run, asserting the
resulting `inbox/BUGREPORT-*.md` contains the expected root cause and ≥1 fix option.
Classified `periodic` (non-deterministic, requires LLM).

### Fixtures

- `test/fixtures/investigate/halt-event-codex-convergence.json`
- `test/fixtures/investigate/state-with-recent-errors.json`
- `test/fixtures/investigate/stdout-log.txt` (~2000-line synthetic with planted errors)
- `test/fixtures/investigate/canned-report-success.json`
- `test/fixtures/investigate/canned-report-bad-faultid.json`

### Touchfile registration

In `test/helpers/touchfiles.ts`, the E2E test depends on:
`build/orchestrator/investigate-mode.ts`, `investigate-context.ts`,
`investigate-report-writer.ts`, `investigator-dispatch.ts`,
`build/SKILL.md.tmpl`.

## Out of scope (future work)

- A `--watch` mode that re-investigates on each new halt event.
- Cross-model second opinion (kicking the same briefing to codex + claude and
  diffing the reports) — could live behind a `--cross-check` flag later.
- Auto-applying the lowest-blast-radius proposedFix when severity is HIGH+ — too
  risky without human review; staying explicitly manual.
- A web UI for browsing skill-fault history. The `inbox/` directory is the UI.

## Open questions

None remaining from brainstorming. All four design decisions made:

1. Both modes, one subcommand. ✓
2. Upgrade to richer `/investigate` methodology. ✓
3. Dual artifact (machine + bug report). ✓
4. Claude in-session, no subprocess. ✓

## Acceptance criteria

- `gstack-build investigate` with no args, while a build run is active and has an
  unresolved halt event, emits a valid briefing block referencing that run's
  fault id, state file, and stdout tail.
- `gstack-build investigate <faultId>` against a stored halt event emits a briefing
  block referencing the same fault id.
- `gstack-build investigate-finalize --run-id X --fault-id Y --report <path>` with
  a valid InvestigationReport JSON writes the machine report under
  `~/.gstack/skill-faults/X/Y.md` and, for HIGH/CRITICAL, an
  `inbox/BUGREPORT-*.md`.
- Invalid reports (bad JSON, faultId mismatch) produce exit 2, stderr error, and
  no on-disk artifacts.
- The full E2E test passes: a Claude session reading the briefing produces a real
  bug report whose root cause matches the planted fault.
