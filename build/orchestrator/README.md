# gstack-build — code-driven phase orchestrator

Standalone CLI that drives a feature-block implementation plan to completion. Replaces the LLM-orchestrated loop in the `/build` skill for long, multi-week plans where context compaction or "Standing by, let me know what's next" stalls become a problem.

## When to use `/build` vs direct CLI

Use the **`/build` skill** for normal execution. It locates the source plan,
synthesizes living plans, writes a manifest, confirms with the user, launches
private worktrees, and runs the foreground monitor.

Use the **`gstack-build` CLI directly** for recovery, smoke tests, dry runs,
manual merge cleanup, or when you already have the exact living plan and
`--project-root` path. The CLI delegates each per-phase task to fresh Claude,
Gemini, Kimi, or Codex subprocesses, so the LLM brain still does the work; it
just does not drive the durable loop.

## Install

`gstack-build` is a bash wrapper at `bin/gstack-build` that invokes `build/orchestrator/cli.ts` via `bun`. It's installed automatically when you run gstack's setup. To verify:

```bash
which gstack-build
gstack-build --help
```

Manual CLI usage still expects `gstack-build` on `PATH`. Add your host's install
bin directory to `PATH`, for example `~/.claude/skills/gstack/bin` for Claude or
`~/.codex/skills/gstack/bin` for Codex, or symlink the binary to `~/.local/bin`.

When launched by the `/build` skill, the skill resolves the executable before
starting the background process. Resolution order is:

1. `GSTACK_BUILD_CLI=/absolute/path/to/gstack-build`
2. `command -v gstack-build`
3. host-specific global and repo-local setup paths
4. the current checkout's `bin/gstack-build`

If none is executable, rerun `./setup --host <claude|codex>` from the gstack repo
or set `GSTACK_BUILD_CLI` explicitly.

## Usage

```bash
gstack-build <plan-file> [flags]
gstack-build plan-status --gstack-repo <path> [--project-root <path>] [--json]
```

When the plan lives in a workspace-level `*-gstack/inbox/living-plan/` or
`*-gstack/inbox/` repo, pass `--project-root <child-repo>` so commits, pushes,
tests, and sub-agents run from the child repo, not the workspace root. Opening a
workspace root that is itself a root repo is supported by `/build`; that root
repo is ignored by default and treated as orchestration-only. Direct CLI
execution against the root repo requires `--allow-workspace-root`. Single
product repo invocation remains supported by passing that product repo as
`--project-root`.

For source plans that touch multiple child repos, `/build` writes one living plan
per target repo and launches manifest runs in private git worktrees. The
foreground monitor tracks every run, resumes stale dead runs when identity is
proven, and preserves failed worktrees for debugging.
Completed living plans are moved to the sibling `archived/` directory after a
successful non-dry-run build. Pass `--origin-plan <file>` when the living plan
was synthesized from a separate source plan in `*-gstack/inbox/`; after the final
completion exam passes, that origin plan is archived too.

Use `gstack-build plan-status` to inspect what `/build` would select before it
claims anything. The human table is for ambiguity/debugging; `--json` is the
machine contract consumed by the `/build` skill.

The plan file is organized into semantic feature blocks. The `/build` skill
should reorganize all origin-plan weeks, milestones, blocks, and phases into
feature groups before handing the living plan to this CLI:

```markdown
## Feature 1: Authentication

Origin trace: Week 1 / Phase 2, Week 2 / Phase 1
Acceptance: Login, logout, and session expiry satisfy the source plan.

### Phase 1.1: Auth tests

- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests that cover...
- [ ] **Implementation (Gemini Sub-agent)**: Make all failing tests pass; the CLI runs the Green tests gate afterward...
- [ ] **Review & QA (review roles)**: Run /review, optional secondary review if configured, and /qa...
```

Legacy phase-only plans still run as a single feature named `Full plan`.

Each phase supports two formats:

**TDD format (required default for newly synthesized plans)** — 3 durable
checkboxes per phase. The CLI-owned runtime gates between those checkboxes are
Verify Red and Green tests, so the full lifecycle is Test Specification ->
Verify Red -> Implementation -> Green tests -> Review/QA.

```markdown
### Phase 1: Skeleton + parser

- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests that cover...
- [ ] **Implementation (Gemini Sub-agent)**: Make all failing tests pass; the CLI runs the Green tests gate afterward...
- [ ] **Review & QA (review roles)**: Run /review, optional secondary review if configured, and /qa...
```

**Legacy format (still supported)** — 2 checkboxes per phase:

```markdown
### Phase 1: Skeleton + parser

- [ ] **Implementation (Gemini Sub-agent)**: Write parser.ts with...
- [ ] **Review & QA (review roles)**: Run /review, optional secondary review if configured, and /qa...
```

**Non-code phase kinds** use the same one-phase/two-gate rule. Do not split
draft/action work and review into separate phases. One executable phase must
contain both required checkboxes for its kind:

```markdown
### Phase 2.1 [writing]: Draft and review the paper

- [ ] **Draft**: Write the paper section.
- [ ] **Review**: Review the section for accuracy and clarity.

### Phase 2.2 [experiment]: Run and review the ablation

- [ ] **Execute**: Run the ablation command and capture results.
- [ ] **Review**: Check result integrity and summarize findings.

### Phase 2.3 [research]: Explore and review prior work

- [ ] **Explore**: Collect relevant sources and notes.
- [ ] **Review**: Verify claims against the collected sources.

### Phase 2.4 [manual]: Complete and verify external setup

- [ ] **Action Required**: Complete the external setup step.
- [ ] **Verify Completion**: Confirm the setup is complete.
```

