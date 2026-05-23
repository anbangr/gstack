# Spec: Allow `/document-release` to fire inside the build orchestrator's `/ship` step

**Date:** 2026-05-23
**Branch target:** new feat branch (TBD by writing-plans)
**Status:** approved for plan generation
**Surface:** `build/orchestrator/sub-agents.ts` only
**Effort:** human ~2 hours / CC+gstack ~15 min

## Background

`/ship`'s Step 18 dispatches `/document-release` as a fresh-context subagent
via the `Task` (a.k.a. `Agent`) tool. When a human runs `/ship` interactively
inside Claude Code, that tool is available by default and Step 18 works. When
the build orchestrator's `runShip` spawns `/ship` autonomously, the inner
Claude session is launched with no tool allowlist passed at all
(`build/orchestrator/sub-agents.ts:1577-1604`, the `buildClaudeTaskArgv`
helper). The `Task` tool is therefore strict-deny-by-omission inside the
build's ship subagent. Per /ship's Step 18 contract:

> If the subagent fails or returns invalid JSON: Print a warning and proceed
> to Step 19 without a `## Documentation` section. Do not block /ship on
> subagent failure.

Step 18 silently skips. The autonomous build path ships PRs whose CHANGELOG
and surrounding docs were never reconciled against the diff — that's the
observed gap.

## Goal

Make `/ship` Step 18 actually fire when `/ship` is invoked autonomously by
the build orchestrator, so `/document-release` runs against every feature
the build ships.

## Non-goals

- **Don't change `/ship`'s step structure or behavior.** Step 18 stays
  exactly as written, including its soft-fail clause.
- **Don't move `/document-release` into the build orchestrator** (rejected
  Approach C — would weaken interactive `/ship` UX).
- **Don't inline `/document-release` into the long ship session** (rejected
  Approach B — defeats the fresh-context-window property Step 18 was
  designed to give docs).
- **Don't grant any tool beyond the subagent-dispatch tool.** No Bash, no
  WebFetch, no Edit additions to the ship spawn's allowlist.
- **Don't touch other Claude subagent spawns** in the build (`feature-review`,
  `feature-verifier`, primary implementor, etc.). Only the ship role.
- **Don't probe `claude --help` for `--allowedTools` flag existence.** The
  flag has been stable in Claude Code for >12 months; accepting the
  "Claude renamed the flag" risk is cheaper than a startup probe.

## Architecture

The full ship subagent spawn path is:

```
cli.ts (status=shipping)
  └─ shipAndDeploy() in ship.ts
       └─ runShip(opts) in sub-agents.ts:1749
            └─ runSlashCommand({ role: opts.ship, … }) at sub-agents.ts:1782
                 └─ runConfiguredRoleTask(...) — provider switch
                      └─ runClaudeTask(opts) at sub-agents.ts:1709
                           └─ buildClaudeTaskArgv(opts) at sub-agents.ts:1577
                                └─ spawnCaptured({ bin: CLAUDE_BIN, argv, … })
```

`buildClaudeTaskArgv` is the single edit point. It currently returns:

```ts
return [...(opts.model ? ["--model", opts.model] : []), "-p", prompt];
```

After this change it accepts an optional `allowedTools?: readonly string[]`
and emits `--allowedTools` followed by each tool name when present:

```ts
return [
  ...(opts.model ? ["--model", opts.model] : []),
  "-p",
  prompt,
  ...(opts.allowedTools && opts.allowedTools.length > 0
    ? ["--allowedTools", ...opts.allowedTools]
    : []),
];
```

Per `claude --help`, `--allowedTools` accepts a space-or-comma-separated
list of tool names. Space-separated (Node argv array form) is the cleanest
fit for the spawnCaptured path.

The new `allowedTools` parameter is plumbed through the three callers in
the chain, each receiving an optional `allowedTools?: readonly string[]`
field defaulting to undefined:

