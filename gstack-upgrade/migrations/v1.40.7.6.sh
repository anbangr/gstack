#!/usr/bin/env bash
# Migration: v1.40.7.6 — Scrub old manual-recovery patterns from learned-patterns.json
#
# Background: PR8 renamed MANUAL_RECOVERY_INVOKED → RECOVERY_BOUNDARY and stopped
# treating recovery-boundary events as faults. This migration removes the four
# manual-recovery category entries from learned-patterns.json that were promoted
# from the same noise source, so the pattern miner no longer proposes them.
#
# Scope: read ~/.gstack/skill-faults/learned-patterns.json, remove entries whose
# category matches /^manual[-_]?recovery/ or /^manual[-_]?phase[-_]?commit/,
# write back, append a one-line note to migration-notes.md.
#
# Marker: ~/.gstack/skill-faults/.migrations/2026-05-21-recovery-boundary-rename.done
# Idempotency: the underlying TypeScript migration writes the marker.
#
# NEVER commits or pushes. Mutates only files under ~/.gstack/.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Run the TypeScript migration module directly via bun.
if command -v bun >/dev/null 2>&1; then
  bun "${SCRIPT_DIR}/2026-05-21-recovery-boundary-rename.ts"
else
  echo "  [v1.40.7.6] WARN: bun not found; skipping recovery-boundary migration. Install bun and re-run gstack-upgrade." >&2
  exit 0
fi