Feature and phase numbers can be `N` or `N.M`. The orchestrator processes features in document order, and phases in document order within each feature. Phases missing their kind-specific implementation/action gate or kind-specific review/verification gate are skipped with a warning. Code phases missing a `**Test Specification` checkbox are treated as legacy and skip the Red/Green steps; keep that compatibility for old plans, but do not generate new living plans in the legacy shape.

## Feature Workflow

For each feature block, the orchestrator:

1. Ensures it is on a feature branch.
2. Runs every incomplete phase through the TDD/review loop.
3. Runs `/ship` for that feature and queues the PR for the release daemon unless `--skip-ship` or `--dry-run` is set. Use `--release-mode auto-land` for legacy inline `/ship` + `/land-and-deploy`.
4. Verifies the landed feature against the origin plan when `--origin-plan` is provided.
5. Marks the feature complete and advances to the next feature.

Every atomic feature/phase/gate transition writes a `status` event to `~/.gstack/analytics/build-runs.jsonl` and prints a `[build-status]` line so monitors can observe progress and pause on unresolved issues.

After all features complete, the final exam verifies there are no incomplete phases/features and, for shipped runs, no unmerged local or remote `feat/*` branches remain. Only then are the living plan and optional origin plan archived.

## Merge Mode

`gstack-build merge` is the CLI-backed `/build merge` cleanup path. It requires
no plan file. It scans all unmerged local and remote `feat/*` branches, runs the
configured review/fix/ship/land loop for each branch, and fails closed on the
first branch that cannot be reviewed clean, fixed within the review cap,
shipped, or landed.

```bash
gstack-build merge --project-root /path/to/product-repo
gstack-build merge --project-root /path/to/product-repo --dry-run
```

## TDD Workflow

When a phase has a `**Test Specification` checkbox, the orchestrator runs a 7-step loop:

```
1. Test Specification  — configured test-writer role writes failing tests (Red)
2. Verify Red          — run tests; if they pass, test-writer rewrites stricter tests (cap: GSTACK_BUILD_RED_MAX_ITER)
3. Implementation      — configured primary-impl role implements until tests pass
4. Test+Fix Loop       — run tests; if failing, configured test-fixer role fixes; repeat (cap: GSTACK_BUILD_TEST_MAX_ITER)
5. Review + QA         — review loops until GATE PASS, then review-secondary loops
                         until GATE PASS, then QA loops until GATE PASS
6. Update Plan         — flip all 3 checkboxes [x]
7. Host context save   — `/build` saves context from the current host LLM
                         session; the CLI has no configured context-save role
```

### Test command detection

The orchestrator auto-detects the test runner by searching the project root (`cwd`) in priority order:

1. Per-phase `<!-- testCmd: <cmd> -->` annotation in the plan body (highest priority — overrides everything for that single phase)
2. `--test-cmd <cmd>` flag (explicit per-run override)
3. `package.json` → `scripts.test` (e.g. `bun test`, `npm test`)
4. `pytest.ini` → `pytest`
5. `pyproject.toml` with `[tool.pytest.ini_options]` → `pytest`
6. `go.mod` → `go test ./...`
7. `Cargo.toml` → `cargo test`
8. None found → warn and skip Red/Green verification (test spec still written; review gates still run)

```bash
# Explicit override — use when auto-detection picks the wrong command:
gstack-build plans/...md --test-cmd "bun test src/"

# Monorepo: runTests splits on whitespace, so use bash -c for shell operators:
gstack-build plans/...md --test-cmd "bash -c 'cd packages/api && bun test'"
```

#### Per-phase test-command override

In polyglot monorepos the same repo can need different runners for different
phases of the same plan. The autodetect heuristic only picks one. To point a
single phase at a specific runner, add an HTML-comment annotation to the phase
body:

```markdown
### Phase 1: Update generation pipeline to emit behavior defaults

<!-- testCmd: pytest tests/test_capability_assembler_behavior.py -->

- [ ] **Test Specification**: write the failing tests
- [ ] **Implementation**: emit behavior defaults from Layer 1
- [ ] **Review**: confirm green
```

The annotation can appear anywhere in the phase body (before or interleaved
with checkboxes). The value is read verbatim, trimmed, and passed to the same
shell invocation as `--test-cmd` — `pytest -k "expr and other"` works, multi-word
commands work, environment overrides like `PYTHONPATH=. python3 -m pytest …`
work.

**Scope:** the annotation overrides VERIFY_RED, the test-fix loop, the green-tests
gate, and dual-impl tournament runs, for this phase only. Sibling phases without
an annotation fall through to `--test-cmd` and then to the autodetect chain.

**Trust:** the value is shell-evaluated, same trust level as `--test-cmd` on
the command line. Treat plans you didn't author the way you'd treat a shell
script — review before running `gstack-build`.

**When to reach for it:** the orchestrator reports `Gemini could not produce
failing tests after N attempts (GSTACK_BUILD_RED_MAX_ITER)` and you can see
in `phase-N-tests-1.log` that the wrong runner ran (e.g. `npx vitest run` for
a Python phase). Add the annotation, resume.

### Common workflows

