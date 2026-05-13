# Fork-Copy Upgrade Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `fork-copy` upgrade path to `/gstack-upgrade` so that changes in `claude-workspace/gstack` (the dev fork) never affect running skills until an explicit upgrade run.

**Architecture:** Edit `gstack-upgrade/SKILL.md.tmpl` in four targeted changes: (1) add `fork-copy` detection to Step 2, (2) add the fork-copy upgrade block to Step 4, (3) annotate Steps 4.6 and 4.8 to skip when `fork-copy`, (4) update the standalone usage section. Then regenerate `gstack-upgrade/SKILL.md` via `bun run gen:skill-docs`.

**Tech Stack:** Bash template text (SKILL.md.tmpl), `bun run gen:skill-docs`, `bun run skill:check`, `bun test`

---

## File Map

| File                           | Change                                       |
| ------------------------------ | -------------------------------------------- |
| `gstack-upgrade/SKILL.md.tmpl` | Four edits (Tasks 1–4)                       |
| `gstack-upgrade/SKILL.md`      | Regenerated in Task 5 — do not edit directly |

---

### Task 1: Add `fork-copy` detection to Step 2

**Files:**

- Modify: `gstack-upgrade/SKILL.md.tmpl` lines 83–109 (the detection `if/elif` chain)

The existing detection block starts with:

```
if [ -d "$HOME/.claude/skills/gstack/.git" ]; then
```

Insert the fork-copy check (and its new opening brace for `elif`) BEFORE that line.

- [ ] **Step 1: Open the template and locate the detection block**

```bash
grep -n 'INSTALL_TYPE\|fork-copy\|global-git' gstack-upgrade/SKILL.md.tmpl | head -20
```

Expected: line ~84 shows `INSTALL_TYPE="global-git"` and line ~86 shows the `.git` check.

- [ ] **Step 2: Edit the detection block**

In `gstack-upgrade/SKILL.md.tmpl`, find this exact string (the opening of the detection `if` block):

```
if [ -d "$HOME/.claude/skills/gstack/.git" ]; then
  INSTALL_TYPE="global-git"
  INSTALL_DIR="$HOME/.claude/skills/gstack"
```

Replace it with:

```
_FORK_PATH=$(~/.claude/skills/gstack/bin/gstack-config get fork_repo_path 2>/dev/null || echo "")
if [ -n "$_FORK_PATH" ] && [ -d "$_FORK_PATH/.git" ]; then
  INSTALL_TYPE="fork-copy"
  INSTALL_DIR="$HOME/.claude/skills/gstack"
  FORK_REPO="$_FORK_PATH"
  echo "Install type: $INSTALL_TYPE | fork: $FORK_REPO | install: $INSTALL_DIR"
elif [ -d "$HOME/.claude/skills/gstack/.git" ]; then
  INSTALL_TYPE="global-git"
  INSTALL_DIR="$HOME/.claude/skills/gstack"
```

Also update the `echo` at the end of the block (the line that currently reads `echo "Install type: $INSTALL_TYPE at $INSTALL_DIR"`) — it only fires for non-fork-copy types now since fork-copy already echoed above. Leave it as-is; it will echo for all other types.

- [ ] **Step 3: Verify the change looks right**

```bash
grep -A 6 '_FORK_PATH' gstack-upgrade/SKILL.md.tmpl
```

Expected output starts with:

```
_FORK_PATH=$(~/.claude/skills/gstack/bin/gstack-config get fork_repo_path 2>/dev/null || echo "")
if [ -n "$_FORK_PATH" ] && [ -d "$_FORK_PATH/.git" ]; then
  INSTALL_TYPE="fork-copy"
```

- [ ] **Step 4: Commit**

```bash
git add gstack-upgrade/SKILL.md.tmpl
git commit -m "feat(upgrade): add fork-copy install type detection to Step 2"
```

---

### Task 2: Add fork-copy upgrade path block to Step 4

**Files:**

- Modify: `gstack-upgrade/SKILL.md.tmpl` — the Step 4 section

The Step 4 upgrade block currently has:

```
**For git installs** (global-git, local-git):
```

as the first upgrade variant. Insert the fork-copy block BEFORE it, after the "Core rule" paragraph.

- [ ] **Step 1: Locate the insertion point**

```bash
grep -n 'For git installs\|Core rule' gstack-upgrade/SKILL.md.tmpl
```

Expected: "Core rule:" on one line, "For git installs" a few lines later.

- [ ] **Step 2: Insert the fork-copy upgrade block**

Find this exact string in `gstack-upgrade/SKILL.md.tmpl`:

```
**For git installs** (global-git, local-git):
```

Insert the following block BEFORE it (keep an empty line between):

````markdown
**For fork-copy installs** (`INSTALL_TYPE=fork-copy`):

**Phase 1 — Upstream pull (in fork)**

