# CPU-aware startup-hang watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the parallel first-token deadline in `sub-agents.ts` with a CPU-aware startup-hang phase inside `stall-watchdog.ts`, so long-reasoning LLM subagents that burn CPU between tokens are no longer killed prematurely while genuinely hung processes (zero CPU AND zero output for 120s) are still killed promptly.

**Architecture:** Two-phase liveness inside the existing stall watchdog. Phase A (startup, default 120s) fires only when both CPU and stream are silent. Phase B (steady state, legacy `stallMs`) fires once any activity is recorded. Transition is automatic: `recordActivity()` sets `firstActivityAt` the first time it fires, and the poll loop picks the phase based on whether that timestamp is null.

**Tech Stack:** TypeScript (Bun runtime), `bun:test`, existing `attachStallWatchdog` in `build/orchestrator/stall-watchdog.ts`, existing `spawnCaptured` in `build/orchestrator/sub-agents.ts`, existing fake-clock + fake-CPU-sample test infrastructure in `build/orchestrator/__tests__/stall-watchdog.test.ts`.

**Spec:** [docs/superpowers/specs/2026-05-25-cpu-aware-startup-hang-watchdog-design.md](../specs/2026-05-25-cpu-aware-startup-hang-watchdog-design.md)

---

## File Structure

### Files modified

- `build/orchestrator/stall-watchdog.ts` — add `startupHangMs` option, `firstActivityAt` state, Phase A branch in `poll()`, new `killReason: "startup_hang"` value in the docstring union.
- `build/orchestrator/sub-agents.ts` — delete the legacy first-token timer (`firstTokenDeadlineMs`, `firstTokenTimer`, `firstTokenKillTimer`, `clearFirstTokenTimers`, `noteFirstToken`, `firstTokenKilled`), wire `startupHangMs` into the `attachStallWatchdog` call, simplify the `killReason` field in the result payload.
- `build/orchestrator/halt-event-helpers.ts` — extend `renderRoleStepFailure` to recognize `killReason === "startup_hang"` with a distinct summary string.
- `build/orchestrator/__tests__/stall-watchdog.test.ts` — six new tests for the Phase A behavior.
- `build/orchestrator/__tests__/sub-agents.test.ts` — modify the existing `kills zero-output child at first-token deadline` test to assert the new killReason and split into zero-CPU vs CPU-active variants.
- `build/orchestrator/__tests__/halt-event-helpers.test.ts` — one new test for the `startup_hang` summary rendering.
- `CHANGELOG.md` — release entry per the spec's "Operational rollout" section.
- `VERSION` — MINOR bump (per CLAUDE.md "Scale-aware bumps" rule — this is a substantial liveness change to the build orchestrator, not a bug fix).

### Files NOT modified

- `build/orchestrator/cli.ts` — confirmed via `grep -n "killReason\|first_token" build/orchestrator/cli.ts` that there is NO switch on `killReason` and NO reference to `first_token_timeout`. The `_metricsEndedBy = "watchdog"` assignment around line 6993 covers all watchdog kills generically (no killReason branching). The spec listed cli.ts as conditional ("only if the grep finds an existing switch"); the grep was empty, so cli.ts stays untouched.
- `build/orchestrator/types.ts` — `killReason` is typed as `string` (not a union of literals) everywhere. Confirmed at `sub-agents.ts:474` (`killReason?: string`), `halt-event-helpers.ts:26/66/84/285` (`killReason?: string`), `stall-watchdog.ts:150` (`killReason: () => string | undefined`). No type addition needed; the JSDoc union list in `stall-watchdog.ts:144-148` needs `startup_hang` appended.

---

## Branch and worktree setup

- [ ] **Step 0: Create the feature branch**

You are operating from `main` per the harness git status. Create a feature branch from current HEAD:

```bash
git checkout -b feat/cpu-aware-startup-hang-watchdog
```

Expected: `Switched to a new branch 'feat/cpu-aware-startup-hang-watchdog'`.

If `using-git-worktrees` was invoked separately, the worktree is already isolated; skip this step.

---

## Task 1: Add Phase A unit tests to stall-watchdog.test.ts (TDD red phase)

**Files:**

- Modify: `build/orchestrator/__tests__/stall-watchdog.test.ts` (append a new `describe` block at end)

