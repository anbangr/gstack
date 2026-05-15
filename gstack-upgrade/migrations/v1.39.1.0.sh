#!/usr/bin/env bash
# Migration: v1.39.1.0 — release-daemon install + reload nudges.
#
# Three independent one-time notices, all gated on queue_has_records:
#   A (not installed):   plist/unit absent → tell the user to install.
#   B macOS (combined):  plist exists but needs reload — either not loaded
#                        into launchctl, or lacks EnvironmentVariables. Same
#                        user action either way: re-install + unload && load.
#   B Linux (combined):  systemd unit exists but lacks Environment="PATH=.
#                        User action: re-install + daemon-reload + restart.
#
# Does NOT auto-install. installReleaseDaemon needs --project-root and we
# refuse to write to ~/Library/LaunchAgents without explicit consent. A
# one-time notice is the right call here.
#
# Two-touchfile gating keeps Notice A and Notice B independent so future
# migrations can selectively re-fire by removing one without the other.

set -u

if [ -z "${HOME:-}" ]; then
  echo "  [v1.39.1.0] HOME unset — skipping migration." >&2
  exit 0
fi

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
MIGRATIONS_DIR="$GSTACK_HOME/.migrations"
QUEUE_DIR="$GSTACK_HOME/build-state/release-queue"
PLIST="$HOME/Library/LaunchAgents/com.gstack.release-daemon.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/gstack-release-daemon.service"

DONE_A="$MIGRATIONS_DIR/v1.39.1.0.queue-no-daemon.done"
DONE_B="$MIGRATIONS_DIR/v1.39.1.0.stale-plist.done"
mkdir -p "$MIGRATIONS_DIR" 2>/dev/null || true

queue_has_records() {
  [ -d "$QUEUE_DIR" ] && [ -n "$(find "$QUEUE_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | head -1)" ]
}

daemon_installed() {
  [ -f "$PLIST" ] || [ -f "$SYSTEMD_UNIT" ]
}

mac_loaded() {
  launchctl list 2>/dev/null | grep -q "com.gstack.release-daemon"
}

mac_plist_has_env_vars() {
  [ -f "$PLIST" ] && grep -q "EnvironmentVariables" "$PLIST" 2>/dev/null
}

linux_unit_has_path() {
  [ -f "$SYSTEMD_UNIT" ] && grep -q 'Environment="PATH=' "$SYSTEMD_UNIT" 2>/dev/null
}

# ---------- Notice A: nothing installed ----------
if [ ! -f "$DONE_A" ]; then
  if queue_has_records && ! daemon_installed; then
    n=$(find "$QUEUE_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
    cat <<NOTICE

  ┌──────────────────────────────────────────────────────────────────┐
  │  gstack v1.39.1.0 — release daemon not installed                 │
  │                                                                  │
  │  Your release queue has $n record(s) waiting to land, but the    │
  │  release daemon is not installed on this machine.                │
  │                                                                  │
  │  From a gstack repo:                                             │
  │    cd /path/to/your/repo                                         │
  │    gstack-build release-daemon install                           │
  │    # macOS:                                                      │
  │    launchctl load ~/Library/LaunchAgents/com.gstack.release-daemon.plist
  │    # Linux:                                                      │
  │    systemctl --user enable --now gstack-release-daemon           │
  │                                                                  │
  │  Diagnose anytime: gstack-build release-daemon doctor            │
  └──────────────────────────────────────────────────────────────────┘

NOTICE
  fi
  touch "$DONE_A"
fi

# ---------- Notice B: needs reload (macOS combined / Linux) ----------
if [ ! -f "$DONE_B" ]; then
  need_macos_reload=0
  need_linux_reload=0

  if queue_has_records; then
    if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST" ]; then
      if ! mac_loaded; then
        need_macos_reload=1
      elif ! mac_plist_has_env_vars; then
        need_macos_reload=1
      fi
    fi
    if [ "$(uname -s)" = "Linux" ] && [ -f "$SYSTEMD_UNIT" ] && ! linux_unit_has_path; then
      need_linux_reload=1
    fi
  fi

  if [ "$need_macos_reload" = "1" ]; then
    cat <<NOTICE

  ┌──────────────────────────────────────────────────────────────────┐
  │  gstack v1.39.1.0 — release daemon plist needs reload            │
  │                                                                  │
  │  Your launchd plist exists but the daemon is not running with    │
  │  the v1.39.1.0 PATH fix. Until reloaded, gh/git/bun lookups may  │
  │  fail and every queued PR is marked "blocked".                   │
  │                                                                  │
  │  Re-install (no-op if already current) and reload:               │
  │    cd /path/to/your/repo                                         │
  │    gstack-build release-daemon install                           │
  │    launchctl unload  ~/Library/LaunchAgents/com.gstack.release-daemon.plist
  │    launchctl load    ~/Library/LaunchAgents/com.gstack.release-daemon.plist
  │                                                                  │
  │  Verify: gstack-build release-daemon doctor                      │
  └──────────────────────────────────────────────────────────────────┘

NOTICE
  fi

  if [ "$need_linux_reload" = "1" ]; then
    cat <<NOTICE

  ┌──────────────────────────────────────────────────────────────────┐
  │  gstack v1.39.1.0 — release daemon unit needs reload             │
  │                                                                  │
  │  Your systemd user unit predates the PATH fix. Subprocesses run  │
  │  with systemd's minimal PATH which may not include /usr/local/bin│
  │  or ~/.local/bin, so gh/bun lookups can fail.                    │
  │                                                                  │
  │  Re-install and reload:                                          │
  │    cd /path/to/your/repo                                         │
  │    gstack-build release-daemon install                           │
  │    systemctl --user daemon-reload                                │
  │    systemctl --user restart gstack-release-daemon                │
  │                                                                  │
  │  Verify: gstack-build release-daemon doctor                      │
  └──────────────────────────────────────────────────────────────────┘

NOTICE
  fi

  touch "$DONE_B"
fi

exit 0