```bash
cd "$FORK_REPO"
_UPSTREAM_REMOTE=""
for _r in upstream github origin; do
  _url=$(git remote get-url "$_r" 2>/dev/null || true)
  echo "$_url" | grep -q "garrytan/gstack" && { _UPSTREAM_REMOTE="$_r"; break; }
done
if [ -n "$_UPSTREAM_REMOTE" ]; then
  git fetch "$_UPSTREAM_REMOTE" main
  if ! git merge --no-edit "$_UPSTREAM_REMOTE/main"; then
    echo "ERROR: upstream merge conflict in $FORK_REPO. Resolve and rerun /gstack-upgrade."
    exit 1
  fi
  echo "Merged $_UPSTREAM_REMOTE/main into fork."
else
  echo "WARNING: no upstream garrytan/gstack remote found. Skipping upstream pull."
  echo "Add one with: git remote add upstream https://github.com/garrytan/gstack.git"
fi
```

**Phase 2 — Fork integrations**

```bash
cd "$FORK_REPO"
bun run gen:skill-docs --host all
bun run skill:check
```

**Phase 3 — Integration tests (abort on failure)**

```bash
cd "$FORK_REPO"
if ! bun test; then
  echo "ERROR: bun test failed in $FORK_REPO. Fix tests before installing."
  exit 1
fi
```

**Phase 4 — Copy to install dir (strips .git)**

```bash
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "NOTE: Converting $INSTALL_DIR from git clone to plain copy."
  echo "Fork git history stays in $FORK_REPO."
fi
mkdir -p "$INSTALL_DIR"
rsync -a --delete --exclude '.git' "$FORK_REPO/" "$INSTALL_DIR/"
echo "Copied fork → $INSTALL_DIR"
```

**Phase 5 — Explicit per-host setup from install dir**

```bash
cd "$INSTALL_DIR"
./setup --host claude
command -v codex    >/dev/null 2>&1 && ./setup --host codex
command -v kiro-cli >/dev/null 2>&1 && ./setup --host kiro
command -v droid    >/dev/null 2>&1 && ./setup --host factory
command -v opencode >/dev/null 2>&1 && ./setup --host opencode
```

Tell the user which hosts were set up.

Then continue to **Step 4.9** (Gemini and Kimi explicit copies). Skip Steps 4.5, 4.6, 4.8 — they do not apply to fork-copy installs (see skip annotations in those steps).
````

- [ ] **Step 3: Verify the block is in the right position**

```bash
grep -n 'For fork-copy\|For git installs\|For vendored' gstack-upgrade/SKILL.md.tmpl
```

Expected: `For fork-copy installs` appears BEFORE `For git installs`.

- [ ] **Step 4: Commit**

```bash
git add gstack-upgrade/SKILL.md.tmpl
git commit -m "feat(upgrade): add fork-copy upgrade path (6-phase block) to Step 4"
```

---

### Task 3: Annotate Steps 4.6 and 4.8 to skip for fork-copy

**Files:**

- Modify: `gstack-upgrade/SKILL.md.tmpl` — Steps 4.6 and 4.8

- [ ] **Step 1: Add skip annotation to Step 4.6**

Find this exact string in `gstack-upgrade/SKILL.md.tmpl`:

```
### Step 4.6: Regenerate and audit skill consistency

After the upstream merge and any local vendored sync, verify that the shared
```

Replace with:

```
### Step 4.6: Regenerate and audit skill consistency

**Skip for `fork-copy` installs** — `gen:skill-docs --host all` and `skill:check` already ran in the fork (Phase 2 of the fork-copy path) before the rsync copy. Jump to Step 4.75.

After the upstream merge and any local vendored sync, verify that the shared
```

- [ ] **Step 2: Add skip annotation to Step 4.8**

Find this exact string in `gstack-upgrade/SKILL.md.tmpl`:

```
### Step 4.8: Fork skill overlay

After migrations, overlay any custom SKILL.md.tmpl files from the user's configured fork repo onto the installed gstack, then regenerate all hosts. This ensures fork-local skill changes (e.g., custom build orchestration, added steps) survive upstream merges.
```

Replace with:

```
### Step 4.8: Fork skill overlay

**Skip for `fork-copy` installs** — the fork IS the source; all fork customizations are already in `$FORK_REPO` before the rsync copy. No overlay step needed. Jump to Step 4.9.

After migrations, overlay any custom SKILL.md.tmpl files from the user's configured fork repo onto the installed gstack, then regenerate all hosts. This ensures fork-local skill changes (e.g., custom build orchestration, added steps) survive upstream merges.
```

- [ ] **Step 3: Update the Step 4.9 Codex note**

Find this exact string in `gstack-upgrade/SKILL.md.tmpl`:

```
Note: Claude reads directly from `$INSTALL_DIR`. Codex's `~/.codex/skills/gstack/SKILL.md` is already symlinked to `$INSTALL_DIR/.agents/skills/gstack/SKILL.md` (set up by `./setup`), so it updates automatically when gen:skill-docs runs. Only gemini and kimi need explicit sync.
```

Replace with:

```
Note: Claude is served from `$INSTALL_DIR` directly. For `fork-copy` installs, Codex is reinstalled via `./setup --host codex` (Phase 5 of the fork-copy path), so its per-skill dirs and `openai.yaml` files are already current before this step. For all other install types, Codex updates automatically via the `./setup --host auto` call above. Gemini and Kimi always need explicit file copies and are handled below.
```

