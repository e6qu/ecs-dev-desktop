#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Container entrypoint: starts the idle-agent in the background then execs
# OpenVSCode Server in the foreground. tini (PID 1) reaps the background child.

set -eu

# Fail loudly if the agent token vars are missing — the container is useless
# without them in production; surface the misconfiguration immediately.
: "${EDD_WORKSPACE_ID:?EDD_WORKSPACE_ID is required}"
: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_AGENT_TOKEN:?EDD_AGENT_TOKEN is required}"

# Start idle-agent in the background.
edd-idle-agent &

# CONNECTION_TOKEN comes from ECS secrets (Secrets Manager); default to a
# random value if unset (acceptable in dev/CI where Pomerium isn't present).
_token="${CONNECTION_TOKEN:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"

exec openvscode-server \
  --host 0.0.0.0 \
  --port 3000 \
  --connection-token "${_token}" \
  --extensions-dir /home/workspace/.openvscode-server/extensions \
  --user-data-dir /home/workspace/.openvscode-server/data \
  --default-folder /home/workspace