1. `runClaudeTask(opts)` — accept and forward to `buildClaudeTaskArgv`.
2. `runConfiguredRoleTask(opts)` — accept and forward to `runClaudeTask`,
   but ONLY on the `provider === "claude"` branch. Gemini, Kimi, and
   Codex branches ignore the field; allowlist is a Claude-specific concept.
3. `runSlashCommand(opts)` — accept and forward to `runConfiguredRoleTask`.

The single call site that sets a non-undefined value is `runShip` at
`sub-agents.ts:1782`, the `runSlashCommand({ role: opts.ship, … })` call.
It passes `allowedTools: ["Task", "Agent"]`. The `/land-and-deploy` call
at `sub-agents.ts:1830` does NOT pass the field — `/land-and-deploy` has
no subagent dispatch step.

### Why both `Task` and `Agent`

Claude Code's tool registry today exposes the subagent-dispatch tool as
`Task`. The `/ship` SKILL.md prose still refers to "the Agent tool"
because that's the human-friendly name from older Claude Code versions
and the tool's prompt-side surface (e.g. `subagent_type: "general-purpose"`)
is invoked through what users call "Agent" in docs. The CLI silently
ignores unknown names in the `--allowedTools` list, so listing both:

- **Today:** `Task` matches; `Agent` is ignored. Step 18 works.
- **If Claude Code renames `Task` → `Agent`:** `Agent` matches; `Task` is
  ignored. Step 18 still works.
- **If both names disappear:** both are ignored. Step 18 soft-fails as it
  does today. No regression vs status quo.

One extra string in the allowlist buys version-skew resilience for free.

## Data flow

Concrete argv emitted when the ship role spawns with the new allowlist:

```
claude --model <model> -p <prompt> --allowedTools Task Agent
```

The existing prompt (built inside `buildClaudeTaskArgv`) is unchanged —
same "Read instructions at …, Run /gstack-ship, Write your output to …,
Return ONLY the output file path" structure. The allowlist flag slots at
the END of the argv with no positional collision: `-p` consumes exactly
one positional (the prompt), and `--allowedTools` is named after that.

## Backward compatibility

The `allowedTools` field is optional with default undefined on every
function in the forwarding chain. When undefined, the argv comes out
byte-for-byte identical to today. The 1242-line existing test suite for
`buildClaudeTaskArgv` at `build/orchestrator/__tests__/sub-agents.test.ts:1242`
keeps passing without modification. The change is strictly additive — no
existing caller of `runSlashCommand`, `runConfiguredRoleTask`, or
`runClaudeTask` needs to be touched.

## Soft-fail preservation

`/ship` Step 18's soft-fail contract is preserved verbatim. This change
gives the subagent the _opportunity_ to run; it does not promise success.
Four edge cases:

1. **`--allowedTools` flag removed from a future Claude Code version:**
   spawn would fail with unknown-flag error. We accept this risk; the flag
   has been stable for >12 months. If it ever happens, the fix is to drop
   the flag and revisit Approach B or C.
2. **Subagent runs but `/document-release` errors mid-flight:** /ship
   Step 18 already handles it (warning, proceed to Step 19). Unchanged.
3. **Subagent runs but writes garbage JSON:** /ship Step 18 handles it
   (skip the `## Documentation` section). Unchanged.
4. **`/land-and-deploy` doesn't need any subagent:** the land call
   explicitly does NOT get `allowedTools`. Minimum exposure.

## Permission mode interaction

`--allowedTools` is allowlist, not auto-approve. The inner subagent
dispatched by Step 18 still inherits the parent ship session's permission
posture (Edit / Accept / YOLO). This change does NOT loosen security — it
unblocks a tool that was strict-deny-by-omission. The `Task` tool itself,
once allowlisted, prompts for user confirmation per the parent's mode.

## Tests

Six free unit tests, all in `build/orchestrator/__tests__/sub-agents.test.ts`.
No new helpers, fixtures, or E2E.

In the existing `describe("buildClaudeTaskArgv (claude role invocation shape)")`
block at line 1242:

1. **`emits no --allowedTools flag when allowedTools is omitted`** — assert
   the returned argv does NOT include the string `--allowedTools`. Pins the
   backward-compat invariant for all existing callers.

2. **`emits --allowedTools followed by each tool name when allowedTools is non-empty`** —
   pass `["Task", "Agent"]`; assert argv contains `--allowedTools`,
   `Task`, `Agent` in that order, adjacent.

3. **`omits --allowedTools when allowedTools is the empty array`** — guards
   against a future bug where an empty array slips through and emits a
   dangling flag with no values. Empty array equivalent to undefined.

4. **`preserves --allowedTools position after -p prompt`** — assert
   `--allowedTools` appears AFTER the `-p <prompt>` pair, not before, so
   the prompt isn't extended by allowlist names. Lock the ordering.

In a new `describe("runShip allowlist propagation")` block at end of file:

5. **`runShip passes allowedTools to the ship runSlashCommand call but not to land-and-deploy`** —
   mock `runClaudeTask` (the boundary where the new field becomes argv),
   invoke `runShip`, assert the first call's opts include
   `allowedTools: ["Task", "Agent"]` and the second call's opts do NOT.
   Pins the scoping invariant by exercising the full forwarding chain
   from `runShip` → `runSlashCommand` → `runConfiguredRoleTask` →
   `runClaudeTask`.

Static-grep invariant test (cheap, blocks accidental removal):

6. **`runShip allowlists the Task subagent tool by literal name`** — read
   `build/orchestrator/sub-agents.ts` as a string; assert it contains the
   substring `allowedTools: ["Task", "Agent"]` AND that this substring
   appears within the `runShip` function body. Catches the future PR that
   "cleans up" the allowlist and silently breaks docs again.

## Manual verification (post-merge, not a checked-in test)

In a throwaway worktree, run `gstack-build` against a tiny single-feature
plan. Observe whether `/ship`'s output line for Step 18 reports
`Documentation synced: N files updated, committed as <sha>` or
`Documentation is current — no updates needed.` instead of the silent skip.
Either of the two reports proves the subagent ran. The silent skip means
the spawn or the allowlist is still wrong.

## What we deliberately don't test

- Don't probe `claude --help` for flag existence. Per the "Soft-fail
  preservation" section's edge case 1, we accept the "Claude renamed the
  flag" risk for now.
- Don't test that `/document-release` produces correct doc output — that's
  `/document-release`'s own test surface, not the orchestrator's.
- Don't add a paid E2E test. Free unit tests + manual smoke cover it.

## Files touched

- `build/orchestrator/sub-agents.ts` — three function signatures extended
  with optional `allowedTools?: readonly string[]`; argv builder emits the
  flag; `runShip` sets `["Task", "Agent"]` on the ship call only.
- `build/orchestrator/__tests__/sub-agents.test.ts` — six new free tests.

## Rejected alternatives (kept for design record)

- **Approach B — inline /document-release into /ship's main session.**
  Rejected: defeats the fresh-context property; /ship's session is
  context-bloated after 17 steps and doc quality drops.
- **Approach C — move /document-release into the build orchestrator,
  strip Step 18 from /ship.** Rejected: breaks interactive `/ship` UX
  for all users who aren't running through the build, OR requires
  conditional Step 18 logic with an env-var coordination flag (added
  complexity for no gain).
- **Make `allowedTools` configurable via `configure.cm` per role.**
  Rejected as YAGNI: nobody needs per-role tool tuning today, and adding
  a config surface invites bikeshedding without changing the outcome.
  Can be added later if a second use case appears.

## Open questions

None as of approval. All raised in brainstorming were resolved:

- Tool name "Task" vs "Agent" → list both.
- Scope only ship role vs all Claude spawns → ship role only.
- Probe `claude --help` → no.
- Soft-fail vs hard-fail → preserve /ship's existing soft-fail contract.
- Test breadth → six free unit tests, no paid E2E.
