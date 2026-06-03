# gstack-build long-running-task robustness — investigation + pre-release validation suite

Status: investigation complete, suite designed, not yet implemented.
Method: `/investigate` (systematic root-cause) + a 31-agent parallel audit across the
8 robustness subsystems of `build/orchestrator/` (52 failure modes mapped, 22 adversarially
verified, 15 confirmed real gaps, 7 refuted/already-covered so the suite stays honest).

## DEBUG REPORT

```
Symptom:    gstack-build is fragile when running long building tasks — runs that
            should keep going instead halt, false-kill healthy sub-agents, strand
            work, or leak resources over multi-hour autonomous builds.

Root cause: The orchestrator's robustness machinery is CLASSIFICATION-RICH but
            ACTUATION-POOR, plus a CRASH/LEAK ASYMMETRY. It detects transient
            failures, parses quota reset times, plumbs killReason, and bumps
            resume counters — but the recovery half is either dead code, counts
            the wrong thing, or is never re-evaluated. Graceful SIGTERM is heavily
            defended while hard SIGKILL strands queue records and leaks worktrees.
            None of it is caught pre-release because EVERY existing test exercises
            a single tick / single pass / quiescent fast-disk happy path and pins
            the present behavior as the spec. The bugs only manifest across many
            ticks, repeated stalls, multi-hour wall-clock, and hard kills — exactly
            the dimensions no current test varies.

Fix:        A deterministic pre-release suite (`build-robustness`) that fakes time,
            spawn, and disk to simulate the long run in milliseconds and pins the
            recovery invariants as the spec. 26 specs / 24 files. Design below.

Status:     DONE_WITH_CONCERNS — root cause confirmed against the code; suite
            designed and ready to implement. Concern: the 15 gaps are real bugs,
            not just missing tests — most [RED] specs require a one-line-to-small
            production fix to go green (that's the point: each gap becomes a
            checklist item).
```

## Independent verification receipts (top 3, confirmed by direct code reading)

These were re-checked by hand after the agent audit, not taken on trust:

