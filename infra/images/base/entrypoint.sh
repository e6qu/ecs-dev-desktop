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
# Create the persisted-volume layout on first attach. The EBS volume mounts empty at /data
# (@edd/config DEFAULT_WORKSPACE_MOUNT_PATH), shadowing anything baked under it, so these dirs
# must be made here — but this is `mkdir` only (no build/install; the software is baked read-only
# under /opt + /usr/local). The layout keeps editor/tool state OUT of the user's project pwd:
#   /data/project    — pwd / shell cwd / editor opened folder (clean; empty for a fresh workspace)
#   /data/home       — HOME: editor/tool config, state, caches, shell history (out of pwd)
#   /data/extensions — writable, persisted OpenVSCode user extensions (the one editor-state dir
#                      the user mutates), out of pwd
# Each path is its own `install -d` argument, not a single nested path -- GNU coreutils'
# `install -d` only chowns/chmods the LEAF of a given path, creating any missing intermediate
# components root-owned. A single nested call once left `.openvscode-server`/`data` root-owned and
# OpenVSCode (running as `workspace`) failed its first extension-dir `mkdir` with EACCES, so the
# editor never loaded. List every level explicitly.
install -d -o workspace -g workspace -m 0755 \
  /data/project \
  /data/home \
  /data/extensions \
  /data/home/.openvscode-server \
  /data/home/.openvscode-server/data

# Persist the coordinates the registered-key AuthorizedKeysCommand needs (sshd
# strips its environment). Root-only (0600): the command runs as root, and the
# workspace user must not be able to read the per-workspace agent token.
(
  umask 077
  printf 'EDD_WORKSPACE_ID=%s\nEDD_CONTROL_PLANE_URL=%s\nEDD_AGENT_TOKEN=%s\n' \
    "${EDD_WORKSPACE_ID}" "${EDD_CONTROL_PLANE_URL}" "${EDD_AGENT_TOKEN}" \
    >/run/edd-ssh-env
)

# Persist SSH host keys on the EBS volume so they stay STABLE across scale-to-zero wakes. A woken
# workspace is a fresh container over the same volume; regenerating host keys every start (the old
# bare `ssh-keygen -A`) changed the server identity on every wake, so SSH clients hit a
# "REMOTE HOST IDENTIFICATION HAS CHANGED" warning each time. Restore persisted keys first, then
# `ssh-keygen -A` (which only fills MISSING types — a no-op on wake, so it also skips the keygen
# cost), then persist any newly generated keys. Root-only 0700 dir: host private keys are secrets.
host_key_dir=/data/home/.edd/ssh
install -d -o root -g root -m 0700 /data/home/.edd "${host_key_dir}"
if ls "${host_key_dir}"/ssh_host_*_key >/dev/null 2>&1; then
  cp -p "${host_key_dir}"/ssh_host_* /etc/ssh/
fi
ssh-keygen -A >/dev/null
cp -p /etc/ssh/ssh_host_* "${host_key_dir}"/
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
  # Clone INTO the user's project dir (the editor's opened folder), not HOME — so the repo shows
  # up as the workspace content and the pwd is the project, not a dir full of dotfiles.
  _repo_dest="/data/project/${_repo_name}"
  _boot_status="/data/project/.edd-bootstrap-status"
  if [ ! -e "${_repo_dest}" ]; then
    echo "edd-bootstrap: cloning ${EDD_REPO_URL} into ${_repo_dest}" >&2
    if [ -n "${EDD_REPO_REF:-}" ]; then
      _clone_err="$(gosu workspace env HOME=/data/home GIT_TERMINAL_PROMPT=0 \
        git clone --branch "${EDD_REPO_REF}" "${EDD_REPO_URL}" "${_repo_dest}" 2>&1)" &&
        _clone_ok=1 || _clone_ok=0
    else
      _clone_err="$(gosu workspace env HOME=/data/home GIT_TERMINAL_PROMPT=0 \
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
settings_dir=/data/home/.openvscode-server/data/User
settings_file="${settings_dir}/settings.json"
install -d -o workspace -g workspace -m 0755 "${settings_dir}"

# (The first-party edd-workspace-ui extension is a real BUILT-IN, packaged to a .vsix and
# `--install-extension`ed into /opt/openvscode-server/extensions at image build — so it loads
# read-only with NO runtime copy. The user's own extensions still install into /data/extensions.)
# Ensure server-side editor defaults are present. Browser-window defaults such as
# the visible File/Edit/View menu bar come from the patched workbench bootstrap:
# OpenVSCode stores those on the browser side, so writing them into this remote
# user-data directory has no effect on the workbench window.
# node ships in the image (the base is node:22; the Monaco server runs bare `node`).
# JavaScript template syntax must not expand in the shell.
# Only seed on FIRST boot (no settings file yet): a woken workspace already has it, so skip the
# ~200ms node spawn every wake. Existing files are the user's — never re-merged over.
# shellcheck disable=SC2016
[ -f "${settings_file}" ] || gosu workspace node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const defaults = {
    "workbench.colorTheme": "Default Dark Modern",
    "files.autoSave": "afterDelay",
  };
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in cur)) { cur[k] = v; changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
' "${settings_file}"
chown workspace:workspace "${settings_file}"
chmod 0644 "${settings_file}"

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
    # opencode picks its project directory from the process CWD (it has no --project flag). The
    # build-time WORKDIR (/data/project) does not exist when the container starts — the EBS volume
    # mounts empty over /data — so CWD is left at "/" and opencode would open the filesystem root.
    # We create the project dir above, so cd into it now; opencode then opens the clean project dir.
    cd "${EDD_WORKSPACE_ROOT:-/data/project}"
    # Give opencode (which ships no terminal) a full multi-tab terminal by running the first-party
    # terminal server as a SIDECAR on :3001 under `/w/<id>/__edd_term/` (mirrors @edd/config
    # DEFAULT_WORKSPACE_TERMINAL_PORT + WORKSPACE_TERMINAL_OVERLAY_SEGMENT). The control-plane proxy
    # routes that sub-path here and injects a bottom-left toggle + on-top overlay into opencode's UI.
    # Tokenless: it is reachable ONLY via the session-authorizing proxy (owner/admin) + the
    # workspace SG (control plane only), so the connection token is redundant here.
    gosu workspace env \
      PORT=3001 \
      EDD_TERMINAL_ONLY=1 \
      EDD_DISABLE_CONNECTION_TOKEN=1 \
      EDD_BASE_PATH="/w/${EDD_WORKSPACE_ID}/__edd_term/" \
      node /opt/edd-editor-monaco/server.js &
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
  --extensions-dir /data/extensions \
  --user-data-dir /data/home/.openvscode-server/data \
  --default-folder /data/project

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