These tests use the existing `makeFakeClock()` + `makeFakeChild()` helpers already defined in the file (lines 14-114). The fake clock returns 0 at construction; `advance(ms)` steps time forward. `single(pid, cpuMs)` builds a Map for the most common one-pid shape (defined at line 620 inside the CPU mode describe block — re-define a local copy in our new describe block since it's not module-scoped).

- [ ] **Step 1: Append new describe block with the six Phase A tests**

Open `build/orchestrator/__tests__/stall-watchdog.test.ts` and append at end of file:

```ts
describe("attachStallWatchdog (Phase A: startup-hang)", () => {
  // Local copy of helper — the CPU-mode block has its own at line ~620.
  const single = (pidNum: number, cpuMs: number) =>
    new Map<number, number>([[pidNum, cpuMs]]);

  it("Phase A fires when CPU=0 and stream=0 for startupHangMs (cpu mode)", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    // Brand-new pid with zero CPU; the existing CPU sampler records it as
    // "first sighting with zero cputime" which is NOT activity.
    const sampleCpuFn = () => single(12345, 0);
    let killSilence: number | null = null;
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 60_000, // long legacy window — must NOT be what fires
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
        startupHangMs: 1_000, // short for the test
        onStallKill: (s) => {
          killSilence = s;
        },
      },
    );
    advance(1_200); // past the 1s Phase A window
    expect(ctrl.stallKilled()).toBe(true);
    expect(ctrl.killReason()).toBe("startup_hang");
    expect(killSilence).not.toBeNull();
    expect(killSilence!).toBeGreaterThanOrEqual(1_000);
    ctrl.stop();
  });

  it("Phase A does NOT fire when CPU > 0 even with zero stream output (main bug fix)", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    // CPU climbs every poll — like a Codex reasoning subagent burning CPU
    // on TLS / event loop while waiting on the model server.
    let cpuMs = 50; // starts non-zero so first sighting registers as activity
    const sampleCpuFn = () => {
      cpuMs += 50;
      return single(12345, cpuMs);
    };
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 60_000,
        provider: "codex",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
        startupHangMs: 1_000,
      },
    );
    advance(3_000); // 3x the startup window
    expect(ctrl.stallKilled()).toBe(false);
    expect(ctrl.killReason()).toBeUndefined();
    ctrl.stop();
  });

  it("Phase A does NOT fire when stream emits bytes even with zero CPU (stream mode)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 60_000,
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        startupHangMs: 1_000,
      },
    );
    // Emit a byte at t=500ms. firstActivityAt is set; Phase A no longer
    // applies; Phase B uses stallMs=60s.
    advance(500);
    emitStdout("hello\n");
    advance(2_000); // past the 1s Phase A window but well under 60s stallMs
    expect(ctrl.stallKilled()).toBe(false);
    ctrl.stop();
  });

  it("Phase A→B transitions to legacy stallMs after first activity", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    const ctrl = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 2_000, // short legacy window for the test
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        startupHangMs: 500, // even shorter Phase A
      },
    );
    advance(200);
    emitStdout("first\n"); // sets firstActivityAt → Phase B
    advance(2_500); // past stallMs from the byte
    expect(ctrl.stallKilled()).toBe(true);
    // Reason is the legacy "stall" string (Phase B uses pre-existing logic).
    expect(ctrl.killReason()).toBe("stall");
    ctrl.stop();
  });

  it("startupHangMs=0 disables Phase A entirely (falls back to legacy stallMs from spawn)", () => {
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    const sampleCpuFn = () => single(12345, 0); // zero CPU, no activity
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 5_000, // legacy window from spawn
        provider: "shell",
        pollIntervalMs: 100,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
        startupHangMs: 0, // disabled
      },
    );
    advance(1_000); // way past what would have been Phase A
    // Still alive because legacy stallMs (5s) hasn't elapsed
    expect(ctrl.stallKilled()).toBe(false);
    advance(5_000); // now past legacy stallMs
    expect(ctrl.stallKilled()).toBe(true);
    expect(ctrl.killReason()).toBe("stall");
    ctrl.stop();
  });

  it("Phase A defaults to 120_000ms when startupHangMs option omitted", () => {
    // Belt-and-suspenders: confirms the in-watchdog default matches the
    // env-var-side default of 120_000. If someone changes one without the
    // other, this test fails fast.
    const { clock, advance } = makeFakeClock();
    const { child } = makeFakeChild();
    (child as unknown as { pid: number }).pid = 12345;
    const sampleCpuFn = () => single(12345, 0);
    const ctrl = attachStallWatchdog(
      { mode: "cpu", child },
      {
        stallMs: 600_000,
        provider: "shell",
        pollIntervalMs: 1_000,
        gracePeriodMs: 50,
        clock,
        sampleCpuFn,
        // startupHangMs omitted on purpose
      },
    );
    advance(119_000); // 1s before default 120s
    expect(ctrl.stallKilled()).toBe(false);
    advance(2_000); // now past 120s
    expect(ctrl.stallKilled()).toBe(true);
    expect(ctrl.killReason()).toBe("startup_hang");
    ctrl.stop();
  });
});
```

- [ ] **Step 2: Run the new tests; they must fail because `startupHangMs` is not implemented yet**

```bash
bun test build/orchestrator/__tests__/stall-watchdog.test.ts --test-name-pattern "Phase A"
```

Expected: 6 tests FAIL. Specifically:

- The startupHangMs option is silently dropped (TypeScript: unknown property error OR runtime: no behavior change).
- Without Phase A, the legacy 60_000ms stallMs in the first test means no kill at t=1200ms.
- Without `killReason === "startup_hang"`, the assertion fails.

If TypeScript blocks compilation because of the unknown `startupHangMs` option, that's fine — these are failing tests by design. Proceed to Task 2 to implement the option.

If any test PASSES without the implementation, stop and reconsider — the test isn't actually testing the new behavior.

- [ ] **Step 3: Commit the failing tests**

```bash
git add build/orchestrator/__tests__/stall-watchdog.test.ts
git commit -m "test(watchdog): add failing Phase A startup-hang tests"
```

---

## Task 2: Implement Phase A in stall-watchdog.ts (TDD green phase)

**Files:**

- Modify: `build/orchestrator/stall-watchdog.ts`

This task touches three regions in the file. Make all three edits, then run the tests.

- [ ] **Step 1: Add `startupHangMs` to the `StallWatchdogOptions` interface**

In `build/orchestrator/stall-watchdog.ts`, find the `StallWatchdogOptions` interface (starts at line 53). Add the new option after the existing `progressGapMs?: number;` field (around line 125):

```ts
  /**
   * Max ms the watchdog tolerates startup-phase silence before firing
   * SIGTERM with killReason="startup_hang". Default 120_000. Set to 0 to
   * disable Phase A entirely (legacy stallMs applies from spawn).
   *
   * Phase A is active as long as no activity has ever been recorded
   * (firstActivityAt === null). In cpu mode this means BOTH zero CPU
   * delta AND zero stream bytes for the full window. In stream mode it
   * means zero stream bytes (no CPU signal available). This is the
   * targeted detector for genuinely hung sub-agents (auth prompts,
   * frozen TTYs, missing binaries) that the older first-token-stream-only
   * deadline used to handle in sub-agents.ts. Long-reasoning LLM CLIs
   * that burn CPU between tokens move out of Phase A on the first
   * CPU-positive sample and run under the longer legacy stallMs.
   */
  startupHangMs?: number;
```

- [ ] **Step 2: Update the `killReason` docstring union to include `"startup_hang"`**

In the same file, find the `killReason: () => string | undefined;` in `StallWatchdogController` (around line 150). The JSDoc above it lists the union members (lines 143-148). Add the new entry:

```ts
/**
 * Why the watchdog killed. Returns:
 *   - "auth_required" — auth-prompt fast-kill (pre-existing).
 *   - "startup_hang"  — Phase A: silent + zero-CPU during startup window.
 *   - "stall"         — legacy silence-based stall (pre-existing).
 *   - "silence"       — tool-aware silence kill (when parseProgress set).
 *   - "progress_gap"  — noisy stdout without classified progress.
 *   - undefined       — watchdog has not killed.
 */
killReason: () => string | undefined;
```

- [ ] **Step 3: Add `firstActivityAt` state and augment `recordActivity()`**

In the `attachStallWatchdog` function body, find the `recordActivity` const (currently around line 431):

```ts
const recordActivity = () => {
  lastActivityAt = clock.now();
};
```

Add a new state variable just above this (after the `let killReason: string | undefined = undefined;` at line 393, alongside the other `let` declarations):

```ts
// Phase A vs Phase B discriminator. Null = Phase A (no activity ever
// recorded). Non-null = Phase B (firstActivityAt is the timestamp of
// the first activity signal, whether CPU or stream).
let firstActivityAt: number | null = null;
```

Augment `recordActivity` to set the new state:

```ts
const recordActivity = () => {
  lastActivityAt = clock.now();
  if (firstActivityAt === null) firstActivityAt = lastActivityAt;
};
```

- [ ] **Step 4: Add Phase A branch to `poll()`**

In the `poll` function (starts around line 510), find the comment block describing the effective stall window (lines 559-565):

```ts
    const silence = clock.now() - lastActivityAt;
    // Effective stall window:
    //   - "slow" → toolStallMs.slow
    //   - "fast" → toolStallMs.fast
    //   - null   → legacy stallMs
    // The legacy path is preserved EXACTLY when parseProgress is absent
    // or when no TOOL_START has been observed yet.
    let effectiveStallMs = stallMs;
    if (currentToolBucket !== null && toolStallMs) {
      effectiveStallMs =
        currentToolBucket === "slow" ? toolStallMs.slow : toolStallMs.fast;
    }
    if (silence >= effectiveStallMs) {
```

Replace the `let effectiveStallMs = stallMs;` block with the Phase A override. The full replacement (preserving the prior tool-aware logic for Phase B):

```ts
    const silence = clock.now() - lastActivityAt;
    // Effective stall window. Phase A wins when in startup (no activity
    // ever recorded). Otherwise Phase B's legacy/tool-aware logic applies:
    //   - "slow" → toolStallMs.slow
    //   - "fast" → toolStallMs.fast
    //   - null   → legacy stallMs
    // The legacy path is preserved EXACTLY when parseProgress is absent
    // or when no TOOL_START has been observed yet.
    const startupWindow = opts.startupHangMs ?? 120_000;
    const inStartupPhase = firstActivityAt === null && startupWindow > 0;
    let effectiveStallMs: number;
    if (inStartupPhase) {
      effectiveStallMs = startupWindow;
    } else {
      effectiveStallMs = stallMs;
      if (currentToolBucket !== null && toolStallMs) {
        effectiveStallMs =
          currentToolBucket === "slow" ? toolStallMs.slow : toolStallMs.fast;
      }
    }
    if (silence >= effectiveStallMs) {
```

- [ ] **Step 5: Set `killReason = "startup_hang"` when Phase A trips**

Immediately after the `if (silence >= effectiveStallMs) {` line, find the block that sets `killed = true;` and computes the killReason (currently around lines 571-580):

```ts
    if (silence >= effectiveStallMs) {
      killed = true;
      // "silence" when the tool-aware path is active (parseProgress set,
      // we have seen at least one classified event). "stall" for
      // the legacy path so existing consumers / tests see the same string.
      if (killReason === undefined) {
        killReason =
          parseProgress && lastClassifiedActivityAt !== null
            ? "silence"
            : "stall";
      }
```

Replace the `if (killReason === undefined) {` block to add the Phase A case first:

```ts
    if (silence >= effectiveStallMs) {
      killed = true;
      // Phase A → "startup_hang"; Phase B → "silence" when tool-aware path
      // is active (parseProgress set, at least one classified event); else
      // "stall" for the legacy path (existing consumers / tests rely on
      // these strings).
      if (killReason === undefined) {
        if (inStartupPhase) {
          killReason = "startup_hang";
        } else {
          killReason =
            parseProgress && lastClassifiedActivityAt !== null
              ? "silence"
              : "stall";
        }
      }
```

- [ ] **Step 6: Run the Phase A tests; all six must now pass**

```bash
bun test build/orchestrator/__tests__/stall-watchdog.test.ts --test-name-pattern "Phase A"
```

Expected: 6 PASS.

- [ ] **Step 7: Run the full stall-watchdog test suite to confirm no regressions in pre-existing behavior**

```bash
bun test build/orchestrator/__tests__/stall-watchdog.test.ts
bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts
```

Expected: all PASS. If any pre-existing test fails, the most likely cause is that `firstActivityAt` is not being set the first time CPU activity is recorded — re-check Step 3 to ensure `recordActivity()` is called from BOTH the stream `onLine` handler (existing wire at line 444) AND the CPU sample branch (existing wire at line 550). The new state set inside `recordActivity` handles both automatically; no extra wiring needed. If a test still fails, share the failure and pause before continuing.

- [ ] **Step 8: Commit Task 2**

```bash
git add build/orchestrator/stall-watchdog.ts
git commit -m "feat(watchdog): add Phase A startup-hang detector to stall-watchdog

CPU-aware startup window. Default 120_000ms. Fires only when both
CPU and stream are silent. Sets killReason='startup_hang'. Phase
B logic untouched. Tests pass."
```

---

## Task 3: Wire `startupHangMs` into `spawnCaptured` in sub-agents.ts (without deleting the old timer yet)

**Files:**

- Modify: `build/orchestrator/sub-agents.ts`

This task is a single additive edit — pass `startupHangMs` to the `attachStallWatchdog` call. We leave the old `firstTokenTimer` machinery in place so both watchdogs run in parallel for this one commit, demonstrating they agree before we delete the legacy code. This makes the diff easier to bisect if something goes wrong in Task 4.

- [ ] **Step 1: Add the `startupHangMs` option to the `attachStallWatchdog` call**

In `build/orchestrator/sub-agents.ts`, find the `attachStallWatchdog` invocation around line 832:

```ts
const watchdog = attachStallWatchdog(
  watchdogMode.mode === "cpu"
    ? { mode: "cpu", child }
    : { mode: "stream", child },
  {
    stallMs: args.timeoutMs,
    provider,
    onStallKill: (silenceMs) => {
      stallKilled = true;
      stallSilenceMs = silenceMs;
    },
    ...(parseProgress
      ? {
          parseProgress,
          toolStallMs: TOOL_AWARE_STALL_MS,
          progressGapMs: PROGRESS_GAP_MS,
        }
      : {}),
  },
);
```

Add `startupHangMs` to the options object. Read the env var directly so explicit `=0` disables Phase A (the existing `envNumberOrDefault` helper coerces 0 → fallback, so we can't use it for a disable-capable knob):

```ts
const watchdog = attachStallWatchdog(
  watchdogMode.mode === "cpu"
    ? { mode: "cpu", child }
    : { mode: "stream", child },
  {
    stallMs: args.timeoutMs,
    provider,
    // GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS keeps its historical name
    // for operator-override continuity. New semantics: Phase A window
    // (CPU + stream both silent). Set to 0 to disable Phase A.
    startupHangMs: resolveStartupHangMs(),
    onStallKill: (silenceMs) => {
      stallKilled = true;
      stallSilenceMs = silenceMs;
    },
    ...(parseProgress
      ? {
          parseProgress,
          toolStallMs: TOOL_AWARE_STALL_MS,
          progressGapMs: PROGRESS_GAP_MS,
        }
      : {}),
  },
);
```

- [ ] **Step 2: Add the `resolveStartupHangMs` helper at module scope**

The helper handles the explicit-zero case that `envNumberOrDefault` can't. Add it once at module scope. A natural location is immediately after the existing `KIMI_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` constants (around line 80, after the existing module-scope env reads). Place it just after the last such constant:

```ts
/**
 * Resolve the Phase A startup-hang window from
 * GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS. Historical name; current semantics
 * are documented at the call site and in stall-watchdog.ts's
 * StallWatchdogOptions.startupHangMs JSDoc.
 *
 * Returns:
 *  - the parsed positive integer when the env var is set to a positive value,
 *  - 0 when the env var is set to literal "0" (disables Phase A entirely),
 *  - 120_000 otherwise (default).
 *
 * Direct env-read instead of envNumberOrDefault because the latter coerces
 * 0 → fallback, leaving no way to disable Phase A via env.
 */
function resolveStartupHangMs(): number {
  const raw = process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS;
  if (raw === undefined) return 120_000;
  const trimmed = raw.trim();
  if (trimmed === "0") return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}
```

- [ ] **Step 3: Confirm the file compiles**

```bash
bun build --target=bun --outdir /tmp/sa-compile-check build/orchestrator/sub-agents.ts >/dev/null
```

Expected: exit code 0. If compilation fails, the most likely cause is `startupHangMs` not being recognized — which means Task 2 was not committed or `stall-watchdog.ts` was edited differently. Re-check.

- [ ] **Step 4: Run the existing sub-agents tests to confirm no behavior regression from the additive change**

```bash
bun test build/orchestrator/__tests__/sub-agents.test.ts --timeout 30000
```

Expected: all pre-existing tests PASS. The test "kills zero-output child at first-token deadline" at line 3748 still passes because both watchdogs are now active and the legacy first-token timer fires first (50ms in the test) before Phase A's default 120s would trigger.

- [ ] **Step 5: Commit Task 3**

```bash
git add build/orchestrator/sub-agents.ts
git commit -m "feat(sub-agents): wire startupHangMs into stall watchdog

Reads GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS via resolveStartupHangMs
helper so '0' explicitly disables Phase A. Legacy first-token timer
still in place; deleted in the next commit."
```

---

## Task 4: Delete the legacy first-token timer from sub-agents.ts

**Files:**

- Modify: `build/orchestrator/sub-agents.ts`
- Modify: `build/orchestrator/__tests__/sub-agents.test.ts`

Now that Phase A is wired and tested, delete the parallel timer. The existing sub-agents.test.ts test must be updated to assert the new killReason and to exercise the new CPU-aware behavior.

- [ ] **Step 1: Modify the existing sub-agents test first (so it fails after the deletion is wrong)**

In `build/orchestrator/__tests__/sub-agents.test.ts`, find the test at line 3748 starting `it("kills zero-output child at first-token deadline", ...)` and replace the entire `it(...)` block with the following two tests:

```ts
it("kills zero-cpu zero-output child at startup-hang deadline", async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "spawncaptured-startup-hang-"),
  );
  const logPath = path.join(tmpDir, "startup-hang.log");
  const oldDeadline = process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS;
  process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS = "50";
  try {
    const result = await spawnCaptured({
      // `sleep 10` consumes ~zero CPU — the canonical hung-but-alive
      // signature. Phase A must kill within startupHangMs.
      bin: "bash",
      argv: ["-c", "sleep 10"],
      cwd: tmpDir,
      timeoutMs: 5000,
      logPath,
      closeStdin: true,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stallKilled).toBe(true);
    expect(result.killReason).toBe("startup_hang");
    // stallSilenceMs is the silence window at kill, which equals the
    // startupHangMs (50ms in this test). Allow some tolerance because the
    // poll interval can round up.
    expect(result.stallSilenceMs).toBeGreaterThanOrEqual(50);
    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("# stdout_bytes: 0");
    expect(log).toContain("# stderr_bytes: 0");
  } finally {
    if (oldDeadline === undefined)
      delete process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS;
    else process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS = oldDeadline;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it("does NOT kill cpu-burning silent child at startup-hang deadline (main bug fix)", async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "spawncaptured-cpu-burn-"),
  );
  const logPath = path.join(tmpDir, "cpu-burn.log");
  const oldDeadline = process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS;
  // Phase A deadline at 200ms; busy-loop must survive past that and exit
  // cleanly on its own at t=400ms.
  process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS = "200";
  try {
    const result = await spawnCaptured({
      // Busy-loop for 400ms then exit. Burns 100% CPU continuously, emits
      // zero output. Phase A must NOT kill it because CPU > 0 from spawn.
      bin: "bash",
      argv: [
        "-c",
        "end=$(($(date +%s%N)/1000000+400)); while [ $(($(date +%s%N)/1000000)) -lt $end ]; do :; done",
      ],
      cwd: tmpDir,
      timeoutMs: 5000,
      logPath,
      closeStdin: true,
    });
    // Process exited on its own — no stall, no timeout.
    expect(result.stallKilled).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.killReason).toBeUndefined();
    expect(result.exitCode).toBe(0);
  } finally {
    if (oldDeadline === undefined)
      delete process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS;
    else process.env.GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS = oldDeadline;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the modified tests; the first must pass (Phase A works), the second may fail until the legacy timer is deleted**

```bash
bun test build/orchestrator/__tests__/sub-agents.test.ts --test-name-pattern "startup-hang" --timeout 30000
```

Expected:

- "kills zero-cpu zero-output child at startup-hang deadline" → **PASS** (Phase A fires).
- "does NOT kill cpu-burning silent child" → **FAIL**. Reason: the legacy first-token timer is still active and fires at 200ms regardless of CPU. The result.killReason will be `"first_token_timeout"` (set by the legacy timer's path), and `stallKilled` will be true.

This proves the legacy timer is the blocker. Proceed to delete it.

- [ ] **Step 3: Delete `firstTokenKilled` state**

In `build/orchestrator/sub-agents.ts`, delete line 576:

```ts
let firstTokenKilled = false;
```

- [ ] **Step 4: Delete the legacy first-token timer block**

Delete lines 770-804 (`firstTokenDeadlineMs` constant, `firstTokenTimer`, `firstTokenKillTimer`, `clearFirstTokenTimers`, `noteFirstToken`, the `setTimeout(firstTokenDeadlineMs)` block, and the SIGKILL escalation inside it). The exact block to remove:

```ts
let firstTokenTimer: unknown = null;
let firstTokenKillTimer: unknown = null;
const firstTokenDeadlineMs = envNumberOrDefault(
  "GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS",
  120000,
);
const clearFirstTokenTimers = () => {
  if (firstTokenTimer) {
    clearTimeout(firstTokenTimer as ReturnType<typeof setTimeout>);
    firstTokenTimer = null;
  }
  if (firstTokenKillTimer) {
    clearTimeout(firstTokenKillTimer as ReturnType<typeof setTimeout>);
    firstTokenKillTimer = null;
  }
};
const noteFirstToken = () => {
  if (stdoutBytes + stderrBytes > 0) clearFirstTokenTimers();
};
if (firstTokenDeadlineMs > 0) {
  firstTokenTimer = setTimeout(() => {
    if (stdoutBytes + stderrBytes > 0 || stallKilled) return;
    firstTokenKilled = true;
    stallKilled = true;
    stallSilenceMs = firstTokenDeadlineMs;
    if (typeof child.pid === "number") {
      killProcessAndGroup(child.pid, "SIGTERM");
      firstTokenKillTimer = setTimeout(() => {
        if (typeof child.pid === "number") {
          killProcessAndGroup(child.pid, "SIGKILL");
        }
      }, 5000);
    }
  }, firstTokenDeadlineMs);
}
```

After deletion the surrounding code at lines 768-806 should read as one continuous flow from the `let watchdogActivityHook: (() => void) | null = null;` line directly into the `child.stdout?.on("data", ...)` handler.

- [ ] **Step 5: Delete the `noteFirstToken()` calls in the data handlers**

After the deletion in Step 4, find the stdout and stderr handlers (formerly lines 806-819 — line numbers shift after the block deletion). The current code reads:

```ts
child.stdout?.on("data", (chunk: Buffer | string) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  stdoutBytes += text.length;
  noteFirstToken();
  stdoutBuf = truncate(stdoutBuf + text);
  writeChannel("OUT", text);
});
child.stderr?.on("data", (chunk: Buffer | string) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  stderrBytes += text.length;
  noteFirstToken();
  stderrBuf = truncate(stderrBuf + text);
  writeChannel("ERR", text);
});
```

Remove the two `noteFirstToken();` calls. The handlers should now read:

```ts
child.stdout?.on("data", (chunk: Buffer | string) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  stdoutBytes += text.length;
  stdoutBuf = truncate(stdoutBuf + text);
  writeChannel("OUT", text);
});
child.stderr?.on("data", (chunk: Buffer | string) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  stderrBytes += text.length;
  stderrBuf = truncate(stderrBuf + text);
  writeChannel("ERR", text);
});
```

- [ ] **Step 6: Delete any `clearFirstTokenTimers()` call in the close handler**

Search for any remaining reference to `clearFirstTokenTimers` and delete the line. There should be one occurrence (the close handler's cleanup). Confirm with:

```bash
grep -n "clearFirstTokenTimers\|firstTokenTimer\|firstTokenKillTimer\|noteFirstToken" build/orchestrator/sub-agents.ts
```

Expected: NO matches. If any remain, delete them.

- [ ] **Step 7: Simplify the `killReason` field in the result payload**

The result resolution block (around line 970-987) currently reads:

```ts
logFlushed.then(() => {
  resolve({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
    timedOut,
    stallKilled,
    stallSilenceMs,
    exitSignal,
    killReason: firstTokenKilled
      ? "first_token_timeout"
      : watchdog.killReason(),
    lastTool: watchdog.lastTool(),
    lastBucket: watchdog.lastBucket(),
    logPath: args.logPath,
    durationMs: Date.now() - startedAt,
    retries: 0,
  });
});
```

Replace the `killReason` field with the unconditional watchdog query:

```ts
logFlushed.then(() => {
  resolve({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
    timedOut,
    stallKilled,
    stallSilenceMs,
    exitSignal,
    killReason: watchdog.killReason(),
    lastTool: watchdog.lastTool(),
    lastBucket: watchdog.lastBucket(),
    logPath: args.logPath,
    durationMs: Date.now() - startedAt,
    retries: 0,
  });
});
```

- [ ] **Step 8: Confirm all legacy first-token references are gone**

```bash
grep -rn "first_token_timeout\|firstTokenKilled\|firstTokenTimer\|firstTokenKillTimer\|noteFirstToken\|clearFirstTokenTimers" build/orchestrator/
```

Expected: NO matches except inside CHANGELOG.md (if you've already drafted one). If anything other than CHANGELOG matches, delete it.

- [ ] **Step 9: Run the modified sub-agents tests; both must now pass**

```bash
bun test build/orchestrator/__tests__/sub-agents.test.ts --test-name-pattern "startup-hang" --timeout 30000
```

Expected: 2 PASS.

- [ ] **Step 10: Run the FULL sub-agents test suite to confirm nothing else broke**

```bash
bun test build/orchestrator/__tests__/sub-agents.test.ts --timeout 60000
```

Expected: all PASS. If any test fails referencing `first_token_timeout` or `firstTokenKilled`, search for it and update it to the new `startup_hang` vocabulary.

- [ ] **Step 11: Commit Task 4**

```bash
git add build/orchestrator/sub-agents.ts build/orchestrator/__tests__/sub-agents.test.ts
git commit -m "refactor(sub-agents): delete legacy first-token timer

