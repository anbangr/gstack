# Active skill clean-install migration

**Date:** 2026-05-15
**Author:** Anbang (via Claude brainstorm)
**Status:** Design — ready for implementation plan
**Triggering bug:** `/build` failed with `unknown flag: --single-branch` in [build/orchestrator/cli.ts](../../../build/orchestrator/cli.ts) — but only when invoked through the active-skill copy at `~/.claude/skills/gstack/`. The flag was present in source.

---

## Problem

The user's runtime install at `~/.claude/skills/gstack/` is a separately-cloned git repo of the `anbangr/gstack` fork. It is 211 commits behind `origin/main`, carries 19 uncommitted modifications, holds 3 stashes, and lives on a non-main branch tip. It is _also_ the binary Claude actually executes when a session runs `/build`, `/ship`, or any other gstack skill.

The original `/build` failure happened because the active skill's `build/SKILL.md.tmpl` had been hand-edited (or partially merged) to reference `--single-branch`, while the active skill's `build/orchestrator/cli.ts` is from a commit pre-dating the flag. The session's investigating agent ran `gstack-build --help`, saw no `--single-branch`, and concluded the flag didn't exist — they were looking at the older binary, not source.

The structural cause is more general than the specific bug:

1. **Two separate git repos for the same project** — source at `/Users/anbang/Documents/Antigravity/claude-workspace/gstack` (this directory, HEAD `6b1b1de0`) and runtime at `~/.claude/skills/gstack/` (HEAD `2fcc96c0` plus uncommitted work). Edits made in one don't reach the other except by hand-copy.
2. **The runtime has been used as a working tree.** `feat/living-plan-step-visibility` branch, 3 stashes, 19 uncommitted file edits.
3. **CLAUDE.md's "Deploying to the active skill" section documents `git fetch && reset --hard`** as the deploy command, which assumes the runtime is a git repo with no local work. The user's actual usage contradicts both assumptions.
4. **`/gstack-upgrade` already implements the correct mechanism** — `rsync -a --delete --exclude '.git'` from the fork copy to the install dir ([gstack-upgrade/SKILL.md.tmpl:183](../../../gstack-upgrade/SKILL.md.tmpl)). The runtime is supposed to be a `.git`-less rsync mirror downstream of source. The current state has drifted from that intent.

When the user has uncommitted local mods in the runtime, the canonical deploy command (`git reset --hard`) destroys real work. So no agent will run it. So the runtime stays stale. So template-vs-CLI mismatches accumulate. So `/build` breaks with a misleading error and an investigating agent reaches the wrong root cause.

This design eliminates the failure class by moving the runtime to the structurally intended state: a `.git`-less rsync mirror with cross-editing mechanically blocked.

---

## Goal & non-goals

**Goal.** Move `~/.claude/skills/gstack/` from "diverged dev clone with stash mess" to "clean rsynced install with no `.git`," using the deploy mechanism `/gstack-upgrade` already implements. Rescue irreplaceable work first; update CLAUDE.md so the next person doesn't recreate the broken pattern; add one structural guardrail.

**Non-goals.**

- **New `gstack-deploy` script.** The user rejected this in Q3. `rsync` invoked directly (or via `/gstack-upgrade`) is enough. No new code surface.
- **Skill-template-vs-CLI-flag drift detector** (the original Phase 4 of the predecessor plan). With no `.git` in the runtime, the runtime's content is mechanically a copy of source — that specific drift class disappears. The `.git` check in §4c is the drift detector in its more fundamental form.
- **Migrating other hosts** (codex, factory, opencode, kiro). Same pattern applies but the user only has broken state on claude. Out of scope.
- **Preserving `feat/living-plan-step-visibility`.** Already merged in source as commit `27e810f5`. Safe to drop.
- **Bisecting why the runtime ended up as a separate git clone** (vs an rsync mirror). The user's documented setup pattern shows the rsync mirror is the intent; how it diverged is archaeology. Forward-fix only.

---

## Architecture

Two trees, one of them mechanically derived from the other:

