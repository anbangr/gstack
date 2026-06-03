# `build-robustness` — long-running-task robustness gate

A deterministic pre-release suite that simulates a _long autonomous build_ (many
ticks, repeated stalls, multi-hour wall-clock, hard kills) in milliseconds by
faking time, spawn, and disk. It pins the **recovery** invariants that only break
on long runs and that the rest of `build/orchestrator/__tests__/` never exercises
(those tests assert single-tick / single-pass / fast-disk happy paths).

Full rationale, the verified audit, and the ranked failure-mode table:
`docs/designs/BUILD_ROBUSTNESS_SUITE.md`.

## Run it

```bash
bun run test:build-robustness        # this suite only (~2-3s)
bun test build/orchestrator/__tests__  # full build-skill gate (includes this dir)
```

No API key, no network, no real long-lived process. The `integration` specs spawn
a real short-lived `/bin/sh`/`/bin/sleep` (bounded-wait, under ~10s combined).

## PIN vs RED protocol

Every spec is tagged in its `describe` title:

- **`[PIN]`** — pins behavior that is _already correct_. Runs live. Catches a
  regression that would break a recovery invariant we currently satisfy.
- **`[RED]`** — pins the _desired_ invariant against code that does **not yet
  satisfy it** (a confirmed gap from the audit). Committed as `describe.skip`
  with an `UNSKIP WHEN <id> IS FIXED` banner so the gate stays green today. The
  fix PR removes `.skip` and the spec goes green — that's the definition of done
  for the gap.

A `[RED]` file must still **load cleanly**: import only symbols that exist today,
put all setup inside `beforeEach`/`it` bodies (never throwing top-level code), and
drive the desired behavior through existing entry points. The skipped body is what
fails pre-fix, not the import.

### Unskip checklist (when fixing a gap in phase B)

1. Implement the minimal production fix.
2. Remove `.skip` from that spec's `describe`/`it`.
3. `bun run test:build-robustness` is green.
4. The fix and the unskip land in the same commit.

## Shared fakes

`./helpers.ts` exports `makeFakeClock()`, `makeFakeChild()`, `mkTmp()`,
`writeExecutable()`, and `counterScript()`. Reuse them; do not re-roll fakes per
file.

## Naming

`<group><n>-<slug>.robustness.test.ts`, e.g. `A1-provider-capacity-retry-wired.robustness.test.ts`.
Groups: A provider, B stall/monitor, C process/shutdown, D release queue/locks,
E git/quarantine/worktree, F halt/drain, G phase runner, H medium hygiene.
