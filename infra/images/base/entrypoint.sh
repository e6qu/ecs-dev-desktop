#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Container entrypoint: configures SSH (registered-key auth via the control plane,
# plus the SSH CA cert path when a CA key is provided), starts sshd and the
# idle-agent in the background, then execs OpenVSCode Server as the workspace user.
# tini (PID 1) reaps the background children.

set -eu

# Fail loudly if the agent vars are missing — the container is useless without
# them in production; surface the misconfiguration immediately.
: "${EDD_WORKSPACE_ID:?EDD_WORKSPACE_ID is required}"
: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_AGENT_TOKEN:?EDD_AGENT_TOKEN is required}"

if ! printf '%s' "${EDD_WORKSPACE_ID}" | grep -Eq '^[a-z0-9][a-z0-9-]{0,38}$'; then
  echo "invalid EDD_WORKSPACE_ID for SSH principal: ${EDD_WORKSPACE_ID}" >&2
  exit 1
fi

install -d -o root -g root -m 0755 /etc/ssh/principals /run/sshd
install -d -o workspace -g workspace -m 0755 /home/workspace

# Persist the coordinates the registered-key AuthorizedKeysCommand needs (sshd
# strips its environment). Root-only (0600): the command runs as root, and the
# workspace user must not be able to read the per-workspace agent token.
(
  umask 077
  printf 'EDD_WORKSPACE_ID=%s\nEDD_CONTROL_PLANE_URL=%s\nEDD_AGENT_TOKEN=%s\n' \
    "${EDD_WORKSPACE_ID}" "${EDD_CONTROL_PLANE_URL}" "${EDD_AGENT_TOKEN}" \
    >/run/edd-ssh-env
)

# SSH CA path (optional): trust the control-plane CA when its public key is
# provided, mapping the cert principal dev-<id> to the `workspace` login. The
# config references workspace-ca.pub unconditionally, so always create the file
# (empty when no CA is configured → only the registered-key path is active).
printf '%s\n' "${EDD_SSH_CA_PUBLIC_KEY:-}" >/etc/ssh/workspace-ca.pub
chmod 0644 /etc/ssh/workspace-ca.pub
printf '%s\n' "dev-${EDD_WORKSPACE_ID}" >/etc/ssh/principals/workspace
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

# Seed default editor settings (Dark mode) on first boot. The user-data-dir lives
# on the EBS home volume, so we seed at runtime (not build, where it'd be shadowed
# by the volume mount) and only when absent — so user overrides persist across
# restarts. It stays a *default* the user can change.
settings_dir=/home/workspace/.openvscode-server/data/User
if [ ! -e "${settings_dir}/settings.json" ]; then
  install -d -o workspace -g workspace -m 0755 "${settings_dir}"
  cat >"${settings_dir}/settings.json" <<'JSON'
{
  "workbench.colorTheme": "Default Dark Modern"
}
JSON
  chown workspace:workspace "${settings_dir}/settings.json"
  chmod 0644 "${settings_dir}/settings.json"
fi

# (Default extensions — the AI agents + dev extensions — are baked into OpenVSCode's
# built-in extensions dir at image build, so they load with no runtime copy. The
# user's own extensions still install into the volume's extensions dir below.)

# Base server args. --disable-workspace-trust: a per-user workspace contains the
# user's own files, so the Workspace Trust prompt is pure friction (a modal that
# blocks the UI); hosted dev environments disable it.
set -- --host 0.0.0.0 --port 3000 --disable-workspace-trust \
  --extensions-dir /home/workspace/.openvscode-server/extensions \
  --user-data-dir /home/workspace/.openvscode-server/data \
  --default-folder /home/workspace

# Auth: behind the workspace gate (Pomerium identity + gate ownership +
# network isolation) the OpenVSCode connection token is redundant, so a gated
# deployment sets EDD_DISABLE_CONNECTION_TOKEN=1 for a tokenless browser URL.
# Otherwise (standalone/dev) require a connection token — from ECS secrets, or a
# random one if unset.
if [ "${EDD_DISABLE_CONNECTION_TOKEN:-}" = "1" ]; then
  set -- "$@" --without-connection-token
else
  _token="${CONNECTION_TOKEN:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"
  set -- "$@" --connection-token "${_token}"
fi

exec gosu workspace openvscode-server "$@"