```bash
# See what would run, no execution:
gstack-build plans/myproj-impl-plan-20260427.md --print-only

# Walk the full TDD state machine without spawning sub-agents (smoke test):
gstack-build plans/...md --dry-run --test-cmd "bun test"

# Inspect independent phase batches for a feature before parallel execution work:
gstack-build plans/...md --dry-run --parallel-phases 2 --test-cmd "bun test"

# Run for real, but stop short of the ship step:
gstack-build plans/...md --skip-ship
gstack-build plans/...md --release-mode auto-land

# Supervise queued releases for this repo:
gstack-build release-daemon install
gstack-build release-daemon status
gstack-build release-daemon run --watch --poll-ms 30000
gstack-build release-daemon retry 123

# Discard prior state and start over:
gstack-build plans/...md --no-resume

# Local JSON only, no gbrain mirror:
gstack-build plans/...md --no-gbrain

# Review/fix/ship/land leftover feat/* branches:
gstack-build merge --project-root /path/to/product-repo
```

Queued mode is the default release mode. It creates or updates a PR, marks it
with the `gstack-release-queued` label and hidden JSON marker, then writes the
local queue record. The release daemon only lands PRs that still have that
marker, and it serializes landing with a remote git lock keyed by canonical
remote identity plus base branch, so the same repo cloned at different local
paths shares one release lane.

`release-daemon install` is repo-aware: run it from the repo you want to
supervise, or pass `--project-root /path/to/repo`. The generated launchd or
systemd user service pins both `--project-root` and `WorkingDirectory` to that
repo.

### Resume after interrupt

Hit Ctrl-C mid-run? Run the same command again — the orchestrator picks up at the phase that was in flight. State lives at `~/.gstack/build-state/<slug>.json` (and mirrored to gbrain page `<slug>` if gbrain is configured).

To force a fresh start: `gstack-build ... --no-resume` or `rm ~/.gstack/build-state/<slug>.json`.

## Dual Implementor Mode (`--dual-impl`)

Tournament selection: the configured primary and secondary implementors build each TDD phase **in parallel**, in **isolated git worktrees**, and the configured judge picks the winner. The winning commits are cherry-picked back onto the main branch and the existing TDD pipeline (test+fix loop → review gates) takes over from there.

**Prewritten test specs are supported** — if a phase has `[x] **Test Specification` already checked (user wrote the tests before running gstack), dual-impl runs `VERIFY_RED` first to confirm the tests fail, then spawns both implementors. If the prewritten tests pass trivially (before any implementation), the phase fails with a clear message: fix the tests so they fail, then re-run. **Legacy 2-checkbox plans** (no test spec checkbox at all) still skip dual-impl silently and use normal single-implementor behavior.

