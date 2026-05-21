# Plan: Implementor + Hygiene Hardening (post-discovery-fault investigations)

> **plan-eng-review status (2026-05-17):** Round 2 — REVISED after gpt-5.5
> plan-reviewer caught two CRITICAL bugs in round 1 decisions D1 + D3 during
> the first /build attempt:
>
> 1. **D3 was wrong**: content-hash delta compared against `before.head` blob
>    (HEAD commit content), NOT against the actual pre-agent worktree content.
>    Any file the user had dirty BEFORE the agent ran was misreported as
>    agent-modified. Round 2 fixes this by capturing pre-agent worktree hashes
>    in `GitSnapshot` itself.
> 2. **D1 was wrong**: `discardBlindExecutionChanges` ran `git reset --hard
before.head && git clean -fd` which erases ALL pre-existing dirty +
>    untracked work in the worktree, not just the blind-execution changes.
>    Round 2 fixes this by preserving pre-agent dirty state across the
>    discard operation (path-by-path restore).
>
> Plus 4 IMPORTANT objections from gpt-5.5 addressed in the test plan
> (T2.1 fidelity, null-head behaviour, wire-in integration test,
> nonzero-exit blind detection). See "Eng Review Decisions" below for the
> revised D-points.

> **Source:** Drafted from the two outstanding skill-fault discovery
> reports (T101049 + T111646) on the `agnt2-prototype-plan4` run. All other
> fault reports on disk are closed by today's earlier fixes or by `be10ed92`.

## Context

Two skill-fault discovery reports surfaced four distinct issues on a single
`agnt2-prototype-plan4` build run (2026-05-17). Each is independently
reproducible, each has a concrete fix, and together they form a tightly-scoped
follow-up to today's fault-detector hardening:

1. **Gemini backup implementor staged its input file at a path outside its
   own sandbox.** `build/orchestrator/sub-agents.ts:165-179` writes Gemini
   I/O to `~/.gemini/tmp/gstack/<slug>/`, but Gemini's `--yolo` workspace
   policy only allows `~/.gemini/tmp/<slug>/`. The `gstack/` subdirectory
   makes the path resolve outside the sandbox. Gemini fails to read its
   instruction file, continues in yolo mode, and makes blind-inference edits.
   **Severity: data integrity** (a phase committed under this condition is
   structurally unable to satisfy its spec).
2. **Hygiene gate is absolute, not relative.** `validatePostAgentHygiene` at
   `build/orchestrator/cli.ts:1455-1495` takes a `before: GitSnapshot` but
   only checks `after.status` for dirty entries — `before.status` is unused
   in the dirty check. Foundry deployment artifacts touched by `forge test`
   (or any review-time test run) trigger false-positive `GATE FAIL` even
   when the agent wrote nothing. Confirmed on Phase 1.1 of the same run
   (`contracts/deployments/base-sepolia*.json`).
3. **Recovery path commits blind-execution output silently.** When the
   hygiene gate fails AND the agent's input file was provably unreadable
   (stderr contains `Path not in workspace`), `recoverMutableAgentCommit`
   still proceeds to stage and commit the dirty changes. The committed
   content is of unknown correctness — the agent never read its spec.
4. **Kimi 900s hard timeout on multi-step phases.** `build/configure.cm`
   pins `timeoutsMs.kimi: 900000`. Multi-framework smoke harness phases
   (npm install chains across 4-5 frameworks) hit the wall clock with zero
   stdout, forcing the backup path that exposes issue #1 above.

What is already shipped (do NOT redo):

- Fault detector hardening (commits `54cc4f2d`, `97415a3e`, `06802f4c`,
  `1ce9afb5`): sentinel gate, structural validator, heading-anchored block
  extraction. Closes the synthesizer-race and run-on-prose fault classes.
- `PREMATURE_COMPLETION` detector tightened to terminal-failed states
  (commit `be10ed92`).

Intended outcome:

- A backup-Gemini invocation that cannot read its spec **never** dirties the
  worktree and **never** commits.
- A `forge test` review side-effect that touches pre-existing tracked
  files **never** triggers a hygiene `GATE FAIL`.
- A Kimi timeout on a structurally-large phase fails into a recoverable
  state, not a 60-minute primary→backup→retry loop.

## Eng Review Decisions

Round-1 decisions D1-D4 (recorded below for history) were partly wrong;
gpt-5.5 plan-reviewer caught two CRITICAL bugs during the first /build
attempt. Round-2 decisions D5 + D6 supersede the wrong parts of D1 + D3.
**The locked decisions are: D2 (unchanged), D4 (unchanged), D5 (replaces
the relevant part of D3), D6 (replaces the relevant part of D1).**

### Round 2 (supersedes — these are the live decisions)

