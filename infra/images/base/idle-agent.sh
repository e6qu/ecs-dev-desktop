#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Idle-agent: POSTs /api/workspaces/:id/heartbeat to the control plane on a
# fixed interval so the reconciler keeps the workspace running while it's active.
#
# Required env vars (validated by entrypoint.sh before this script runs):
#   EDD_WORKSPACE_ID       — workspace id (ws-…)
#   EDD_CONTROL_PLANE_URL  — control-plane base URL (no trailing slash)
#   EDD_AGENT_TOKEN        — HMAC-SHA256 machine-auth token for the heartbeat route
#
# Optional:
#   EDD_HEARTBEAT_INTERVAL_S — seconds between beats (default 120)

set -eu

INTERVAL="${EDD_HEARTBEAT_INTERVAL_S:-120}"
URL="${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/heartbeat"
# OpenVSCode HTTP port (the IDE) — what makes the desktop actually usable.
IDE_PORT="${EDD_WORKSPACE_PORT:-3000}"

# Functional self-report: is the desktop actually USABLE, not just "task running"?
#   ide       — OpenVSCode answers on its port (a 4xx token-gate still means "up").
#   workspace — the home directory is writable.
# Echoes a JSON heartbeat body the control plane folds into the workspace's functional
# status (surfaced in the admin Inspect view + the functional metric).
functional_body() {
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
  printf '{"functional":{"ide":%s,"workspace":%s}}' "${_ide}" "${_ws}"
}

while true; do
  # Heartbeat (with the functional self-report) — failures are logged but do not stop
  # the agent; a transient network blip should not kill the workspace process.
  if ! curl -sf -X POST "${URL}" \
    -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 10 \
    --retry 2 \
    --retry-delay 3 \
    --data "$(functional_body)" \
    -o /dev/null 2>&1; then
    echo "edd-idle-agent: heartbeat failed (will retry in ${INTERVAL}s)" >&2
  fi
  sleep "${INTERVAL}"
done
