#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Container entrypoint: configures SSH (registered-key auth via the control plane),
# starts sshd and the idle-agent in the background, then execs OpenVSCode Server as
# the workspace user. tini (PID 1) reaps the background children.

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

install -d -o root -g root -m 0755 /run/sshd
# Each path below is its own `install -d` argument, not a single nested path --
# GNU coreutils' `install -d` only chowns/chmods the LEAF of a given path,
# creating any missing intermediate components with the default mode (root-
# owned, since this script still runs as root here). A single call for the
# nested `.openvscode-server/data/User` (as the settings-seed step below used
# to do alone) left `.openvscode-server` and `data` themselves root-owned —
# found live: OpenVSCode Server (running as `workspace`) failed on its very
# first `mkdir '/home/workspace/.openvscode-server/extensions'` with EACCES,
# and every extension install/data-dir (`data/logs`, `data/Machine`, the user
# extensions dir) failed the same way, so the editor never finished loading.
install -d -o workspace -g workspace -m 0755 \
  /home/workspace \
  /home/workspace/.openvscode-server \
  /home/workspace/.openvscode-server/data \
  /home/workspace/.openvscode-server/extensions

# Persist the coordinates the registered-key AuthorizedKeysCommand needs (sshd
# strips its environment). Root-only (0600): the command runs as root, and the
# workspace user must not be able to read the per-workspace agent token.
(
  umask 077
  printf 'EDD_WORKSPACE_ID=%s\nEDD_CONTROL_PLANE_URL=%s\nEDD_AGENT_TOKEN=%s\n' \
    "${EDD_WORKSPACE_ID}" "${EDD_CONTROL_PLANE_URL}" "${EDD_AGENT_TOKEN}" \
    >/run/edd-ssh-env
)

ssh-keygen -A >/dev/null
/usr/sbin/sshd -t -f /etc/ssh/sshd_config
/usr/sbin/sshd -D -e &

# Start idle-agent in the background.
gosu workspace edd-idle-agent &

# Clone the session repo on first boot ("one repo per session"). Idempotent: on
# wake the snapshot already contains the clone, so skip when the dir exists. The
# git credential for private repos is brokered by the idle-agent over its
# authenticated channel (not injected here); public repos clone as-is.
#
# A clone failure is non-fatal — the workspace still starts so the user can fix it
# (link a private repo, then clone manually) rather than losing the session. But it
# is NOT silent: an ERROR line goes to stderr (→ CloudWatch → the portal
# per-workspace log view) with git's own reason, and a marker file is written into
# the workspace so the user sees it in the IDE explorer.
if [ -n "${EDD_REPO_URL:-}" ]; then
  _repo_name="$(basename "${EDD_REPO_URL%.git}")"
  _repo_dest="/home/workspace/${_repo_name}"
  _boot_status="/home/workspace/.edd-bootstrap-status"
  if [ ! -e "${_repo_dest}" ]; then
    echo "edd-bootstrap: cloning ${EDD_REPO_URL} into ${_repo_dest}" >&2
    if [ -n "${EDD_REPO_REF:-}" ]; then
      _clone_err="$(gosu workspace env HOME=/home/workspace GIT_TERMINAL_PROMPT=0 \
        git clone --branch "${EDD_REPO_REF}" "${EDD_REPO_URL}" "${_repo_dest}" 2>&1)" &&
        _clone_ok=1 || _clone_ok=0
    else
      _clone_err="$(gosu workspace env HOME=/home/workspace GIT_TERMINAL_PROMPT=0 \
        git clone "${EDD_REPO_URL}" "${_repo_dest}" 2>&1)" &&
        _clone_ok=1 || _clone_ok=0
    fi
    if [ "${_clone_ok}" = "1" ]; then
      rm -f "${_boot_status}"
      echo "edd-bootstrap: cloned ${EDD_REPO_URL}" >&2
    else
      echo "edd-bootstrap: ERROR repo clone failed for ${EDD_REPO_URL}: ${_clone_err}" >&2
      {
        echo "Workspace bootstrap could not clone the requested repository:"
        echo "  ${EDD_REPO_URL}${EDD_REPO_REF:+ (ref ${EDD_REPO_REF})}"
        echo
        echo "Reason:"
        echo "  ${_clone_err}"
        echo
        echo "The workspace is running. For a private repo, link your Git account in"
        echo "the portal, then clone manually from the terminal."
      } >"${_boot_status}"
      chown workspace:workspace "${_boot_status}" 2>/dev/null || true
    fi
  fi
fi