- [ ] **Step 4: Commit**

```bash
git add gstack-upgrade/SKILL.md.tmpl
git commit -m "feat(upgrade): annotate Steps 4.6/4.8 to skip for fork-copy; update 4.9 Codex note"
```

---

### Task 4: Update standalone usage section

**Files:**

- Modify: `gstack-upgrade/SKILL.md.tmpl` — the `## Standalone usage` section

The standalone section needs a fork-copy fast-path at the top: if `INSTALL_TYPE=fork-copy`, run the full fork-copy upgrade path and skip the version-check / vendored-copy logic below.

- [ ] **Step 1: Locate the standalone section**

```bash
grep -n 'Standalone usage\|Force a fresh update' gstack-upgrade/SKILL.md.tmpl
```

Expected: `## Standalone usage` followed a few lines later by `Force a fresh update check`.

- [ ] **Step 2: Add fork-copy fast-path to standalone usage**

Find this exact string in `gstack-upgrade/SKILL.md.tmpl`:

```
When invoked directly as `/gstack-upgrade` (not from a preamble):

1. Force a fresh update check (bypass cache):
```

Replace with:

```
When invoked directly as `/gstack-upgrade` (not from a preamble):

**First, run the Step 2 detection block** to determine `INSTALL_TYPE`, `INSTALL_DIR`, and (for fork-copy) `FORK_REPO`.

**If `INSTALL_TYPE=fork-copy`:** run the complete fork-copy upgrade path from Step 4 above (all five phases through the Step 4.9 Gemini/Kimi copies). This runs regardless of whether upstream has a new version — the standalone action for fork-copy is always "pull upstream into fork, gen, test, copy to install, set up all hosts." After completing Step 4.9, proceed to Step 5 (write marker + clear cache) and Step 6 (show what's new).

**For all other install types** (`global-git`, `local-git`, `vendored`, `vendored-global`), continue with the steps below:

1. Force a fresh update check (bypass cache):
```

- [ ] **Step 3: Update the item-4 fork overlay tail**

Find this exact string in `gstack-upgrade/SKILL.md.tmpl`:

```
4. After vendored copy handling, always run the fork skill overlay and multi-host sync:
```

Replace with:

```
4. After vendored copy handling, run the fork skill overlay and multi-host sync (applies to non-fork-copy installs only):
```

- [ ] **Step 4: Verify the standalone section structure**

```bash
grep -n 'INSTALL_TYPE=fork-copy\|fork-copy fast\|all other install' gstack-upgrade/SKILL.md.tmpl
```

Expected: the fork-copy fast-path text appears in the standalone section.

- [ ] **Step 5: Commit**

```bash
git add gstack-upgrade/SKILL.md.tmpl
git commit -m "feat(upgrade): add fork-copy fast-path to standalone usage section"
```

---

### Task 5: Regenerate SKILL.md and validate

**Files:**

- Regenerate: `gstack-upgrade/SKILL.md`

- [ ] **Step 1: Regenerate**

```bash
bun run gen:skill-docs
```

Expected: runs without errors, updates `gstack-upgrade/SKILL.md`.

- [ ] **Step 2: Verify SKILL.md has the new content**

```bash
grep -n 'fork-copy\|FORK_REPO\|Phase 1\|Phase 5' gstack-upgrade/SKILL.md | head -20
```

Expected: all four phrases appear.

- [ ] **Step 3: Run skill:check**

```bash
bun run skill:check
```

Expected: passes. If it reports issues on `gstack-upgrade`, inspect and fix the template (not the generated SKILL.md).

- [ ] **Step 4: Run free tests**

```bash
bun test
```

Expected: all pass. The skill-validation suite will check SKILL.md structure.

- [ ] **Step 5: Commit the regenerated file**

```bash
git add gstack-upgrade/SKILL.md
git commit -m "chore(docs): regenerate gstack-upgrade/SKILL.md after fork-copy upgrade flow"
```

---

## Verification (end-to-end)

After all tasks:

```bash
# 1. Template has fork-copy in all the right places
grep -c 'fork-copy' gstack-upgrade/SKILL.md.tmpl   # expect ≥ 8 matches
grep -c 'fork-copy' gstack-upgrade/SKILL.md         # expect ≥ 8 matches

# 2. Step 2 detection order is correct (fork-copy first)
grep -n 'INSTALL_TYPE' gstack-upgrade/SKILL.md | head -6
# Expected: fork-copy appears before global-git

# 3. Fork-copy block has all 5 phases
grep -n 'Phase [1-5]' gstack-upgrade/SKILL.md
# Expected: Phase 1 through Phase 5 all present

# 4. Skip annotations exist in 4.6 and 4.8
grep -n 'Skip for.*fork-copy' gstack-upgrade/SKILL.md
# Expected: two matches (one for 4.6, one for 4.8)

# 5. Standalone fast-path is present
grep -n 'INSTALL_TYPE=fork-copy' gstack-upgrade/SKILL.md
# Expected: matches in both Step 4 and Standalone usage

# 6. All tests pass
bun test
```