```
SOURCE (editable, full git):
  /Users/anbang/Documents/Antigravity/claude-workspace/gstack
  remotes: fork (anbangr/gstack), github (garrytan/gstack), upstream
  HEAD: 6b1b1de0 (main)
  This is where ALL development happens.

         │
         │  rsync -a --delete --exclude '.git'
         │  (manual, or via /gstack-upgrade)
         ▼

RUNTIME (read-only-by-convention, no git):
  ~/.claude/skills/gstack/
  no .git directory                  ← load-bearing structural guardrail
  content is a byte-mirror of source
  This is what Claude actually executes.
```

The `--exclude '.git'` is the structural guardrail. Without `.git`, git operations in the runtime fail immediately:

```
$ cd ~/.claude/skills/gstack && git status
fatal: not a git repository (or any of the parent directories): .git
```

A user (or another agent) attempting to `git add` / `git commit` / `git stash` / clone into the runtime will hit this error within seconds and notice the structural rule. The current failure mode — silent partial deploys, uncommitted hand-edits that look identical to source — becomes mechanically impossible.

---

## Components

### Section 1: Rescue triage

Before any destructive step, capture irreplaceable work from the active skill.

**Triage table** (from investigation in the brainstorm):

| Item                                                                                                        | Status                                               | Action                                                    |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| 18 of 19 uncommitted file mods                                                                              | Byte-identical to source HEAD — git index drift only | Discard with runtime                                      |
| `ship/SKILL.md` (2-line `--query` filter on learnings-search calls)                                         | Genuinely diverges from source                       | Save diff to `/tmp/`; evaluate later for upstream landing |
| Untracked `bin/gstack-skill-learned-faults`                                                                 | Exists identically in source                         | Discard with runtime                                      |
| Stash@{0} (`safer-stale-branch-handling`, 10 files, 165+ insertions, includes cli.ts/phase-runner.ts/tests) | Real WIP                                             | Export to patch; import as branch in source               |
| Stash@{1} (`GSTACK_PLAYBOOK.md`, 102 lines)                                                                 | Doc work                                             | Export to patch; diff against source; decide              |
| Stash@{2} (`CLAUDE.md`, 3 lines from /checkpoint rename)                                                    | Almost certainly obsolete                            | Export to patch; eyeball; likely discard                  |
| `feat/living-plan-step-visibility` branch                                                                   | Merged in source as `27e810f5`                       | Discard with runtime                                      |

**Rescue commands:**

```bash
# Save the one real file diff
git -C ~/.claude/skills/gstack diff ship/SKILL.md \
  > /tmp/active-skill-ship-skill-md.patch

# Export every stash as a patch
for i in 0 1 2; do
  git -C ~/.claude/skills/gstack stash show -p "stash@{$i}" \
    > "/tmp/active-skill-stash-${i}.patch"
done

# Full tarball snapshot — insurance against missing something
tar -czf "/tmp/active-skill-full-backup-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C ~/.claude/skills/ gstack
```

After completion: from source repo, create `rescue/active-skill-stash-0` branch, apply `/tmp/active-skill-stash-0.patch`, evaluate whether to keep. Repeat for other patches. Keep the tarball for one week as insurance, then delete.

### Section 2: Deploy

**2a. Sanity check no concurrent process is using the runtime.**

```bash
pgrep -lf "~/.claude/skills/gstack" 2>&1 | grep -v grep || echo "clean"
pgrep -lf "bun.*orchestrator/cli" 2>&1 | grep -v grep || echo "clean"
```

Both should be empty before the swap. Background `claude` processes are fine — they only touch the active skill when running a skill, not continuously.

**2b. Atomic swap.**

```bash
SRC=/Users/anbang/Documents/Antigravity/claude-workspace/gstack
DST=~/.claude/skills/gstack
TS=$(date +%Y%m%d-%H%M%S)

# Move old out of the way (one inode rename, atomic from a reader's POV)
mv "$DST" "${DST}.broken-${TS}"

# Rsync new (no .git — runtime is git-less by construction)
rsync -a --delete --exclude '.git' "$SRC/" "$DST/"

# Restore world-readable perms
# (./setup uses umask 077; runtime needs to be readable by all session processes)
chmod -R go+rX "$DST"
```