Phase A in stall-watchdog now handles startup-hang detection with
CPU awareness. The legacy stream-only first-token timer in
spawnCaptured is removed, including firstTokenKilled,
firstTokenDeadlineMs, firstTokenTimer, firstTokenKillTimer,
clearFirstTokenTimers, and noteFirstToken. Result killReason is
now sourced unconditionally from watchdog.killReason(). The
sub-agents test that asserted first_token_timeout is replaced
by a startup-hang test plus a cpu-burning regression test that
proves long-reasoning subagents are no longer killed."
```

---

## Task 5: Extend `renderRoleStepFailure` for the new `startup_hang` reason

**Files:**

- Modify: `build/orchestrator/halt-event-helpers.ts`
- Modify: `build/orchestrator/__tests__/halt-event-helpers.test.ts`

- [ ] **Step 1: Write a failing test for the new startup_hang case**

Open `build/orchestrator/__tests__/halt-event-helpers.test.ts` and append a new test inside the existing `describe("renderRoleStepFailure", ...)` block (find it via `grep -n "describe.*renderRoleStepFailure" build/orchestrator/__tests__/halt-event-helpers.test.ts`). If the test file uses a different describe naming, place this test alongside the existing `progress_gap` test in `render-role-step-failure.shape.test.ts`:

```ts
it("startup_hang killReason produces a startup-specific stalled summary", () => {
  const result = {
    stallKilled: true,
    stallSilenceMs: 120_000,
    killReason: "startup_hang",
  };
  const fr = renderRoleStepFailure("planSynthesizer", result);
  expect(fr.kind).toBe("stalled");
  if (fr.kind !== "stalled") return;
  expect(fr.summary).toContain("planSynthesizer");
  expect(fr.summary).toContain("startup");
  expect(fr.summary).toContain("120000");
  expect(fr.stallSilenceMs).toBe(120_000);
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

```bash
bun test build/orchestrator/__tests__/halt-event-helpers.test.ts --test-name-pattern "startup_hang"
```

If the test runs but the assertion on `"startup"` in summary fails, that's the expected red. The existing `reasonLabel` only differentiates `progress_gap`; everything else falls into the generic `no output for ${ms}ms` branch.

If `bun test` reports `0 tests` (because the test ended up in a file with no other tests in that describe block), move the test to wherever the other `renderRoleStepFailure` shape tests live — confirmed via `grep -rn "renderRoleStepFailure" build/orchestrator/__tests__/` to be `render-role-step-failure.shape.test.ts` per the earlier inventory.

- [ ] **Step 3: Add the `startup_hang` branch in `renderRoleStepFailure`**

In `build/orchestrator/halt-event-helpers.ts`, find the `if (result.stallKilled)` block (around lines 294-305):

```ts
if (result.stallKilled) {
  const ms = result.stallSilenceMs ?? 0;
  const reasonLabel =
    result.killReason === "progress_gap"
      ? `no classified progress for ${ms}ms`
      : `no output for ${ms}ms`;
  return {
    kind: "stalled",
    summary: `${role} stalled (${reasonLabel}, killed by watchdog)`,
    stallSilenceMs: ms,
  };
}
```

Add the `startup_hang` case to the ternary. The cleanest shape is a small switch:

```ts
if (result.stallKilled) {
  const ms = result.stallSilenceMs ?? 0;
  let reasonLabel: string;
  switch (result.killReason) {
    case "progress_gap":
      reasonLabel = `no classified progress for ${ms}ms`;
      break;
    case "startup_hang":
      reasonLabel = `no CPU and no output during startup window of ${ms}ms`;
      break;
    default:
      reasonLabel = `no output for ${ms}ms`;
  }
  return {
    kind: "stalled",
    summary: `${role} stalled (${reasonLabel}, killed by watchdog)`,
    stallSilenceMs: ms,
  };
}
```

- [ ] **Step 4: Run the new test; it must pass**

```bash
bun test build/orchestrator/__tests__/halt-event-helpers.test.ts --test-name-pattern "startup_hang"
bun test build/orchestrator/__tests__/render-role-step-failure.shape.test.ts
bun test build/orchestrator/__tests__/render-role-step-failure-message.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add build/orchestrator/halt-event-helpers.ts build/orchestrator/__tests__/halt-event-helpers.test.ts build/orchestrator/__tests__/render-role-step-failure.shape.test.ts 2>/dev/null
# (whichever test file was actually modified — the second/third command is a no-op if the file wasn't touched)
git commit -m "feat(halt-events): render startup_hang killReason distinctly

renderRoleStepFailure now emits a startup-specific summary for
killReason='startup_hang', distinct from generic stalls and
progress_gap. Surfaces the failure mode in halt-event logs and
auto-filed bug reports."
```

---

## Task 6: Final test sweep, CHANGELOG, VERSION bump

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `VERSION`

- [ ] **Step 1: Run the full build/orchestrator test directory to verify the integrated change**

```bash
bun test build/orchestrator/__tests__/ --timeout 120000
```

Expected: all PASS. The expensive E2E suites (`test:evals`, `test:e2e`) are NOT required for this task; the orchestrator unit tests cover the watchdog behavior end-to-end via spawnCaptured.

If a non-watchdog test fails, share the output and pause — it likely uncovered an unrelated regression OR an unmodified consumer of `firstTokenKilled` / `first_token_timeout` that the earlier greps missed.

- [ ] **Step 2: Run the project-wide free-tier tests (skill validation + browse integration)**

```bash
bun test
```

Expected: all PASS. This is the gate that `bun test` runs before every commit per CLAUDE.md.

- [ ] **Step 3: Read and bump VERSION**

```bash
cat VERSION
```

Note the current value. Per CLAUDE.md's "Scale-aware bumps" guidance, this change is a MINOR bump:

- Net diff is around 300-400 lines (Phase A logic + tests + first-token deletion + halt-event branch + CHANGELOG entry).
- The user-visible capability changes: long-reasoning LLM subagents no longer killed prematurely.
- The killReason vocabulary changes for halt-event log consumers.

Per CLAUDE.md "Fork versioning rule": this repo is `anbangr/gstack`, a fork of `garrytan/gstack`. The rule says NOT to bump top-level VERSION for fork-specific skill work. But this change is in the build orchestrator (not a skill), and the spec's "Open follow-ups" called this out: the implementation plan's call. We are NOT working on a fork-specific skill; we are modifying core orchestrator code that would ship upstream. Bump VERSION MINOR.

If current VERSION is `1.44.0.0`, write `1.45.0.0`. If different, increment the MINOR digit (second component), reset PATCH and MICRO to 0.

```bash
# Example assuming current is 1.44.0.0 — replace with actual values:
echo "1.45.0.0" > VERSION
```

Adjust the version literal to match `cat VERSION` + 1 MINOR bump.

- [ ] **Step 4: Add CHANGELOG entry**

Open `CHANGELOG.md`. The top of the file should have the latest version entry. Add a new entry ABOVE it (newest first). Use the release-summary format from CLAUDE.md:

```markdown
## [1.45.0.0] - 2026-05-25

**Sub-agent startup-hang detection is now CPU-aware.** Long-reasoning
LLM subagents no longer get killed mid-reasoning.

The build orchestrator used to run two watchdogs against every sub-agent
spawn: a 120s first-token deadline that only watched stdout, and a CPU-aware
stall watchdog that knew the process was alive. They disagreed. The
first-token timer killed Codex and Claude subagents that were burning CPU
on TLS keepalive and HTTP/2 pings while reasoning server-side. The
killReason in halt-event logs read `first_token_timeout` and the symptom
was "long and complicated tasks are killed prematurely."

The fix unifies them. The 120s window now lives inside the stall watchdog
as a Phase A startup-hang detector. It fires only when **both** CPU and
stream are silent for the window. Long-reasoning CLIs burn CPU just
keeping the connection open, which satisfies Phase A, and the watchdog
moves into Phase B (per-role `stallMs`, 15-25 min for LLM bins). Genuinely
hung processes (auth prompts, frozen TTYs, missing binaries) still die at
120s because they consume zero CPU.

### The startup-hang numbers that matter

Reproducible benchmark: `bun test build/orchestrator/__tests__/sub-agents.test.ts --test-name-pattern "startup-hang"`. Two cases.

| Scenario                                      | Before         | After                               |
| --------------------------------------------- | -------------- | ----------------------------------- |
| Zero-CPU silent child (`sleep 10`)            | killed at 120s | killed at 120s                      |
| CPU-burning silent child (busy loop)          | killed at 120s | runs to completion                  |
| Codex `reasoning=xhigh` first-token (typical) | killed at 120s | runs to first token (often 3-8 min) |

The middle row is the bug. CPU-burning silent child used to die at the
first-token deadline despite being maximally alive. Now it doesn't.

### What this means for `/build` users

If you've been seeing `killReason: first_token_timeout` in halt logs on
long planSynthesizer / judge / featureReview runs, those runs now complete.
If you've been padding per-role `stallMs` to compensate, you can move the
values back down. The env var `GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS` keeps
its historical name and still controls the (now CPU-aware) 120s window. Set
it to `0` to disable Phase A entirely.

### Itemized changes

Changed:

- The killReason string emitted on startup-phase kills changed from
  `first_token_timeout` to `startup_hang`. Consumers parsing halt-event
  JSON (gstack-build halt drains, custom monitoring) need to update if they
  string-matched the old value. Internal consumers updated in this PR.
- `renderRoleStepFailure` in `halt-event-helpers.ts` now renders
  startup_hang with a distinct summary: "X stalled (no CPU and no output
  during startup window of Nms, killed by watchdog)".
- `GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS=0` now genuinely disables the
  startup-hang window (pre-fix, the env helper coerced 0 to the 120000
  default; the wiring now reads the raw env value).

For contributors:

- `StallWatchdogOptions.startupHangMs?: number` added to
  `build/orchestrator/stall-watchdog.ts`. Default 120000. The watchdog
  tracks `firstActivityAt` and uses it to discriminate Phase A from
  Phase B.
- `spawnCaptured` in `build/orchestrator/sub-agents.ts` no longer owns a
  first-token timer; the `firstTokenKilled`, `firstTokenDeadlineMs`,
  `firstTokenTimer`, `firstTokenKillTimer`, `clearFirstTokenTimers`, and
  `noteFirstToken` symbols are deleted.
- Six new Phase A unit tests in
  `build/orchestrator/__tests__/stall-watchdog.test.ts`. The existing
  "kills zero-output child at first-token deadline" test in
  `sub-agents.test.ts` is replaced by two tests: one asserting Phase A
  fires for `sleep 10` (zero CPU), one asserting Phase A does NOT fire
  for a CPU-burning busy loop.

Spec: [`docs/superpowers/specs/2026-05-25-cpu-aware-startup-hang-watchdog-design.md`](docs/superpowers/specs/2026-05-25-cpu-aware-startup-hang-watchdog-design.md).
```

If the file's existing entries use a different format (heading level, date style), match the surrounding entries' style — show your draft to the operator if it looks inconsistent with the latest pre-existing entry.

- [ ] **Step 5: Final sweep — no stale references, no untracked test files**

```bash
git status
grep -rn "first_token_timeout\|firstTokenKilled" build/ docs/superpowers/specs/ 2>/dev/null
```

`git status` should show modifications to: `VERSION`, `CHANGELOG.md`, `build/orchestrator/stall-watchdog.ts`, `build/orchestrator/sub-agents.ts`, `build/orchestrator/halt-event-helpers.ts`, `build/orchestrator/__tests__/stall-watchdog.test.ts`, `build/orchestrator/__tests__/sub-agents.test.ts`, and one of the halt-event test files. Plus the design doc and plan doc that are already committed.

The grep should match ONLY the design spec (where the strings appear inside historical context) and the CHANGELOG (where they appear in the "Changed" entry). If they match anywhere in `build/orchestrator/` (other than tests that DELIBERATELY reference the old name as part of an interop test that doesn't exist here), delete them.

- [ ] **Step 6: Commit Task 6**

```bash
git add VERSION CHANGELOG.md
git commit -m "v1.45.0.0 feat(orchestrator): CPU-aware startup-hang watchdog

VERSION + CHANGELOG bump for the watchdog unification."
```

(Adjust the version literal in the commit message to match what you actually wrote to VERSION.)

---

## Self-review checklist (run by the worker after Task 6)

- [ ] **Spec coverage:** Every section in the spec maps to a task. Phase A logic → Task 2. Spawn wiring → Task 3. Legacy deletion → Task 4. Halt-event vocab → Task 5. Operational rollout → Task 6.
- [ ] **No placeholders:** Every step has executable commands or full code blocks.
- [ ] **Type consistency:** `startupHangMs` is the same name everywhere (option, helper return, env-derived). `killReason === "startup_hang"` is the exact same string in all three places (stall-watchdog kill site, halt-event-helpers switch, sub-agents test assertion).
- [ ] **Diff target:** Final diff is under 400 lines as the spec required. Spot-check: `git diff main --stat`. If over 600 lines, the CHANGELOG entry may be longer than needed; trim it.
- [ ] **Env-var semantics:** `GSTACK_BUILD_FIRST_TOKEN_DEADLINE_MS=0` actually disables Phase A in the new code (Task 3 used `resolveStartupHangMs`, not `envNumberOrDefault`, specifically to enable this).
- [ ] **All four tests asserted in the spec are present:** zero-CPU kill, CPU-active survival, stream-active survival, Phase A→B transition, startupHangMs=0 disable, default-value sanity check. Six tests, not the five originally scoped in the spec — the sixth (default 120000 sanity check) is added belt-and-suspenders because Phase 2 and Phase 3 both contain the literal `120_000`. If they drift, one of those tests catches it.

---

## Plan complete and saved to `docs/superpowers/plans/2026-05-25-cpu-aware-startup-hang-watchdog.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