**Required CLIs**: every provider configured for `primaryImpl`, `secondaryImpl`, and `judge` must be on `PATH` (or configured via that provider's `*_BIN` override). The orchestrator does not preflight check these — if one implementor fails to produce committed work, `countCommitsSinceBase` returns 0 for that side, making it ineligible. If only one side committed and its tests pass, it is auto-selected and dual-tests + judge are skipped (`selectedBy='auto'`). If neither committed, the phase fails.

This eliminates single-model blind spots: if one implementor takes a structurally wrong approach, the other independent attempt may not, and the judge sees both diffs side-by-side.

```bash
gstack-build plans/...md --dual-impl
```

### Per-phase loop (when `--dual-impl` is active)

```
1. Test Specification  — configured test-writer writes failing tests (Red)
2. Verify Red          — confirm tests fail                            [unchanged]
3. Dual Impl           — createWorktrees, then Promise.all of:
                           - primary role in /tmp/gstack-dual-<slug>-pN-<ts>/primary
                           - secondary role in /tmp/gstack-dual-<slug>-pN-<ts>/secondary
                         Each commits to its own branch.
4. Dual Fix Loops      — Promise.all of runDualImplFixLoop on both worktrees:
                         For each implementor:
                           a. run test command
                           b. if tests fail: invoke fix agent (up to DEFAULT_MAX_TEST_ITERATIONS)
                              collecting per-iteration failure output into fixHistory
                           c. repeat until green or iterations exhausted
                         SHA of worktree HEAD captured at test time (testedCommit)
                         — validated on resume; stale cache detected
                         fail-closed if HEAD has moved since tests ran.
                         Outcomes:
                           → both pass: judge decides (or test hygiene gate below)
                           → one passes: auto-select the passing one
                           → both fail: auto-select fewer-failures winner
                           → both timed out / no signal: fail closed
                         Test hygiene gate: before auto-select, git-diff test files
                         (**/__tests__/**) — if either implementor modified test assertions,
                         route to the configured judge instead of auto-deciding.
5. Judge               — configured judge reads both diffs + test results + fixHistory,
                         emits "WINNER: primary|secondary" + REASONING + HARDENING block
                         (HARDENING: lists concrete bug surfaces from either side's
                         fix history; injected into the review prompt)
6. Apply Winner        — cherry-pick winning branch's commits onto main cwd
                         (patch fallback if cherry-pick conflicts)
7. — handoff —         — phase rejoins impl_done; existing TDD loop runs
8. Test+Fix Loop       — adopted code is verified again on main cwd
9. Review + QA         — final review on main cwd; receives HARDENING notes so
                         the reviewers check for known edge cases from both
                         implementors' failure histories
```

### Worktree isolation

Each phase creates a fresh pair under `os.tmpdir()/gstack-dual-<slug>-p<N>-<timestamp>/`. Branches are named `gstack-dual-p<N>-{primary|secondary}-<timestamp>`. Cleanup behavior by outcome:

- **Successful Apply Winner** → worktrees torn down immediately.
- **Apply Winner failure** (cherry-pick + patch both fail) → worktrees **preserved** for manual recovery; cwd tracking files are restored to HEAD via `git reset --hard HEAD` (only on the specific patch-apply failure branch; `git add` or `git commit` failures after a successful patch leave cwd dirty — check `git status` before recovery). Error message includes the worktree paths.
- **Phase FAIL before Apply — at Dual Tests** (both timed out, or both fail with no parseable failure count) → worktrees torn down immediately after the test result is recorded; `failed` status set. These have no recovery value since there is no winner to cherry-pick.
- **Phase FAIL before Apply — at RUN_DUAL_IMPL** (e.g. neither implementor committed, unexpected crash) → worktrees torn down in the `finally` block; only `failed` status is left in state.
- **Judge failure / malformed verdict** → worktrees torn down; phase status `failed`.

Manual recovery: `git worktree list` to find leftover worktrees, then `git worktree remove --force <path>` + `git branch -D <branch>` to clean up.

### Auto-select vs Judge

- **Both passed tests** → test hygiene gate: if either implementor modified test files (`**/__tests__/**`), the configured judge runs. Otherwise the configured judge runs unconditionally.
- **One passed, one failed** → auto-select the passing one (`selectedBy='auto'`), unless test hygiene gate triggers.
- **Both failed** → auto-select fewer-failures winner via `parseFailureCount` (priority: explicit summary line like "3 failed", then ✗/FAIL marker counts), unless test hygiene gate triggers.
- **Both timed out OR both had no parseable failure count** → fail-closed; phase status `failed`, you resume manually.
- **Judge output malformed (no anchored `WINNER:` line)** → fail-closed; worktrees are torn down.
- **Fix iterations** reported in judge prompt: `null` = fix loop not run (impl crashed or no test command), `0` = passed on first try, `N` = required N fix passes.

### Backward compat

`--dual-impl` is a runtime-only flag. Plans don't need any per-phase frontmatter — when the flag is set, every parsed phase gets `dualImpl=true`. Prewritten test-spec phases (where `[x] **Test Specification` is already checked) now run `VERIFY_RED` first before spawning both implementors. Legacy 2-checkbox plans (no test-spec checkbox at all) still skip dual-impl and use the normal single-implementor path.

## Parallel Phase Planner (`--parallel-phases N`)

`--parallel-phases N` is the opt-in planner for Option 2: run independent phases inside a single feature in bounded batches. The current implementation is intentionally planning-only: use it with `--dry-run` to inspect batches. Real execution with `--parallel-phases > 1` fails closed until the isolated worktree executor and integration queue are wired.

```bash
gstack-build plans/...md --dry-run --parallel-phases 2 --test-cmd "bun test"
```

Planner metadata is read from each phase body:

```md
### Phase 1.2: UI shell

Touches: src/ui/ProfileShell.tsx, src/ui/ProfileShell.test.tsx
Depends on: 1.1
```

Guardrails:

- `N=1` keeps the legacy sequential path.
- Unknown dependency numbers fail closed.
- Missing `Touches:` metadata serializes the phase as an unknown write set.
- Overlapping touch paths serialize to avoid patch conflicts.
- Lockfiles, package manager files, migrations, GitHub workflows, and common build config paths serialize automatically.
- Common prose dependencies like `after Phase 1.1` are treated as dependencies.
- `--parallel-phases > 1` cannot be combined with `--dual-impl` yet.

## Environment variables

The built-in defaults are data-driven from `build/configure.cm`. Edit that file
to update default role routing, retry caps, or timeout values. Use
`GSTACK_BUILD_CONFIG_FILE` to run with an alternate config file without editing
the repo copy. `GSTACK_BUILD_DEFAULTS_FILE` remains as a legacy alias.

| Variable                              | Default              | Purpose                                                                                                                                                                        |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_BIN`                          | `gemini`             | Path to Gemini CLI.                                                                                                                                                            |
| `CODEX_BIN`                           | `codex`              | Path to Codex CLI.                                                                                                                                                             |
| `CLAUDE_BIN`                          | `claude`             | Path to Claude Code.                                                                                                                                                           |
| `GBRAIN_BIN`                          | `gbrain`             | Path to gbrain CLI (optional).                                                                                                                                                 |
| `GSTACK_BUILD_CONFIG_FILE`            | `build/configure.cm` | Alternate build config file.                                                                                                                                                   |
| `GSTACK_BUILD_DEFAULTS_FILE`          | `build/configure.cm` | Legacy alias for `GSTACK_BUILD_CONFIG_FILE`.                                                                                                                                   |
| `GSTACK_BUILD_TEST_WRITER_MODEL`      | role default         | Failing-test writer model.                                                                                                                                                     |
| `GSTACK_BUILD_PRIMARY_IMPL_MODEL`     | role default         | Primary implementation model.                                                                                                                                                  |
| `GSTACK_BUILD_TEST_FIXER_MODEL`       | role default         | Test-fixer model.                                                                                                                                                              |
| `GSTACK_BUILD_SECONDARY_IMPL_MODEL`   | role default         | Dual-impl secondary model.                                                                                                                                                     |
| `GSTACK_BUILD_REVIEW_MODEL`           | role default         | Primary review model.                                                                                                                                                          |
| `GSTACK_BUILD_REVIEW_SECONDARY_MODEL` | role default         | Secondary review model.                                                                                                                                                        |
| `GSTACK_BUILD_QA_MODEL`               | role default         | QA model.                                                                                                                                                                      |
| `GSTACK_BUILD_SHIP_MODEL`             | role default         | Ship model.                                                                                                                                                                    |
| `GSTACK_BUILD_LAND_MODEL`             | role default         | Land model.                                                                                                                                                                    |
| `GSTACK_BUILD_<ROLE>_PROVIDER`        | role default         | Provider override where supported; dual-impl primary, secondary, and judge roles are model-agnostic.                                                                           |
| `GSTACK_BUILD_<ROLE>_REASONING`       | role default         | Role reasoning override.                                                                                                                                                       |
| `GSTACK_BUILD_<ROLE>_COMMAND`         | role default         | Command override for review, QA, ship, and land roles.                                                                                                                         |
| `GSTACK_BUILD_GEMINI_TIMEOUT`         | `600000`             | Per-Gemini-call timeout in ms (10 min).                                                                                                                                        |
| `GSTACK_BUILD_CODEX_TIMEOUT`          | `900000`             | Per-Codex-iteration timeout in ms (15 min).                                                                                                                                    |
| `GSTACK_BUILD_SHIP_TIMEOUT`           | `1800000`            | Final ship-step timeout in ms (30 min).                                                                                                                                        |
| `GSTACK_BUILD_CODEX_MAX_ITER`         | `5`                  | Hard cap on recursive review gate iterations.                                                                                                                                  |
| `GSTACK_BUILD_TEST_TIMEOUT`           | `300000`             | Per-test-run timeout in ms (5 min).                                                                                                                                            |
| `GSTACK_BUILD_TEST_MAX_ITER`          | `5`                  | Hard cap on test-fixer iterations when tests fail post-impl.                                                                                                                   |
| `GSTACK_BUILD_RED_MAX_ITER`           | `1`                  | Hard cap on test-writer re-spec iterations when tests pass trivially (VERIFY_RED). Set `GSTACK_BUILD_RED_LEGACY_CAP=3` during the deprecation window to restore the old cap.   |
| `GSTACK_BUILD_JUDGE_TIMEOUT`          | `600000`             | Per-judge-call timeout in ms (10 min). Dual-impl only.                                                                                                                         |
| `GSTACK_BUILD_JUDGE_MODEL`            | role default         | Model passed to `claude --model` for the judge. Dual-impl only.                                                                                                                |
| `GSTACK_BUILD_CODEX_IMPL_SANDBOX`     | `workspace-write`    | Sandbox mode for `runCodexImpl`. Set to `danger-full-access` to opt in to looser sandboxing (worktrees share .git/remotes — be aware).                                         |
| `GSTACK_BUILD_CODEX_REVIEW_SANDBOX`   | `workspace-write`    | Sandbox mode for Codex review/QA gates. If unset, known local sandbox-block failures retry once with `danger-full-access`; setting this env var disables that automatic retry. |

## Living plan storage

`/build` writes synthesized living plans to the workspace-level
`*-gstack/inbox/living-plan/` directory. Source plans to execute are searched
first in `*-gstack/inbox/`. The product repo remains the execution root: tests,
sub-agents, review, ship, and land all run from `--project-root` or the current
git worktree. When the current directory is a workspace root with child repos,
the root repo is ignored by default and each child repo gets its own living plan.
Direct CLI execution against that root repo requires `--allow-workspace-root`.
Multi-repo plans run through a manifest, one living plan per target repo. If
`gstack-build` is invoked with a plan inside the `*-gstack` repo and cannot infer
the product repo, it exits with instructions to rerun with `--project-root
<repo>`.

## File layout

```
~/.gstack/build-state/
├── <slug>.json                           Live state (atomic temp+rename)
├── <slug>.lock                           O_EXCL lock file (cleared on graceful exit)
└── <slug>/
    ├── phase-1-test-writer-1.log         Test-writer stdout+stderr
    ├── phase-1-gemini-testspec-1-input.md
    ├── phase-1-gemini-testspec-1-output.md
    ├── phase-1-tests-1.log               Test runner stdout+stderr (VERIFY_RED)
    ├── phase-1-dual-primary-1.log        Primary implementor stdout+stderr
    ├── phase-1-tests-1.log               Test runner stdout+stderr (post-impl)
    ├── phase-1-dual-primary-fix1-1.log   Fix-iteration stdout+stderr
    ├── phase-1-dual-secondary-1.log
    ├── phase-1-dual-secondary-fix1-1.log
    └── ship.log

~/.gstack/analytics/build-runs.jsonl   Append-only activity log
```

The `<slug>` is `build-<plan-basename-without-ext>`, e.g. `build-agnt2-impl-plan-20260427`.

## Failure modes

The orchestrator stops at any of these and writes the failure reason into the state file. Resume picks up at the same phase after the user fixes the underlying issue.

| Symptom                                                                   | Likely cause                                                                                                                                                            | Fix                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Gemini timed out (after 1 retry)`                                        | Phase too large, network blip, or Gemini hung                                                                                                                           | Raise `GSTACK_BUILD_GEMINI_TIMEOUT`, or split the phase                                                                                                                                                                                                          |
| `Codex review failed to converge`                                         | One review gate could not reach `GATE PASS` within `GSTACK_BUILD_CODEX_MAX_ITER` attempts                                                                               | Read the phase review logs, fix the underlying issue manually, resume                                                                                                                                                                                            |
| `Codex output did not contain GATE PASS or GATE FAIL`                     | Codex changed output format, or hit an internal error                                                                                                                   | Read the log; usually means the codex CLI itself errored                                                                                                                                                                                                         |
| `Tests still failing after N fix iterations`                              | Gemini can't converge; tests and impl are in conflict                                                                                                                   | Read `phase-N-gemini-fix-*.log`, fix manually, resume                                                                                                                                                                                                            |
| `Gemini could not produce failing tests after N attempts`                 | Either trivially-asserting tests, OR the wrong test runner is detected (e.g. vitest runs for a pytest phase in a polyglot repo)                                         | Inspect `phase-N-tests-1.log`'s `# command:` header. If the runner is wrong, add `<!-- testCmd: <correct-cmd> -->` to the phase body. If the runner is right, read `phase-N-gemini-testspec-*.log` and tighten the phase description. Resume.                    |
| `plan checkbox flip failed: line N no longer contains "**Implementation"` | Plan file edited externally between parse and mutate                                                                                                                    | Re-run; the orchestrator re-parses on every start                                                                                                                                                                                                                |
| `another gstack-build instance is running`                                | Another process holds the lock, or stale lock                                                                                                                           | Either wait, or `rm ~/.gstack/build-state/<slug>.lock` if you're sure it's stale                                                                                                                                                                                 |
| `worktree is dirty (N path(s)) — refusing to mark phase X committed`      | `--mark-phase-committed` invoked while the worktree had uncommitted changes — used to silently force-mark over the dirty state                                          | Inspect the dirty files. Then re-run with `--commit-dirty` to stage+commit them with a `fix(recovery): ...` message, or `--force-dirty` to keep the dirty state and mark anyway (warns; next phase starts dirty). Manual `git reset/checkout/commit` also works. |
| `git status failed in <cwd> — cannot inspect worktree state`              | Stale `.git/index.lock`, corrupted repo, or permission error during `--mark-phase-committed` recovery                                                                   | Resolve the underlying git error (often `rm .git/index.lock` after confirming no live git process), then retry. Pass `--force-dirty` only if you accept that the worktree state is unknown.                                                                      |
| `plan markdown drift — could not un-flip checkboxes for phase X`          | Origin-verification rewind hit a plan file that was hand-edited between parse and rewind; one or more of the three checkbox lines no longer matches the expected marker | The feature is paused with an explicit reason. Re-flip `[x] → [ ]` for the named phase's test-spec, implementation, and review lines in the plan markdown, then resume.                                                                                          |

Exit codes: `0` clean run, `1` phase failed, `2` bad args, `3` lock contention (startup) OR plan-review stalemate, `4` user abort at plan-review gate, `130` SIGINT.

## Running inside Claude Code or other supervisors

`gstack-build monitor --watch` is a foreground process by design. It exits with
code `12` (`MONITOR_REENTER`) when it hits its wall-time budget, and the caller
re-enters with the same flags to continue. That exit code is only meaningful
to a synchronous caller — if the monitor is backgrounded with `nohup … &
disown` or similar, the caller loses the signal and the build silently stalls.

**Background the orchestrator, not the monitor.** Patterns like `gstack-build
… & disown` work for the orchestrator itself; only the foreground monitor
needs to stay attached.

**Claude Code's Bash auto-background threshold.** Claude Code backgrounds
commands that run past ~10 minutes, which breaks the monitor's synchronous
re-entry contract. Since v1.40+, `parseArgs` detects `CLAUDECODE` in the
environment and caps `monitorMaxWallMs` to `540000` (9 min) when the user
hasn't passed `--max-wall-ms` explicitly. Each Bash invocation re-enters the
monitor, and the build progresses one cycle at a time. To opt out (e.g.
custom supervisor wrapping Claude Code) pass `--max-wall-ms <ms>` and the
auto-cap is skipped.

## Manual phase recovery (`--mark-phase-committed`)

When an agent leaves the worktree in a half-recovered state — most often after
a hygiene failure where the operator hand-finishes the work — use
`--mark-phase-committed <feat>.<phase>` to mark the phase committed without
re-running test-spec, implementation, tests, or review.

```bash
gstack-build <plan> --mark-phase-committed 1.2
```

**Dirty-tree guard.** The recovery exit refuses by default if the worktree is
dirty. Three of the four 2026-05-18 mitosis PREMATURE_COMPLETION faults traced
back to a silent force-mark over a dirty worktree, after which the next phase
started on inconsistent state. The guard makes you choose a policy:

- `--commit-dirty` — stage everything and commit with a standard
  `fix(recovery): <phase> auto-commit of agent-left changes during
--mark-phase-committed` message. Pre-commit hooks still run; if a hook
  fails, the commit fails and the mark refuses (you see the hook output
  and decide).
- `--force-dirty` — preserve the dirty state, warn-only. The next phase
  starts on this dirty tree, so review carefully.
- Pass neither — the guard prints the dirty file list and refuses, leaving
  state untouched.
- `--commit-dirty` and `--force-dirty` are mutually exclusive.

If `git status` itself fails (stale `.git/index.lock`, corrupted repo,
permissions) the guard fails closed unless `--force-dirty` is passed. The
operator needs to know — silently bypassing a `git status` failure is the
exact failure mode that recreates the bug class.

**Ship side effect.** `--mark-phase-committed` advances state and falls
through to the main loop. In multi-branch mode, if the marked phase was the
last phase of a feature, the orchestrator will set that feature to
`phases_done` and immediately trigger `/ship` + `/land-and-deploy` for it.
Pair with `--skip-ship` if you want to mark without triggering ship.

## Mark a feature as already-shipped

When a feature was merged outside the orchestrator's normal pipeline (manual
ship from another lane, parallel merge, recovery after a killed orchestrator),
the orchestrator's anti-tamper detector will treat any partial hand-edit to
state as a `manual JSON state patch that bypassed ship+land+verify` and reset
the feature to `phases_done`, trying to re-ship it. The supported way out:

```bash
gstack-build mark-shipped --plan <plan.md> --feature <number> [--pr <num>] [--merge-sha <sha>]
```

This writes the canonical terminal-state shape the detector trusts —
`status=committed`, `completedAt`, `shippedAt`, `prNumber`, `mergeSha` — in one
atomic local + gbrain write. Safety guards before any write:

1. Refuses if any live orchestrator owns the same plan (stop it first).
2. Auto-resolves `--pr` via `gh pr list --state merged --head <branch>` when
   omitted. If multiple PRs match, the most-recently-merged wins.
3. Verifies the PR is genuinely `MERGED` via `gh pr view`. Single source of
   truth for `mergeSha` (`mergeCommit.oid`).
4. If `--merge-sha` was passed, errors out on mismatch — catches operator
   typos before any write.
5. No-op + clean success message when the feature is already terminal.

Does NOT touch `currentFeatureIndex` — that stays the orchestrator's
responsibility. `findNextFeatureIndex()` will skip the feature naturally on
the next launch because `isFeatureTerminal()` now returns true.

Exit codes for mark-shipped: `0` success or no-op, `2` bad args / missing
state / feature not found, `3` active orchestrator refused, `4` PR not
merged, `5` `--merge-sha` mismatch.

## Child process management

Every spawn the orchestrator makes routes through `child-registry.ts`, a thin
wrapper around `node:child_process` that:

- Spawns each child detached (its own process group), so
  `process.kill(-pid, signal)` reaches the whole subtree.
- Tracks live pids in an in-memory registry.
- Installs `SIGTERM` / `SIGINT` / `SIGHUP` handlers at orchestrator startup.
  On any of those signals: SIGTERM every live group, wait up to 2 seconds,
  SIGKILL survivors, then exit.

`__tests__/no-bare-spawn.test.ts` is a static invariant: any new file under
`build/orchestrator/` that imports from `node:child_process` directly fails CI.
All `spawn`/`spawnSync`/`execFile` imports must go through
`./child-registry` instead.

**SIGKILL caveat.** `kill -9 <orchestrator-pid>` cannot be intercepted —
the kernel terminates the process without running userspace cleanup, so
in-flight children are reparented to init and outlive the orchestrator. This
is standard POSIX behavior. The pre-fix polis-mesh incident hit this when the
operator escalated straight to `kill -9` and `gbrain put` subprocesses
survived. The fix handles the survivable signals (the common `kill`/SIGTERM,
Ctrl-C/SIGINT, terminal-disconnect/SIGHUP) cleanly. For SIGKILL recovery,
follow up with `pkill -9 gbrain` (or whichever subagent is still alive).

## Architecture

```
cli.ts          driver loop, merge mode, signal handling, lock, activity log
parser.ts       plan markdown → Phase[]
phase-runner.ts pure state machine (decideNextAction, applyResult)
sub-agents.ts   gemini/kimi/codex/claude CLI wrappers with retries; detectTestCmd; runTests
plan-mutator.ts atomic [ ] → [x] checkbox flip (impl, review, test-spec)
state.ts        ~/.gstack/build-state/<slug>.json + gbrain mirror
release-identity.ts canonical remote/path identity for queue records and locks
release-queue.ts typed queued-release records, PR marker parsing/verification
release-lock.ts remote git ref lock, heartbeat refresh, stale-owner handling
release-daemon.ts FIFO queued release worker, scratch checkout, drift repair
gbrain.ts       gbrain CLI wrapper (best-effort, never throws)
ship.ts         configurable /ship + /land-and-deploy delegation
mark-shipped.ts operator escape hatch — write canonical terminal state shape
pr-info.ts      gh pr lookup helpers (findMergedPRForBranch, readMergedPRInfo)
child-registry.ts drop-in spawn wrappers + signal handlers (reap detached children)
stall-watchdog.ts liveness watchdog: stream/mtime/cpu modes + tool-aware windowing + progress-gap arm
subagent-progress-parser.ts per-provider stdout parser (Gemini/Codex/Claude/Kimi) → ProgressEvent | null
plan-reviewer.ts single-round review: parsing, reconciliation, annotation read/write, prompts
plan-review-loop.ts multi-round orchestration, triage gates, adaptive cap, history JSONL
drain-faults.ts skill-fault drain consumer; short-circuits audit events (investigate:false)
halt-event-helpers.ts emitRecoveryBoundary() — pins investigate:false on audit events
halt-events.ts  HaltEvent schema, markInvestigated; investigate?: boolean property
feature-review.ts per-feature meta-review pass; same-shape fingerprint detection; UNCLEAR fail-fast
feature-review-metrics.ts JSONL instrumentation for cycles, tokens, latency, verdict (T1)
feature-review-cache.ts FEATURE_PASS verdict cache keyed on tree+plan hash (T14)
feature-verifier.ts pre-merge featureVerifier CLI gate (T12) + post-merge tree-hash audit (T13)
types.ts        Phase, PhaseState, BuildState
```

