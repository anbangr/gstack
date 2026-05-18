# /build — Skill Template + Orchestrator CLI: Live-Run Failures (Investigation + Fix Plan)

> **Status:** Investigation complete. No code edits yet. Awaiting user approval.
> **Investigated:** 2026-05-18 against HEAD `d3a6869c`.
> **Scope:** Both `build/SKILL.md.tmpl` (the prompt template Claude reads) AND
> `build/orchestrator/*.ts` (the CLI it launches). Every failure has issues
> at both layers; fixes are paired.
> **Source incident:** Live `/build` run on `mitosis-oasis` Bundle 0 hit four
> failures back-to-back; user manually recovered and switched the work plan.
> See screenshots in `/investigate` session (2026-05-18, user message
> "check why the build skill caused all these").

## Two-layer architecture

The `/build` feature has two stacked layers:

1. **`build/SKILL.md.tmpl`** — a 1912-line prompt template Claude (the
   skill-executing agent) reads. It locates the source plan, runs
   `planSynthesizer` and `planReviewer` subagents to write the living plan,
   asks the user single-branch vs multi-branch (Step 5.7), then launches
   `gstack-build` and enters a monitor loop.
2. **`build/orchestrator/*.ts`** — the `gstack-build` CLI (~50K LOC) that
   actually executes phases via configured roles (test-writer,
   primary-impl, review, qa, ship, land).

Every failure in the screenshots crosses both layers. The skill template
generates inputs the CLI must consume; when the inputs violate an
unstated invariant, the CLI bails. Examining only one layer would miss
half the root cause.

## Executive summary

Four independent failures, four different root causes, one shared
architectural theme: **state-shape contracts that are produced and consumed by
different parts of the orchestrator are not enforced symmetrically.** Each
failure is small in surface area but compounds: truncation corrupts identity
→ recovery branch lookup fails → manual recovery → hygiene gate refuses →
manual `--mark-phase-committed` → unintended ship.

| #   | Failure                                   | Severity | Fix shape                                                | Effort (CC) |
| --- | ----------------------------------------- | -------- | -------------------------------------------------------- | ----------- |
| 1   | Branch name truncated at 72 chars         | HIGH     | Hash-suffix or longer slice + collision check            | ~30 min     |
| 2   | Zombie kimi/gstack-build subprocesses     | HIGH     | Fix child-registry exit contract OR add startup sweep    | ~45 min     |
| 3   | Hygiene gate refuses mixed test+prod diff | MEDIUM   | Split diff + per-role layer enforcement in synthesizer   | ~1 hr       |
| 4   | Per-feature ship fires after manual mark  | MEDIUM   | Add `--ship-on-plan-complete` flag OR auto-detect bundle | ~30 min     |