`mv`-then-`rsync` (vs `rsync` over the live dir): rsync updates files in non-deterministic order; an in-flight skill read could see a partially-updated tree. `mv` renames atomically — old tree becomes invisible at the path in a single operation. An in-flight read would fail cleanly with "file not found," not "garbled content."

**2c. Rebuild & verify.**

The launcher `bin/gstack-build` is a thin bash wrapper that `bun run`s `build/orchestrator/cli.ts` — no compile step. The browse and design binaries (`browse/dist/browse`, `design/dist/design`) ride along with rsync since they're tracked in the source repo. Verification:

```bash
# 1. Runtime is not a git repo (load-bearing structural guardrail)
[ ! -d ~/.claude/skills/gstack/.git ] && echo "OK: no .git" || echo "FAIL: .git present"

# 2. Original failing flag works
~/.claude/skills/gstack/bin/gstack-build --help 2>&1 | grep -q "single-branch" && \
  echo "OK: --single-branch in help" || echo "FAIL"

# 3. Existing symlink chain unbroken
/Users/anbang/.local/bin/gstack-build --help 2>&1 | grep -q "single-branch" && \
  echo "OK: installed launcher resolves" || echo "FAIL"

# 4. Sibling skill dirs still resolve
ls -la ~/.claude/skills/qa/SKILL.md ~/.claude/skills/ship/SKILL.md 2>&1 | head -2
```

If check 4 fails (symlinks broken because `./setup` was run from the runtime, not from source), run `./setup` from the source dir. Track as **2d (conditional)**.

**2d (conditional). Re-run `./setup` from source if check 4 fails.**

```bash
cd /Users/anbang/Documents/Antigravity/claude-workspace/gstack
./setup
```

This recreates the sibling-skill symlinks under `~/.claude/skills/` pointing into the (now correct) `gstack/` runtime.

### Section 3: Documentation update

Edit `CLAUDE.md` in source (under "Deploying to the active skill" section):

**Replace this:**

```markdown
## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`
```

**With this:**

```markdown
## Deploying to the active skill

The active skill at `~/.claude/skills/gstack/` is a clean rsync of this source
repo with no `.git` — by design. **Do not git-clone into it, do not edit it
directly, do not commit there.** All changes happen here in the source repo.

To deploy a change from source to active skill:

    rsync -a --delete --exclude '.git' \
      /Users/anbang/Documents/Antigravity/claude-workspace/gstack/ \
      ~/.claude/skills/gstack/

This is the same mechanism `/gstack-upgrade` uses. If you upgrade from upstream
via `/gstack-upgrade`, that overwrites your local source changes — push your
source branch first.

**Why no `.git` in the runtime:** the runtime is downstream of source. A git
repo there invites cross-editing, stash mess, partial deploys, and the
"skill template references CLI flag that the runtime CLI doesn't parse" failure
class. Keeping it git-less makes those structurally impossible.
```

Also tighten "Dev symlink awareness" by half a sentence: when a separate source clone exists, the symlink path is no longer interchangeable with the global-install path; rsync is the canonical deploy. Symlink remains valid for users who don't maintain a separate source clone.

### Section 4: Structural guardrail

Add ~10 lines to `bin/gstack-update-check` (already runs at every skill start, output goes to preamble):

```bash
if [ -d "$HOME/.claude/skills/gstack/.git" ]; then
  echo "WARNING: gstack runtime has .git — this should not be." >&2
  echo "  The runtime is supposed to be a clean rsync downstream of source." >&2
  echo "  See CLAUDE.md → 'Deploying to the active skill'." >&2
