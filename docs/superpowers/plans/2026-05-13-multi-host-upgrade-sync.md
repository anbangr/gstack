# Multi-Host Upgrade Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `gstack-upgrade` so it keeps all installed agent hosts (Codex, Kiro, Factory, OpenCode) in sync — not just Claude — and warn when bare `./setup` would silently skip other hosts.

**Architecture:** Three targeted changes: (1) the upgrade template passes `--host auto` to `./setup` so every installed agent is updated; (2) a migration script re-syncs hosts on the next upgrade for users already broken; (3) a warning guard in `setup` catches future bare-invocation misses. Immediate remediation runs first so Codex works before code lands.

**Tech Stack:** Bash, gstack setup script, SKILL.md template system (`bun run gen:skill-docs`)

---

### Task 0: Immediate remediation — restore Codex skills now

**Files:**

- (No file edits — runtime command only)

- [ ] **Step 1: Verify the broken state**

```bash
ls ~/.codex/skills/ | grep gstack
```

Expected: only `gstack` — no `gstack-build`, `gstack-investigate`, etc.

- [ ] **Step 2: Run setup for all hosts**

```bash
cd ~/.claude/skills/gstack && ./setup --host auto
```

Expected output: lines like `linked skills: gstack-autoplan gstack-benchmark ...`

- [ ] **Step 3: Verify Codex skills are now present**

```bash
ls ~/.codex/skills/ | grep gstack | wc -l
```

Expected: 50 or more entries.

---

### Task 1: Fix the upgrade template — pass `--host auto` to `./setup`

**Files:**

- Modify: `gstack-upgrade/SKILL.md.tmpl` (lines 148, 155, 160, 200, 246, 251)

- [ ] **Step 1: Confirm current broken state in template**

```bash
grep -n "\./setup" /Users/anbang/.claude/skills/gstack/gstack-upgrade/SKILL.md.tmpl
```

Expected: lines 148, 155, 160, 200, 246, 251 all show bare `./setup` with no `--host` flag.

- [ ] **Step 2: Fix line 148 — git conflict error message**

In `gstack-upgrade/SKILL.md.tmpl`, change line 148:

```
# Before
  echo "Resolve conflicts, run ./setup, then rerun /gstack-upgrade if needed."

# After
  echo "Resolve conflicts, run ./setup --host auto, then rerun /gstack-upgrade if needed."
```

- [ ] **Step 3: Fix line 155 — stash-pop error message**

Change line 155:

```
# Before
    echo "Resolve conflicts in $INSTALL_DIR, run ./setup, then rerun /gstack-upgrade if needed."

# After
    echo "Resolve conflicts in $INSTALL_DIR, run ./setup --host auto, then rerun /gstack-upgrade if needed."
```

- [ ] **Step 4: Fix line 160 — git install `./setup` call**

Change line 160:

```bash
# Before
if ! ./setup; then

# After
if ! ./setup --host auto; then
```

- [ ] **Step 5: Fix line 200 — vendored install `./setup` call**

Change line 200:

```bash
# Before
if ! (cd "$INSTALL_DIR" && ./setup); then

# After
if ! (cd "$INSTALL_DIR" && ./setup --host auto); then
```

- [ ] **Step 6: Fix line 246 — local vendored copy `./setup` call**

Change line 246:

```bash
# Before
cd "$LOCAL_GSTACK" && ./setup

# After
cd "$LOCAL_GSTACK" && ./setup --host auto
```

- [ ] **Step 7: Fix line 251 prose — sync-failed message**

Change line 251 (inside the "If `./setup` fails" prose block — note this is markdown prose, not a code block):

```
# Before
Tell user: "Sync failed — restored previous version at `$LOCAL_GSTACK`. Run `/gstack-upgrade` manually to retry."

# After
Tell user: "Sync failed — restored previous version at `$LOCAL_GSTACK`. Run `cd $INSTALL_DIR && ./setup --host auto`, then retry `/gstack-upgrade`."
```

- [ ] **Step 8: Verify all six occurrences are updated**

```bash
grep -n "\./setup" /Users/anbang/.claude/skills/gstack/gstack-upgrade/SKILL.md.tmpl
```

Expected: every match now includes `--host auto`. Zero bare `./setup` calls remain.

- [ ] **Step 9: Commit the template change**

```bash
cd /Users/anbang/.claude/skills/gstack
git add gstack-upgrade/SKILL.md.tmpl
git commit -m "fix(upgrade): pass --host auto to ./setup so all installed agent hosts stay in sync"
```

---

### Task 2: Create the migration script

**Files:**

- Create: `gstack-upgrade/migrations/v1.32.1.0.sh`

- [ ] **Step 1: Create the migration file**

