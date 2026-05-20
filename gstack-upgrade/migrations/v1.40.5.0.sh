#!/usr/bin/env bash
# Migration: v1.40.5.0 — flag legacy MANUAL_RECOVERY_INVOKED audit rows as audit-only.
#
# Background: before this version, every cli manual-recovery entry point
# (drain-faults, mark-shipped, --mark-phase-committed) emitted a
# MANUAL_RECOVERY_INVOKED halt event WITHOUT the new `investigate: false`
# flag. The drain-faults --queue consumer would then pay codex (~$0.30) to
# investigate the recovery sink invoking itself. New emits set the flag
# from this version forward; this migration retroactively flags audit rows
# filed by PR 2 through PR 7 so the next drain-faults --queue short-circuits
# them cleanly.
#
# Scope: rewrite the body of every JSON file under
#   ~/.gstack/skill-faults/pending-investigations/
#   ~/.gstack/skill-faults/processed/
# whose kind == MANUAL_RECOVERY_INVOKED, lacks `investigate`, AND whose
# message matches a known recovery-sink emit. The message gate restricts
# scope to events emitted by the three production cli sites; any custom or
# investigative MANUAL_RECOVERY_INVOKED row from another emitter is left
# alone. Filename stable because computeFaultId() hashes `kind` — and kind
# is unchanged.
#
# Marker: ~/.gstack/skill-faults/.migrations/v1.40.5.0.done
#   Written ONLY when the run completed without any rewrite failures AND
#   without a missed concurrent emitter row. If jq is missing, mv failed
#   on any row, or a re-scan finds a still-unflagged audit row written
#   during the run, the marker is NOT written and the next gstack-upgrade
#   retries. This is the H1+H2 fix from codex adversarial review.
#
# Crash-safe: atomic tmp+rename per file. Mid-flight Ctrl+C leaves either
# the original file or the rewritten file on disk, never a partial JSON.
# Idempotent: rewrite step is a jq merge that adds `investigate: false`
# only when absent, so re-running over already-migrated rows is a no-op.
#
# Defensive: rows whose JSON doesn't parse are skipped with a one-line
# warn. The migration does not abort on a single bad row, but a parse-err
# count of >0 prevents the marker from being written so a future run can
# retry once the source of the malformed row is fixed.
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
  # (Codex H1 fix: jq-missing must not lock out retries.)
  exit 0
fi

# Known recovery-sink message prefixes. M3 fix: only flag rows whose
# message matches one of these. Custom or investigative
# MANUAL_RECOVERY_INVOKED rows from outside the three production cli sites
# (drain-faults, mark-shipped, --mark-phase-committed) are left alone.
matches_recovery_sink() {
  local msg="$1"
  case "${msg}" in
    "drain-faults subcommand invoked"*) return 0 ;;
    "mark-shipped subcommand invoked"*) return 0 ;;
    "--mark-phase-committed invoked"*) return 0 ;;
    *) return 1 ;;
  esac
}

rewritten=0
skipped_malformed=0
write_failures=0

migrate_dir() {
  local dir="$1"
  [ -d "${dir}" ] || return 0
  local f
  for f in "${dir}"/*.json; do
    [ -f "${f}" ] || continue
    # Read kind, investigate-presence, and message in one jq invocation.
    local row_json
    row_json=$(jq -rc '
      if (.kind // "") == "MANUAL_RECOVERY_INVOKED" and (.investigate == null)
      then {kind: .kind, msg: (.message // "")}
      else null
      end
    ' "${f}" 2>/dev/null) || row_json="parse_err"

    case "${row_json}" in
      parse_err)
        skipped_malformed=$((skipped_malformed + 1))
        echo "  [v1.40.5.0] WARN: skipping malformed row ${f}" >&2
        ;;
      null)
        : # not a MANUAL_RECOVERY_INVOKED audit candidate; leave alone
        ;;
      *)
        # row_json is {kind, msg}; check the message gate.
        local msg
        msg=$(printf '%s' "${row_json}" | jq -r '.msg')
        if matches_recovery_sink "${msg}"; then
          local tmp="${f}.migrate.tmp.$$"
          if jq '. + {investigate: false}' "${f}" > "${tmp}" 2>/dev/null && \
             mv "${tmp}" "${f}" 2>/dev/null; then
            rewritten=$((rewritten + 1))
          else
            rm -f "${tmp}" 2>/dev/null || true
            write_failures=$((write_failures + 1))
            echo "  [v1.40.5.0] WARN: write failed for ${f} (will retry on next gstack-upgrade)" >&2
          fi
        fi
        # Non-recovery-sink MANUAL_RECOVERY_INVOKED rows are intentionally
        # left untouched (M3 fix).
        ;;
    esac
  done
}

migrate_dir "${SKILL_FAULTS}/pending-investigations"
migrate_dir "${SKILL_FAULTS}/processed"

# M2 fix: re-scan for any still-unflagged recovery-sink audit row written
# by a concurrent emitter during the run. If we find one, refuse to write
# the marker so the next gstack-upgrade picks them up.
concurrent_unflagged=0
rescan_dir() {
  local dir="$1"
  [ -d "${dir}" ] || return 0
  local f
  for f in "${dir}"/*.json; do
    [ -f "${f}" ] || continue
    local row_json
    row_json=$(jq -rc '
      if (.kind // "") == "MANUAL_RECOVERY_INVOKED" and (.investigate == null)
      then (.message // "")
      else null
      end
    ' "${f}" 2>/dev/null) || continue
    [ "${row_json}" = "null" ] && continue
    if matches_recovery_sink "${row_json}"; then
      concurrent_unflagged=$((concurrent_unflagged + 1))
    fi
  done
}
rescan_dir "${SKILL_FAULTS}/pending-investigations"
rescan_dir "${SKILL_FAULTS}/processed"

# Write marker ONLY when the run is genuinely complete. The four gates,
# any one of which prevents the marker (so the next gstack-upgrade retries):
#   1. jq present (checked above; we exit before here if missing)
#   2. write_failures == 0 (H2 fix)
#   3. concurrent_unflagged == 0 (M2 fix)
#   4. skipped_malformed == 0 (don't lock out retry while malformed rows exist)
if [ "${write_failures}" -gt 0 ] 2>/dev/null; then
  echo "  [v1.40.5.0] ERROR: ${write_failures} row(s) failed to rewrite; marker NOT written, next gstack-upgrade will retry." >&2
  exit 1
fi
if [ "${concurrent_unflagged}" -gt 0 ] 2>/dev/null; then
  echo "  [v1.40.5.0] WARN: ${concurrent_unflagged} recovery-sink audit row(s) appeared during the run; marker NOT written, next gstack-upgrade will pick them up." >&2
  exit 1
fi
if [ "${skipped_malformed}" -gt 0 ] 2>/dev/null; then
  echo "  [v1.40.5.0] WARN: ${skipped_malformed} malformed row(s) skipped; marker NOT written, fix the rows and re-run." >&2
  exit 1
fi

touch "${DONE}"

if [ "${rewritten}" -gt 0 ] 2>/dev/null; then
  echo "  [v1.40.5.0] flagged ${rewritten} legacy MANUAL_RECOVERY_INVOKED row(s) as audit-only (investigate:false). Next drain-faults --queue will short-circuit them." >&2
fi

exit 0
