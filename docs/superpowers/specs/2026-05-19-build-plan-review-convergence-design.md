# Build plan-review convergence loop

**Date:** 2026-05-19
**Author:** Anbang (via Claude brainstorm)
**Status:** Design — ready for implementation plan
**Triggering pain:** Bundle-1 of a crypto build took 4 rounds of planSynthesizer ↔ planReviewer disagreement before convergence (trajectory `5 → 3 → 2 → manual round 4`). Codex caught 3 real bugs (EIP-712 digest, clerk DID invariant collision, message_log payload split) before any code was written. The rigor paid for itself, but the user was locked out of the loop until the hard 3-round cap fired and the SKILL.md.tmpl Step 5.5 stalemate prompt appeared. The loop works; the UX traps the operator outside the critical decisions.

---

## Problem

The `/build` skill's plan-review machinery has two failure modes that compound:

1. **User locked out until round 3.** The planReviewer ([build/orchestrator/plan-reviewer.ts](../../../build/orchestrator/plan-reviewer.ts)) runs at startup before Phase 1 of Feature 1. On `REVISE` / `CRITICAL`, it writes a report, exits code 3, and [build/SKILL.md.tmpl Step 5.5](../../../build/SKILL.md.tmpl) re-invokes the synthesizer with a targeted revision prompt, then re-launches `gstack-build`. The user is asked nothing until round 3 hits the hard cap, at which point an AskUserQuestion offers override / accept / manual. Rounds 1 and 2 are autonomous — the user can't say "this objection is a false positive, skip it" until the loop has already burned ~$5-10 of API spend.

2. **Each round is expensive end-to-end.** Re-launching `gstack-build` between rounds re-parses the manifest, re-resolves run identity, re-reads plan and target repos, before the planReviewer subagent call. The reviewer call itself is ~$1-2 (large plan + Codex high reasoning). The synthesizer's revision call is comparable. Re-launch overhead is non-trivial because every round is a fresh CLI invocation.

The triggering bundle-1 case showed the system has real value (Codex caught 3 production bugs that would have cost hours of downstream debugging) but the journey to that value cost ~$5-10 and the user had to manually take over at round 4. With the current 3-round cap, every multi-round build hits the same shape: autonomous loop until cap, then user steps in cold.

The structural cause is three properties of the current loop:

1. **No mid-loop user gate.** The only AskUser is at round 3 stalemate. Rounds 1 and 2 are blind to the operator's judgment.
2. **No cross-round memory for subagents.** Each round's planReviewer is invoked fresh with no signal that "the user already rejected this in round 1" or "the synth tried to address this in round 2." The reviewer can re-raise concerns the user has already considered, and the synth can re-implement work the reviewer already approved.
3. **Hard cap is binary.** Three rounds and out, regardless of trajectory. A build that's converging cleanly (`5 → 3 → 2`) hits the same wall as one that's stuck (`5 → 5 → 5`). The first deserves more rounds; the second deserves fewer.

This design replaces the loop with one that: (a) brings the user in after round 1, (b) makes annotations on the plan file the cross-round memory subagents read, and (c) lets the cap adapt to whether the loop is actually converging.

---

## Goal & non-goals

**Goal:** when a `/build` invocation hits CRITICAL objections, the user participates in the loop's decisions starting at round 1, the subagents read cross-round history from the plan file itself, and the loop terminates earlier on stalls and later on clean convergence than the current fixed 3-round cap.

**Success looks like:** a bundle-1-shaped build (5 → 3 → 2 → 0) completes in ~the same wall-clock and cost as today but with the user triaging at each round, plus a clear adaptive bail-out for the 5 → 5 → 5 stall case before round 5.

**Non-goals:**

1. No semantic-dedup LLM judge for "same objection different words." Deterministic `(location, severity)` match-keying is enough — the reviewer already emits structured locations. Revisit only if telemetry shows the reviewer's wording drifts within the same concern.
2. No cross-build memory. Build state is per-build-slug; decisions don't carry across builds. (An earlier sketch of a per-branch `decided.jsonl` was for `/autoplan`, a different loop.)
3. No reviewer model auto-selection (e.g., lighter model on round 2+). The `planReviewer` role-config stays single-model per build.
4. No partial round resumption mid-triage. Ctrl+C re-starts that round's triage from objection 1 on resume; the round's reviewer call is the expensive part and is already cached in `plan-review-report.json`.
5. No UI for browsing `convergence.jsonl`. Tuning is a bash + jq script (`bin/gstack-convergence-stats`), not a dashboard.
6. No changes to IMPORTANT or SUGGESTION severity handling. Both already auto-annotate-and-proceed; that behavior is preserved.

---

## Architecture

The CRITICAL → re-synth cycle becomes an **in-process** while loop inside `gstack-build`'s startup path. Exit code 3 is preserved as the stalemate exit path only — the common case never crosses the process boundary between rounds. Four new mechanisms compose:

```
┌─────────────────────────────────────────────────────────────────────┐
│  gstack-build startup (Feature 1, before Phase 1)                   │
│                                                                     │
│  ┌────────────┐    ┌──────────────┐    ┌──────────────┐             │
│  │ Round N    │ →  │ Triage Gate  │ →  │ Re-synth     │             │
│  │ Reviewer   │    │ (NEW)        │    │ in-process   │  ──┐        │
│  └────────────┘    └──────────────┘    └──────────────┘    │        │
│       ↑                  ↓                    ↓            │        │
│       │            user accepts /        synth subagent    │        │
│       │            rejects each          edits plan file   │        │
│       │            CRITICAL              in place          │        │
│       │                                                    │        │
│       │           ┌──────────────┐    ┌──────────────┐    │        │
│       │           │ Adaptive Cap │ ←  │ Plan File    │    │        │
│       └───────────│ check (NEW)  │    │ Ledger       │ ←──┘        │
│                   └──────────────┘    │ (annotations │             │
│                          ↓            │ extended)    │             │
│                   bail / continue     └──────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
                          ↓
                ~/.gstack/analytics/convergence.jsonl       (cross-build telemetry)
                ~/.gstack/build-state/<slug>/plan-review-history.jsonl  (per-build history)
```