# Seed default editor settings (Dark mode) on first boot. The user-data-dir lives
# on the EBS home volume, so we seed at runtime (not build, where it'd be shadowed
# by the volume mount) and only when absent — so user overrides persist across
# restarts. It stays a *default* the user can change.
settings_dir=/home/workspace/.openvscode-server/data/User
settings_file="${settings_dir}/settings.json"
install -d -o workspace -g workspace -m 0755 "${settings_dir}"
# Ensure our default UI settings are PRESENT without clobbering the user's own
# choices: merge (add only missing keys). Seeding only when the file was absent
# meant a workspace on a volume created by an OLDER image never got a later default
# — which is why the OpenVSCode menu bar (window.menuBarVisibility: "classic", the
# visible File/Edit/View… bar) was missing on pre-existing workspaces. Merging on
# every boot fixes old volumes too; a key the user explicitly set is left untouched.
# node ships in the image (the base is node:22; the Monaco server runs bare `node`).
gosu workspace node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cur = {}; }
  if (cur === null || typeof cur !== "object") cur = {};
  const defaults = {
    "workbench.colorTheme": "Default Dark Modern",
    "window.menuBarVisibility": "classic",
    "files.autoSave": "afterDelay",
  };
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in cur)) { cur[k] = v; changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
' "${settings_file}" || true
chown workspace:workspace "${settings_file}" 2>/dev/null || true
chmod 0644 "${settings_file}" 2>/dev/null || true

# (Terminal-open-on-startup, the "EDD home" portal link, the visible open-terminal
# keybinding control, and the one-time CLI remote-OAuth tip all live in the
# first-party edd-workspace-ui extension, baked into the built-in extensions dir at
# image build — an extension opens a real interactive shell, unlike the earlier
# folder-open-task approach, which only surfaced a read-only task-output panel.)

# (Default extensions — the AI agents + dev extensions — are baked into OpenVSCode's
# built-in extensions dir at image build, so they load with no runtime copy. The
# user's own extensions still install into the volume's extensions dir below.)

# Editor selection. The control plane sets EDD_EDITOR_MODE from the workspace's editor choice
# (a per-session pick at create, else its base-image catalog entry):
#   monaco         -> the first-party Monaco editor server;
#   terminal       -> the first-party multi-tab terminal server with the agent CLIs on PATH.
#   opencode       -> opencode's local web client (`opencode web`).
#   openvscode/unset -> OpenVSCode Server, the product default.
#   anything else    -> fail loudly; unknown editor values are invalid config.
# The Monaco server (bundled at /opt/edd-editor-monaco) listens on :3000 under
# /w/<id>/ and reads the same coordinates from the environment (EDD_WORKSPACE_ID,
# CONNECTION_TOKEN, EDD_DISABLE_CONNECTION_TOKEN), so the in-app proxy reaches it
# exactly like OpenVSCode.
case "${EDD_EDITOR_MODE:-openvscode}" in
  monaco)
    exec gosu workspace node /opt/edd-editor-monaco/server.js
    ;;
  terminal)
    command -v claude >/dev/null 2>&1 || {
      echo "EDD_EDITOR_MODE=terminal requires the Claude Code CLI on PATH" >&2
      exit 64
    }
    command -v codex >/dev/null 2>&1 || {
      echo "EDD_EDITOR_MODE=terminal requires the Codex CLI on PATH" >&2
      exit 64
    }
    exec gosu workspace env EDD_TERMINAL_ONLY=1 node /opt/edd-editor-monaco/server.js
    ;;
  opencode)
    command -v opencode >/dev/null 2>&1 || {
      echo "EDD_EDITOR_MODE=opencode requires the opencode CLI on PATH" >&2
      exit 64
    }
    if [ "${EDD_DISABLE_CONNECTION_TOKEN:-}" = "1" ]; then
      echo "EDD_EDITOR_MODE=opencode cannot run with EDD_DISABLE_CONNECTION_TOKEN=1" >&2
      exit 64
    fi
    : "${CONNECTION_TOKEN:?EDD_EDITOR_MODE=opencode requires CONNECTION_TOKEN}"
    exec gosu workspace env \
      OPENCODE_SERVER_USERNAME=opencode \
      OPENCODE_SERVER_PASSWORD="${CONNECTION_TOKEN}" \
      opencode web --hostname 0.0.0.0 --port 3000 --print-logs
    ;;
  openvscode)
    ;;
  *)
    echo "unknown EDD_EDITOR_MODE: ${EDD_EDITOR_MODE}" >&2
    exit 64
    ;;
esac

# Base server args. --disable-workspace-trust: a per-user workspace contains the
# user's own files, so the Workspace Trust prompt is pure friction (a modal that
# blocks the UI); hosted dev environments disable it.
# --server-base-path: the control-plane app proxies this editor at the path
# `/w/<workspace-id>/`, so the server must emit all its URLs under that prefix
# (the proxy forwards paths unrewritten). Mirrors the in-app `WORKSPACE_PATH_PREFIX`.
set -- --host 0.0.0.0 --port 3000 --disable-workspace-trust \
  --server-base-path "/w/${EDD_WORKSPACE_ID}/" \
  --extensions-dir /home/workspace/.openvscode-server/extensions \
  --user-data-dir /home/workspace/.openvscode-server/data \
  --default-folder /home/workspace

# Auth: behind the in-app workspace proxy (Auth.js session + per-workspace
# ownership + network isolation) the OpenVSCode connection token is redundant, so a
# proxied deployment sets EDD_DISABLE_CONNECTION_TOKEN=1 for a tokenless browser URL.
# Otherwise (standalone/dev) require the connection token injected by compute.
if [ "${EDD_DISABLE_CONNECTION_TOKEN:-}" = "1" ]; then
  set -- "$@" --without-connection-token
else
  : "${CONNECTION_TOKEN:?CONNECTION_TOKEN is required unless EDD_DISABLE_CONNECTION_TOKEN=1}"
  set -- "$@" --connection-token "${CONNECTION_TOKEN}"
fi

exec gosu workspace openvscode-server "$@"
