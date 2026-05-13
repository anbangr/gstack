# Design: Fork-Copy Upgrade Flow

**Date:** 2026-05-13
**Status:** Approved
**Branch:** feat/multi-host-upgrade-sync

## Problem

The current `/gstack-upgrade` flow for git installs merges upstream directly into
`~/.claude/skills/gstack`, which is a live git clone. This creates an isolation gap:
changes made in the dev fork (`claude-workspace/gstack`) and changes in the install
clone are two separate histories that drift apart. There is no clean way to say "the
installed skills only change when I explicitly run an upgrade."

Additionally, Gemini and Kimi receive file copies from the installed dir, while Codex
is handled by `./setup --host auto`. The asymmetry means each host has a different
update mechanism with different guarantees.

## Goal

- `claude-workspace/gstack` is the isolated dev fork. Changes there never affect
  running skills until an explicit `/gstack-upgrade` run.
- `~/.claude/skills/gstack` is a plain copy (no `.git/`), replaced atomically on
  each upgrade via `rsync`.
- Every registered host (Claude, Codex, Kiro, Factory, OpenCode) is reinstalled
  explicitly from the install dir on each upgrade.
- Gemini and Kimi get explicit file copies from the install dir (same as today, just
  sourced from the copy rather than a live path).

## Design

### New install type: `fork-copy`

Detected in Step 2 of the upgrade skill, highest priority (before existing git-clone
detection):

```bash
_FORK_PATH=$(~/.claude/skills/gstack/bin/gstack-config get fork_repo_path 2>/dev/null || echo "")
if [ -n "$_FORK_PATH" ] && [ -d "$_FORK_PATH/.git" ]; then
  INSTALL_TYPE="fork-copy"
  INSTALL_DIR="$HOME/.claude/skills/gstack"
  FORK_REPO="$_FORK_PATH"
fi
```

`fork_repo_path` is already in `~/.gstack/config.yaml`. The `.git` check confirms it
is a real repo. If `fork_repo_path` is unset or the path has no `.git`, detection
falls through to existing logic — all other users are unaffected.

### Step 4: Fork-copy upgrade path

A new "For fork-copy installs" block inserted before the existing git-install block.
Six sequential phases:

**Phase 1 — Upstream pull (in fork)**

Scan remotes for one pointing at `garrytan/gstack`. Try `upstream`, `github`, `origin`
in order. If found, `git fetch` + `git merge --no-edit`. Merge conflict → error and
stop. If no upstream remote found → warn and continue (user may want to install
current fork state without pulling).

**Phase 2 — Fork integrations**

```bash
bun run gen:skill-docs --host all
bun run skill:check
```

Generates host-specific SKILL.md files (openai.yaml for Codex, path-rewritten files
for Kiro, etc.) inside the fork before the copy. The copy will contain all generated
artifacts.

**Phase 3 — Integration tests (gate)**

```bash
bun test
```

Abort on failure. The install dir is not touched until tests pass.

**Phase 4 — Copy to install dir**

```bash
# One-time migration notice if install is currently a git clone
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "NOTE: Converting $INSTALL_DIR from git clone to plain copy."
  echo "Fork git history stays in $FORK_REPO."
fi
mkdir -p "$INSTALL_DIR"
rsync -a --delete --exclude '.git' "$FORK_REPO/" "$INSTALL_DIR/"
```

`rsync --delete` removes files no longer in the fork. `--exclude '.git'` means the
fork's `.git/` is not copied — and because the destination's `.git/` is not in the
source, `--delete` removes it from the destination, converting a git clone to a plain
copy automatically on first run.

**Phase 5 — Explicit per-host setup**

```bash
cd "$INSTALL_DIR"
./setup --host claude
command -v codex    >/dev/null 2>&1 && ./setup --host codex
command -v kiro-cli >/dev/null 2>&1 && ./setup --host kiro
command -v droid    >/dev/null 2>&1 && ./setup --host factory
command -v opencode >/dev/null 2>&1 && ./setup --host opencode
```

Each host gets a full setup run from the install dir. Codex receives its proper
`openai.yaml` per-skill dirs. New future hosts that are registered in setup are
picked up automatically once they are on PATH.

**Step 4.9 — Gemini and Kimi explicit copies**

Unchanged in behavior. Sourced from `$INSTALL_DIR` (the fresh copy) rather than
a live symlink. Same `cp` loop as today.

### Steps skipped for fork-copy type

| Step                         | Reason                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| 4.5 (local vendored sync)    | Not applicable — install dir is a copy, not a vendored project file |
| 4.6 (post-merge skill:check) | Already ran in Phase 2 before the copy                              |
| 4.8 (fork overlay)           | Fork IS the source; all customizations are in the fork already      |

These steps annotate themselves with "Skip for fork-copy installs" so the logic
is visible when reading the skill.

### Standalone usage update

When `/gstack-upgrade` is invoked directly (not from a preamble) and
`INSTALL_TYPE=fork-copy`: run the full fork-copy upgrade path from Step 4 regardless
of whether upstream has a new version. This makes "install my current fork state
everywhere" the primary standalone action.

## Files Changed

| File                           | Change                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `gstack-upgrade/SKILL.md.tmpl` | New fork-copy detection in Step 2; new Step 4 fork-copy block; skip annotations on 4.5/4.6/4.8; standalone usage tail update |
| `gstack-upgrade/SKILL.md`      | Regenerated from template (`bun run gen:skill-docs`)                                                                         |

No new files, no migration scripts. The rsync handles the git-clone → plain-copy
conversion on first run automatically.

## Backwards Compatibility

Zero changes to `global-git`, `local-git`, `vendored`, and `vendored-global` upgrade
paths. If `fork_repo_path` is not set, everything runs exactly as before.

## Verification

```bash
# 1. Edit template, regenerate
bun run gen:skill-docs
bun run skill:check
bun test

# 2. Run upgrade (with fork_repo_path set)
# /gstack-upgrade

# 3. Verify plain copy (no .git)
ls ~/.claude/skills/gstack/.git   # should not exist

# 4. Verify per-host installs
ls ~/.codex/skills/ | grep gstack  # should show 50+ gstack-* skill dirs with openai.yaml
ls ~/.gemini/skills/gstack/        # should have SKILL.md updated from install dir
ls ~/.kimi/skills/gstack/          # same

# 5. Verify isolation
echo "test" >> claude-workspace/gstack/SKILL.md.tmpl
cat ~/.claude/skills/gstack/SKILL.md.tmpl   # should NOT contain "test"
git checkout -- claude-workspace/gstack/SKILL.md.tmpl
```
