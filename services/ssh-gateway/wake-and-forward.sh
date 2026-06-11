#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# ForceCommand script for the SSH gateway proxy.
#
# Invoked by sshd when a user connects. The authenticated SSH login username
# is "dev-<workspaceId>" (the workspace principal). This script:
#   1. Extracts the workspace ID from $USER ("dev-abc123" → "abc123").
#   2. Calls POST /connect on the control plane to wake the workspace if stopped.
#   3. Polls GET /workspaces/:id until state == "running".
#   4. Calls GET /connect-info to get the workspace's ENI host:port.
#   5. exec nc to proxy TCP from the SSH session to the workspace sshd.
#
# Required env vars (set by the docker-compose service):
#   EDD_CONTROL_PLANE_URL  — base URL of the control plane API (no trailing slash)
#   EDD_GATEWAY_SECRET     — 32-byte hex machine-auth secret shared with the
#                            control plane (its EDD_GATEWAY_SECRET)
#
# The gateway is a service process, not an interactive user, so it authenticates
# with a per-workspace bearer token derived from the shared secret:
#   token = HMAC-SHA256(hexkey(EDD_GATEWAY_SECRET), workspaceId)
# — the same machine-auth scheme the in-workspace idle-agent uses for heartbeats.
# A token observed for one workspace cannot wake or inspect another.

set -eu

# sshd strips the container's env; the entrypoint (proxy-entrypoint.sh) saved
# EDD_* vars to /run/edd-env — source it if present.
if [ -f /run/edd-env ]; then
  # shellcheck disable=SC1091
  . /run/edd-env
fi

: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_GATEWAY_SECRET:?EDD_GATEWAY_SECRET is required}"
: "${USER:?USER (login username) is not set}"

# "dev-abc123" → "abc123"
WORKSPACE_ID="${USER#dev-}"
if [ "$WORKSPACE_ID" = "$USER" ]; then
  echo "error: USER '$USER' is not a dev-* principal" >&2
  exit 1
fi

# Per-workspace machine-auth token: HMAC-SHA256 keyed with the hex secret.
# `openssl dgst` prints "HMAC-SHA2-256(stdin)= <hex>" — keep the last field.
GATEWAY_TOKEN=$(printf '%s' "$WORKSPACE_ID" |
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:${EDD_GATEWAY_SECRET}" |
  awk '{print $NF}')
if [ -z "$GATEWAY_TOKEN" ]; then
  echo "error: could not derive gateway machine-auth token" >&2
  exit 1
fi

AUTH_HEADER="Authorization: Bearer ${GATEWAY_TOKEN}"
CP="${EDD_CONTROL_PLANE_URL}"

# Step 1: wake the workspace (idempotent — no-op if already running).
connect_status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${CP}/api/workspaces/${WORKSPACE_ID}/connect" \
  -H "${AUTH_HEADER}")
if [ "$connect_status" != "200" ]; then
  echo "error: POST /connect returned ${connect_status} for workspace ${WORKSPACE_ID}" >&2
  exit 1
fi

# Step 2: poll until running (max 60 s).
DEADLINE=$(($(date +%s) + 60))
while true; do
  state=$(curl -s "${CP}/api/workspaces/${WORKSPACE_ID}" \
    -H "${AUTH_HEADER}" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
  if [ "$state" = "running" ] || [ "$state" = "idle" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "error: workspace ${WORKSPACE_ID} did not reach running within 60s (state=${state})" >&2
    exit 1
  fi
  sleep 2
done

# Step 3: get the workspace's ENI host:port.
connect_info=$(curl -s "${CP}/api/workspaces/${WORKSPACE_ID}/connect-info" \
  -H "${AUTH_HEADER}")
WORKSPACE_HOST=$(printf '%s' "$connect_info" | grep -o '"host":"[^"]*"' | cut -d'"' -f4)
WORKSPACE_PORT=$(printf '%s' "$connect_info" | grep -o '"port":[0-9]*' | cut -d: -f2)

if [ -z "$WORKSPACE_HOST" ] || [ -z "$WORKSPACE_PORT" ]; then
  echo "error: could not extract host/port from connect-info: $connect_info" >&2
  exit 1
fi

# Step 4: proxy TCP. nc exits when the SSH client disconnects.
exec nc -q0 "$WORKSPACE_HOST" "$WORKSPACE_PORT"
