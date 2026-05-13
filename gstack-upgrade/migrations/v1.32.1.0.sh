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