**The four mechanisms:**

1. **In-process round loop.** Replace the current "exit 3 → SKILL.md re-launch" cycle with an in-process while loop in `gstack-build`'s startup. Exit 3 is preserved only as the stalemate / manual-mode exit path. Eliminates per-round re-launch overhead.
2. **Triage Gate (after each round's reviewer).** TTY: readline prompt per CRITICAL objection (accept / reject / defer / view-prose / accept-all / reject-all / stop / quit). Non-TTY: configurable mode (`auto-accept` default, `fail-fast` and `auto-reject` opt-ins).
3. **Plan File as Ledger.** Each round's annotations include user triage decisions and synth resolutions, so the next round's reviewer reads "we already addressed X by doing Y, user rejected Z because W" directly from the plan file it's already reading.
4. **Adaptive Cap.** Hard cap moves from 3 → 5 rounds. Bail-out fires earlier if a round shows no new signal AND at least one re-raise of a previously accepted-and-resolved objection (set-aware, not raw count comparison).

**Why in-place wins:** the planSynthesizer is invoked via the configured subagent provider, not via `gstack-build` itself — re-launching gstack-build between rounds re-parses the manifest, re-reads the plan, re-resolves run identity, before reaching the reviewer again. The user's symptom analysis ("re-launch overhead is meaningful") pushes the architecture in-process. The TTY-only triage limitation is a feature for the operator path; CI inherits the existing non-TTY auto-accept contract.

**Module boundaries (no new top-level files):**

| File                                                                                | Change                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [build/orchestrator/plan-reviewer.ts](../../../build/orchestrator/plan-reviewer.ts) | Add `runPlanReviewLoop()` in-process loop, triage gate, history ledger writer, adaptive-cap check, new prompt constants                                                                       |
| [build/orchestrator/cli.ts](../../../build/orchestrator/cli.ts)                     | Call `runPlanReviewLoop()` instead of single-shot `reconcilePlanReview()`; add CLI flags (`--plan-review-max-rounds`, `--plan-review-no-adaptive-cap`, `--plan-review-noninteractive=<mode>`) |
| [build/SKILL.md.tmpl](../../../build/SKILL.md.tmpl) Step 5.5                        | Shrink: most rounds resolve in-CLI now. Stalemate handler stays but covers exit codes 3 / 4 / 130 only. Synthesizer revision prompt moves to a TS constant.                                   |
| `~/.gstack/build-state/<slug>/plan-review-history.jsonl`                            | NEW append-only file, per build state                                                                                                                                                         |
| `~/.gstack/analytics/convergence.jsonl`                                             | NEW append-only file, per build (aggregate)                                                                                                                                                   |

**Backwards compatibility:**

- `--no-plan-review` flag continues to skip the entire loop.
- Existing `plan-review-report.json` schema gets new optional fields (`triage_decisions`, `round_history_path`, `convergence`); old reports still parse.
- Exit code 3 still means stalemate; SKILL.md.tmpl Step 5.5 stalemate handler still fires for it.
- IMPORTANT and SUGGESTION severity handling is unchanged.
- Existing `--plan-review-max-rounds=3` flag (new) restores the old hard cap if needed.

---

## Data structures

### Extended `plan-review-report.json`

Additive fields on the existing `PlanReviewVerdict` shape. No breaking change.

```jsonc
{
  // ── existing fields ──
  "verdict": "REVISE",
  "reviewedBy": "codex/gpt-5.5/high",
  "round": 2,
  "assessment": "Plan now addresses EIP-712 digest but still missing message_log split.",
  "objections": [
    {
      "severity": "CRITICAL",
      "location": "Feature 3, Phase 2",
      "issue": "message_log payload split is unspecified",
      "suggestion": "Add a dedicated phase for log-payload schema with explicit field boundaries",
    },
  ],

  // ── NEW: user triage decisions for THIS round's objections ──
  "triage_decisions": [
    {
      "objection_index": 0,
      "decision": "accept", // accept | reject | defer
      "rationale": "agreed, real bug", // optional
    },
  ],

  // ── NEW: pointer to append-only history ──
  "round_history_path": "~/.gstack/build-state/<slug>/plan-review-history.jsonl",

  // ── NEW: convergence telemetry snapshot for this round ──
  "convergence": {
    "objection_count_raw": 3, // before triage
    "objection_count_accepted": 1, // after triage
    "prior_round_accepted": 3, // null on round 1
    "delta": -2, // accepted(k) - accepted(k-1); null on round 1
    "re_raises": 0, // count of objections matching a prior round's accepted-and-resolved
    "new_objections": 1, // objections with no prior-round match
    "no_forward_progress": false, // see adaptive-cap rule
  },
}
```

### NEW `plan-review-history.jsonl` (append-only)

One line per round, at `~/.gstack/build-state/<slug>/plan-review-history.jsonl`. The current round's `plan-review-report.json` is the full version of the most recent line.

```jsonl
{"round":1,"ts":"...","reviewedBy":"codex/gpt-5.5/high","verdict":"REVISE","objection_count_raw":5,"critical":5,"important":0,"suggestion":0,"triage":{"accepted":[0,2,4],"rejected":[1,3],"deferred":[]},"convergence":{"delta":null,"no_forward_progress":false,"re_raises":0,"new_objections":5}}
{"round":2,"ts":"...","reviewedBy":"codex/gpt-5.5/high","verdict":"REVISE","objection_count_raw":3,"critical":3,"important":0,"suggestion":0,"triage":{"accepted":[0],"rejected":[1,2],"deferred":[]},"convergence":{"delta":-2,"no_forward_progress":false,"re_raises":0,"new_objections":3}}
{"round":3,"ts":"...","reviewedBy":"codex/gpt-5.5/high","verdict":"REVISE","objection_count_raw":2,"critical":2,"important":0,"suggestion":0,"triage":{"accepted":[0,1],"rejected":[],"deferred":[]},"convergence":{"delta":-1,"no_forward_progress":false,"re_raises":0,"new_objections":2}}
{"round":4,"ts":"...","reviewedBy":"codex/gpt-5.5/high","verdict":"APPROVE","objection_count_raw":0,"critical":0,"important":0,"suggestion":0,"triage":null,"convergence":{"delta":-2,"no_forward_progress":false}}
```

Append-only is crash-safe, tail-able, parseable by `jq`, and mirrors the existing `spec-review.jsonl` pattern. Bundle-1's actual trajectory would be those four lines.

**Lifecycle:** lives with build state, deleted when state slug cleans up. Syncs via the existing gbrain artifacts pipeline if `artifacts_sync_mode` is on.

### Extended in-plan annotations

The plan file already carries an annotation header ([plan-reviewer.ts:160-186](../../../build/orchestrator/plan-reviewer.ts#L160)). Extended with two new block kinds.

**Round history block** at top of plan (replaces current single-round annotation):

```markdown
<!-- gstack-plan-review-history
round 1 (2026-05-19T12:01:33Z): codex/gpt-5.5/high → REVISE — 5 CRITICAL (3 accepted, 2 rejected)
round 2 (2026-05-19T12:08:47Z): codex/gpt-5.5/high → REVISE — 3 CRITICAL (1 accepted, 2 rejected as re-raises)
round 3 (2026-05-19T12:14:02Z): codex/gpt-5.5/high → REVISE — 2 CRITICAL (2 accepted)
round 4 (2026-05-19T12:19:55Z): codex/gpt-5.5/high → APPROVE
final: APPROVED after 4 rounds, 5→3→2→0 trajectory, 5 of 10 objections accepted
-->
```

**Per-objection decision block** above each `### Phase N` heading:

```markdown
### Phase 2: Implementation

<!-- ROUND 1 CRITICAL [Feature 3, Phase 2]: EIP-712 digest doesn't include chainId → add chainId to digest struct
     ROUND 1 USER: accept ("agreed, real bug")
     ROUND 2 RESOLUTION: synth added chainId field per Codex suggestion
     ROUND 2 REVIEWER: not re-raised (resolved) -->
<!-- ROUND 1 CRITICAL [Feature 3, Phase 2]: message_log payload split unclear → specify field boundaries
     ROUND 1 USER: reject ("synthesizer's first attempt was correct, reviewer misread")
     ROUND 2 REVIEWER: re-raised
     ROUND 2 USER: reject ("same misread, see round 1 rationale")
     ROUND 3 REVIEWER: not re-raised (reviewer accepted user's prior rejection) -->
```

**Why the format:**

- Next round's reviewer reads the plan and sees decision history for free; no separate file lookup.
- Format is line-anchored; `applyInlineAnnotations` regex extends straightforwardly.
- `RESOLUTION:` line is written by the synth when it acts on an accepted objection — paper trail for the next reviewer.
- `REVIEWER: not re-raised` / `re-raised` is written by the parser when checking round N+1's objections against round N's accepted set.

**Round-vs-round match key:** an objection from round N+1 matches a round-N objection if `location == location` AND `severity == severity`. No semantic dedup, no extra API call. Deterministic and cheap.

### NEW `~/.gstack/analytics/convergence.jsonl`

One line per _build_ (aggregated, not per round). Written when the loop exits.

```jsonc
{
  "ts": "2026-05-19T12:19:55Z",
  "slug": "<state-slug>",
  "branch": "feat/bundle-1-crypto",
  "rounds": 4,
  "final_verdict": "APPROVE", // APPROVE | STALEMATE | ABORTED | INTERRUPTED
  "exit_reason": "approved", // approved | adaptive_cap_no_forward_progress | adaptive_cap_re_raises_only | max_rounds_hit | user_manual | user_abort | sigint | reviewer_unavailable
  "trajectory_raw": [5, 3, 3, 0], // raw CRITICAL count per round (pre-triage)
  "trajectory_accepted": [3, 3, 2, 0], // accepted CRITICAL per round (post-triage)
  "re_raises": [0, 0, 1, 0], // accepted-objection re-raises per round
  "re_rejected": [0, 0, 1, 0], // re-raised objections the user rejected again
  "disputed_resolutions": [0, 0, 0, 0], // synth marked accepted objection as disputed
  "total_accepted": 8,
  "total_rejected": 4,
  "total_deferred": 0,
  "reviewer": "codex/gpt-5.5/high",
  "synthesizer": "<role-config value>",
  "wall_time_s": 1102,
  "reviewer_wall_time_s": 487,
  "synth_wall_time_s": 542,
  "plan_file_size_bytes": [4821, 5103, 5410, 5398],
  "interrupted": false,
  "annotation_parse_errors": 0,
}
```

**Why aggregated, not per-round:** per-round is in `plan-review-history.jsonl` (per-build-state). This file is for "across all my builds, how is convergence trending" — tuning data over weeks. Local-only by default; syncs if user has artifacts sync on.

---

## Triage Gate UX

Runs after each round's reviewer call, only when there are ≥1 CRITICAL objections, before re-synth is invoked. No CRITICALs → skip triage entirely; loop continues to the next decision point. IMPORTANT and SUGGESTION handling is unchanged from current code.

### TTY flow

Triggered when `process.stdin.isTTY === true` and there are ≥1 CRITICAL objections.

```
═══════════════════════════════════════════════════════════════════════
[plan-review] Round 1 — codex/gpt-5.5/high — 5 CRITICAL objection(s)

Trajectory so far: 5  (this is round 1)
History: ~/.gstack/build-state/<slug>/plan-review-history.jsonl
═══════════════════════════════════════════════════════════════════════

Objection 1 of 5 — CRITICAL
  Location:    Feature 1, Phase 2
  Issue:       EIP-712 digest doesn't include chainId in TypedData struct
  Suggestion:  Add chainId to the digest fields; the EIP requires it for
               cross-chain replay protection

  [a]ccept this fix
  [r]eject (false positive, plan is correct as written)
  [d]efer (real concern but won't address this round — note in plan)
  [v]iew prose (show reviewer's full Overall Assessment for context)
  [A]ccept ALL remaining
  [R]eject ALL remaining
  [s]top triage (treat remaining as accept, default)
  [q]uit (exit loop, save state, you handle manually)

  Decision (a/r/d/v/A/R/s/q): a
  Rationale (optional, one line): agreed, EIP-712 spec is explicit

[... continues for remaining objections ...]

═══════════════════════════════════════════════════════════════════════
[plan-review] Round 1 triage complete.
  Accepted: 3 (re-synth will address)
  Rejected: 2 (annotated as rejected; next round shouldn't re-raise)
  Deferred: 0

Proceeding to round 2 re-synthesis...
═══════════════════════════════════════════════════════════════════════
```

**Key design choices:**

- **Per-objection prompt, not batch.** Bundle-1 had 5 CRITICALs. Per-objection lets the operator triage with context in front of them. `[A]ccept ALL` / `[R]eject ALL` are escapes for "I trust this round."
- **`[v]iew prose`** pulls the reviewer's `## Overall Assessment` on demand. Keeps the default prompt tight while giving access to nuance when needed.
- **`[d]efer` is distinct from reject.** Reject = "reviewer is wrong." Defer = "reviewer is right, but not this build." Defer gets annotated as `<!-- ROUND N DEFERRED -->`, surfaces in convergence.jsonl as accumulated technical debt.
- **`[q]uit` vs `[s]top`.** `[s]top` accepts remaining objections and continues the round. `[q]uit` hard-exits to manual mode (exit code 4). Two intentions, two keys.
- **Optional rationale capture.** Single line, written into plan annotation and `triage_decisions[].rationale`. Empty rationale recorded as empty string. Most useful weeks later when revisiting a build.

**Re-raise framing.** Round N reviewer raising an objection that's annotated as rejected in round N-1 is detected before the user is prompted. The triage gate surfaces it specially:

```
Objection 3 of 5 — CRITICAL (RE-RAISED from round 1)
  Location:    Feature 3, Phase 2
  Issue:       message_log payload split unclear
  Prior round: round 1, user rejected with rationale:
               "synthesizer's first attempt was correct, reviewer misread"
  Reviewer's new framing: "...same concern, with additional context..."

  Decision (a/r/d/v/A/R/s/q):
```

If the user rejects again, the annotation captures the repeat and convergence.jsonl `re_rejected` counter increments.

### Non-TTY flow

Triggered when `process.stdin.isTTY === false` OR `--plan-review-noninteractive=<mode>` is set.

| Mode                                                         | Round 1 behavior                                      | Round 2+ behavior                          |
| ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------ |
| `auto-accept` (default — matches existing IMPORTANT pattern) | Accept all CRITICAL → re-synth                        | Accept all CRITICAL → re-synth (until cap) |
| `fail-fast`                                                  | Exit code 3 immediately on first round with CRITICAL  | n/a                                        |
| `auto-reject` (escape hatch)                                 | Reject all CRITICAL → annotate, proceed to next round | Reject all CRITICAL → proceed              |

CLI flag: `--plan-review-noninteractive=<mode>` (default: `auto-accept`).

### Interrupt handling (Ctrl+C mid-triage)

If SIGINT during readline prompt:

1. Persist whatever triage decisions are complete to `plan-review-report.json` with `interrupted_at_objection: N`.
2. Append a partial line to `plan-review-history.jsonl` with `verdict: "INTERRUPTED"`.
3. Exit code 130 (SIGINT canonical).
4. On `gstack-build resume` with the same state slug, restart triage for the partial round from objection 1. The reviewer call result is still in the report file, so only the triage replays — not the expensive reviewer call.

### Edge cases

- **Reviewer returns CRITICAL with malformed location** (e.g., `[unknown]`): triage prompt still shows it; annotation falls back to plan-file-header insertion if `### Phase N` regex doesn't match.
- **Same objection, two rounds, different wording, same location**: deterministic `(location, severity)` match-key catches it. The round-N+1 reviewer sees the round-N annotation; user rejecting it twice surfaces in `re_rejected` telemetry.
- **Reviewer call fails (transport error, timeout)**: existing `isLikelyCodexTransportFailure` path triggers — synthetic APPROVE, loop exits, triage gate skipped.

---

## Adaptive cap + stalemate exit

### Cap parameters

| Parameter            | Value                           | Rationale                                                                                    |
| -------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `MAX_ROUNDS`         | 5 (was 3)                       | Doubles the upper bound for clean convergence; adaptive bail keeps worst-case stalls bounded |
| Adaptive-cap trigger | Set-aware re-raise rule (below) | Strict no-forward-progress with regression detection                                         |

### Adaptive-cap decision table

After each round's reviewer + triage gate, the loop picks one branch:

| Round verdict | Round k state                                                                              | Round number   | Action                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| APPROVE       | 0 accepted CRITICAL                                                                        | any            | **Exit loop: APPROVE.** Write convergence.jsonl with `exit_reason: approved`. Proceed to Phase 1 of Feature 1. |
| REVISE        | ≥1 accepted                                                                                | k = 1          | **Continue to re-synth.** Always allow round 2 (no prior round to compare).                                    |
| REVISE        | ≥1 accepted, accepted count strictly decreased from k-1, OR all round-k objections are new | k ≤ MAX_ROUNDS | **Continue to re-synth.** Forward progress.                                                                    |
| REVISE        | ≥1 accepted, AND ≥1 re-raise of a round-(k-1) accepted objection, AND zero new objections  | k < MAX_ROUNDS | **Bail-out gate.** Adaptive cap fires. AskUser with 4 options.                                                 |
| REVISE        | ≥1 accepted, count increased from k-1 (regression)                                         | k < MAX_ROUNDS | **Bail-out gate.** Either reviewer is noisier or new bugs exposed; user decides.                               |
| REVISE        | ≥1 accepted, any state                                                                     | k = MAX_ROUNDS | **Stalemate gate.** Force AskUser with 3 options.                                                              |

**The set-aware rule (from end-to-end walkthrough refinement).** A round k+1 where all objections are NEW (no overlap with round k's accepted set) is forward progress in a different dimension, not a stall. A round k+1 where ≥1 objection re-raises an accepted-and-resolved round-k objection AND no new objections appear is the real stall — the synth isn't getting the fixes done. The latter triggers bail; the former does not.

### Bail-out gate (no forward progress, rounds remain)

```
═══════════════════════════════════════════════════════════════════════
[plan-review] Convergence stalled at round k.

Trajectory: [N(1), N(2), ..., N(k)]    e.g.  [5, 3, 3]
Round k accepted CRITICAL: N(k)         e.g.  3
Round k-1 accepted CRITICAL: N(k-1)     e.g.  3
Re-raises: 3 (all of round k are re-raises of round k-1)
New objections: 0
Delta: 0 (no forward progress)

[a] Approve as-is — proceed despite remaining objections (annotated in plan)
[c] Continue anyway — try one more round (synth needs another shot)
[m] Manual mode — exit code 3, drop to SKILL.md.tmpl Step 5.5 stalemate flow
[q] Abort — exit code 4, leave plan and state intact for inspection

Decision (a/c/m/q):
```

Non-TTY mapping: `auto-accept` → `[a]`; `fail-fast` → `[m]`; `auto-reject` → `[a]`.

### Stalemate gate (MAX_ROUNDS hit)

```
═══════════════════════════════════════════════════════════════════════
[plan-review] Hard cap reached: 5 rounds completed.

Trajectory: [5, 3, 2, 2, 2]
Final round 5 accepted CRITICAL: 2

[a] Approve as-is — concerns annotated in plan, proceed to implementation
[m] Manual mode — exit code 3, edit plan by hand, re-launch
[q] Abort — exit code 4, leave plan and state intact

Decision (a/m/q):
```

Same non-TTY mapping.

### Exit code contract

| Code | Meaning                                                       | SKILL.md.tmpl Step 5.5 action                                                                  |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 0    | Plan approved (clean or auto-accepted IMPORTANT)              | Proceed to Phase 1 of Feature 1 (unchanged)                                                    |
| 1    | Runtime error during planReviewer / planSynthesizer           | Existing error path (unchanged)                                                                |
| 2    | Test failure downstream (not reachable from plan-review loop) | Existing test-fix path (unchanged)                                                             |
| 3    | Stalemate — user picked `[m]`, or non-TTY `fail-fast` mode    | Step 5.5 stalemate handler: read final report, present manual options                          |
| 4    | NEW — user aborted with `[q]`                                 | Step 5.5 abort handler: print state paths and exit; user runs `gstack-build resume` when ready |
| 130  | SIGINT during triage                                          | Step 5.5 interrupt handler: print resume command and exit                                      |

### Trajectory data flow

The adaptive cap reads from `plan-review-history.jsonl`, not just the current round's report. Cross-launch resume needs this — if user Ctrl+Cs after round 2 and resumes, history.jsonl is the source of truth for "what round are we on." Consistent with existing [readPlanReviewRound](../../../build/orchestrator/plan-reviewer.ts#L43) role.

### Tunable knobs

| Flag                                  | Default       | When to use                                                                                                              |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--plan-review-max-rounds=N`          | 5             | Bump to 7 if legit convergence past round 5 (rare). Drop to 3 to restore current behavior.                               |
| `--plan-review-no-adaptive-cap`       | off           | Disable the bail-out trigger. Loop only exits at MAX_ROUNDS or APPROVE. Use during tuning if adaptive cap fires wrongly. |
| `--plan-review-noninteractive=<mode>` | `auto-accept` | CI override. Modes: `auto-accept`, `fail-fast`, `auto-reject`.                                                           |

No config file persistence — these are per-invocation tweaks. If a project consistently needs different defaults, that's signal to revisit the design.

---

## Synthesizer prompt extension + plan-annotation contract

The triage gate, plan annotations, synthesizer, and reviewer form one contract. Three actors, one plan file, deterministic round-trip.

### Synthesizer revision prompt (new version)

Current prompt at [build/SKILL.md.tmpl:876-882](../../../build/SKILL.md.tmpl#L876) is a string in the SKILL template. Move to a TypeScript constant in plan-reviewer.ts so it's testable and versioned with the loop logic.

```
You previously synthesized a living implementation plan. A second-opinion
reviewer raised CRITICAL objections, and the user has triaged them.

Your task: revise the plan to address ONLY the user-accepted objections.
Do NOT address objections the user rejected. Do NOT modify sections without
accepted objections.

The plan file at <path> contains annotation blocks immediately above each
`### Phase N` heading that look like:

  <!-- ROUND <N> CRITICAL [<location>]: <issue> → <suggestion>
       ROUND <N> USER: accept ("<rationale>")
       ROUND <N> RESOLUTION: <YOUR PRIOR WORK or 'pending'> -->

For each annotation with `USER: accept` and `RESOLUTION: pending`:
  1. Apply the suggested fix (or a better fix you can defend).
  2. Replace `RESOLUTION: pending` with `RESOLUTION: <one-line description
     of what you changed and where>`. The reviewer will read this next round.
  3. If you decide the suggestion is wrong even though the user accepted
     it, do NOT make the change. Replace `RESOLUTION: pending` with
     `RESOLUTION: disputed — <one-line reason>`. The user will see this
     in next round's triage.

For each annotation with `USER: reject`:
  Do NOT change the plan around it. Leave the annotation in place.

For each annotation with `USER: defer`:
  Do NOT change the plan, but keep the annotation attached to the right
  phase heading.

Annotation history from prior rounds is informational — read for context
on what was already resolved. Do not re-resolve already-resolved items.

If the plan file's `<!-- gstack-plan-review-history -->` header indicates
this is round 3 or later, you may collapse stale RESOLUTION lines from
rounds 1+ to keep the plan readable, but preserve the annotation header
counts so the reviewer can see the trajectory.

Return only the path of the updated plan and a single-line summary of
what you changed.
```

**The "disputed" escape hatch.** If the synth concludes the user accepted an objection but the synth thinks it's wrong, marking the resolution `disputed` instead of silently complying surfaces the conflict to the next triage gate. Cheap mechanism for model second-guess without adding a separate review step.

### Reviewer prompt extension

Current `PLAN_REVIEW_PROMPT` at [plan-reviewer.ts:395](../../../build/orchestrator/plan-reviewer.ts#L395). New paragraph appended:

```
The plan file may contain annotation blocks (HTML comments) above each
`### Phase N` heading that record prior review rounds. They look like:

  <!-- ROUND 1 CRITICAL [Feature 3, Phase 2]: issue → suggestion
       ROUND 1 USER: accept ("rationale")
       ROUND 1 RESOLUTION: synth added chainId per suggestion
       ROUND 2 REVIEWER: not re-raised -->

Use this history:

1. If a prior round raised an objection and the user REJECTED it
   ("USER: reject"), do NOT re-raise the same objection unless you have
   NEW evidence the plan doesn't address. The user explicitly considered
   and rejected this concern. Repeating it wastes a round.

2. If a prior round raised an objection and the synth's RESOLUTION
   appears to actually address the issue, do not re-raise. Check the
   resolution against the plan text — if the plan reflects the fix, the
   objection is settled.

3. If a prior round's RESOLUTION says "disputed" or doesn't fully address
   the concern, you SHOULD re-raise it. The user will re-triage.

4. New objections (not in any prior round's annotations) follow normal
   severity rules.

Output format unchanged: emit `PLAN_REVIEW: APPROVE` or `REVISE` followed
by objection lines using the same `- <SEVERITY>: [<location>] <issue> →
<suggestion>` format.
```

### Triage gate's plan-annotation writer

After triage completes for a round, the gate writes annotations using an extended version of [applyInlineAnnotations](../../../build/orchestrator/plan-reviewer.ts#L188). Shapes:

**Accepted objection:**

```html
<!-- ROUND 2 CRITICAL [Feature 3, Phase 2]: message_log payload split unclear → specify field boundaries
     ROUND 2 USER: accept ("agreed, real bug")
     ROUND 2 RESOLUTION: pending -->
```

After re-synth finishes, the synth itself rewrites `RESOLUTION: pending` to `RESOLUTION: <description>`. The triage gate doesn't write resolution lines — synth does. Clear ownership.

**Rejected objection:**

```html
<!-- ROUND 2 CRITICAL [Feature 3, Phase 2]: message_log payload split unclear → specify field boundaries
     ROUND 2 USER: reject ("synthesizer's first attempt was correct, reviewer misread") -->
```

No RESOLUTION line because there's nothing to resolve.

**Re-rejected (round N rejects what was rejected in round N-1):**

```html
<!-- ROUND 1 CRITICAL [Feature 3, Phase 2]: message_log payload split unclear → ...
     ROUND 1 USER: reject ("synthesizer's first attempt was correct, reviewer misread")
     ROUND 2 REVIEWER: re-raised
     ROUND 2 USER: reject ("same misread, see round 1 rationale") -->
```

### Plan-history header writer

After each round (regardless of verdict), update the top-of-plan history block. Algorithm:

1. Read current `<!-- gstack-plan-review-history --> ... -->` block (empty if first round).
2. Parse existing round lines.
3. Append new round line: `round N (ts): reviewer → verdict — count CRITICAL (Acc accepted, Rej rejected, Def deferred)`.
4. On final exit (APPROVE / stalemate / abort), append `final: <reason> after N rounds, <trajectory> trajectory, <total_accepted> of <total_objections> objections accepted`.
5. Atomic write via temp file + rename (same pattern as existing report file).

### Annotation parser robustness

| Failure                                                          | Behavior                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synth writes `RESOLUTION: pending` but reviewer re-raises anyway | Treat as new objection. The "didn't apply the fix" signal is captured in re-raise count.                                                                                                                                                                 |
| Synth never writes RESOLUTION (skips the contract)               | Reviewer sees `RESOLUTION: pending` → re-raises → user sees re-raise with prior accept → user re-accepts → loop. After 2 cycles, treat as synth failure: surface in telemetry, prompt user with "synth not addressing accepted objections, manual mode?" |
| Annotation HTML comment malformed                                | Strict regex match in reader; malformed blocks skipped, logged as `annotation_parse_error` in convergence.jsonl. Plan still loads.                                                                                                                       |
| Plan file has annotations from a prior abandoned build           | History header is build-state-scoped, so this is rare. If detected (timestamp older than build state init), prompt user to wipe or proceed.                                                                                                              |

### End-to-end example: bundle-1's trajectory

Walking through 5 → 3 → 2 → 0 under this design:

**Round 1.** Reviewer raises 5 CRITICAL. Triage gate appears. User accepts [EIP-712 chainId, clerk DID, message_log split], rejects [2 reviewer misreads]. Plan annotations written. Synth invoked, addresses 3 accepted objections, writes 3 RESOLUTION lines. History header updated.

**Round 2.** Reviewer reads plan (sees 3 RESOLUTIONs, 2 rejections). Verifies 3 fixes look right. Raises 3 NEW CRITICALs (deeper issues exposed by round-1 fixes — your "Codex caught real bugs" signal). Adaptive cap check: `re_raises = 0`, `new_objections = 3`. **NOT a stall** — forward progress in a different dimension. Continue.

**Round 3.** User accepts 2, rejects 1 as misread. Synth addresses 2. RESOLUTIONs written.

**Round 4.** Reviewer raises 0 CRITICAL → APPROVE. Loop exits clean.

Total: 4 rounds (within MAX=5), no bail-out fired, in-process so no re-launch overhead, ~$5-10 (same as today) but **user participated at rounds 1, 2, 3 instead of only at round 4**. That's the experience win.

---

## Telemetry, error handling, testing

### Telemetry streams

| Stream                      | Location                                                 | Granularity        | Consumer                                           |
| --------------------------- | -------------------------------------------------------- | ------------------ | -------------------------------------------------- |
| Per-round history           | `~/.gstack/build-state/<slug>/plan-review-history.jsonl` | One line per round | Resume logic, post-mortem of a single build        |
| Per-build aggregate         | `~/.gstack/analytics/convergence.jsonl`                  | One line per build | Cross-build trend analysis, tuning                 |
| Per-round report (existing) | `~/.gstack/build-state/<slug>/plan-review-report.json`   | Latest round only  | SKILL.md.tmpl Step 5.5, next round reviewer pickup |

**Tuning script (not in scope to build, mentioned for completeness):** `bin/gstack-convergence-stats` reads `convergence.jsonl` and produces median rounds, APPROVE/STALEMATE/ABORTED rates, median wall time, re-raise rate, disputed-resolution rate. Bash + jq.

### Error handling matrix

| Failure                                                                  | Action                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer subagent times out                                              | Existing: synthetic APPROVE, `reviewedBy: skipped-unavailable`. Loop exits. Triage gate skipped.                                                                                                      |
| Reviewer returns malformed PLAN_REVIEW header                            | Existing: synthetic APPROVE + console warn. Loop exits.                                                                                                                                               |
| Reviewer returns objection with missing `→` separator                    | Existing: console warn, objection silently dropped. Continue with parsed objections.                                                                                                                  |
| Synth subagent times out during re-synth                                 | Loop exits code 1 (runtime error). Plan unchanged. Step 5.5 sees error report.                                                                                                                        |
| Synth produces invalid plan (breaks `^Acceptance:` structural validator) | Loop reports the structural error as a synthetic CRITICAL objection: "synth produced structurally invalid plan." Next round's reviewer sees it. After 2 such cycles, bail-out gate fires.             |
| Synth marks accepted objection as `disputed`                             | Next round's triage gate surfaces specially: "Synth disputed your accept on objection N. Show synth's reason: ..." User can accept synth's view (changes to reject) or hold (changes to accept-firm). |
| User Ctrl+C during triage                                                | SIGINT handler persists partial state, exit code 130. Step 5.5 prints resume command and exits.                                                                                                       |
| User picks `[q]` abort                                                   | Exit code 4. Step 5.5 prints state paths and exits.                                                                                                                                                   |
| plan-review-history.jsonl missing on resume                              | Treat as round 1. Plan file's history header is fallback truth source.                                                                                                                                |
| plan-review-history.jsonl corrupt JSON on a line                         | Skip line, log warning, continue. Compute round count from remaining valid lines + 1.                                                                                                                 |
| Annotation block malformed in plan file                                  | Skip block, log to convergence.jsonl `annotation_parse_errors++`. Don't crash.                                                                                                                        |
| Two consecutive rounds of `disputed` resolutions                         | Surface to user before round k+1: "Synth has disputed your accepts twice. Continue with synth's view or manual mode?"                                                                                 |
| File-write race during atomic write                                      | Catch, log, retry once. If still fails, exit code 1 with error report.                                                                                                                                |

**Principle:** loop never blocks the build silently. Either it converges, the user is prompted, or it exits with a clear code.

### Testing strategy — four layers

**Layer 1: Unit tests (fast, deterministic, no subagents)** — in [build/orchestrator/**tests**/](../../../build/orchestrator/__tests__/):

| Test file                              | Coverage                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `plan-reviewer-loop.test.ts`           | In-process round loop: 1-round APPROVE, 4-round converge, hard-cap stalemate, adaptive-cap bail                               |
| `plan-reviewer-triage-tty.test.ts`     | TTY readline triage gate: each key (a/r/d/v/A/R/s/q) produces correct decision                                                |
| `plan-reviewer-triage-non-tty.test.ts` | Non-TTY: `auto-accept` / `fail-fast` / `auto-reject` correctness                                                              |
| `plan-annotation-round-trip.test.ts`   | Round-trip: triage writes annotation → reviewer prompt's expected format matches → synth's RESOLUTION update parses correctly |
| `plan-review-history-jsonl.test.ts`    | Append-only writes, corrupt-line recovery, round counter derivation                                                           |
| `adaptive-cap-set-aware.test.ts`       | Re-raise detection via `(location, severity)` match; new-objections vs re-raises distinction; bail trigger correctness        |
| `convergence-jsonl.test.ts`            | Aggregate schema correctness, all `exit_reason` values reachable                                                              |

**Layer 2: Integration tests with stub subagents** — also in `__tests__/`, using `runConfiguredRoleTask` mock pattern:

| Test                                | Trajectory simulated                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `loop-approve-round-1.test.ts`      | 1 round, APPROVE, clean exit                                                                                    |
| `loop-converge-bundle-1.test.ts`    | Exact bundle-1 shape: 5 → 3 → 2 → 0. Verifies trajectory recording, annotation history, convergence.jsonl shape |
| `loop-bail-no-progress.test.ts`     | 5 → 5 → bail at round 2. Adaptive cap fires                                                                     |
| `loop-stalemate-max-rounds.test.ts` | 5 → 4 → 3 → 2 → 2 (5 rounds). Stalemate gate at round 5                                                         |
| `loop-synth-disputes.test.ts`       | Synth marks RESOLUTION:disputed. Round 2 triage surfaces it                                                     |
| `loop-resume-after-sigint.test.ts`  | SIGINT round 2 → re-launch → resumes from round 3                                                               |

**Layer 3: Snapshot test on prompts** — `__tests__/plan-review-prompts.test.ts`. Reviewer prompt and synthesizer revision prompt are load-bearing. Snapshot-test the strings so unintended changes are visible. Regeneration is deliberate (`bun test -u`).

**Layer 4: E2E with real subagents** — one new test in `test/skill-e2e-build-convergence.test.ts`. Uses real Codex via `codex exec` against a fixture plan with seeded structural issues. Classified `gate` tier per CLAUDE.md (safety-critical loop behavior). Estimated ~$0.50/run. Gated via `EVALS=1`. Catches the failure class "unit tests pass but real Codex doesn't follow the annotation contract."

### Migration / rollout

No migration script needed:

- Existing `plan-review-report.json` schema is additive; old reports still parse.
- Plans without annotations behave as round 1 (no history to read).
- `--no-plan-review` flag unchanged.

The new behavior is opt-out, not opt-in. Three escape hatches:

1. `--plan-review-max-rounds=3` restores old hard cap.
2. `--plan-review-no-adaptive-cap` disables adaptive bail.
3. `--no-plan-review` skips loop entirely (existing flag).

### Documentation updates

| Doc                                                                   | Update                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [build/SKILL.md.tmpl](../../../build/SKILL.md.tmpl) Step 5.5          | Shrink. Most rounds resolve in-CLI now. Stalemate handler covers exit codes 3/4/130. Synth revision prompt moves out to TS constant. |
| [build/orchestrator/README.md](../../../build/orchestrator/README.md) | New "Plan review convergence loop" section: round lifecycle, exit codes, triage UX                                                   |
| CHANGELOG.md                                                          | Release entry (skill-version frontmatter only per fork rule, NOT top-level VERSION)                                                  |
| build/SKILL.md.tmpl `version:` frontmatter                            | Bump (MINOR — new capability)                                                                                                        |

---

## Open questions for implementation plan

Items to resolve during writing-plans, not during this design:

1. **`runPlanReviewLoop()` exact signature** — does it accept the existing `reconcilePlanReview` arguments plus a config object, or is the config threaded through a separate struct? Decide during plan write.
2. **Where the synth subagent dispatch happens** — currently the SKILL.md.tmpl Step 5.5 invokes synth out-of-process. Moving it in-process means the loop calls `runConfiguredRoleTask` with the planSynthesizer role-config. Need to verify role-config resolution works from inside `gstack-build` startup the same way it does from the SKILL.md prompt.
3. **Test fixture data** for the integration tests — bundle-1's actual objections will need to be turned into stub reviewer responses. Capture from the existing build state if available, or hand-author equivalent shapes.
4. **`bin/gstack-convergence-stats` script** is mentioned but not in scope. Defer to a follow-up if telemetry signal is interesting.

---

## What ships

A single PR on a new branch `feat/plan-review-convergence` off `main`, containing:

- Extended [build/orchestrator/plan-reviewer.ts](../../../build/orchestrator/plan-reviewer.ts) with `runPlanReviewLoop`, triage gate, annotation writers, adaptive-cap logic, prompt constants
- Updated [build/orchestrator/cli.ts](../../../build/orchestrator/cli.ts) call site and new flags
- Shrunk [build/SKILL.md.tmpl](../../../build/SKILL.md.tmpl) Step 5.5
- New [build/orchestrator/README.md](../../../build/orchestrator/README.md) section
- All four test layers
- CHANGELOG entry under skill-version frontmatter bump

Estimated effort: human team ~3-5 days / CC+gstack ~3-4 hours.