Create `/Users/anbang/.claude/skills/gstack/gstack-upgrade/migrations/v1.32.1.0.sh` with this exact content:

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

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Users/anbang/.claude/skills/gstack/gstack-upgrade/migrations/v1.32.1.0.sh
```

- [ ] **Step 3: Dry-run the migration (skip path)**

Temporarily rename the codex dir to test the skip path:

```bash
mv ~/.codex/skills/gstack ~/.codex/skills/gstack.test-bak
bash /Users/anbang/.claude/skills/gstack/gstack-upgrade/migrations/v1.32.1.0.sh
mv ~/.codex/skills/gstack.test-bak ~/.codex/skills/gstack
```

Expected output: `  [v1.32.1.0] No additional host installs — skipping.`

- [ ] **Step 4: Run the migration for real**

```bash
bash /Users/anbang/.claude/skills/gstack/gstack-upgrade/migrations/v1.32.1.0.sh
```

Expected output: `  [v1.32.1.0] Re-syncing all installed agent hosts...` followed by setup output.

- [ ] **Step 5: Commit the migration**

```bash
cd /Users/anbang/.claude/skills/gstack
git add gstack-upgrade/migrations/v1.32.1.0.sh
git commit -m "fix(upgrade): add v1.32.1.0 migration to re-sync all installed agent hosts"
```

---

### Task 3: Add the multi-host warning guard to `setup`

**Files:**

- Modify: `setup` (insert after line 221, before line 223)

- [ ] **Step 1: Verify the insertion point**

```bash
sed -n '219,225p' /Users/anbang/.claude/skills/gstack/setup
```

Expected output:

```
    ) >/dev/null 2>&1
  fi
}

# 1. Build browse binary if needed (smart rebuild: stale sources, package.json, lock)
NEEDS_BUILD=0
if [ ! -x "$BROWSE_BIN" ]; then
```

The blank line at 222 is the insertion point — guard goes between line 221 (`}`) and line 223 (`# 1. Build browse binary...`).

- [ ] **Step 2: Insert the warning guard**

In `setup`, replace the blank line between line 221 and line 223 with the guard block. The content after `}` closing `ensure_playwright_browser` and before `# 1. Build browse binary` should become:

```bash
}

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

# 1. Build browse binary if needed (smart rebuild: stale sources, package.json, lock)
```

- [ ] **Step 3: Verify the guard syntax is valid bash**

```bash
bash -n /Users/anbang/.claude/skills/gstack/setup
```

Expected: no output, exit code 0.

- [ ] **Step 4: Test the warning fires**

```bash
cd /Users/anbang/.claude/skills/gstack && ./setup 2>&1 | grep -i "warning"
```

Expected: `warning: existing installs for codex won't be updated.` (because `~/.codex/skills/gstack` exists).

- [ ] **Step 5: Commit the setup guard**

```bash
cd /Users/anbang/.claude/skills/gstack
git add setup
git commit -m "fix(setup): warn when claude-only run would silently skip other installed agent hosts"
```

---

### Task 4: Regenerate `gstack-upgrade/SKILL.md` and validate

**Files:**

- Modify: `gstack-upgrade/SKILL.md` (regenerated, do not hand-edit)

- [ ] **Step 1: Regenerate all SKILL.md files from templates**

```bash
cd /Users/anbang/.claude/skills/gstack && bun run gen:skill-docs
```

Expected: completes without errors, lists generated files.

- [ ] **Step 2: Confirm the generated file reflects `--host auto`**

```bash
grep -n "\./setup" /Users/anbang/.claude/skills/gstack/gstack-upgrade/SKILL.md | head -20
```

Expected: every match includes `--host auto`. Zero bare `./setup` remain.

- [ ] **Step 3: Run the free test suite**

```bash
cd /Users/anbang/.claude/skills/gstack && bun test
```

Expected: all tests pass, no failures.

- [ ] **Step 4: Commit the regenerated SKILL.md**

```bash
cd /Users/anbang/.claude/skills/gstack
git add gstack-upgrade/SKILL.md
git commit -m "chore(docs): regenerate gstack-upgrade/SKILL.md after --host auto fix"
```

---

### Task 5: Final verification

- [ ] **Step 1: Confirm Codex skill count**

```bash
ls ~/.codex/skills/ | grep "^gstack" | wc -l
```

Expected: 50 or more.

- [ ] **Step 2: Spot-check a specific skill is present**

```bash
ls ~/.codex/skills/gstack-build/SKILL.md
```

Expected: file exists (is a symlink into `.agents/skills/gstack-build/SKILL.md`).

- [ ] **Step 3: Confirm migration is idempotent**

```bash
bash /Users/anbang/.claude/skills/gstack/gstack-upgrade/migrations/v1.32.1.0.sh
```

Expected: runs cleanly a second time without errors. `link_codex_skill_dirs` skips existing symlinks.

- [ ] **Step 4: Confirm no regressions**

```bash
cd /Users/anbang/.claude/skills/gstack && bun test
```

Expected: all tests pass.