The state machine is the heart of the design and is deliberately a pure function: `(currentPhaseState, lastResult) → (nextAction, newPhaseState)`. The driver in `cli.ts` is the only place with I/O. This makes every state transition trivially unit-testable — see `__tests__/phase-runner.test.ts` for the full transition table.

## Subcommand: `drain-faults`

Recovers stranded skill-fault investigations from a build's `monitor-output.log`.
Used when a `/build` skill session dies before reaching Step M3.5 (host crash,
context limit, manual abort) so monitor-detected faults never got investigated.

```bash
# Recovery via manifest path (the build-run-manifest.json a /build session creates):
gstack-build drain-faults --manifest /path/to/build-run-manifest.json

# Or point directly at the BUILD_TMP_DIR containing monitor-output.log:
gstack-build drain-faults --build-tmp-dir /path/to/.llm-tmp/build-runs/XXX

# Optional flags:
gstack-build drain-faults --manifest ... --dry-run              # Parse and plan only, no spawns
gstack-build drain-faults --manifest ... --catch-all            # Fire a discovery investigator when log has RUN_FAILED but no faults
gstack-build drain-faults --manifest ... --investigator-timeout-ms 600000   # Per-investigator timeout (default 10 min)
```

Idempotent: subsequent runs dedup against on-disk reports in `~/.gstack/skill-faults/`.
The `/build` skill template calls this at the top of Step M3.5 automatically;
manual invocation is for after-the-fact recovery.