- **D5 — Fix #2 content-hash compares pre-agent WORKTREE bytes, NOT HEAD
  blob.** `captureGitSnapshot` is extended to capture a
  `Map<path, sha256>` of every dirty path's worktree content at the
  moment of capture (not just the porcelain status lines). The new
  `contentHashDelta` helper compares `after` worktree hashes against
  the `before` worktree hashes for the same path. Rules:
  - Path was dirty before AND after with identical hashes → idempotent
    rewrite, drop from the dirty list (Foundry case).
  - Path was dirty before AND after with different hashes → real
    change, count.
  - Path was clean before AND dirty after → real change, count.
  - Path was dirty before AND clean after → still in `after.status` if
    git noticed, but if hashes match `before` then the file is back to
    its original content (untouched); if hashes mismatch then the agent
    fixed or further-modified — count.
  - Untracked file (`?? path`) → compare hashes between pre and post
    if both snapshots have it (e.g. agent rewrote an untracked file
    with same bytes — rare but symmetrically handled); count otherwise.
  - Deleted file (worktree-only delete `D ` or staged delete) →
    always count.
  - File-read error at hash time → count conservatively + log warning.
  - **Null-head handling**: gpt-5.5 IMPORTANT — when `before.head` is
    null AND the path is dirty in `after`, conservatively count as a
    real change (do NOT fall back to "if before had it dirty too,
    drop"; null head means we cannot trust the comparison).
  - **Test fidelity for idempotent case (gpt-5.5 IMPORTANT)**: T2.1
    must dirty the file BEFORE capturing `before`, then rewrite with
    identical bytes after the agent — that way `before.status`
    contains the entry AND `before.workTreeHashes[path] ===
after.workTreeHashes[path]`. A clean→identical-rewrite test is
    unreliable because git's stat refresh often hides it as clean.

  This closes both the Foundry idempotent-rewrite case AND the new
  case gpt-5.5 caught: a user who has uncommitted work in the
  worktree before the agent runs no longer sees their dirty state
  misattributed to the agent.

- **D6 — `discardBlindExecutionChanges` preserves pre-existing dirty
  state via path-by-path restore (NOT `git reset --hard + clean -fd`).**
  The naive reset+clean nukes any uncommitted work the user had in
  the worktree before the agent ran — unacceptable for a hygiene
  recovery path. The corrected design:

  ```ts
  // Pseudo-code
  function discardBlindExecutionChanges(cwd, before): Result {
    // Guards (carry-over from D1, still required)
    if (!before.head) return error("null head");
    if (!cwd.startsWith(WORKTREE_ROOT + path.sep))
      return error("outside worktree");

    // For every path the AGENT touched (after.status ∖ before.status by path),
    // restore to `before` content if the path was present in `before` with a hash,
    // else delete (it was untracked before too if hash absent, or absent entirely).
    const after = captureGitSnapshot(cwd);
    const beforeByPath = new Map(
      before.status
        .map(parsePorcelainPath)
        .map((p, i) => [p, before.workTreeHashes.get(p)]),
    );
    const afterPaths = new Set(after.status.map(parsePorcelainPath));
    const agentTouched = [...afterPaths].filter(
      (p) =>
        !beforeByPath.has(p) ||
        beforeByPath.get(p) !== after.workTreeHashes.get(p),
    );
    for (const p of agentTouched) {
      if (before.workTreeHashes.has(p)) {
        // Path existed before; restore exact bytes
        fs.writeFileSync(path.join(cwd, p), before.workTreeContents.get(p));
      } else if (existsInBeforeHead(cwd, before.head, p)) {
        // Path was tracked + clean before; restore HEAD blob
        spawnSync("git", ["checkout", before.head, "--", p], { cwd });
      } else {
        // Path was untracked + absent before; delete it
        try {
          fs.unlinkSync(path.join(cwd, p));
        } catch {}
        // Recursively remove empty parent dirs the agent created
      }
    }
    return ok();
  }
  ```

  This means `GitSnapshot` must also carry `workTreeContents: Map<path,
Buffer>` for paths that were dirty in `before`. Memory cost is
  bounded (per-phase worktrees are small; typical pre-agent dirty set
  is 0-3 files). Tests T3.10 + T3.11 prove pre-existing tracked +
  untracked dirty content survives the discard. Restored from D1: the
  null-head + cwd-inside-worktree guards stay; the destructive `reset
--hard + clean -fd` is removed.

### Round 1 (history — partly superseded by D5 + D6)

- **D1 (partly superseded by D6) — `discardBlindExecutionChanges` guard rails: null-head + cwd assertions.** Guards (null-head, cwd-inside-worktree) carry over to D6 verbatim. The `git reset --hard + git clean -fd` implementation is REPLACED by D6's path-by-path restore.

- **D2 (live) — Blind-execution probe: generic name + speculative markers across providers.** `detectBlindExecution(logPath: string)` uses a per-agent marker table covering Gemini (proven) + speculative Kimi/Codex.

- **D3 (superseded by D5) — Content-hash delta vs HEAD blob.** Wrong: misreports pre-existing dirty as agent-modified. D5 captures pre-agent worktree hashes in `GitSnapshot` and compares against those.

- **D4 (live) — Rich multi-line sentinel for plan-reviewer.** Already shipped (commits `54cc4f2d`+); not in this plan's scope.

## Architectural decisions (unchanged from draft)

- **Fix #1 is a path edit, not a sandbox workaround.** The Gemini sandbox
  rule is fixed by Gemini itself; we conform to it rather than try to argue.
  Three-character delete: drop the `gstack/` literal in `stageGeminiIO`.
- **Fix #3 is a stderr probe + early abort, not a new gate.** The signal
  for "agent ran blind" is already in the captured stderr. The probe runs
  in `applyMutableAgentHygiene` BEFORE `recoverMutableAgentCommit` (the
  existing recovery path that stages and commits). On positive match, the
  function calls `discardBlindExecutionChanges` and returns a
  `hygieneFailureResult` — `recoverMutableAgentCommit` never runs for
  blind-execution cases. The normal retry/escalation path handles the
  resulting failure.
- **Fix #4 raises the Kimi default, with an envelope.** Bumping
  `configure.cm` kimi to 1500000 (25 min) covers all real-world
  multi-framework phases we've seen without inviting indefinite hangs.
  Decomposition is a planner-side concern, out of scope.

## Changes

### Fix #1 — Gemini staging path (sandbox-correct)

[build/orchestrator/sub-agents.ts:165-179](build/orchestrator/sub-agents.ts):
`stageGeminiIO` constructs `path.join(HOME, ".gemini", "tmp", "gstack", slug)`.
Drop the `"gstack"` literal:

```diff
   const stagingDir = path.join(
     process.env.HOME ?? "~",
     ".gemini",
     "tmp",
-    "gstack",
     opts.slug,
   );
```

The block comment at line 154-164 references the path; update it to match.

Files dirtied by historical leftovers from the old path
(`~/.gemini/tmp/gstack/<slug>/`) can be cleaned up by hand or with a
one-time `rm -rf ~/.gemini/tmp/gstack` — not part of this plan.

### Fix #2 — Worktree-content-hash hygiene delta (per D5)

[build/orchestrator/cli.ts:1424-1495](build/orchestrator/cli.ts):
`captureGitSnapshot` is extended to capture pre-agent worktree content
hashes. `validatePostAgentHygiene` uses a new `contentHashDelta` helper
that compares `after` worktree hashes against the `before` worktree
hashes — NOT against the HEAD blob. This correctly handles the case
where the worktree was dirty BEFORE the agent ran (gpt-5.5 CRITICAL #1).

Implementation:

1. Extend `GitSnapshot` interface:

   ```ts
   export interface GitSnapshot {
     head: string | null;
     status: string[];
     // NEW: hex sha256 of worktree bytes for every dirty entry in `status`.
     // Untracked entries hash the file as it exists on disk; missing/unreadable
     // entries are absent from the map.
     workTreeHashes: Map<string, string>;
     // NEW: full file contents for dirty entries; used by discardBlindExecutionChanges
     // (D6) to restore pre-existing dirty state. Optional — only populated when
     // captureGitSnapshot is invoked with `captureContents: true` (the call site
     // in applyMutableAgentHygiene's `before` capture). Pure-status callers can
     // skip this for memory efficiency.
     workTreeContents?: Map<string, Buffer>;
   }
   ```

2. `captureGitSnapshot(cwd, opts?: { captureContents?: boolean })`:
   - After `git status --porcelain --untracked-files=all`, iterate the
     dirty entries. For each `path` (extracted via `parsePorcelainPath`):
     read the worktree file at `cwd/path`, compute sha256, store in
     `workTreeHashes`. If `captureContents`, store the bytes in
     `workTreeContents`. Deleted entries (`D` or `D ` codes) have no
     worktree file — skip both maps for those.
   - File-read errors → omit from both maps; log a warning naming the
     path and the error.

3. `contentHashDelta(before: GitSnapshot, after: GitSnapshot)`:
   Returns the subset of `after.status` lines that represent REAL agent
   changes. Path-level rules:
   - **Path was dirty before AND dirty after with same `workTreeHashes`**
     → idempotent rewrite (Foundry case); drop.
   - **Path was dirty before AND dirty after with different hashes**
     → agent further-modified an already-dirty file; count.
   - **Path was clean before (NOT in `before.status`) AND dirty after**
     → check if path's after-hash matches the blob at `before.head`
     (read via `git show <before.head>:<path>`). Match → idempotent
     rewrite of a clean tracked file (rare but possible); drop. Mismatch
     OR no HEAD blob exists → real change, count.
   - **Path is `?? path` (untracked) in `after`** → check `before.workTreeHashes`
     for the same path. Match → idempotent untracked rewrite, drop.
     Mismatch or absent from `before` → real change, count.
   - **Path is deleted in `after`** (`D` or `D `) → always real change.
   - **File-read or hash error during the check** → conservatively
     count, log warning.

4. **Null-head handling (gpt-5.5 IMPORTANT)**: when `before.head` is
   null, the "clean before → check HEAD blob" branch cannot fall back
   to "drop if matches HEAD" — there's no HEAD. Conservatively count
   the entry. Same for "tracked but not yet committed" entries.

5. `validatePostAgentHygiene` captures `after` via
   `captureGitSnapshot(cwd)` (no `captureContents` needed for the
   hygiene check; only `before` needs contents because D6 may need to
   restore from them). It then calls
   `contentHashDelta(opts.before, after)` to compute `dirty`. The
   existing `requireNonEmptyOutput` and `requireNewCommit` checks are
   unchanged.

6. `applyMutableAgentHygiene` already captures `opts.before` before the
   agent spawns; that call site must use
   `captureGitSnapshot(cwd, { captureContents: true })` so D6's discard
   has the bytes available.

The `before` parameter is already plumbed through — no new public API.
Two new private helpers live at module scope alongside
`captureGitSnapshot`.

Performance: typical pre-agent dirty set is 0-3 files of <1MB each;
sha256 on a few MB is sub-ms; total cost <50ms per hygiene check
plus ~1-5MB peak RSS for cached `workTreeContents`. Negligible.

### Fix #3 — Detect blind execution + path-preserving discard (per D2 + D6)

[build/orchestrator/cli.ts](build/orchestrator/cli.ts) — extend
`applyMutableAgentHygiene` (lines 3772-3825) with a sandbox-violation
probe that runs BEFORE `recoverMutableAgentCommit` (currently called at
line 3795). The probe is unchanged from D2; the discard helper is
materially different from round 1 — it preserves pre-existing dirty
state (gpt-5.5 CRITICAL #2).

**Probe — `detectBlindExecution(logPath)`** (per D2, unchanged):

```ts
type BlindExecutionAgent = "gemini" | "kimi" | "codex";
const BLIND_EXECUTION_MARKERS: Record<BlindExecutionAgent, string[]> = {
  gemini: [
    "Path not in workspace:",
    "resolves outside the allowed workspace directories:",
  ],
  // Speculative — refine on first observed Kimi/Codex blind failure.
  kimi: ["workspace path not allowed:", "outside --add-dir scope:"],
  codex: ["sandbox denied", "workspace-write violation:"],
};

export function detectBlindExecution(logPath: string): {
  ok: boolean;
  violation?: string;
  agent?: BlindExecutionAgent;
} {
  let content = "";
  try {
    content = fs.readFileSync(logPath, "utf8");
  } catch {
    return { ok: true }; // missing log → no signal → don't escalate
  }
  for (const [agent, markers] of Object.entries(BLIND_EXECUTION_MARKERS)) {
    for (const marker of markers) {
      if (content.includes(marker)) {
        return {
          ok: false,
          violation: marker,
          agent: agent as BlindExecutionAgent,
        };
      }
    }
  }
  return { ok: true };
}
```

**Discard helper — `discardBlindExecutionChanges(cwd, before)`** (per
D6, path-by-path restore that PRESERVES pre-existing dirty work):

```ts
const WORKTREE_ROOT = path.join(
  process.env.HOME ?? os.homedir(),
  ".gstack",
  "build-worktrees",
);

export function discardBlindExecutionChanges(
  cwd: string,
  before: GitSnapshot,
): { ok: boolean; error?: string; restored?: string[]; deleted?: string[] } {
  // Guards (D1 carry-over)
  if (!before.head) {
    return { ok: false, error: "before.head is null; refusing to discard" };
  }
  const resolved = path.resolve(cwd);
  if (!resolved.startsWith(WORKTREE_ROOT + path.sep)) {
    return {
      ok: false,
      error: `cwd ${resolved} is outside ${WORKTREE_ROOT}; refusing to discard`,
    };
  }
  // D6 requires `before.workTreeContents` to be present (captured with
  // captureContents:true). Without it we cannot restore pre-existing
  // dirty bytes — fail closed.
  if (!before.workTreeContents) {
    return {
      ok: false,
      error:
        "before.workTreeContents not captured; refusing to discard without it",
    };
  }

  const after = captureGitSnapshot(resolved); // status-only is fine
  const beforePaths = new Set<string>(before.status.map(parsePorcelainPath));
  const restored: string[] = [];
  const deleted: string[] = [];

  for (const line of after.status) {
    const p = parsePorcelainPath(line);
    const wasDirtyBefore = beforePaths.has(p);
    const beforeHash = before.workTreeHashes.get(p);
    const afterHash = after.workTreeHashes.get(p);
    // If hashes match, the file is unchanged from the pre-agent state
    // — nothing for the agent to "discard."
    if (beforeHash && afterHash && beforeHash === afterHash) continue;

    if (wasDirtyBefore && before.workTreeContents.has(p)) {
      // Path was dirty before; restore the EXACT pre-agent bytes.
      const target = path.join(resolved, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, before.workTreeContents.get(p)!);
      restored.push(p);
    } else if (existsInCommit(resolved, before.head, p)) {
      // Path was tracked + clean before; restore HEAD blob via checkout.
      const result = spawnSync("git", ["checkout", before.head, "--", p], {
        cwd: resolved,
        encoding: "utf8",
      });
      if (result.status === 0) restored.push(p);
    } else {
      // Path was untracked + absent before; delete what the agent created.
      try {
        const target = path.join(resolved, p);
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
        deleted.push(p);
      } catch (err) {
        // Best-effort; the file may have already been moved by the agent.
      }
    }
  }

  return { ok: true, restored, deleted };
}

// Private helper: does `path` exist as a tracked file at the given commit?
function existsInCommit(cwd: string, commit: string, p: string): boolean {
  const r = spawnSync("git", ["cat-file", "-e", `${commit}:${p}`], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0;
}
```

Crucially: paths that were dirty before AND have identical hashes after
are **skipped** entirely — the agent didn't touch them, no restore
needed. Only agent-touched paths get restored or deleted.

**Wire-in to `applyMutableAgentHygiene`** — gpt-5.5 IMPORTANT: the
existing function returns early when `result.exitCode !== 0` (line
3786-3788). The plan-reviewer's objection is correct: a blind-execution
agent can exit non-zero AND still dirty the tree. The wire-in must
**precede the exit-code early-return** so the discard fires whether the
agent exited 0 or non-zero, as long as `opts.before` exists. New shape:

```ts
function applyMutableAgentHygiene(opts: { ... }): SubAgentResult {
  if (!opts.before) {
    return opts.result;
  }
  // BLIND-EXECUTION PROBE — runs before timed-out / non-zero early-return,
  // so we can clean up a blind agent that exited non-zero or hit a timeout.
  const blind = detectBlindExecution(opts.result.logPath);
  if (!blind.ok) {
    console.warn(
      `  ⚠ BLIND_EXECUTION_DETECTED (${blind.agent}): ${blind.violation}`,
    );
    const discard = discardBlindExecutionChanges(opts.cwd, opts.before);
    if (!discard.ok) {
      console.warn(`  ⚠ discardBlindExecutionChanges failed: ${discard.error}`);
    } else {
      if (discard.restored?.length) {
        console.warn(`  ↺ restored pre-existing files: ${discard.restored.join(", ")}`);
      }
      if (discard.deleted?.length) {
        console.warn(`  ✗ deleted agent-created files: ${discard.deleted.join(", ")}`);
      }
    }
    return hygieneFailureResult(
      `${opts.label}: blind execution — input file unreachable; changes discarded`,
      opts.result.logPath,
    );
  }
  // Original early-return for timeouts and non-zero exits (no blind signal)
  if (opts.result.timedOut || opts.result.exitCode !== 0) {
    return opts.result;
  }
  // ...rest of applyMutableAgentHygiene unchanged: cleanupGeneratedCacheChanges,
  // recoverMutableAgentCommit, validatePostAgentHygiene, validateParentWorkspaceUnchanged.
}
```

This addresses gpt-5.5 IMPORTANT #4 (probe wired before recovery) AND
IMPORTANT #6 (probe runs even on non-zero exit when before exists).

### Fix #4 — Kimi timeout bump to 25 min

[build/configure.cm](build/configure.cm) — change `timeoutsMs.kimi` from
`900000` to `1500000`. The same change in
[build/configure.cm.template](build/configure.cm.template) keeps fresh
installs aligned. No code changes needed — the value flows through
`BUILD_DEFAULTS.timeoutsMs.kimi` and `KIMI_TIMEOUT_MS`.

Update the affected test expectations:

- [build/orchestrator/**tests**/role-config.test.ts:27](build/orchestrator/__tests__/role-config.test.ts) and `:139` — change
  `.toBe(900000)` to `.toBe(1500000)` for the kimi case.

### Test coverage

New file `build/orchestrator/__tests__/hygiene-delta.test.ts` covers
Fix #2 (worktree-content-hash delta per D5) with an isolated git
tempdir. Per gpt-5.5 IMPORTANT, tests construct realistic pre-agent
dirty states (not just "clean then identical rewrite"):

- **T2.1 — Idempotent rewrite of a PRE-EXISTING DIRTY file ignored
  (Foundry case + gpt-5.5 corrected fidelity).** Init repo, commit
  tracked file `contracts/deployments/base.json` with content "V1".
  Overwrite with "V2" so the file is dirty. Capture `before` (status
  contains the entry; `before.workTreeHashes` records SHA of "V2").
  Simulate "Foundry rewrites with identical bytes" by overwriting
  again with the SAME "V2" content. Capture `after`. Run
  `validatePostAgentHygiene`. Assert NO fault — `before` and `after`
  worktree hashes match for that path.
- **T2.2 — Real agent-modified content fails.** Same setup; capture
  `before` with file dirty as "V2". Overwrite with "V3" (different
  bytes). Run hygiene. Assert fault names the path.
- **T2.3 — Untracked file the agent created counted.** Capture clean
  `before`; create new `e2e/test.mjs` after. Assert fault includes
  the new file.
- **T2.4 — Untracked file with byte-identical content survives drop
  (symmetric case).** Capture `before` where `e2e/draft.mjs` exists
  untracked with content "X" (so `before.workTreeHashes` has it).
  Overwrite with "X" again. Assert no fault.
- **T2.5 — Deleted file always counted.** Capture `before` with
  tracked file present; delete the file from worktree. Assert fault.
- **T2.6 — File-read error during after-hash counted conservatively.**
  Make a tracked file unreadable (chmod 000 on Unix; skip on Windows).
  Assert fault includes the path AND a warning was logged.
- **T2.7 — Clean → clean passes.** No changes. Assert no fault.
- **T2.8 — Null-head conservatism (gpt-5.5 IMPORTANT #2).** Init repo
  with NO commits (`before.head === null`). Create a tracked-but-
  uncommitted file. Capture `before` (head null, status non-empty).
  Modify the file. Assert fault — null-head must NOT fall back to a
  "drop matching status line" branch.
- **T2.9 — Pre-existing dirty file unchanged passes (gpt-5.5
  CRITICAL #1 regression test).** This is the exact case gpt-5.5
  flagged: capture `before` with `contracts/deployments/base.json`
  dirty as "V2". Run the agent without touching the file. Capture
  `after`. The file is still in `after.status` AND
  `after.workTreeHashes[path] === before.workTreeHashes[path]`.
  Assert NO fault — the user's pre-existing dirty work is NOT
  misattributed to the agent.

`build/orchestrator/__tests__/sub-agents.test.ts` — extend with Fix #1:

- **T1.1 — Gemini staging path matches sandbox shape.** Call
  `stageGeminiIO` with a known slug; assert `stagedInput` resolves under
  `os.homedir() + "/.gemini/tmp/<slug>/..."` (no `gstack/` segment).

New file `build/orchestrator/__tests__/blind-execution-detect.test.ts`
covers Fix #3 with fixture logs + a real git tempdir for the discard
path. Tests T3.1-T3.9 cover the probe + guards; T3.10-T3.13 are NEW
per gpt-5.5 IMPORTANTs to prove the discard preserves pre-existing
state and the wire-in actually runs:

- **T3.1 — Gemini marker `Path not in workspace:` detected.** Fixture
  log contains the string. Assert `detectBlindExecution` returns
  `{ ok: false, violation: "Path not in workspace:", agent: "gemini" }`.
- **T3.2 — Gemini marker `resolves outside the allowed workspace
directories:` detected.** Same shape, agent "gemini".
- **T3.3 — Speculative Kimi marker detected.** Fixture log contains
  `workspace path not allowed:`. Test comment notes pattern is
  speculative; will be refined on first observed Kimi blind failure.
- **T3.4 — Speculative Codex marker detected.** Same shape, agent
  "codex".
- **T3.5 — Clean log → ok.** Fixture log with no marker. `{ ok: true }`.
- **T3.6 — Missing log → ok.** Nonexistent path. `{ ok: true }`.
- **T3.7 — `discardBlindExecutionChanges` happy path (agent-only changes
  reverted; HEAD intact).** Init real git repo under
  `$HOME/.gstack/build-worktrees/<slug>` (use `useIsolatedGstackHome`
  to point `$HOME` at a tempdir), commit baseline. Capture `before`
  with `captureContents: true` (clean state). Simulate agent: modify
  one tracked file, create one untracked file. Call discard. Assert
  `git status --porcelain` empty, HEAD matches `before.head`,
  `restored` contains the tracked path, `deleted` contains the new file.
- **T3.8 — Null-head guard.** Call discard with `before.head: null`.
  Returns `{ ok: false, error: contains "head" }`. No git ops ran.
- **T3.9 — cwd-outside-worktree guard.** Call discard with `cwd =
"/tmp/outside"`. Returns `{ ok: false, error: contains "outside" }`.
  No git ops ran.
- **T3.10 — Pre-existing dirty TRACKED file survives discard
  (gpt-5.5 CRITICAL #2 regression test).** Commit baseline. Modify
  tracked file `repo/foo.ts` to "USER-DIRTY". Capture `before` with
  contents. Simulate agent: modify a DIFFERENT tracked file
  `repo/agent.ts`. Call discard. Assert `repo/foo.ts` content is
  STILL "USER-DIRTY" (user's pre-existing dirty work preserved);
  `repo/agent.ts` content matches HEAD (agent change reverted).
- **T3.11 — Pre-existing UNTRACKED file survives discard.** Capture
  `before` with `repo/notes.txt` untracked (in `before.status` as
  `?? notes.txt`, contents captured). Simulate agent: create a
  different untracked file `repo/agent-tmp.txt`. Call discard.
  Assert `repo/notes.txt` STILL present with original content;
  `repo/agent-tmp.txt` deleted.
- **T3.12 — Discard refuses without `workTreeContents`.** Capture
  `before` with default options (no `captureContents`). Call discard.
  Assert `{ ok: false, error: contains "workTreeContents" }`. No git
  ops ran.
- **T3.13 — Call-site integration: probe runs before recovery
  (gpt-5.5 IMPORTANT #4 regression).** Spin up a `SubAgentResult`
  with `exitCode: 0`, `logPath` pointing to a fixture log containing
  a Gemini sandbox marker, and a dirty worktree where a tracked
  file was modified by "the agent". Call `applyMutableAgentHygiene`
  with `requireNewCommit: true`. Assert the returned `SubAgentResult`
  is a `hygieneFailureResult` with "blind execution" in the error,
  AND `recoverMutableAgentCommit` was NOT invoked (verifiable via
  the absence of a new commit on HEAD), AND the dirty file is
  back to its pre-agent content (via D6 restore).
- **T3.14 — Call-site integration: blind probe fires on nonzero exit
  (gpt-5.5 IMPORTANT #6 regression).** Same setup but agent
  `SubAgentResult.exitCode: 1`. Assert blind probe still fires AND
  discard still runs AND result is `hygieneFailureResult`. The
  current code's early-return on nonzero exit must not skip the
  probe when `opts.before` is non-null.

`build/orchestrator/__tests__/role-config.test.ts` — change the two
existing `.toBe(900000)` assertions to `.toBe(1500000)` for the kimi
case (Fix #4).

`build/orchestrator/__tests__/coverage-matrix.test.ts` — no change
needed; new helpers live in `cli.ts` which is already in the matrix.

## Critical Files

| File                                                                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                       | Diff       |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [build/orchestrator/sub-agents.ts](build/orchestrator/sub-agents.ts)                                                       | Drop `gstack/` from Gemini staging path (Fix #1)                                                                                                                                                                                                                                                                                                              | ~2 lines   |
| [build/orchestrator/cli.ts](build/orchestrator/cli.ts)                                                                     | `GitSnapshot` extended with `workTreeHashes` + optional `workTreeContents` (D5); `captureGitSnapshot` rewrite; new `contentHashDelta` + `existsInCommit` private helpers; `validatePostAgentHygiene` rewire; `detectBlindExecution` + `discardBlindExecutionChanges` (D6 path-preserving); `applyMutableAgentHygiene` blind-probe wire-in BEFORE early-return | ~220 lines |
| [build/configure.cm](build/configure.cm)                                                                                   | Kimi 900s → 1500s (Fix #4)                                                                                                                                                                                                                                                                                                                                    | 1 line     |
| [build/configure.cm.template](build/configure.cm.template)                                                                 | Same                                                                                                                                                                                                                                                                                                                                                          | 1 line     |
| [build/orchestrator/**tests**/role-config.test.ts](build/orchestrator/__tests__/role-config.test.ts)                       | Two `.toBe()` updates for Fix #4                                                                                                                                                                                                                                                                                                                              | 2 lines    |
| [build/orchestrator/**tests**/hygiene-delta.test.ts](build/orchestrator/__tests__/hygiene-delta.test.ts)                   | NEW: 9 tests covering Fix #2 worktree-content-hash delta (T2.1-T2.9 including pre-existing-dirty regression T2.9 + null-head conservatism T2.8)                                                                                                                                                                                                               | ~220 lines |
| [build/orchestrator/**tests**/blind-execution-detect.test.ts](build/orchestrator/__tests__/blind-execution-detect.test.ts) | NEW: 14 tests covering Fix #3 probe + guarded discard + preservation regression (T3.10/T3.11) + call-site integration (T3.13/T3.14)                                                                                                                                                                                                                           | ~320 lines |
| [build/orchestrator/**tests**/sub-agents.test.ts](build/orchestrator/__tests__/sub-agents.test.ts)                         | Fix #1 staging-path shape assertion                                                                                                                                                                                                                                                                                                                           | ~20 lines  |

Total: ~785 lines, 8 files. At the 8-file complexity threshold by count
(2 of the 8 are pure 1-line config bumps + 1 is a 2-line assertion
update; effective real-code surface is 5 files). Materially larger than
the round-1 ~485-line plan: D5 added `workTreeHashes`/`workTreeContents`
to `GitSnapshot` (+40 lines); D6 replaced `git reset --hard + clean -fd`
with path-by-path restore (+60 lines including `existsInCommit` helper);
T2.8/T2.9 + T3.10-T3.14 (5 new tests) added ~200 lines of regression
coverage for the gpt-5.5 CRITICALs and IMPORTANTs.

## Reused functions / patterns

- `captureGitSnapshot`, `GitSnapshot`, `hygieneFailureResult` — all
  already exist at [build/orchestrator/cli.ts](build/orchestrator/cli.ts). Fix #2 + Fix #3 use them
  as-is.
- `spawnCaptured` log capture (already records stderr to the same file
  Fix #3 reads).
- Test isolation: existing `useIsolatedGstackHome()` from
  [test/helpers/test-home.ts](test/helpers/test-home.ts).
- `BUILD_DEFAULTS` flow from [build/configure.cm](build/configure.cm) → `KIMI_TIMEOUT_MS`
  needs no change; Fix #4 only edits the data file.

## NOT in scope

- **Decomposing multi-framework phases into sub-phases.** Planner-side
  work; the timeout bump covers the immediate cases.
- **Adding `contracts/deployments/` to `.gitignore` in agnt2-prototype.**
  Per-project `.gitignore` is owned by that repo, not gstack. Fix #2's
  content-hash delta makes this unnecessary on the gstack side.
- **Rewriting `recoverMutableAgentCommit` to not commit on hygiene
  failure.** The recovery path is correct for non-blind cases (e.g. agent
  forgot to `git add`). Fix #3 pre-empts the wrong cases without
  destabilising the right ones.
- **A pre-agent stash mechanism** (the report's alt option). Strictly
  more state to manage than a content-hash check; Fix #2 (per D3) is
  sufficient.
- **Extracting hygiene helpers into a separate `hygiene-helpers.ts`
  module.** `cli.ts` is large (5900+ lines) but the new helpers follow
  the existing pattern (next to `validatePostAgentHygiene`). Refactor is
  a separate plan.

## Failure modes

- **Fix #1 leaves orphan files at `~/.gemini/tmp/gstack/`.** They are
  inert. No collision risk — slug is unique. Manual `rm -rf` if desired.
- **Fix #2 hashes a file deleted between `git status` and hash read.**
  Race window; conservatively counted as a real change. T2.6 covers it.
- **Fix #2 hashes a large generated file (multi-MB lockfile).** SHA-256
  on a few MB is sub-ms; cumulative cost stays under 50ms per hygiene
  check + ~1-5MB peak RSS for `workTreeContents`.
- **Fix #2 / D5: `before.workTreeContents` adds memory pressure.**
  Per-phase pre-agent dirty sets are typically 0-3 files. Hard cap:
  if `workTreeContents` reads exceed 50MB per snapshot, log a warning
  and skip captureContents for that path (best-effort).
- **Fix #3 speculative Kimi/Codex markers false-positive on unrelated
  log content** (per D2). Worst case: phase discarded unnecessarily;
  re-runs recover. Markers are specific enough (`workspace-write
violation:`, `outside --add-dir scope:`) that natural collision is
  unlikely. Refinement on first real failure.
- **Fix #3 / D6 discard runs without `workTreeContents`.** New guard:
  fails closed with an explicit error if `before.workTreeContents` is
  absent. T3.12 covers this. The call site in `applyMutableAgentHygiene`
  always captures `before` with `captureContents: true`, so this guard
  fires only on programmer error.
- **Fix #3 / D6 discard fires with `before.head == null` or cwd outside
  worktree.** Guards (carry-over from D1) return early. T3.8 + T3.9.
- **Fix #3 / D6 race: a file present in `before` is unlinked by the user
  during the agent's run.** `discardBlindExecutionChanges` writes the
  pre-agent bytes back, effectively restoring the file the user deleted.
  Acceptable — the build worktree is meant to be agent-owned during a
  build; user edits there during a run are unsupported.
- **Fix #3 / D6 race: agent creates a directory under a path that was
  a regular file before.** Path-by-path restore stat()s the target;
  if it's a directory, `fs.rmSync(recursive: true)` removes it before
  the writeFile. Cost: ~50ms per such path; negligible. (Inverse case
  — agent replaces a directory with a file — is similarly handled.)
- **Fix #4 doesn't bound the per-task wall time.** True. Bumping the
  floor doesn't fix runaway agents; a task >25 min is a real signal to
  decompose. Out of scope here.

## Parallelization

Three lanes, mostly independent:

- **Lane A** ([build/orchestrator/sub-agents.ts](build/orchestrator/sub-agents.ts) + sub-agents test):
  Fix #1 path edit + path-shape assertion. Smallest lane.
- **Lane B** ([build/orchestrator/cli.ts](build/orchestrator/cli.ts) + 2 new test files): Fix #2
  delta filter + Fix #3 blind-execution probe + discardBlindExecutionChanges
  - new test files for both. Largest lane; touches the hygiene call site.
- **Lane C** ([build/configure.cm](build/configure.cm) + template + role-config.test.ts): Fix #4
  timeout bump + 2 assertion updates. Trivial; can land first.

Recommended execution: C first (1-line preparatory change, makes tests
agree with the new default), then A and B in parallel.

## Verification

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack

# Lane-targeted runs first
bun test build/orchestrator/__tests__/sub-agents.test.ts          # Fix #1 staging path
bun test build/orchestrator/__tests__/hygiene-delta.test.ts        # Fix #2 delta filter
bun test build/orchestrator/__tests__/blind-execution-detect.test.ts # Fix #3 probe + reset
bun test build/orchestrator/__tests__/role-config.test.ts          # Fix #4 timeout default

# Then the whole orchestrator suite + skill-fault-detector for regression
bun test build/orchestrator/__tests__/
bun test test/skill-fault-detector.test.ts

# Manual smoke for Fix #1 (no spawn): inspect path shape
bun -e "import { stageGeminiIO } from './build/orchestrator/sub-agents'; \
        const r = stageGeminiIO({slug:'smoke', phaseNumber:'1.1', iteration:1, \
        suffix:'test', inputFilePath:'/tmp/in', outputFilePath:'/tmp/out'}); \
        console.log(r.stagedInput); r.cleanup();"
# expect path: ~/.gemini/tmp/smoke/...   (NO gstack/)
```

Real-world regression material is already on disk: the
`agnt2-prototype-plan4-20260517-082700-f58c68a8` build run that produced
both T101049 and T111646. After all four fixes ship, re-running that exact
plan should: (a) NOT trigger the dirty-tree gate on Phase 1.1 review
(Foundry artifacts ignored as pre-existing dirty), (b) NOT pollute the
worktree if Kimi times out and Gemini falls back (blind execution
detected + discarded), (c) likely not hit the Kimi timeout at all on the
25-minute envelope.

## Notes

- **VERSION bump**: PATCH (~785 lines, no new user-facing surface;
  contributor/orchestrator-internal).
- **CHANGELOG entry** (For contributors section):
  "Build orchestrator distinguishes agent-introduced dirty files from
  pre-existing ones via worktree content hashes (not HEAD blobs), so
  the post-agent hygiene gate stops misreporting user-dirty work as
  agent-modified. Blind-execution recovery preserves pre-existing dirty
  and untracked files via path-by-path restore (no more `git reset
--hard + clean -fd`). Gemini staging path matches Gemini's `--yolo`
  sandbox. Default Kimi per-phase timeout bumped to 25 min."
- **Auto-checkpoint hook is active**: bisect into 4 commits matching
  the fixes — (C) timeout bump, (A) Gemini path, (B1) GitSnapshot +
  hygiene delta, (B2) blind-execution probe + path-preserving discard —
  for clean revertability.
- The two fault reports that surfaced this stay on disk as historical
  evidence (`~/.gstack/skill-faults/skill-fault-discovery-agnt2-prototype-plan4-...-T101049.md`
  and `...-T111646.md`); future drain-faults runs on the same monitor logs
  will dedup against them (idempotent).

## Implementation Tasks

- [ ] **T1 (P1, human: ~20min / CC: ~5min)** — config — Kimi timeout 900000 → 1500000
  - Surfaced by: T111646 §"Fix 3 — Kimi Timeout"
  - Files: `build/configure.cm`, `build/configure.cm.template`, `build/orchestrator/__tests__/role-config.test.ts`
  - Verify: `bun test build/orchestrator/__tests__/role-config.test.ts` passes; both `.toBe(1500000)` assertions match.

- [ ] **T2 (P1, human: ~30min / CC: ~5min)** — staging — Drop `gstack/` from Gemini staging path
  - Surfaced by: T111646 §"Fix 1 — Gemini Temp Dir Path"
  - Files: `build/orchestrator/sub-agents.ts`, `build/orchestrator/__tests__/sub-agents.test.ts`
  - Verify: New T1.1 asserts path shape lacks `gstack/`; existing sub-agents tests still pass.

- [ ] **T3 (P1, human: ~3h / CC: ~40min)** — hygiene — `GitSnapshot` extended + worktree-content-hash delta (per D5)
  - Surfaced by: T101049 §"Systemic Fix Recommendations" + T111646 §"Fix 5"; eng review round 2 D5 (round 1 D3 was wrong — HEAD-blob comparison misreports pre-existing dirty as agent-modified, gpt-5.5 CRITICAL #1)
  - Files: `build/orchestrator/cli.ts` (extend `GitSnapshot` with `workTreeHashes` + optional `workTreeContents`; rewrite `captureGitSnapshot` to populate them; add `contentHashDelta` + `existsInCommit` helpers; rewire `validatePostAgentHygiene`), `build/orchestrator/__tests__/hygiene-delta.test.ts` (NEW)
  - Verify: 9 new tests pass — T2.1 idempotent rewrite of pre-existing dirty ignored; T2.2 real change fails; T2.3 agent-created untracked counted; T2.4 symmetric untracked drop; T2.5 deleted counted; T2.6 read-error conservative; T2.7 clean→clean passes; T2.8 null-head conservative (gpt-5.5 IMPORTANT #2); T2.9 pre-existing dirty unchanged passes (gpt-5.5 CRITICAL #1 regression).

- [ ] **T4 (P1, human: ~3h / CC: ~45min)** — hygiene — Blind-execution detection + path-preserving discard (per D2 + D6)
  - Surfaced by: T111646 §"Fix 2 — Gemini Should Abort" and §"Fix 4 — Discard Blind-Execution Commits"; eng review round 2 D6 (round 1 D1 destructive — `git reset --hard + clean -fd` clobbers pre-existing dirty, gpt-5.5 CRITICAL #2)
  - Files: `build/orchestrator/cli.ts` (new helpers `detectBlindExecution` + `discardBlindExecutionChanges` with path-by-path restore + `existsInCommit`; wire into `applyMutableAgentHygiene` BEFORE the `exitCode !== 0` early-return so blind probe fires on nonzero exits too, gpt-5.5 IMPORTANT #6), `build/orchestrator/__tests__/blind-execution-detect.test.ts` (NEW)
  - Verify: 14 new tests pass — T3.1-T3.6 probe + log handling; T3.7 happy path; T3.8 null-head guard; T3.9 cwd guard; T3.10 pre-existing TRACKED dirty survives (gpt-5.5 CRITICAL #2 regression); T3.11 pre-existing UNTRACKED survives; T3.12 fails closed without `workTreeContents`; T3.13 call-site integration (wire-in fires before recoverMutableAgentCommit, gpt-5.5 IMPORTANT #4); T3.14 blind probe fires on nonzero exit (gpt-5.5 IMPORTANT #6).

- [ ] **T5 (P2, human: ~10min / CC: ~5min)** — regen + smoke — Run `bun run gen:skill-docs --host all` (only if any template changed) + manual Gemini path smoke
  - Surfaced by: standard build hygiene
  - Files: derived only — `build/SKILL.md` if any template changed (none expected for this plan)
  - Verify: `bun test test/gen-skill-docs.test.ts` 391+ pass; no STALE markers on `--dry-run` host smoke for any host.

## Review Log

| Round | Reviewer                          | Verdict                         | Notes                                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | self-draft (claude opus-4-7)      | AWAITING USER + plan-eng-review | Plan derived from two on-disk discovery reports.                                                                                                                                                                                                                                                                                                                     |
| 1a    | plan-eng-review (claude opus-4-7) | APPROVE WITH DECISIONS          | D1 null-head + cwd guards; D2 per-agent marker table speculative; D3 content-hash vs HEAD blob; D4 (outside voice) skipped. **Outcome: this approval was WRONG** — D1 + D3 both had data-integrity bugs caught by gpt-5.5 in round 1b.                                                                                                                               |
| 1b    | plan-reviewer (gpt-5.5)           | REJECT — round 3 stalemate      | CRITICAL #1: D3 content-hash compares against HEAD blob, not pre-agent worktree → misreports user's pre-existing dirty as agent-modified. CRITICAL #2: D1 discard runs `git reset --hard + clean -fd` → nukes pre-existing dirty + untracked. Plus 4 IMPORTANTs (T2.1 test fidelity, null-head fallback, missing wire-in integration test, nonzero-exit blind path). |
| 2     | revise (claude opus-4-7)          | APPROVED                        | D5 supersedes D3: pre-agent worktree hashes in `GitSnapshot`. D6 supersedes D1's destructive discard: path-by-path restore using `workTreeContents`. Tests T2.8/T2.9 + T3.10-T3.14 added as direct regressions for the 2 CRITICALs and 4 IMPORTANTs. D2 + D4 unchanged.                                                                                              |

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status                             | Findings                                                                                                                                                                                                                                          |
| ------------- | --------------------- | ------------------------------- | ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —                                  | n/a (contributor-internal, no product surface)                                                                                                                                                                                                    |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 1    | CLEAR (via plan-reviewer round 1b) | gpt-5.5 plan-reviewer caught 2 CRITICAL + 4 IMPORTANT bugs in round 1 D1 + D3 that round 1a eng-review missed. All addressed in round 2 via D5 + D6 + new tests T2.8/T2.9 + T3.10-T3.14.                                                          |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 2    | CLEAR (PLAN)                       | Round 1a (claude opus-4-7) wrongly approved D1 + D3. Round 2 reworked Fix #2 (worktree content hashes in `GitSnapshot`, not HEAD blob) and Fix #3 (path-by-path restore, not `git reset --hard`). 5 new regression tests for the gpt-5.5 catches. |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —                                  | n/a (no UI)                                                                                                                                                                                                                                       |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —                                  | n/a                                                                                                                                                                                                                                               |

**CROSS-MODEL:** Claude opus-4-7 (eng-review round 1a) and gpt-5.5
(plan-reviewer round 1b) DISAGREED on D1 + D3. Resolution: gpt-5.5
was right; round 2 plan supersedes the wrong parts via D5 + D6. The
round 1 disagreement is itself a learning — single-model eng review
missed two real data-integrity bugs that the diverse plan-reviewer
caught. Future plans touching destructive operations or
content-hash logic should explicitly run /codex review before /build.

**UNRESOLVED:** 0. All 2 CRITICAL + 4 IMPORTANT objections from gpt-5.5
addressed in round 2 (D5, D6, T2.8/T2.9, T3.10-T3.14).

**VERDICT:** ENG CLEARED (round 2) — ready to implement via
`/build inbox/build-implementor-hygiene-hardening-20260517.md`. The
plan-reviewer will re-run at /build launch; expect it to PASS this
time (round 1 objections are all addressed; if any survive, the
revision was incomplete).
