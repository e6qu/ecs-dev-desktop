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

while true; do
  # Heartbeat — failures are logged but do not stop the agent; a transient
  # network blip should not kill the workspace process.
  if ! curl -sf -X POST "${URL}" \
    -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 10 \
    --retry 2 \
    --retry-delay 3 \
    -o /dev/null 2>&1; then
    echo "edd-idle-agent: heartbeat failed (will retry in ${INTERVAL}s)" >&2
  fi
  sleep "${INTERVAL}"
done
