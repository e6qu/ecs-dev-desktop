#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Idle-agent: POSTs /api/workspaces/:id/heartbeat to the control plane on a
# fixed interval. Each beat carries an ACTIVITY self-report — whether the
# workspace saw real usage since the last beat, not merely that the container is
# alive. An `active: false` beat still reports functional health, but the control
# plane does not refresh the idle window for it, so an untouched workspace ages
# toward the reconciler's scale-to-zero threshold instead of living forever.
#
# "Real usage" is any of (checked over the last beat interval + slack):
#   1. PTY I/O — any /dev/pts/* device mtime is recent. Covers typing AND output
#      in every terminal: OpenVSCode's integrated terminal, the Monaco editor's
#      PTY bridge, and interactive SSH sessions. A long-running foreground
#      process that still prints (builds, `claude` streaming) keeps this fresh.
#   2. The editor activity marker — /tmp/edd-activity, touched (throttled) by
#      the edd-workspace-ui extension on real editor events (typing, cursor
#      movement, terminal opens, window focus) and by the Monaco editor server
#      on file saves/terminal input. Catches editor-only interaction that never
#      touches a PTY (e.g. editing a buffer with the mouse and command palette).
#   3. CPU load — 1-minute loadavg at/above a threshold. Catches genuinely
#      running compute detached from any terminal (background builds, tests).
#
# This script runs INSIDE the Debian-based golden image only (GNU coreutils
# guaranteed); it is not one of the repo's host-portable scripts.
#
# Required env vars (validated by entrypoint.sh before this script runs):
#   EDD_WORKSPACE_ID       — workspace id (ws-…)
#   EDD_CONTROL_PLANE_URL  — control-plane base URL (no trailing slash)
#   EDD_AGENT_TOKEN        — HMAC-SHA256 machine-auth token for the heartbeat route
#
# Optional:
#   EDD_HEARTBEAT_INTERVAL_S — seconds between beats (default 120)
#   EDD_ACTIVITY_LOAD_MIN    — 1-min loadavg that counts as "in use" (default 0.5)

set -eu

INTERVAL="${EDD_HEARTBEAT_INTERVAL_S:-120}"
URL="${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/heartbeat"
# OpenVSCode HTTP port (the IDE) — what makes the desktop actually usable.
IDE_PORT="${EDD_WORKSPACE_PORT:-3000}"
# Editor-side activity marker (see the header): tmpfs, container-local.
ACTIVITY_MARKER="/tmp/edd-activity"
LOAD_MIN="${EDD_ACTIVITY_LOAD_MIN:-0.5}"
# The activity lookback: one beat interval plus slack, so an event landing just
# after a beat is still counted by the next one.
ACTIVITY_WINDOW_S=$((INTERVAL + 60))

# Functional self-report: is the desktop actually USABLE, not just "task running"?
#   ide       — OpenVSCode answers on its port (a 4xx token-gate still means "up").
#   workspace — the home directory is writable.
functional_json() {
  if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${IDE_PORT}/" 2>/dev/null; then
    _ide=true
  else
    _ide=false
  fi
  if (: >"${HOME}/.edd-probe") 2>/dev/null; then
    _ws=true
    rm -f "${HOME}/.edd-probe" 2>/dev/null || true
  else
    _ws=false
  fi
  printf '{"ide":%s,"workspace":%s}' "${_ide}" "${_ws}"
}

# Newest mtime (epoch seconds) among the given paths, or 0 when none exist.
newest_mtime() {
  _newest=0
  for _p in "$@"; do
    [ -e "${_p}" ] || continue
    _m=$(stat -c %Y "${_p}" 2>/dev/null || echo 0)
    [ "${_m}" -gt "${_newest}" ] && _newest="${_m}"
  done
  printf '%s' "${_newest}"
}

# "true" when the workspace saw real usage within ACTIVITY_WINDOW_S — see header.
active_json() {
  _now=$(date +%s)
  _cutoff=$((_now - ACTIVITY_WINDOW_S))

  _latest=$(newest_mtime /dev/pts/* "${ACTIVITY_MARKER}")
  if [ "${_latest}" -ge "${_cutoff}" ]; then
    printf 'true'
    return 0
  fi

  # loadavg comparison in awk (sh has no float arithmetic).
  if awk -v min="${LOAD_MIN}" '{exit !($1 >= min)}' /proc/loadavg 2>/dev/null; then
    printf 'true'
    return 0
  fi

  printf 'false'
}

while true; do
  # Heartbeat (activity + functional self-reports) — failures are logged but do not
  # stop the agent; a transient network blip should not kill the workspace process.
  if ! curl -sf -X POST "${URL}" \
    -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 10 \
    --retry 2 \
    --retry-delay 3 \
    --data "{\"active\":$(active_json),\"functional\":$(functional_json)}" \
    -o /dev/null 2>&1; then
    echo "edd-idle-agent: heartbeat failed (will retry in ${INTERVAL}s)" >&2
  fi
  sleep "${INTERVAL}"
done