All four are root-caused to specific file:line locations. Three are
recent-regression-adjacent (introduced in commits from the last 10 days);
one (#4) is intentional design that no longer matches user expectations
for multi-feature bundles.

---

## Failure 1: Branch name truncated at 72 chars, hash suffix lost

### Symptom

User saw `feat/mitosis-oasis-mitosis-oasis-...−180025−` in their git log.
The unique hash suffix after the timestamp `180025` was missing. Recovery
branch logic could not derive the correct bootstrap branch from this
truncated name.

### Root cause

[build/orchestrator/cli.ts:2847-2855](build/orchestrator/cli.ts#L2847-L2855)
defines `safeBranchPart`:

```typescript
function safeBranchPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "run"
  );
}
```

The `.slice(0, 72)` truncates silently. It is called at:

- [cli.ts:537](build/orchestrator/cli.ts#L537) — bootstrap branch:
  `feat/${safeBranchPart(launch.branchPrefix)}-bootstrap`
- [cli.ts:2862-2866](build/orchestrator/cli.ts#L2862-L2866) —
  `ownedFeatureBranch`: `feat/${prefix}-${featureSlug(feature)}`

When `launch.branchPrefix` is missing, the code falls back to
[state.ts:144](build/orchestrator/state.ts#L144):
`planBasename = path.basename(args.planFile).replace(/\.md$/i, "")`.

If the plan file is named
`mitosis-oasis-mitosis-oasis-2026-05-18-bundle-0-bug-fix-20260518-180025-b0bf5c19.md`
(80 chars after sanitization), the slice cuts off `b0bf5c19` — the unique
identifier that distinguishes parallel runs of the same project.

### Why the double `mitosis-oasis-mitosis-oasis-` prefix?

This is a _separate_ issue from the truncation but observed in the same
run. Likely the orchestrator was launched with the project slug
`mitosis-oasis` prepended _and_ the plan filename also began with
`mitosis-oasis-...`. The double prefix is a callsite bug, not a
`safeBranchPart` bug. Suspect candidate: the launcher that constructs
`branchPrefix` concatenates the slug with the plan-basename without
de-duplicating common stems. Worth a separate hunt — not in this fix.

### Git context

Commit `4d62ee0220` ("feat: support safe parallel build runs", 2026-05-08)
introduced `safeBranchPart` _and_ the `--branch-prefix` feature in the
same change. No tests for the truncation path. The 72-char limit is below
git's actual ref limit (255 bytes), so it's a defensive choice that
trades identity preservation for shorter names.

### Fix shape

Three options, ranked:

**A) (Recommended) Preserve last 8 chars when truncating.** When input
exceeds 72 chars, take `head(60) + "-" + tail(8)` so the unique suffix
survives. Plus an assertion in tests that the input's first 8 chars and
last 8 chars are present in the output for any input < 200 chars.

**B) Increase slice to 200 chars.** Git refs allow up to 255 bytes. The
slice was conservative because of filesystem path-length anxiety on
Windows worktrees (Windows MAX_PATH = 260). 200 leaves headroom for the
`feat/` prefix and feature-slug suffix. Still allows pathological inputs
to truncate, but is much less likely to bite real users.

**C) Throw on truncation.** Identity-preserving is non-negotiable.
Aggressive but correct. Forces the caller to provide a sensible
`branchPrefix` — pushing the de-duplication problem upstream where it
belongs.

Recommendation: **A**, plus add a test that the truncation never drops
the last 8 chars of the input. This is the minimal-blast-radius fix.

### Regression test

```typescript
// build/orchestrator/__tests__/cli.test.ts
test("safeBranchPart preserves tail hash on long input", () => {
  const long =
    "mitosis-oasis-mitosis-oasis-2026-05-18-bundle-0-bug-fix-20260518-180025-b0bf5c19";
  const out = safeBranchPart(long);
  expect(out.endsWith("b0bf5c19")).toBe(true);
  expect(out.length).toBeLessThanOrEqual(72);
});
```

---

## Failure 2: Zombie kimi/gstack-build subprocesses after parent exit

### Symptom

After the live build run exited, `ps aux | grep -E '(kimi|gstack-build)'`
showed multiple zombie processes. User killed them manually:

```
pkill -f 'kimi.*bundle-0'
pkill -f gstack-build
```

### Root cause

Two-part interaction:

**Part A — child-registry defaults `detached = true` for every spawn.**
[build/orchestrator/child-registry.ts:233-251](build/orchestrator/child-registry.ts#L233-L251):

```typescript
export function spawn(command, args, options): ChildProcess {
  const effective: SpawnOptions = { ...(options ?? {}) };
  if (effective.detached === undefined) effective.detached = true;  // <-- L239
  const child = nodeSpawn(command, args as string[], effective);
  if (typeof child.pid === "number") {
    livePids.add(child.pid);
    const unregister = () => { ... };
    child.once("exit", unregister);
    child.once("close", unregister);
    child.once("error", unregister);
  }
  return child;
}
```

The contract: every spawned child auto-unregisters from `livePids` via
the `exit`/`close`/`error` events. But `detached: true` puts the child
in its own process group, so when the parent dies via SIGTERM, the
child is NOT in the parent's group and doesn't receive the signal.

**Part B — monitor.ts:499 calls `child.unref()`.**
[build/orchestrator/monitor.ts:490-503](build/orchestrator/monitor.ts#L490-L503):

```typescript
const outFd = fs.openSync(run.stdoutLog, "a");
try {
  const child = spawn(run.launchCommand[0], run.launchCommand.slice(1), {
    cwd: run.worktreePath,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, ...(run.launchEnv ?? {}) },
  });
  fs.writeFileSync(run.pidFile, `${child.pid}\n`);
  child.unref(); // <-- L499
  return child.pid ?? 0;
} finally {
  fs.closeSync(outFd);
}
```

`child.unref()` decouples the child from the parent's event loop. When
the monitor exits, the event loop terminates _before_ the child's
`exit`/`close` events fire. The unregister callbacks never run.
`livePids` still contains the dead pid; the child becomes a zombie if
the OS hasn't yet reaped it.

**Why `sweep-orphans` doesn't catch this:** the orchestrator's
sweep-orphans logic runs at startup and reaps dead pids — but only if
both the pid is dead AND the active-run record is stale. When the child
just exited but the active-run record still shows a fresh heartbeat
from seconds ago (heartbeat is written by the child, not the parent),
the sweep won't reap.

### Git context

`monitor.ts` was introduced in commit `2f6f5b0a` ("Add foreground build
monitor"). The `detached: true` + `unref()` pair was there from day one.
Recent commit (`0a4e501f`, per the agent report) routed monitor's spawn
through `child-registry.spawn` for tracking — but the tracking only
works when events fire, and `unref()` ensures they don't.

### Existing learning

[M35_BACKGROUNDED_INVESTIGATORS_NEVER_WAITED] in
`~/.gstack/projects/anbangr-gstack/learnings.jsonl` documents the same
pattern in `build/SKILL.md.tmpl` Step M3.5 — backgrounded subshells
never waited. **Same root cause class, different surface.** The fix
approach should generalize.

### Fix shape

Three options, ranked:

**A) (Recommended) Make `child-registry.spawn` NOT default detached.**
Remove the `if (effective.detached === undefined) effective.detached = true;`
line. Callers that want detachment opt in explicitly. monitor.ts:494
already passes `detached: true` explicitly, so the change is one-line
and behavior-preserving for the legitimate detached callsite.

**B) Add a SIGTERM/SIGINT handler that kills livePids on parent exit.**
Already partially exists at child-registry.ts:81-95 per the agent report.
Verify it works under `detached: true` (it doesn't, because the children
are in their own pgrp). Need to use the negative pid trick:
`process.kill(-pgrp, signal)`.

**C) Add a startup sweep that reaps any pid in the pidfile that's no
longer alive AND the active-run record is stale OR missing.** Belt and
braces — catches zombies from the previous session regardless of why
they were leaked.

Recommendation: **A + C.** A fixes the leak; C makes the system
self-healing for any future leak class.

### Regression test

```typescript
test("child-registry.spawn defaults to attached (not detached)", () => {
  const child = registrySpawn("sleep", ["10"]);
  expect((child.spawnargs as any).detached).not.toBe(true);
  child.kill("SIGTERM");
});
```

Plus an integration test that monitor + child can be SIGTERM'd cleanly
and `livePids` is empty after exit.

---

## Failure 3: QA hygiene gate refused to auto-commit mixed test+production diff

### Symptom

Phase 1 of the user's bundle had agents writing across BOTH test files
AND production files in a single phase. The hygiene gate (which expects
review/QA roles to touch only test paths) refused to auto-commit and
printed the recovery hint:

```
3. Mark the phase committed: gstack-build --mark-phase-committed 1
```

### Root cause

[build/orchestrator/cli.ts:4297-4350](build/orchestrator/cli.ts#L4297-L4350)
defines `maybeAutoCommitTestOnlyDirty`:

```typescript
const nonTest = paths.filter((p) => !isTestOnlyPath(p, globs));
if (nonTest.length > 0) {
  return {
    committed: false,
    reason: `non-test paths present: ${nonTest.slice(0, 3).join(", ")}...`,
    nonTestPaths: nonTest,
  };
}
// All paths test-only → auto-commit.
```

The gate is **binary**: 100% test-only paths → auto-commit; any
production path → bail to manual recovery.

The synthesizer template
[build/SKILL.md.tmpl:636-648](build/SKILL.md.tmpl#L636-L648) (per the
agent report) does NOT instruct agents to keep phases single-layer. It
allows `[code]` phases to contain a "Test Specification" sub-phase, an
"Implementation" sub-phase, and a "Review/QA" sub-phase — all writing
across both layers within one outer phase.

**The contract mismatch:** the gate assumes review/QA roles produce
test-only diffs. The synthesizer doesn't pin that assumption. When
agents in Phase 1 wrote production code (e.g., the review found a bug
and the agent fixed it inline rather than queuing a separate phase),
the gate fired.

### Git context

Recent commits in the gate area:

- `66556fbc` (2026-05-18 10:44): "hygiene gate auto-commits test-only
  dirty trees" — introduced `maybeAutoCommitTestOnlyDirty`.
- `db7ab419` (2026-05-18): "tolerate `.codex/` scratch in post-review
  hygiene" — added tolerance for a specific scratch dir.
- `6eedf0b5` (2026-05-18 17:52): "print --mark-phase-committed recovery
  hint on gate fail" — added the recovery message the user saw.

All three are this week. The gate is new functionality, still being
calibrated. The mixed-layer case wasn't anticipated when synthesis
templates allow it.

### Fix shape

Three options, ranked by safety and effort:

**A) (Recommended) Auto-split into two commits.** When the gate sees a
mixed diff:

1. Commit test paths separately with the existing auto-commit message.
2. Stage production paths and create a second commit with role-prefix:
   `chore(qa): production fixes from ${role} (auto-split)`.
3. Both commits land; the user sees two commits with clear provenance.

This handles "review found a real bug" without forcing manual recovery.
The split is auditable because the messages differ.

**B) Tighten the synthesizer template.** Add an explicit rule:
"Review/QA roles must touch only test paths. Production fixes go into a
follow-up implementation phase." Document in
[build/SKILL.md.tmpl:636-648](build/SKILL.md.tmpl#L636-L648). This
matches the gate's assumption but pushes the burden onto the synthesizer
agent (Gemini/Kimi), which may not consistently follow the rule.

**C) Relax the gate to auto-commit any small mixed diff (e.g., <10
files, <200 lines).** Quickest fix; least safe. Effectively says
"trust the agents on small diffs." Probably wrong default for this
project's safety culture.

Recommendation: **A**, plus **B** for synthesizer hygiene. Defense in
depth: synthesizer tries to keep phases single-layer; gate handles the
mixed-layer case gracefully when synthesizer fails.

### Regression test

```typescript
test("maybeAutoCommitTestOnlyDirty auto-splits mixed test+prod diff", () => {
  const result = maybeAutoCommitTestOnlyDirty({
    cwd: tmpRepo,
    label: "Codex review",
    dirtyLines: ["M test/foo.test.ts", "M src/foo.ts"],
  });
  expect(result.committed).toBe(true);
  expect(result.reason).toMatch(/split/);
  // git log shows two commits with different messages
});
```

---

## Failure 4: `--mark-phase-committed` triggered single-feature ship in 9-feature bundle

### Symptom

User had a "bundle of 9 features" living plan. Feature 1 was complete and
manually recovered. They ran `gstack-build --mark-phase-committed 1`
expecting to advance state and continue with Features 2-9 in the same
branch. Instead the orchestrator immediately kicked off `/ship` for
Feature 1 alone.

### Root cause

The orchestrator has **no concept of a "bundle"**. Grep for `bundle` in
`build/orchestrator/*.ts` returns zero non-test hits. The closest
concept is `--single-branch`, which DOES defer all shipping until every
feature is done.

The sequence:

1. [cli.ts:8554-8579](build/orchestrator/cli.ts#L8554-L8579):
   `--mark-phase-committed 1` runs `markPhaseCommittedAfterManualRecovery`,
   sets phase 1 committed, persists state. Then **falls through** (no
   early-return) to the main loop at line 8684.
2. [cli.ts:8687-8690](build/orchestrator/cli.ts#L8687-L8690):
   `findNextFeatureIndex` returns Feature 1 (status="running"). All its
   phases are now committed, so the inner phase loop has no work.
3. [cli.ts:9131](build/orchestrator/cli.ts#L9131): Feature 1 status set
   to `phases_done`.
4. [cli.ts:9135-9210](build/orchestrator/cli.ts#L9135-L9210):
   ```typescript
   if (
     !resumeAfterLanding &&
     !args.skipShip &&
     !args.singleBranch &&
     !args.dryRun
   ) {
     // ... call shipAndDeploy() for Feature 1 alone
   }
   ```

The gate is `!args.singleBranch`. The user didn't pass `--single-branch`,
so the per-feature ship path fires. The orchestrator is operating
correctly per its documented contract — but the user's mental model was
"bundle", which doesn't exist.

### Git context

The per-feature ship path is old; the most recent touch is `548baca8`
("v1.39.1.0 fix(release-daemon): homebrew-aware PATH"), which only
reformatted the conditional. Behavior is intentional design from the
original orchestrator.

### Why "single-branch shipping logic" in the screenshot is misleading

The screenshot says "the orchestrator's single-branch shipping logic
kicked off ship-and-land for Feature 1 alone." That's _wrong_ — it's
the _per-feature_ ship path (line 9135), which fires precisely BECAUSE
single-branch is NOT set. The single-branch path (line 9577) waits for
all features. The screenshot author conflated the two.

### Fix shape

Four options:

**A) (Recommended) Add `--ship-on-plan-complete` flag.** Defers
shipping until every feature reaches `origin_verified`, similar to
`--single-branch` but without forcing all features onto one branch.
Each feature still gets its own branch, but PRs are batched at the end.
Backward-compatible: opt-in flag, default behavior unchanged.

**B) Auto-detect bundle from plan filename / metadata.** If the plan
filename contains "bundle" or the plan has a `bundle: true` frontmatter
key, behave as if `--ship-on-plan-complete` was passed. Magic; would
need to be carefully documented to avoid surprise.

**C) Make `--mark-phase-committed` an early-return.** Change the
fall-through at line 8579. After marking, exit cleanly. User runs
`gstack-build` again to continue. This avoids the surprise ship, but
breaks any user who does want the auto-continue behavior.

**D) Add an AskUserQuestion-style confirmation before ship in
multi-feature plans.** "Ship Feature 1 now, or wait for the rest?" Too
invasive for an orchestrator that's supposed to be autonomous.

Recommendation: **A** (flag) + document the gap clearly in
`build/SKILL.md.tmpl` and the `--help` output for `--mark-phase-committed`.

### Regression test

```typescript
test("--ship-on-plan-complete defers per-feature ship", () => {
  const state = makeStateWithFeatures(9, "Feature 1 phases_done");
  const args = { shipOnPlanComplete: true };
  const shouldShip = shouldShipFeatureNow(state, 0, args);
  expect(shouldShip).toBe(false);
});

test("--mark-phase-committed honors --ship-on-plan-complete", () => {
  // Integration test: mark phase, expect no ship called
});
```

---

## Cross-cutting theme

All four failures share a pattern: **a contract is implicitly assumed by
one part of the orchestrator and silently violated by another part
because the orchestrator lacks symmetric enforcement.**

- #1: `safeBranchPart` produces strings; downstream code assumes
  identity preservation. No assertion on either side.
- #2: `child-registry` assumes 'exit' events fire; `unref()` ensures
  they don't. Producer and consumer disagree.
- #3: Hygiene gate assumes per-role layer purity; synthesizer doesn't
  pin it. Producer-consumer asymmetry.
- #4: Orchestrator has per-feature ship semantics; user has bundle
  semantics. No shared vocabulary.

**Architectural recommendation (separate from this plan):** the
orchestrator would benefit from an explicit "contracts module" — a
single file that names the invariants every state-shape producer must
satisfy and every consumer can rely on. Today these contracts live in
prose comments scattered across 50K LOC, which is why each of these
four bugs survived to a real user session.

Not in scope for the fix plan. Noted as a follow-up architectural
investigation if user wants to go there.

---

## Skill-template layer — what `build/SKILL.md.tmpl` got wrong

The investigation above focused on the CLI consumers. Each failure also
has a producer-side gap in `build/SKILL.md.tmpl` (the prompt template
Claude reads when executing `/build`). Fixing only the CLI side leaves
the skill template still emitting bad inputs.

### Skill-side bug 5: `branchPrefix` template duplicates `repoSlug` (NEW finding)

The screenshot's `feat/mitosis-oasis-mitosis-oasis-...` had two roots,
not one. The truncation root was Failure 1 (CLI side). The duplication
root is a **skill-template specification bug** at line 704 and 712 of
`build/SKILL.md.tmpl`:

```
"runId": "<repoSlug>-<sourceSlug>-<timestamp>-<shortHash>",   # line 704
...
"branchPrefix": "<repoSlug>-<runId>",                         # line 712
```

Substituting runId into branchPrefix yields
`<repoSlug>-<repoSlug>-<sourceSlug>-<timestamp>-<shortHash>`.

The synthesizer subagent follows this spec literally. So the input to
`safeBranchPart` is already 80+ chars long because of the duplication
_before_ truncation even enters the picture. Fix: change line 712 to
`"branchPrefix": "<runId>"` (drop the leading `<repoSlug>-`, which is
already in runId). Or change line 704 to omit repoSlug from runId
itself — but that breaks downstream parsing of runId elsewhere, so the
712 fix is the lower-blast-radius choice.

**Verification:** grep the template for `branchPrefix` usage elsewhere
to confirm no other callsite relies on the doubled form.

This single one-line fix may be enough to make Failure 1 disappear in
practice — without it, `safeBranchPart`'s 72-char slice is what catches
the symptom; with it, the prefix fits comfortably under 72 chars and
truncation never fires for realistic inputs. **Recommendation: fix this
first (it's a 1-character edit), THEN apply the head+tail truncation
fix as defense in depth.**

### Skill-side bug for Failure 2 (zombies): no cleanup directive on monitor exit

`build/SKILL.md.tmpl:1198-1276` (Step M3) defines the monitor loop. It
never instructs the agent to verify subprocess cleanup before exiting,
nor to run `pkill -f gstack-build` on a wedged exit. The CLI-side fix
(make `child-registry.spawn` not default detached) is necessary; the
skill-side fix is to add a "before reporting DONE_WITH_CONCERNS,
verify no live child PIDs remain via the active-runs manifest" check.

Fix shape: append a sub-step in Step M3.5 (Skill Fault Investigator) or
Step 3 (Final Ship & Completion) that runs:

```bash
gstack-build doctor --check-zombies --json
```

and surfaces any leaked PIDs to the user before declaring done. Doctor
subcommand already exists per recent commit `548baca8`; the skill just
needs to invoke it at the right moments.

### Skill-side bug for Failure 3 (hygiene gate): synthesizer prompt allows mixed-layer phases

The synthesizer prompt at `build/SKILL.md.tmpl:398-475` describes the
TDD lifecycle for `[code]` phases as **three checkbox sub-steps inside
one phase**: Test Specification → Implementation → Review & QA. The
prompt does NOT instruct the synthesizer that the Review & QA sub-step
must touch only test paths if it triggers a hygiene-gate check. So a
synthesized plan can have Phase 1 where:

- Test Specification writes `test/foo.test.ts`
- Implementation writes `src/foo.ts`
- Review & QA finds a real bug and writes `src/foo.ts` AGAIN (mixed)

All three sub-steps commit into Phase 1's diff. The hygiene gate at
`cli.ts:4297-4350` then refuses to auto-commit because Review & QA
touched production paths.

The skill's contract with the synthesizer is silent on this. Fix the
prompt at line 398-475 to add:

```
- Review & QA sub-steps in [code] phases MUST limit their diff to test
  paths (test/**, **/__tests__/**, **/*.test.*, **/*.spec.*). If the
  Review & QA agent finds a real bug in production code, it must STOP
  and emit a follow-up [code] phase rather than fix inline. The
  follow-up phase runs through the full TDD lifecycle.
```

This shifts the producer-side contract to match the gate's consumer-side
assumption. Together with the CLI-side auto-split fix, Failure 3 has
defense in depth.

### Skill-side bug for Failure 4 (premature ship): Step 5.7 was bypassed or misunderstood

`build/SKILL.md.tmpl:902-928` (Step 5.7 "Branch Strategy Decision")
**already exists** to prevent Failure 4. It asks the user via
AskUserQuestion: "single-branch (one PR for the whole plan) vs
multi-branch (PR per feature)". If the user picks single-branch, the
skill passes `--single-branch` to the CLI, which then defers shipping
until all features complete.

So Failure 4 means one of three things happened:

1. **The user picked multi-branch (B) without realizing per-feature
   ship is the consequence.** Step 5.7's option B description is:
   `❌ Multiple PRs, multiple CI runs, more merge noise`. That's
   accurate but doesn't say "Feature 1 ships the moment its phases
   finish, even if Features 2-9 are still running."

2. **The run was resumed and 5.7 never ran a second time.** Resume
   Mode (line 42-43) skips 5.7 because the manifest already encodes the
   choice.

3. **The screenshot author mis-attributed.** The text says
   "single-branch shipping logic kicked off ship-and-land" — but
   `--single-branch` is precisely what would have prevented it. Probably
   the user picked B at 5.7 but described it later as "single-branch"
   from memory.

Fix shape:

**A) Tighten Step 5.7's option B description** to explicitly call out
the per-feature ship timing:

```
B) Multi-branch — separate `feat/<prefix>-<feature>` branch per feature, /ship +
   /land-and-deploy fires AS SOON AS each feature's phases complete (even
   while other features are still running)
   ✅ Each feature is independently revertable
   ❌ Multiple PRs, multiple CI runs, more merge noise
   ❌ Feature 1 may ship before Features 2-9 even start;
      no way to bundle them into one PR later without rebasing
```

**B) Document the `--mark-phase-committed` side effect.**
Line 932 says only "use `gstack-build <plan> --mark-phase-committed
<phase>` to mark that phase committed". Add: "Note: in multi-branch
mode, marking the last phase of a feature committed will trigger
immediate ship-and-land for that feature. Pass `--skip-ship` if you
want to mark the phase but not ship."

**C) Add a third option to 5.7: bundle.** Pairs with the CLI-side
`--ship-on-plan-complete` flag from Failure 4 fix. Choice C is
"separate branches per feature, but all PRs deferred until plan
completes". Best of both worlds; new capability.

Recommendation: **A + B + C**, in that order of urgency. A and B are
template edits (zero CLI changes); C requires the CLI flag from
Failure 4 to exist first.

### Skill-side summary

| Failure | Skill-side gap                                             | Fix                                    |
| ------- | ---------------------------------------------------------- | -------------------------------------- |
| 1       | `branchPrefix` template duplicates `repoSlug` (line 712)   | 1-line edit                            |
| 2       | No zombie-check before declaring done                      | Add doctor invocation in M3.5 / Step 3 |
| 3       | Synthesizer prompt allows Review & QA to touch prod files  | Add producer-side rule at line 398-475 |
| 4       | Step 5.7 option B doesn't disclose per-feature ship timing | Tighten language + add option C        |

Effort estimate for all four skill-side fixes: **~45 min CC**. All are
prompt edits; no code. Run `bun run gen:skill-docs` afterward to
regenerate `build/SKILL.md` from the template.

---

## Recommended fix ordering

Now eight fixes total (four skill-side + four CLI-side). Skill-side
edits are cheaper to land and reduce the probability of triggering the
CLI bugs in the first place — do them first.

**Phase A — Skill template (prompt-only, ~45 min CC, no compiled changes):**

1. **#5 (skill) — `branchPrefix: "<runId>"` one-line fix at SKILL.md.tmpl:712.**
   Probably eliminates Failure 1's symptom on its own. Smallest, highest
   leverage.
2. **#4 (skill) — Tighten Step 5.7 option B language + document
   `--mark-phase-committed` ship side effect at line 932.** Sets user
   expectations before they pick.
3. **#3 (skill) — Add Review & QA "test-paths-only" rule to synthesizer
   prompt at line 398-475.** Aligns producer with gate consumer.
4. **#2 (skill) — Add `gstack-build doctor --check-zombies` invocation
   in Step M3.5 / Step 3.** Surfaces leaks before user thinks the run
   ended cleanly.

After Phase A, run `bun run gen:skill-docs` once, commit the template +
generated SKILL.md together.

**Phase B — CLI orchestrator (compiled code, ~3 hours CC):**

5. **#1 (CLI) — Head+tail truncation in `safeBranchPart`.** Defense in
   depth in case Phase A #5 leaves any other long-input path.
6. **#2 (CLI) — SKIPPED after deeper investigation.** The plan's
   recommendation to "remove `detached: true` default" was based on the
   investigation agent's read; reading the actual
   `build/orchestrator/child-registry.ts:1-27` and `monitor.ts:494-499`
   reveals that the `detached: true` default and `child.unref()` are
   intentional and load-bearing:
   - `detached: true` gives every child its own process group so the
     parent's SIGTERM/SIGINT/SIGHUP handler can reach the whole tree
     via `process.kill(-pid, signal)`. Removing it would silently break
     group-signal reaping.
   - `child.unref()` lets the foreground monitor's resumed `gstack-build`
     child survive the monitor's own re-entry on `--max-wall-ms`.
   - `sweepOrphans` already protects dead-PID + fresh-heartbeat from
     reaping (supervised-restart case), which is by design.

   The screenshot's zombies survived because the user `pkill`'d the
   hierarchy after a graceful path failed, bypassing the SIGTERM
   contract. The Phase A4 fix (subprocess-leak warning in the
   skill-template completion report at SKILL.md.tmpl:1823) is the right
   mitigation: surface the leak to the user before declaring done, so
   they can clean up. No CLI changes for Failure 2.

7. **#4 (CLI) — Add `--ship-on-plan-complete` flag.** Enables Phase A
   #4's "option C" (deferred-bundle multi-branch) in the template.
8. **#3 (CLI) — Auto-split mixed test+prod diff in
   `maybeAutoCommitTestOnlyDirty`.** Safety net for any synthesizer
   that violates the Phase A #3 rule.

Each Phase B fix ships as its own commit with regression tests, gated
by a `bun test build/orchestrator/__tests__/` pass.

**Total effort: ~4 hours CC across both phases.**

---

## Open questions for user

1. **Skill-side #5 (`branchPrefix` template fix) — verify before
   editing.** Is there any consumer of the manifest's `branchPrefix`
   field that depends on the doubled `<repoSlug>-<runId>` form? I'll
   grep before editing, but flagging now so you can object if you know
   of a consumer. (Suspected safe: branchPrefix is used only by
   `safeBranchPart` callsites in cli.ts; runId is already used as the
   identity key everywhere else.)

2. **Hygiene gate fix shape — skill rule (#3 skill), CLI auto-split
   (#3 CLI), or both?** Recommendation: both, as defense in depth. The
   skill rule prevents most cases; the CLI auto-split handles the
   residual.

3. **Step 5.7 option C (deferred-bundle multi-branch) — add it now or
   wait until the CLI flag from #4 exists?** If you want sequential
   shipping (Phase A first, Phase B second), option C goes in Phase A
   #4 alongside the language tightening, even though it can't be
   selected until Phase B lands. Or skip C from Phase A and add it as
   part of Phase B #4. Preference?

4. **One PR or eight?** Options:
   - **One PR** — easy review, single CHANGELOG entry, atomic land.
   - **Two PRs** — Phase A (skill) and Phase B (CLI) separately;
     skill-only PR is risk-free and could ship today.
   - **Eight PRs** — cleanest bisect, slowest to merge.
     Recommendation: **two PRs** (Phase A first, Phase B second) — the
     skill-only changes don't need the CLI changes and unblock the
     immediate pain (especially #5 branchPrefix).

5. **Why did the live `/build` run not catch any of these in earlier
   runs?** The mitosis-oasis bundle was probably the first run with a
   sufficiently long plan-basename to trigger truncation AND with the
   user's specific bundle-style mental model. Worth confirming via
   git log on prior `/build` invocations to set a "this is a real
   regression vs always-been-broken" baseline. Not blocking the fix.

Awaiting answers before `/build`-ing this plan.