- **A1 `provider-retry-budget-is-dead-code` (highest leverage).** `planProviderRetry`
  and `nextCapacityBackoffMs` ([halt-event-helpers.ts:717,744](../../build/orchestrator/halt-event-helpers.ts#L717))
  have ZERO production call sites — grep across `build/orchestrator/` (excluding tests)
  returns only the definitions; `nextCapacityBackoffMs` is called only _inside_
  `planProviderRetry`, which nothing calls. `PROVIDER_RETRY_SESSION_CAP = 6` and the
  per-phase `providerRetryAttempts` counter are maintained ([state.ts:158](../../build/orchestrator/state.ts#L158))
  but never consumed. A transient `529 Overloaded` / `RESOURCE_EXHAUSTED` mid-build is
  not retried with backoff — it halts.

- **B1 `resume-count-monotonic-no-reset` (most likely cause of the report).** The only
  write to the resume counter is `writeResumeCount(counterPath, priorCount + 1)`
  ([monitor.ts:1400](../../build/orchestrator/monitor.ts#L1400)); nothing in production
  ever resets or decrements `<stateDir>/<stateSlug>.resume-count`. The cap
  (`priorCount >= maxResumes`, default 3) counts LIFETIME resumes, not CONSECUTIVE
  failed resumes. Three fully-recovered transient stalls over a long run trip
  `RUN_HALTED_RESTART_CAP` on a healthy build.

- **E1 `quarantine-walk-throw-crashes-fetch`.** `quarantineMalformedRefs`'s `walk()`
  ([cli.ts:4673-4686](../../build/orchestrator/cli.ts#L4673-L4686)) calls
  `fs.readdirSync`/`fs.statSync` with no try/catch. A dangling-symlink ref (statSync
  ENOENT) throws straight out of the pre-fetch quarantine, which runs on every
  `git fetch` preflight, killing the whole run on a recoverable FS condition.

---

## 1. Root-cause verdict

The orchestrator is fragile on long runs because its robustness machinery is **classification-rich but actuation-poor**: the code correctly _detects_ transient provider failures, parses quota reset times, plumbs `killReason`, and bumps resume counters, but the recovery half is either dead code (`planProviderRetry`/`nextCapacityBackoffMs`/`providerRetryAttempts` have zero production callers, `halt-event-helpers.ts:744`), counts the wrong thing (resume cap is lifetime-monotonic per `stateSlug` with no reset-on-progress, `monitor.ts:1377-1400`), or never re-evaluated (auth preflight caches `{ok:true}` process-wide with no TTL, `sub-agents.ts:328`). A second cluster is **crash/leak asymmetry**: graceful SIGTERM is heavily defended but a hard SIGKILL strands release-queue records in `landing`/`claiming` forever (`release-daemon.ts:332,1320`), two competing signal handlers race so the SIGKILL escalation never fires (`cli.ts:12533` vs `13155`), scratch and dual-impl worktrees under `os.tmpdir()` are never swept (the sweep only walks `~/.gstack/build-worktrees/`), and an uncaught `statSync` on a dangling ref kills the whole run at fetch time (`cli.ts:4673-4687`). Current tests miss all of this for one structural reason: **every existing test exercises a single tick / single pass / quiescent fast-disk happy path**, and pins the present behavior as the spec (e.g. `monitor.test.ts:278` asserts the counter _only_ climbs; `gemini-auth-preflight.test.ts` T11 asserts the cache is _never_ re-probed; daemon tests use `heartbeatIntervalMs:60_000` so no beat ever fires; signal tests install only one of the two real handlers). The bugs only manifest across many ticks, repeated stalls, multi-hour wall-clock, and hard kills, exactly the dimensions no test currently varies. The fix is a deterministic suite that fakes time, spawn, and disk to _simulate the long run_ in milliseconds and pins the recovery invariants as the spec.

## 2. Ranked failure-mode table

### Confirmed high-severity gaps (write these)

| id                                                             | subsystem            | what breaks on a long run                                                                                                                                      | invariant to pin                                                                                                                                                                 | tier        |
| -------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `provider-retry-budget-is-dead-code`                           | provider failures    | A transient 529/`RESOURCE_EXHAUSTED` mid-run halts the whole build; the backoff-retry planner is never wired in                                                | A classified capacity/overloaded verdict drives backoff+retry bounded by `PROVIDER_RETRY_SESSION_CAP`, not an immediate `return "failed"`                                        | smoke       |
| `resume-count-monotonic-no-reset`                              | stall/monitor        | 3 fully-recovered transient stalls over hours exhaust the cap; healthy run gets `RUN_HALTED_RESTART_CAP`                                                       | A resume followed by genuine phase progress resets the consecutive-failed-resume counter (cap counts _consecutive_ failures, not lifetime)                                       | smoke       |
| `hard-crash-strands-inflight-record`                           | release queue/daemon | SIGKILL/OOM/reboot strands a record in `landing`/`claiming`/`drift_repairing` forever; even manual `retry` is a no-op                                          | A fresh daemon (empty `activeRecords`) detects a stale-`lastUpdatedAt` in-flight record on disk and requeues/blocks it; `retryReleaseQueueRecord` can rescue an in-flight record | smoke       |
| `signal-handler-race-cuts-child-sigkill-escalation`            | state/shutdown       | Two SIGINT/SIGTERM handlers race; `process.exit(130)` pre-empts the `wait2s→SIGKILL` escalation, orphaning SIGTERM-ignoring sub-agents                         | On interrupt: state saved AND lock released AND every registered child process group eventually receives SIGKILL                                                                 | integration |
| `quarantine-walk-throw-crashes-fetch`                          | git/quarantine       | A dangling/unstattable ref makes the pre-fetch quarantine walk throw uncaught, killing the whole run instead of degrading to `{ok:false}`                      | A malformed/unstattable ref entry must not turn a fetch preflight into a process-killing throw; callers return `{ok:false}`                                                      | smoke       |
| `learned-pattern-redos-wedge`                                  | halt/drain           | An LLM-proposed backtracking regex matched against a long `stdoutTail` spins the event loop past the 60s deadline; heartbeat freezes, monitor may stall-kill   | `learnedPatternMatch` against a backtracking regex on a long tail returns within a hard wall-clock bound (input cap, timeout, or load-time rejection)                            | smoke       |
| `auth-preflight-cache-permanent-positive`                      | provider failures    | Token expires at hour 1; cached `{ok:true}` skips the early-halt preflight for the rest of the run                                                             | A positive auth result is invalidated by TTL or by an auth-shaped spawn failure; a stale positive does not outlive a plausible token lifetime                                    | smoke       |
| `dual-impl-worktree-leak-never-swept`                          | git/worktree         | Every applyWinner-failure or crash leaks a `/tmp/gstack-dual-*` worktree pair + 2 branches; nothing reaps `os.tmpdir()`                                        | Leaked dual-impl worktrees under `os.tmpdir()` are discoverable and reapable by some sweep/teardown path                                                                         | integration |
| `scratch-worktree-tmp-leak`                                    | release queue/daemon | Daemon scratch worktrees under `os.tmpdir()/gstack-release-daemon/` accumulate forever over a multi-day watch                                                  | After a record reaches terminal status, its daemon-created scratch worktree is removed (`git worktree remove`/prune)                                                             | integration |
| `subagent-child-grandchild-false-stall-kill`                   | stall/monitor        | A legit 25-30min shell-wrapped Kimi/ship call (CLI is a grandchild, phase not `_running`) is escalated `USER_ACTION_REQUIRED` and burns a Codex escalation     | A live recognized subagent _anywhere_ in the orchestrator's process subtree suppresses the stale alarm                                                                           | integration |
| `preflight-auth-fail-loses-forensics-and-double-spawns-backup` | provider failures    | A preflight auth-fail (exit 1) unconditionally spawns the backup, and non-`PROVIDER_AUTH_RE` phrasings (`not authenticated`) fall through to a generic failure | An auth-classified primary failure is classified (not generic) AND does not blindly fan out to the backup before recording the verdict                                           | integration |
| `run-tests-timeout-hard-fail`                                  | phase runner         | A `runTests` timeout (leaked port / infra hang) is terminal with no retry, indistinguishable from a real red                                                   | A test-run timeout records `finalStatus:"timeout"` distinctly from red; one timeout is not permanently terminal (bounded retry)                                                  | smoke       |
| `faultid-collision-silent-overwrite`                           | halt/drain           | A phase re-failing with the same render message collapses to one `faultId` and `renameSync`-clobbers prior forensic snapshots                                  | Two distinct occurrences (same kind+phase, different snapshot/timestamp) are both preserved OR the collapse is counted                                                           | smoke       |
| `quota-resetAt-parsed-never-scheduled`                         | provider failures    | An overnight build hits a 90-min cap, parses `resetAt`, then dead-halts until morning                                                                          | `resetAt` is surfaced as a structured field to the supervisor (and, if policy added, drives a bounded sleep-until-reset)                                                         | smoke       |

### Medium / low (selective — pick the highest-leverage, see §3 group H)

| id                                                                            | subsystem      | what breaks                                                                                             | tier        |
| ----------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| `state-save-no-fsync-torn-on-crash`                                           | state          | Torn/zero-length `state.json` after OOM/power-loss; resume acts on partial state                        | smoke       |
| `sweep-pid-reuse-false-live` / `orphaned-tmp-and-stale-pid-state-files`       | state/sweep    | Recycled PID protects an abandoned worktree forever; `.tmp.<pid>` orphans accumulate                    | smoke       |
| `shape-z-sweep-can-reap-other-live-runs-worktree`                             | state/sweep    | A transient torn-read of a live run's record makes the startup sweep destroy in-progress work           | integration |
| `heartbeat-transient-failure-ttl-expiry-double-land`                          | release locks  | Sustained transient push failures let the 2h lock TTL lapse; a second daemon steals and double-lands    | smoke       |
| `verifymerged-default-ttl-asymmetry`                                          | release locks  | `acquire` default TTL (1h) < `refresh` TTL (2h); lock stealable before first refresh                    | smoke       |
| `gbrain-restore-mutates-lastupdatedat-before-mirror`                          | state          | Cross-machine resume resets the progress timestamp, blinding stall detection                            | smoke       |
| `stuck-slow-bucket-missed-hang` / `cpu-mode-transient-ps-failure-false-stall` | stall watchdog | A hung slow tool kept alive indefinitely; ps-probe flake false-kills a live silent agent                | smoke       |
| `persisthitcounts-busyspin-blocks-loop` / `analytics-jsonl-unbounded-growth`  | halt/drain     | Orphaned detector lock busy-spins 5s per tick; append-only sinks grow unbounded                         | smoke       |
| `corrupt-repo-matcher-too-narrow` / `packed-refs-malformed-blind-spot`        | git            | Most real corruption messages miss the `GIT_REPO_CORRUPT` halt; packed malformed refs defeat quarantine | smoke       |

## 3. The robustness smoke suite design

**Suite name:** `build-robustness` (files live in `build/orchestrator/__tests__/robustness/` so they run under the existing `bun test build/orchestrator/__tests__` glob but are greppable as a set; the npm wrapper targets the subdir directly).

**Naming convention:** every spec file ends `.robustness.test.ts`. All `smoke`-tier specs are free, deterministic (fake clock / fake spawn / temp git / injected state), and finish in well under 2s combined. `integration`-tier specs spawn a _real short-lived `/bin/sh` or `/bin/sleep`_ (no LLM, no network) and stay under ~10s combined. Nothing here needs an API key.

A note shared by most specs below: several pin the **desired** invariant against code that does not yet satisfy it. Those are authored as **red TDD specs gated behind a fix** — they are committed `.skip`-marked with a `// UNSKIP WHEN <id> IS FIXED` banner so the suite stays green pre-fix, then the fix PR removes `.skip`. This keeps the gate runnable today while making each gap a checklist item. Specs that pin _current correct_ behavior (regression pins) run live immediately. Each spec below is tagged `[PIN]` (runs now) or `[RED]` (committed skipped until fix).

### Group A — Provider failures (auth, capacity, quota)

**A1. `provider-capacity-retry-wired.robustness.test.ts`** `[RED]` — smoke
Setup: temp `BuildState` fixture, one phase, no `backupProvider`. Inject a fake `spawnCaptured`/`runConfiguredRoleTask` that returns a canned `SubAgentResult` whose log text contains `API Error: 529 Overloaded` + `exitCode:1` on the first N calls then a clean PASS; inject a `sleepMs` spy and deterministic rng (same seam `feature-start-network-retry.test.ts` uses for `gitFetchWithRetry`).
Invariant: the FAIL path sleeps the backoff schedule and re-spawns; `providerRetryAttempts` increments per attempt; after `PROVIDER_RETRY_SESSION_CAP` (6) failures it emits the halt (not before); a clean PASS within budget completes the phase.
Catches: the dead-code regression where `planProviderRetry` is never wired (current state) or gets unwired by a refactor. **Highest-value spec in the suite.**

**A2. `auth-preflight-revalidation.robustness.test.ts`** `[RED]` — smoke
Setup: point `GEMINI_BIN` at a temp shell script driven by a counter file (first call exit 0, later calls print `please re-authenticate` to stderr + exit 1), like `gemini-auth-preflight.test.ts` T11. Call `assertGeminiAuth` twice _without_ `_resetAuthPreflightForTests` between.
Invariant: the second call re-probes and returns `{ok:false}` (cache invalidated by TTL or auth-shaped failure), not an unconditional permanent positive.
Catches: builds running for hours on an expired token because the once-cached positive is never revisited.

**A3. `preflight-auth-fail-classified-and-no-blind-fallback.robustness.test.ts`** `[RED]` — integration
Setup: `GEMINI_BIN` → temp script printing `not authenticated` / exit 1 (the phrasing `AUTH_REQUIRED_RE` accepts but `PROVIDER_AUTH_RE` does not). Drive `runConfiguredRoleTask` with a role that has `backupProvider`, injecting a spy fake spawn for the backup.
Invariant: (a) the auth reason reaches a classifiable auth verdict (exposes the `AUTH_REQUIRED_RE` vs `PROVIDER_AUTH_RE` asymmetry) rather than a generic `markPhaseFailed`; (b) the backup spawn is not invoked, or only after the auth verdict is recorded.
Catches: auth root cause vanishing from forensics + a redundant backup spawn per affected phase.

**A4. `quota-reset-resume-policy.robustness.test.ts`** `[PIN]+[RED]` — smoke
Setup: feed `classifyProviderFailure` a canned quota log with `resets at 11pm`; fake clock.
Invariant: `[PIN]` `verdict.resetAt` is captured. `[RED]` `resetAt` reaches the `HaltEvent` as a _structured field_ (not buried in prose), and if a sleep-until-reset policy exists it bounds the wait (near-future cap waits, far-future weekly cap halts).
Catches: silent multi-hour overnight stalls on self-resolving caps; any regression dropping `resetAt` from the structured surface.

### Group B — Stall detection / monitor / watchdog

**B1. `monitor-resume-count-resets-on-progress.robustness.test.ts`** `[RED]` — smoke
Setup: reuse `monitor.test.ts` harness (`GSTACK_BUILD_STATE_DIR` temp, `manifest()`, `writeState`, injected `now`, `spawnResume:false`). Sequence: stale+dead-pid → `RUN_RESUMED` resumeCount 1; pre-stage counter to 2 (`fs.writeFileSync`, mirrors `monitor.test.ts:366`); advance `currentPhaseIndex` + freshen `lastUpdatedAt`; re-stale.
Invariant: after genuine phase progress, the re-stale yields `RUN_RESUMED` with resumeCount back at 1, not 3. (Load-bearing assertion is the final count; the intermediate event label is `RUN_STALE`, not `RUN_RUNNING`, per `monitor.ts:1424`.)
Catches: a healthy long run with intermittent recovered stalls falsely `RUN_HALTED_RESTART_CAP`'d.

**B2. `monitor-grandchild-subagent-no-false-stall.robustness.test.ts`** `[RED]` — integration
Setup: spawn `/bin/sh -c 'exec <copied /bin/sleep renamed kimi> 60'` so the recognized CLI is a grandchild (`ppid = sh ≠ test pid`). Write state with all phases `committed`/`pending` (none `_running`), `lastUpdatedAt` 20min old, fresh sidecar with frozen phase/`drainProcessedCount`, fresh `stdoutLog`/`pidFile` mtimes. `evaluateMonitorOnce` with small `buildStallThresholdMs`.
Invariant: does NOT emit `USER_ACTION_REQUIRED` (a live recognized subagent anywhere in the subtree suppresses the alarm).
Catches: a healthy 25-30min shell-wrapped call interrupted + a wasted supervisor escalation.

**B3. `monitor-stale-tracker-across-resume.robustness.test.ts`** `[RED]` — smoke
Setup: temp `stateDir`. Pre-write `heartbeat-track.json` with `lastChangedAt = now-20min`, `lastSeenPhase=N`, `lastSeenDrainProcessedCount=K`; fresh sidecar (same runId+pid trust gate) replaying phase=N, drain=K. `evaluateMonitorOnce` once, `buildStallThresholdMs=15min`, fresh `now`.
Invariant: does NOT immediately escalate (a resumed process gets a grace window / re-seeds `lastChangedAt` on the first post-resume poll).
Catches: a resumed long run killed on its first monitor poll because the stall clock was inherited from the dead process.

**B4. `cpu-watchdog-transient-probe-flake.robustness.test.ts`** `[PIN]` — smoke
Setup: `attachStallWatchdog({mode:'cpu'})` with `makeFakeChild`+`makeFakeClock` (`auth-prompt-watchdog.test.ts` helpers) and an injected `sampleCpuFn` returning increasing cputime on most ticks, `null` on scattered ticks.
Invariant: scattered `null` probe samples between positive samples do NOT trip `stallKilled`; a continuous run of `null` past `stallMs` DOES kill.
Catches: ps-probe flakiness on a loaded host false-killing a healthy silent-by-design agent.

**B5. `stall-watchdog-sticky-slow-bucket.robustness.test.ts`** `[RED]` — smoke
Setup: same fake harness; `parseProgress` returns `slowToolStart` for a marker line emitted every 4min (< `progressGapMs` 5min, < slow window) for 40min of fake time.
Invariant: the watchdog eventually kills (an absolute cap on a single tool invocation without `TOOL_END`).
Catches: a genuinely-hung slow tool kept alive indefinitely by repeated classifiable `TOOL_START` lines.

### Group C — Process lifecycle / shutdown

**C1. `signal-shutdown-escalation-order.robustness.test.ts`** `[RED]` — integration
Setup: fork a child node/bun harness that installs _both_ `installSignalHandlers()` and the `onSignal` pair against a fake state+slug in a temp dir. Register a real detached `sh -c "trap '' TERM; sleep 60"` process group via child-registry. Send SIGTERM to the harness; poll.
Invariant: (1) state file written + lock removed; (2) the trapped group is dead within a bounded window (the SIGKILL escalation reached it). Since the 2000ms grace is hardcoded, assert via process liveness after a bounded wait.
Catches: the dual-registration race where state-save wins the exit and leaks SIGTERM-ignoring sub-agents.

**C2. `shutdown-grace-escalation.robustness.test.ts`** `[PIN]` — integration
Setup: spawn a real `node -e` child that traps SIGTERM and keeps running; register via `child-registry.spawn`. `killAllChildren('SIGTERM')` → assert alive; `killAllChildren('SIGKILL')` → poll `isProcessAlive` until dead within a bounded loop.
Invariant: the escalation actually SIGKILLs a SIGTERM-ignoring child and the parent does not hang.
Catches: regressions in the kill-escalation primitive itself (independent of the C1 ordering bug).

**C3. `state-resume-torn-file.robustness.test.ts`** `[PIN]` — smoke
Setup: temp dir; write a deliberately truncated/partial JSON to the state path. Call `readState`/resume entry.
Invariant: it fails closed (throws a clear error or returns null), never silently acts on partial state. Separately assert `saveState`'s tmp+rename hygiene (and document the no-fsync gap by asserting current behavior so a future fsync fix is observable).
Catches: a long-run-killed orchestrator resuming on a corrupt state file and double-running phases.

### Group D — Release queue / locks / daemon

**D1. `release-daemon-stale-inflight-reclaim.robustness.test.ts`** `[RED]` — smoke
Setup: `writeReleaseQueueRecord` a record `status:'landing'` with old `lastUpdatedAt` into a temp `queueDir` + temp `.git` on the TMP allowlist; do NOT register it in `activeRecords` (`_resetReleaseDaemonForTests` clears module state, simulating a fresh post-SIGKILL process). `runReleaseDaemon({once:true, processor: recording-stub})`.
Invariant: the stranded record is handed to the processor or rewritten to `queued`/`blocked` (an in-flight status is never a permanent dead end). Also assert `retryReleaseQueueRecord` can rescue an in-flight (not just `blocked`) record.
Catches: a hard-killed daemon permanently abandoning an in-flight PR.

**D2. `release-heartbeat-fails-closed-on-ttl.robustness.test.ts`** `[RED]` — smoke
Setup: construct `createReleaseLockHeartbeat` with a fake `now` advancing past `ttlMs` across `beat()` calls and a `refresh` stub always returning `{ok:false,lostOwnership:false}`.
Invariant: once elapsed-since-last-success exceeds `ttlMs`, `lostOwnership()` becomes non-null (fail closed).
Catches: the "transient forever" behavior allowing expired-lock double-landing on long lands.

**D3. `release-acquire-ttl-not-shorter-than-refresh.robustness.test.ts`** `[PIN]` — smoke
Setup: `acquireRemoteReleaseLock` with `fakeGit` + fixed `now`, no `ttlMs`; parse pushed `expiresAt`; same for `refreshRemoteReleaseLock`.
Invariant: `(acquire expiresAt - now) >= (refresh expiresAt - now)` and both align with `RELEASE_LOCK_TTL_MS`.
Catches: the 1h/2h default-arg asymmetry and future drift re-opening an early-steal window.

**D4. `release-scratch-worktree-reaped.robustness.test.ts`** `[RED]` — integration
Setup: `spyOn(childRegistry,'spawnSync')` to canned-success fetch/worktree-add/rev-parse, recording argv. Drive `processReleaseQueueRecord` to `landed` (`verifyMerged:()=>({merged:true})`, land stub exit 0) with a non-existent `worktreePath` so the scratch fallback fires.
Invariant: `spawnSync` is called with `git worktree remove` (or prune) for the scratch path after land.
Catches: the total absence of scratch-worktree cleanup; `/tmp` + `.git/worktrees` unbounded growth on a long daemon.

**D5. `sweep-shape-z-protects-unreadable-record.robustness.test.ts`** `[RED]` — integration
Setup: temp fake HOME + registry + real parent git repo. Create a real worktree under `<fakeHome>/.gstack/build-worktrees/test-repo/<runId>`; write a corrupt (truncated JSON) active-run record for that runId so `readActiveRunRecords` skips it. `sweepOrphans` with injected `homeDir`.
Invariant: the worktree still exists afterward (an unreadable record must not be treated as "unclaimed therefore orphaned").
Catches: a startup sweep destroying a concurrent live build's worktree on a transient read error.

### Group E — Git / quarantine / worktree

**E1. `quarantine-walk-resilience.robustness.test.ts`** `[RED]` — smoke
Setup: temp git repo (real `git init` + one commit). Create `.git/refs/heads/feat/` then `fs.symlinkSync('/nonexistent', '.git/refs/heads/feat/dangling')` so `statSync` throws ENOENT. Call `quarantineMalformedRefs(tmpDir)`; separately call `syncLandedBase(tmpDir)` on a no-origin repo.
Invariant: `quarantineMalformedRefs` does NOT throw (skip-and-continue); `syncLandedBase` returns `{ok:false}` (a normal error result), not a process-killing throw.
Catches: the uncaught `statSync`/`readdirSync` throw aborting a multi-hour run on a recoverable FS condition.

**E2. `dual-impl-leak-sweep.robustness.test.ts`** `[RED]` — integration
Setup: temp git repo + one commit. Call `worktree.createWorktrees({cwd,slug,phaseNumber})` twice (two phases) → four `/tmp` worktrees + four branches; skip teardown (simulate crash).
Invariant: `git worktree list --porcelain` shows the leaks; the chosen reaper (tmpdir-aware branch in `sweepOrphans`, or recorded-list teardown) removes them and `git branch --list 'gstack-dual-*'` is empty.
Catches: the missing reaper for `/tmp` dual worktrees + leaked branches.

**E3. `stale-index-lock-boundary.robustness.test.ts`** `[PIN]` — smoke
Setup: temp git repo via `resolveGitDir`; use `fs.utimesSync` as a fake clock (mirrors `cli.test.ts:2095-2236`).
Invariant: a `<10s`-old `index.lock` is preserved; a `>=10s`-old one is removed.
Catches: a regression that lowers the age cutoff and starts deleting live locks. (Note: a PID-from-lockfile liveness probe is _not_ implementable — git's index.lock holds no owner PID — so this spec pins the age boundary only, per the refutation in §5.)

**E4. `corrupt-repo-matcher-coverage.robustness.test.ts`** `[RED]` — smoke
Setup: unit-test `isCorruptRepoError` directly (export if needed) with representative real corruption strings beyond the two current literals; or drive `syncFeatureBranchWithBase` against a clone with a truncated loose object.
Invariant: representative corruption messages classify as `GIT_REPO_CORRUPT` with a `git fsck --full` hint, OR there is an explicit tested decision that they do not.
Catches: silent loss of the actionable corrupt-repo halt for most real corruption messages.

### Group F — Halt events / fault drain / replay

**F1. `learned-pattern-redos-bounded.robustness.test.ts`** `[RED]` — smoke
Setup: write `learned-patterns.json` with one `stdout_regex` like `(a+)+$`. Emit a halt whose `snapshot.stdoutTail` is ~5000 chars of `a` then `!`. Synchronous `mockInvestigator` so only the short-circuit path runs. Wrap a direct `learnedPatternMatch` call in a wall-clock assertion.
Invariant: returns within ~500ms (input cap / regex timeout / load-time rejection).
Catches: reintroduction of unbounded untrusted-regex evaluation in the drain hot path. **Defeats the 60s `Promise.race` deadline today — high priority.**

**F2. `halt-faultid-distinct-occurrences-preserved.robustness.test.ts`** `[RED]` — smoke
Setup: temp `queueDir`. Call `emitHaltEvent` twice with identical `kind=PHASE_FAILED`, same phase index, same message, but different `snapshot.stdoutTail` and `opts.now` 5 min apart.
Invariant: read `pending-investigations/` and assert the intended contract — either two files exist (faultId carries a discriminator) OR exactly one file plus a documented overwrite-counter/analytics row records the collapse.
Catches: silent destruction of forensic snapshots across long-run recurrences (the `renameSync` clobber).

**F3. `inbox-autofile-no-same-day-clobber.robustness.test.ts`** `[RED]` — smoke
Setup: temp `GSTACK_HOME`. Emit one HIGH `PHASE_FAILED`, drain with a synchronous `mockInvestigator` returning root-cause-identified; re-emit the same faultId, drain again with a fixed `now` on the same UTC day.
Invariant: `inboxFiled` count equals the number of distinct files actually on disk in `inboxDir`.
Catches: a second day-of triage signal silently overwriting the first.

**F4. `detector-stale-lock-reclaimed.robustness.test.ts`** `[PIN]` — smoke
Setup: temp `GSTACK_HOME` with valid `learned-patterns.json`; pre-create `learned-patterns.json.lock` with a dead PID (`999999`). Call `detectSkillFaults` with a fault-triggering state; time the call.
Invariant: completes well under 5s AND the hit count actually incremented (stale lock reclaimed, not timed-out-and-swallowed).
Catches: orphaned-lock-after-crash injecting 5s event-loop freezes per tick on a resumed run.

### Group G — Phase runner / TDD loop

**G1. `phase-runner-run-tests-timeout.robustness.test.ts`** `[PIN]+[RED]` — smoke
Setup: `applyResult(phaseState{impl_done→RUN_TESTS}, {type:'RUN_TESTS'}, mockResult({timedOut:true}))` (pure in-memory).
Invariant: `[PIN]` `next.status==='failed'`, `next.testRun.finalStatus==='timeout'`, `iterations` incremented (the timeout-vs-red distinction must survive). `[RED]` a second `RUN_TESTS` with a green result after a timeout still reaches `tests_green` (one timeout is not permanently terminal).
Catches: losing the timeout-vs-red distinction; a single flaky suite hang throwing away a phase.

**G2. `feature-review-needs-phases-bounded.robustness.test.ts`** `[RED]` — smoke
Setup: drive `runFeatureReviewIteration` with a fake dispatcher always returning a parseable `FEATURE_NEEDS_PHASES` verdict + fresh phase block (the dry-run/stub seam from `feature-verifier-pre-merge.test.ts`); temp plan file for `appendFeaturePhases`.
Invariant: `fr.iterations` is consumed each cycle (the cap fires) and `phasesAdded` never exceeds the cap.
Catches: a flapping successful-verdict loop appending phases without bound, burning a long run's budget.

### Group H — Selective medium hygiene (one consolidated file)

**H1. `state-and-sweep-hygiene.robustness.test.ts`** `[RED]` — smoke (multiple `it()` blocks)
A single file batching the highest-leverage medium findings so they cost one file, not five:

- `savestate-write-failure-no-tmp-orphan`: monkeypatch `fs.renameSync` to throw ENOSPC once → assert no `.tmp.<pid>` orphan remains and `lastUpdatedAt` was not advanced past the last durable write.
- `sweep-pid-reuse-not-protected`: write a `running` record with stale `lastUpdatedAt` and `pid=process.pid` → assert the live-PID short-circuit is gated by an identity/heartbeat check (reaped despite live PID).
- `gbrain-restore-preserves-lastupdatedat`: stub `gbrainGet(slug)` → a state with a 3h-old `lastUpdatedAt`, no local JSON → assert `loadState` preserves the old timestamp (does not stamp restore-time).

Catches: torn-write tmp-orphan growth, PID-recycle false-live worktree protection, and cross-machine resume blinding the stall detector.

**Total: 26 specs across 24 files** (H1 batches three). A maintainer pre-release runs the whole set in a few seconds (smoke) plus a handful of real short-lived spawns (integration). The `[RED]` specs are committed skipped, so the gate is green today and each fix PR unskips its spec.

## 4. Wiring

### npm script

Add to `package.json` `scripts` (alongside the existing `test:build-skill`):

```json
"test:build-robustness": "bun test build/orchestrator/__tests__/robustness/",
"test:build-robustness:all": "GSTACK_ROBUSTNESS_INCLUDE_PERIODIC=1 bun test build/orchestrator/__tests__/robustness/"
```

`test:build-robustness` runs the default set (all smoke + integration specs; `[RED]` specs are `.skip` and don't run until their fix lands). It is free, deterministic, no API key. Because the robustness files sit under `build/orchestrator/__tests__/`, they _also_ run under the existing `test:build-skill` glob — that is intentional, so anyone running the existing gate gets them for free. The dedicated script exists for a fast, targeted local pre-release run (`bun test build/orchestrator/__tests__/robustness/` is ~2-3s vs the full build-skill suite).

### CI gate

The existing `.github/workflows/build-skill-gate.yml` already runs `bun run test:build-skill` on every `build/**` PR and push, which now transitively includes `build/orchestrator/__tests__/robustness/`. **No new workflow needed for the smoke/integration tier** — they ride the existing gate. To make the robustness set visible as its own pass/fail signal (recommended, so a robustness regression is named in the CI log rather than buried in the build-skill output), add one step after the existing gate step:

```yaml
- name: Run deterministic build skill gate
  run: bun run test:build-skill

- name: Run long-run robustness suite
  run: bun run test:build-robustness
```

This is a redundant-but-named run (the files already ran in the prior step); it costs ~3s and gives the maintainer a labeled green/red. If that redundancy bothers you, instead exclude the robustness subdir from `test:build-skill` and run only the named step — but the simpler path is the named redundant step.

### Periodic tier

Almost nothing here needs the periodic tier — the whole point is that the suite is free and deterministic so it runs _before every release_. The two candidates for opt-in periodic gating are the **integration specs that spawn real processes** (`C1`, `C2`, `B2`, `D4`, `D5`, `E2`), because real-spawn timing can be marginally flaky on a loaded CI box. Recommendation: keep them in the smoke gate (they are bounded-wait, not wall-clock-fragile, and the value of catching a shutdown/leak regression pre-release outweighs the rare retry), but guard the _slowest_ one — `C1` `signal-shutdown-escalation-order` (forks a full harness + real grace window) — behind `GSTACK_ROBUSTNESS_INCLUDE_PERIODIC` and run it via `test:build-robustness:all` in a weekly cron alongside `test:periodic`. If CI ever flakes on a real-spawn spec, move that single spec behind the same env flag rather than weakening the assertion. These specs are NOT added to `E2E_TIERS` in `test/helpers/touchfiles.ts` — that table is for paid `claude -p` evals; the robustness suite is free `bun:test` and is gated by file path, not by `EVALS_TIER`.

## 5. What was refuted / already covered

The audit did not pad. Eight candidate findings were investigated and dropped, and the drops are load-bearing for trust:

- **`startup-hang-window-clamped-to-stallms`** — refuted. The claim's own proposed test case (a first byte before the clamped window aborts Phase A) is _already correct_ behavior (`stall-watchdog.ts:469-485,546-549`) and _already covered_ (`stall-watchdog.test.ts:949-1141`, 46 passing). Production always passes the resolved 300_000, so the in-watchdog 120_000 default is dead. Residual is a one-line stale-comment cleanup, not a test gap.
- **`startup-hang-misclassified-as-recoverable-stall`** — refuted on severity. The code-evidence (killReason collapsed to `kind:"stall"`) is real, but the claimed retry-budget runaway does NOT occur: spawn explicitly does not retry stalls (`sub-agents.ts:1857-1860`), and the FAIL path halts in one shot. It is a low-severity labeling gap, not a long-run multiplier.
- **`provider-retry-cap-not-persisted-across-resume`** — refuted. The "reset to 0 on every resume" mechanism is false (`state.ts:158` guards on `=== undefined`; survival is already covered by `state-migration-pr1b.test.ts:149-170`). The real issue here is the _dead-code_ one captured in `A1`, not a persistence bug.
- **`codex-unclear-verdict-hard-fail-no-retry`** — invalid. `mergeGateResults` (`cli.ts:7411-7418`) always synthesizes the `GATE PASS`/`GATE FAIL` verdict string itself, so `parseVerdict` can never return `unclear` from the gate path; the `unclear→failed` branch is dead defensive code, and a no-marker result already degrades to `codex_running` and re-iterates under `maxCodexIterations`.
- **`stale-index-lock-clobber-on-slow-disk`** — downgraded high→low. The age-boundary invariants are _already covered_ in `cli.test.ts:2095-2236` (the auditor's grep missed that file). The proposed PID-liveness hardening is **not implementable** — git's `index.lock` contains the new index binary, not an owner PID. `E3` pins only the age boundary.
- **`orphan-resolved-races-detected-emit`** — invalid. The triggering scenario is structurally impossible: both production `emitHaltEventResolved` sites emit DETECTED first and _synchronously_ (`console.warn`→`emitHaltEvent`→`writeFileSync`+`renameSync`) before an `await`'d backup task, so RESOLVED can never land before its DETECTED. Already covered for the real (cross-run) orphan case.
- **`applywinner-head-drift-wrong-base`** — invalid as a long-run mechanism. Phases run strictly sequentially in one state-machine loop; nothing commits to `cwd` HEAD between `createWorktrees` and `applyWinner`, so wall-clock duration cannot cause base drift. Only an out-of-band manual commit could, and the porcelain preflight catches a dirty tree.

This is why the suite has ~26 specs, not 100: the candidates that turned out to be already-covered, structurally-impossible, or low-severity labeling were cut.

## 6. Implementation order

Write these 7 first — biggest robustness payoff per unit effort. The ordering favors (a) confirmed-or-upgraded severity, (b) the failure actively defeats an existing safety net, (c) cheap pure-function or existing-harness setup.

1. **`A1` provider-capacity-retry-wired** — the single highest-leverage finding. An entire tested-but-unwired recovery subsystem (`planProviderRetry`, `PROVIDER_RETRY_SESSION_CAP`) means transient 529/`RESOURCE_EXHAUSTED` kills multi-hour builds. Pure fakes (`sleepMs` spy, canned `SubAgentResult`), pattern already exists in `feature-start-network-retry.test.ts`.
2. **`B1` monitor-resume-count-resets-on-progress** — the most likely single cause of the user's "fragile on long runs" report. The `monitor.test.ts` harness already pre-stages counter files; this is a few lines of new sequence.
3. **`F1` learned-pattern-redos-bounded** — defeats the 60s `Promise.race` deadline and freezes the heartbeat (which then trips the monitor's own stall-kill). Trivial setup: one `learned-patterns.json` + one long `stdoutTail` + a wall-clock assertion.
4. **`D1` release-daemon-stale-inflight-reclaim** — permanent silent loss of one PR per hard kill, the most-likely-killed workload. `writeReleaseQueueRecord` + `runReleaseDaemon({once:true})` + `_resetReleaseDaemonForTests` are all proven seams in `release-daemon.test.ts`.
5. **`C1` signal-shutdown-escalation-order** — orphans LLM sub-processes on every interrupt, compounding across restarts. Real but cheap: a forked harness + one trapped `sleep`; the integration cost is justified because no pure test can reproduce two competing OS signal handlers.
6. **`E1` quarantine-walk-resilience** — an uncaught `statSync` crashes the whole orchestrator at fetch time on a recoverable FS condition. Pure local git + one `fs.symlinkSync`; reproduced empirically in the audit.
7. **`A2` auth-preflight-revalidation** — hours of spawns running on a dead token. The exact counter-file temp-shell-script harness already exists in `gemini-auth-preflight.test.ts` T11; this is a near-copy with the inverted assertion.

After these seven, fill in `B2`, `G1`, `F2`, `D4`/`E2` (the leak reapers), then the `D3`/`H1` hygiene batch. Files relevant to the writer: `build/orchestrator/__tests__/monitor.test.ts` (harness), `build/orchestrator/__tests__/auth-prompt-watchdog.test.ts` (`makeFakeChild`/`makeFakeClock`), `build/orchestrator/__tests__/release-daemon.test.ts` (`spyOn(childRegistry,'spawnSync')`, `_resetReleaseDaemonForTests`), `build/orchestrator/__tests__/gemini-auth-preflight.test.ts` (counter-file `GEMINI_BIN` pattern), `build/orchestrator/__tests__/feature-start-network-retry.test.ts` (`sleepMs` spy seam), and `build/orchestrator/halt-events.ts:150-153` (`emitHaltEvent(event, {queueDir, now})` signature).

## 7. Implementation status (live)

The suite scaffold (§3) is built and wired: 28 spec files under
`build/orchestrator/__tests__/robustness/`, a shared `helpers.ts`, the
`test:build-robustness` npm script, and a named CI step in
`build-skill-gate.yml`. The full build-skill gate is green (PIN specs pass,
unfixed gaps committed as `describe.skip` REDs).

**Fixed and green (RED → unskipped) — 23 of 24 fixable gaps:**

| id   | fix                                                                                                                                                                  | production touched                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `B1` | monitor resume counter resets on committed-phase progress (consecutive-failed, not lifetime)                                                                         | `monitor.ts`                              |
| `F1` | learned `*_regex` matchers reject nested-quantifier ReDoS at eval time + input cap                                                                                   | `skill-fault-detector.ts`                 |
| `D1` | daemon reclaims a stale in-flight (`landing`/`claiming`/`drift_repairing`) record; `retryReleaseQueueRecord` rescues in-flight too                                   | `release-daemon.ts`                       |
| `E1` | quarantine `walk()` skips an unstattable / dangling-symlink ref instead of throwing out of the fetch preflight                                                       | `cli.ts`                                  |
| `A2` | `assertGeminiAuth` TTL+clock revalidation — a cached positive is re-probed after the TTL (no more hours on a dead token)                                             | `sub-agents.ts`                           |
| `D2` | release-lock heartbeat fails closed once `> ttlMs` since the last successful refresh (no transient-forever)                                                          | `release-daemon.ts`                       |
| `D3` | acquire + refresh share one `RELEASE_LOCK_DEFAULT_TTL_MS` (2h); steal-window closed                                                                                  | `release-lock.ts`, `release-daemon.ts`    |
| `D4` | daemon reaps the scratch worktree (`git worktree remove`/`prune`) after a land via the scratch fallback                                                              | `release-daemon.ts`                       |
| `E4` | corrupt-repo matcher widened (packed-refs / empty loose object) + applied on checkout/merge legs → `GIT_REPO_CORRUPT` + fsck hint                                    | `cli.ts`                                  |
| `F3` | inbox auto-file suffix loop (`-2`,`-3`) — a same-UTC-day re-emit no longer clobbers the prior triage file                                                            | `drain-faults.ts`                         |
| `F4` | detector `acquireLock` reclaims a dead-PID stale lock once (via `isPidAlive`) instead of spinning 5s and dropping the hit-count                                      | `skill-fault-detector.ts`                 |
| `A4` | quota `resetAt` surfaced as a structured `HaltEvent.snapshot.resetAt` field, not just prose                                                                          | `halt-event-helpers.ts`, `halt-events.ts` |
| `B5` | opt-in absolute single-tool-invocation cap (`maxToolInvocationMs`) — a never-completing slow tool is killed (`tool_timeout`)                                         | `stall-watchdog.ts`                       |
| `G1` | a `RUN_TESTS` timeout is retryable (bounded) — `decideNextAction` re-issues `RUN_TESTS` for `finalStatus:"timeout"`, not FAIL                                        | `phase-runner.ts`                         |
| `H1` | saveState rolls back `lastUpdatedAt` + cleans tmp on torn rename; gbrain-restore preserves the restored timestamp; sweep live-PID skip gated on a fresh heartbeat    | `state.ts`, `cli.ts`                      |
| `D5` | sweep Shape Z fails closed on an unreadable active-run record — a torn/truncated registry file no longer lets a concurrent build's live worktree be reaped           | `cli.ts`                                  |
| `F2` | recurrence with a different snapshot archives the prior capture to `<queueDir>/collapsed/` + an `occurrences` counter (stable faultId; dedup/pairing intact)         | `halt-events.ts`                          |
| `A3` | `PROVIDER_AUTH_RE` realigned with `AUTH_REQUIRED_RE`; primary auth failure is classified and does NOT blindly fan out to the backup                                  | `halt-event-helpers.ts`, `sub-agents.ts`  |
| `B3` | resumed run gets a stall-clock grace window (tracker records `lastSeenPid`; a pid change re-seeds instead of inheriting the dead clock)                              | `monitor.ts`                              |
| `B2` | subagent-liveness probe walks the whole subtree (shell-wrapped grandchild counts), not just direct children                                                          | `monitor.ts`                              |
| `E2` | sweep reaps leaked `os.tmpdir()/gstack-dual-*` worktrees + branches (staleness-gated so a live concurrent dual-impl is never destroyed)                              | `cli.ts`                                  |
| `G2` | feature-review cap decision extracted to a pure, exported `featureReviewCapReached({iterationsConsumed,cap})`; run() routes through it so the bound is unit-tested   | `phase-runner.ts`, `cli.ts`               |
| `C1` | interrupt cleanup is a `registerShutdownHook` (no early `process.exit`) inside the single signal path; the SIGTERM→grace→SIGKILL escalation now reaps trapped groups | `child-registry.ts`, `cli.ts`             |

Each fix landed with its RED spec unskipped and the touched file's existing tests
re-run green (zero regressions). Existing tests that had codified the old
behavior were corrected alongside their fix: the D3 PIN (acquire TTL 1h→2h), the
sweep "skips live-PID records" test (now carries a fresh heartbeat, matching
H1's heartbeat-gated live-skip), and the F2 spec's 3rd assertion (stable faultId,
not a discriminator). The pre-existing monitor-stale-subagent-child T-B1c/T-B1d
load flake was also stabilized (poll for ps visibility + deterministic child reap).

**Update (this pass): `G2` and `C1` shipped.**

- `G2` (feature-review needs-phases bound) — production was already bounded; the
  only gap was testability. Fixed by extracting the cap-firing comparison into a
  pure, exported `featureReviewCapReached({iterationsConsumed, cap})` in
  `phase-runner.ts` and routing run() through it. Behavior-preserving; the spec
  now drives the REAL decision, so an off-by-one in the bound fails the suite.
- `C1` (signal-handler unification) — fixed by a `registerShutdownHook` seam in
  `child-registry.ts`. `shutdownAndExit` runs the caller cleanup hooks first,
  then the SIGTERM→`sleep(2000)`→SIGKILL→exit escalation; cli.ts replaces its
  racing `onSignal` pair (which `process.exit(130)`'d synchronously) with a hook
  that saves state + releases the lock and does NOT exit. Verified by the C1
  forked-process integration spec (now `[RED→FIXED]`, stable 5/5 in isolation)
  plus a static-grep guard pinning the production wiring.

**Remaining RED (1) — `A1` provider-capacity-retry-wired, a documented deferral:**

- `A1` is the single highest-leverage finding (a transient 529 /
  `RESOURCE_EXHAUSTED` kills a multi-hour build because `planProviderRetry` /
  `PROVIDER_RETRY_SESSION_CAP` are dead code). It is held back deliberately — not
  for lack of effort but because it has **no airtight cli-level verification** in
  this suite's scope and is a layered-retry POLICY decision, not a wiring:
  - Two provider-retry layers already exist BELOW the FAIL path — the sub-agent
    CLI's own `retryWithBackoff` (Gemini) / transport retry (Codex) at
    `sub-agents.ts:1029-1032`, and a one-shot Codex 429/403 re-spawn in
    `runCodexImpl` (`sub-agents.ts:2085-2121`). A third orchestrator-level
    backoff composed wrongly yields very long DOOMED builds (3 layers × backoff),
    the opposite of the robustness this targets.
  - A capacity 529 reaches the FAIL handler only after the failure is recorded;
    for a retry to actually re-RUN the role (not re-classify stale state and burn
    backoff before halting), the failing role's `phaseState` must be reset so
    `decideNextAction` re-issues it — role-specific, risky hot-loop surgery.
  - RED #1 is a static-grep on cli.ts; RED #2 drives the real planner through a
    test-local loop (it never touches cli.ts). Neither exercises the actual
    respawn-on-529 behavior, which needs a build-forking harness that injects
    529s and asserts re-dispatch-then-converge.
  - The correct fix is a focused follow-up: one shared
    `runRoleStepWithProviderRetry(spawnFn)` seam at the dispatch boundary that
    COMPOSES with the existing CLI/transport retries, plus an injection harness.
    The full RED rationale lives in the A1 spec header.

The honest state: the pre-release gate exists and is green today; **23 of 24
confirmed gaps are closed with zero regressions**; the lone remaining gap is `A1`,
a tracked, reproducible RED with its deferral rationale documented in-spec and
here — shipped only when its dispatch-boundary seam and 529-injection harness can
verify it airtight, rather than landing an unverified change to the orchestrator's
hot retry loop.
