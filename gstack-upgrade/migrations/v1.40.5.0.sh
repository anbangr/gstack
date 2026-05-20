#!/usr/bin/env bash
# Migration: v1.40.5.0 — flag legacy MANUAL_RECOVERY_INVOKED rows as audit-only.
#
# Background: before this version, every cli manual-recovery entry point
# (drain-faults, mark-shipped, --mark-phase-committed) emitted a
# MANUAL_RECOVERY_INVOKED halt event WITHOUT the new `investigate: false`
# flag. The drain-faults --queue consumer would then pay codex (~$0.30) to
# investigate the recovery sink invoking itself. New emits set the flag
# from this version forward; this migration retroactively flags rows
# filed by PR 2 through PR 7 so the next drain-faults --queue short-circuits
# them cleanly.
#
# Scope: rewrite the body of every JSON file under
#   ~/.gstack/skill-faults/pending-investigations/
#   ~/.gstack/skill-faults/processed/
# whose kind == MANUAL_RECOVERY_INVOKED and lacks `investigate`, adding
# investigate: false in place. Filename stable because computeFaultId()
# hashes `kind` — and kind is unchanged.
#
# Idempotent: marker at ~/.gstack/skill-faults/.migrations/v1.40.5.0.done.
# Re-running is a no-op.
#
# Crash-safe: atomic tmp+rename per file. Mid-flight Ctrl+C leaves either
# the original file or the rewritten file on disk, never a partial JSON.
# Re-running picks up where it left off because already-rewritten rows
# carry investigate:false and the migration only touches rows lacking it.
#
# Defensive: rows whose JSON doesn't parse, or that miss expected fields,
# are skipped with a one-line warn. The migration does not abort on a
# single bad row.
#
# NEVER commits or pushes. Mutates only files under ~/.gstack/.

set -u

GSTACK_HOME="${GSTACK_HOME:-${HOME}/.gstack}"
SKILL_FAULTS="${GSTACK_HOME}/skill-faults"
MIGRATION_DIR="${SKILL_FAULTS}/.migrations"
DONE="${MIGRATION_DIR}/v1.40.5.0.done"

mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
if [ -f "${DONE}" ]; then
  exit 0
fi

# Fresh install (no skill-faults dir): write marker, no-op.
if [ ! -d "${SKILL_FAULTS}" ]; then
  touch "${DONE}"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "  [v1.40.5.0] WARN: jq not found; skipping legacy MANUAL_RECOVERY_INVOKED migration. Install jq and re-run gstack-upgrade." >&2
  # Do NOT write the marker — we want a future re-run to migrate once jq lands.
  exit 0
fi

rewritten=0
skipped=0

migrate_dir() {
  local dir="$1"
  [ -d "${dir}" ] || return 0
  local f
  for f in "${dir}"/*.json; do
    [ -f "${f}" ] || continue
    # Only touch MANUAL_RECOVERY_INVOKED rows missing `investigate`.
    local needs_patch
    needs_patch=$(jq -r '
      if (.kind // "") == "MANUAL_RECOVERY_INVOKED" and (.investigate == null)
      then "yes"
      else "no"
      end
    ' "${f}" 2>/dev/null || echo "parse_err")
    case "${needs_patch}" in
      yes)
        local tmp="${f}.migrate.tmp.$$"
        if jq '. + {investigate: false}' "${f}" > "${tmp}" 2>/dev/null; then
          if mv "${tmp}" "${f}" 2>/dev/null; then
            rewritten=$((rewritten + 1))
          else
            rm -f "${tmp}" 2>/dev/null || true
            echo "  [v1.40.5.0] WARN: failed to rename tmp for ${f}" >&2
          fi
        else
          rm -f "${tmp}" 2>/dev/null || true
          echo "  [v1.40.5.0] WARN: jq rewrite failed for ${f}" >&2
        fi
        ;;
      no)
        : # leave unchanged
        ;;
      parse_err|*)
        skipped=$((skipped + 1))
        echo "  [v1.40.5.0] WARN: skipping malformed row ${f}" >&2
        ;;
    esac
  done
}

migrate_dir "${SKILL_FAULTS}/pending-investigations"
migrate_dir "${SKILL_FAULTS}/processed"

touch "${DONE}"

if [ "${rewritten}" -gt 0 ] 2>/dev/null; then
  echo "  [v1.40.5.0] flagged ${rewritten} legacy MANUAL_RECOVERY_INVOKED row(s) as audit-only (investigate:false). Next drain-faults --queue will short-circuit them." >&2
fi
if [ "${skipped}" -gt 0 ] 2>/dev/null; then
  echo "  [v1.40.5.0] skipped ${skipped} malformed row(s); see warnings above." >&2
fi

exit 0