The monitor mode (`gstack-build monitor`) ALSO calls drain inline on terminal
events so investigations fire even if no skill agent is alive. Two paths, same
dedup — belt-and-suspenders.

## Testing

```bash
cd ~/.claude/skills/gstack
bun run test:build-skill
```

The dedicated gate runs `build/orchestrator/__tests__` plus
`test/gen-skill-docs.test.ts`. `coverage-matrix.test.ts` is the ownership
guard: every build orchestrator module and build-critical behavior must name
deterministic tests, so future updates cannot silently bypass the `/build` TDD
contract.

## Plan review convergence loop

The `planReviewer` role runs at startup (before Phase 1 of Feature 1) and produces structured CRITICAL / IMPORTANT / SUGGESTION objections against the living plan. CRITICAL objections trigger an in-process loop with up to 5 rounds (configurable):

```
Round N reviewer call
   ↓
Triage gate (TTY readline or non-TTY mode)
   ↓
Plan-file annotation write (RoundAnnotation per accepted/rejected/deferred objection)
   ↓
Convergence snapshot (re-raises vs new objections, set-aware)
   ↓
Adaptive-cap decision (continue, bail-out gate, stalemate gate)
   ↓
Synthesizer dispatch (in-process, edits plan file, writes RESOLUTION lines)
   ↓
Round N+1
```

### Exit codes from `gstack-build` (plan-review portion)

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Plan approved (clean APPROVE or user picked `[a]pprove as-is` at a gate)       |
| 3    | Stalemate — user picked `[m]anual mode`, or non-TTY `fail-fast` mode triggered |
| 4    | User abort — user picked `[q]uit` at the triage gate or stalemate gate         |
| 130  | SIGINT during triage (Ctrl+C)                                                  |

### Flags

- `--no-plan-review` — skip the entire loop (no reviewer call, no triage gate)
- `--plan-review-max-rounds=N` (default 5) — hard cap on rounds
- `--plan-review-no-adaptive-cap` — disable the no-forward-progress bail
- `--plan-review-noninteractive=<auto-accept|fail-fast|auto-reject>` (default `auto-accept`) — CI behavior on CRITICAL objections

### Telemetry files

- `~/.gstack/build-state/<slug>/plan-review-report.json` — most recent round's verdict, kept for SKILL.md.tmpl Step 5.5 backward compatibility
- `~/.gstack/build-state/<slug>/plan-review-history.jsonl` — append-only, one line per round
- `~/.gstack/analytics/convergence.jsonl` — append-only, one line per completed build (aggregate trajectory + totals)

### Triage gate keys (TTY)

| Key | Action                                         |
| --- | ---------------------------------------------- |
| `a` | accept this objection                          |
| `r` | reject (false positive)                        |
| `d` | defer (real concern but not this build)        |
| `v` | view reviewer's Overall Assessment prose       |
| `A` | accept all remaining                           |
| `R` | reject all remaining                           |
| `s` | stop triage, default remaining to accept       |
| `q` | quit loop (exit 4, state preserved for resume) |

After each decision (a/r/d), user is prompted for an optional one-line rationale that gets written into the plan annotation.

### Module map

- [plan-reviewer.ts](./plan-reviewer.ts) — single-round parsing, reconciliation, annotation read/write, reviewer prompt, synth revision prompt
- [plan-review-loop.ts](./plan-review-loop.ts) — multi-round orchestration, triage gates, adaptive cap, history JSONL, convergence aggregate
- [cli.ts](./cli.ts) — wires the loop in at startup

See [docs/superpowers/specs/2026-05-19-build-plan-review-convergence-design.md](../../docs/superpowers/specs/2026-05-19-build-plan-review-convergence-design.md) for the full design rationale.
