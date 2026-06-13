#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Container entrypoint: configures SSH certificate auth, starts sshd and the
# idle-agent in the background, then execs OpenVSCode Server as the workspace
# user. tini (PID 1) reaps the background children.

set -eu

# Fail loudly if the agent token vars are missing — the container is useless
# without them in production; surface the misconfiguration immediately.
: "${EDD_WORKSPACE_ID:?EDD_WORKSPACE_ID is required}"
: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_AGENT_TOKEN:?EDD_AGENT_TOKEN is required}"
: "${EDD_SSH_CA_PUBLIC_KEY:?EDD_SSH_CA_PUBLIC_KEY is required}"

if ! printf '%s' "${EDD_WORKSPACE_ID}" | grep -Eq '^[a-z0-9][a-z0-9-]{0,38}$'; then
  echo "invalid EDD_WORKSPACE_ID for SSH principal: ${EDD_WORKSPACE_ID}" >&2
  exit 1
fi

workspace_principal="dev-${EDD_WORKSPACE_ID}"

install -d -o root -g root -m 0755 /etc/ssh/principals /run/sshd
install -d -o workspace -g workspace -m 0755 /home/workspace

printf '%s\n' "${EDD_SSH_CA_PUBLIC_KEY}" >/etc/ssh/workspace-ca.pub
chmod 0644 /etc/ssh/workspace-ca.pub

printf '%s\n' "${workspace_principal}" >/etc/ssh/principals/workspace
chmod 0644 /etc/ssh/principals/workspace

ssh-keygen -A >/dev/null
/usr/sbin/sshd -t -f /etc/ssh/sshd_config
/usr/sbin/sshd -D -e &

# Start idle-agent in the background.
gosu workspace edd-idle-agent &

# Clone the session repo on first boot ("one repo per session"). Idempotent: on
# wake the snapshot already contains the clone, so skip when the dir exists. The
# git credential for private repos is brokered by the idle-agent over its
# authenticated channel (not injected here); public repos clone as-is. A clone
# failure is non-fatal — the session still starts (the user can retry).
if [ -n "${EDD_REPO_URL:-}" ]; then
  _repo_name="$(basename "${EDD_REPO_URL%.git}")"
  _repo_dest="/home/workspace/${_repo_name}"
  if [ ! -e "${_repo_dest}" ]; then
    echo "edd: cloning ${EDD_REPO_URL} into ${_repo_dest}" >&2
    if [ -n "${EDD_REPO_REF:-}" ]; then
      gosu workspace env HOME=/home/workspace GIT_TERMINAL_PROMPT=0 \
        git clone --branch "${EDD_REPO_REF}" "${EDD_REPO_URL}" "${_repo_dest}" ||
        echo "edd: repo clone failed (continuing)" >&2
    else
      gosu workspace env HOME=/home/workspace GIT_TERMINAL_PROMPT=0 \
        git clone "${EDD_REPO_URL}" "${_repo_dest}" ||
        echo "edd: repo clone failed (continuing)" >&2
    fi
  fi
fi

# CONNECTION_TOKEN comes from ECS secrets (Secrets Manager); default to a
# random value if unset (acceptable in dev/CI where Pomerium isn't present).
_token="${CONNECTION_TOKEN:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"

# --disable-workspace-trust: a per-user workspace contains the user's own files,
# so the Workspace Trust prompt is pure friction (and a modal that blocks the UI
# until dismissed); hosted dev environments disable it.
exec gosu workspace openvscode-server \
  --host 0.0.0.0 \
  --port 3000 \
  --connection-token "${_token}" \
  --disable-workspace-trust \
  --extensions-dir /home/workspace/.openvscode-server/extensions \
  --user-data-dir /home/workspace/.openvscode-server/data \
  --default-folder /home/workspace
