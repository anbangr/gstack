# Design: Multi-host upgrade sync

**Date:** 2026-05-13
**Status:** Approved

## Problem

After running `/gstack-upgrade`, only the Claude host is updated. All other installed
agent hosts (Codex, Kiro, Factory, OpenCode) are silently skipped. Concretely:
`~/.codex/skills/` ends up with only `gstack` and `gstack-upgrade` — none of the 50+
individual `gstack-*` skill symlinks (`gstack-build`, `gstack-investigate`, etc.) that
`link_codex_skill_dirs` would create.

## Root Cause

`gstack-upgrade/SKILL.md.tmpl` calls `./setup` without a `--host` flag. The `setup`
script defaults to `HOST="claude"`, sets `INSTALL_CODEX=0`, and skips every
non-claude host installation path, including `link_codex_skill_dirs`.

**Affected calls in `gstack-upgrade/SKILL.md.tmpl`:**

- Line 160: git install path — `if ! ./setup; then`
- Line 200: vendored install path — `if ! (cd "$INSTALL_DIR" && ./setup); then`
- Line 246: local vendored sync — `cd "$LOCAL_GSTACK" && ./setup`

## Design

### Change 1: `gstack-upgrade/SKILL.md.tmpl` — use `--host auto`

Replace all three `./setup` calls with `./setup --host auto`. Also update the
matching prose error messages (lines 148, 155, 251) for consistency.

`--host auto` detects which agents are on PATH (`command -v codex`, `command -v
kiro-cli`, etc.) and sets `INSTALL_*=1` for each. If codex isn't installed, nothing
changes. If it is, `link_codex_skill_dirs` runs and creates/updates all `gstack-*`
symlinks in `~/.codex/skills/`.

**Exact line changes:**

| Location               | Before                          | After                                       |
| ---------------------- | ------------------------------- | ------------------------------------------- |
| Line 148 (prose)       | `run ./setup,`                  | `run ./setup --host auto,`                  |
| Line 155 (prose)       | `run ./setup, then`             | `run ./setup --host auto, then`             |
| Line 160 (git install) | `if ! ./setup; then`            | `if ! ./setup --host auto; then`            |
| Line 200 (vendored)    | `&& ./setup); then`             | `&& ./setup --host auto); then`             |
| Line 246 (local copy)  | `cd "$LOCAL_GSTACK" && ./setup` | `cd "$LOCAL_GSTACK" && ./setup --host auto` |
| Line 251 (prose)       | `run ./setup`                   | `run ./setup --host auto`                   |

After changes: regenerate `gstack-upgrade/SKILL.md` with `bun run gen:skill-docs`.

### Change 2: `gstack-upgrade/migrations/v1.32.1.0.sh` — new migration

Fixes existing broken installs automatically for users who already upgraded past the
broken point. Version `1.32.1.0` falls between the current installed version
(`1.32.0.0`) and upstream (`1.33.2.0`), so it fires on the next upgrade run.

```bash
#!/usr/bin/env bash
# Migration: v1.32.1.0 — Re-setup all installed agent hosts
#
# gstack-upgrade previously ran ./setup without --host, so only the claude host
# was updated after each upgrade. This re-runs ./setup --host auto to create
# or update skill symlinks for all installed agents (codex, kiro, factory, opencode).
#
# Idempotent: link_codex_skill_dirs only creates symlinks when target is absent
# or already a symlink. Safe to re-run.
set -euo pipefail

INSTALL_DIR="${HOME}/.claude/skills/gstack"

[ -f "$INSTALL_DIR/setup" ] || { echo "  [v1.32.1.0] gstack not at expected path — skipping."; exit 0; }

# Only run if at least one non-claude host install dir exists
NEEDS_RUN=0
for host_dir in \
  "${HOME}/.codex/skills/gstack" \
  "${HOME}/.kiro/skills/gstack" \
  "${HOME}/.factory/skills/gstack" \
  "${HOME}/.config/opencode/skills/gstack"; do
  [ -d "$host_dir" ] && NEEDS_RUN=1 && break
done

[ "$NEEDS_RUN" -eq 0 ] && { echo "  [v1.32.1.0] No additional host installs — skipping."; exit 0; }

echo "  [v1.32.1.0] Re-syncing all installed agent hosts..."
(cd "$INSTALL_DIR" && ./setup --host auto -q) || \
  echo "  [v1.32.1.0] Failed — run manually: cd $INSTALL_DIR && ./setup --host auto" >&2
```

### Change 3: `setup` — multi-host warning guard

Add a warning block after line 221 (end of `ensure_playwright_browser` function),
before line 223 (`# 1. Build browse binary if needed`). This is after all function
definitions and the `migrate_direct_codex_install` call, so all variables are set and
`log` is defined. Fires when `HOST=claude` (the default) and other host install dirs
already exist on disk.

```bash
# Guard: warn when running claude-only but other host installs exist
if [ "$HOST" = "claude" ]; then
  _WARN_HOSTS=()
  [ -d "$HOME/.codex/skills/gstack" ] && _WARN_HOSTS+=("codex")
  [ -d "$HOME/.kiro/skills/gstack" ] && _WARN_HOSTS+=("kiro")
  [ -d "$HOME/.factory/skills/gstack" ] && _WARN_HOSTS+=("factory")
  [ -d "$HOME/.config/opencode/skills/gstack" ] && _WARN_HOSTS+=("opencode")
  if [ ${#_WARN_HOSTS[@]} -gt 0 ]; then
    log "warning: existing installs for ${_WARN_HOSTS[*]} won't be updated."
    log "         Run './setup --host auto' to update all installed agents."
  fi
fi
```

Warning only — does not block, does not change behavior.

## Files Changed

| File                                     | Change                                                     |
| ---------------------------------------- | ---------------------------------------------------------- |
| `gstack-upgrade/SKILL.md.tmpl`           | `./setup` → `./setup --host auto` (3 calls + 3 prose refs) |
| `gstack-upgrade/SKILL.md`                | Regenerated from template — do not edit directly           |
| `gstack-upgrade/migrations/v1.32.1.0.sh` | New migration script                                       |
| `setup`                                  | Multi-host warning guard added                             |

## Immediate Remediation (before code lands)

```bash
cd ~/.claude/skills/gstack && ./setup --host auto
```

Run once to restore all `gstack-*` symlinks in `~/.codex/skills/` right now.

## Verification

1. Immediate fix: `ls ~/.codex/skills/ | grep gstack` — should show 50+ entries
2. Open Codex, ask "what gstack skills do you have?" — `gstack-build`, `gstack-investigate`, etc. should appear
3. After code changes: `bun test` (free, <2s) to confirm skill validation passes
4. Run `bun run gen:skill-docs` and verify `gstack-upgrade/SKILL.md` reflects `--host auto`
5. Test the warning: run bare `./setup` with codex installed — warning should appear
6. Test the migration: run the migration script directly with `bash gstack-upgrade/migrations/v1.32.1.0.sh` — should re-sync hosts