fi
```

**Informational, not blocking.** Exit 0. Catches: (1) future accidental `git clone` into runtime, (2) teammate setting up wrong, (3) `/gstack-upgrade` regressing on the rsync path. Single signal, single failure mode, lives in a script already on the hot path. Blocking would risk crashing the preamble bash and breaking unrelated skill starts — visibility is enough.

---

## Data flow

```
1. Rescue:    runtime/diff + stashes ──> /tmp/*.patch + tarball
2. Triage:    /tmp/*.patch ──> rescue branches in source (decide later)
3. Swap:      runtime ──[mv]──> runtime.broken-{ts} (read-only snapshot)
              source ──[rsync --exclude .git]──> runtime
4. Verify:    no .git in runtime, --single-branch in --help, symlinks intact
5. Doc:       CLAUDE.md updated (rsync command + no-git rule + symlink section)
6. Guardrail: bin/gstack-update-check warns on .git presence (informational)
```

---

## Error handling

| Error                                                | Cause                                                  | Response                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Verification check 2 fails                           | rsync didn't actually overwrite cli.ts                 | Re-run rsync; check `--exclude` syntax; check src path                                                              |
| Verification check 3 fails                           | `/Users/anbang/.local/bin/gstack-build` symlink broken | `ls -la /Users/anbang/.local/bin/gstack-build` to see what it points to; restore symlink                            |
| Verification check 4 fails                           | Sibling skill symlinks broken by old setup paths       | Run `./setup` from source dir (step 2d)                                                                             |
| `mv` fails                                           | Concurrent process holding open file in runtime        | Wait, retry. If persists: identify process with `lsof +D ~/.claude/skills/gstack`                                   |
| `rsync` fails partway                                | Disk full, perms, network if NFS mounted               | Source is unchanged; remove `~/.claude/skills/gstack` and rerun. `runtime.broken-{ts}` still exists for diagnostics |
| Stash export fails                                   | Stash already dropped, ref invalid                     | Skip; tarball still has full content if needed                                                                      |
| User decides one rescued patch should land in source | Patch is dirty, doesn't apply cleanly                  | Resolve conflicts manually in the rescue branch; standard git workflow                                              |

---

## Testing

Manual end-to-end verification (this is one-time migration, not ongoing code — no unit tests warranted):

1. **Pre-change verification (capture baseline).** Run `~/.claude/skills/gstack/bin/gstack-build --help` and confirm `--single-branch` is absent. Confirm `git -C ~/.claude/skills/gstack status` shows the 19 mods.
2. **Rescue patches saved.** Confirm 4 files exist in `/tmp/`: 3 stash patches + 1 ship/SKILL.md diff, plus the tarball. Confirm each is non-empty and applies cleanly to source via `git apply --check`.
3. **Post-swap verification.** Run all four verification checks from §2c. All four must pass.
4. **Skill round-trip.** From a fresh shell, invoke a simple skill (`/health` or a no-op) and confirm the preamble prints normally. Then run `~/.claude/skills/gstack/bin/gstack-build --help` and confirm `--single-branch` is listed; for an end-to-end parse test, run `gstack-build /tmp/throwaway-plan.md --single-branch --dry-run` and confirm parseArgs accepts the flag (any failure should be from missing/empty plan, NOT "unknown flag").
5. **Guardrail fires.** After the swap and the guardrail edit, manually `mkdir ~/.claude/skills/gstack/.git`, run any skill, confirm the warning appears in the preamble. Remove the dummy `.git` dir. (The guardrail edit ships in source and reaches runtime on a future rsync — verify on source first by running `bin/gstack-update-check` directly.)
6. **Documentation correctness.** Read the updated CLAUDE.md section out loud. Does it correctly describe what the runtime is? Does the rsync command, copy-pasted into a terminal, work?

---

## Open decisions deferred to plan time

- **Order of operations between source-side doc edit and runtime swap.** Doing the doc edit first means the rsync that follows will bring the new CLAUDE.md to runtime in one operation; doing it after means an extra rsync. Probably doc first — fewer steps, no race. Plan will lock this in.
- **Whether `./setup` re-run is preemptive or conditional.** Spec says conditional (2d); plan can revisit if the symlink check is cheap enough to always run.
- **Disposition of the 3 rescue patches.** Spec defers — they go to `/tmp/`, the user decides later. Plan will document the decision criteria for each one but not force a choice.
