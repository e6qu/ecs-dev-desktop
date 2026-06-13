#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Git credential helper for the workspace: fetches the session owner's git token
# from the control plane over the idle-agent's authenticated channel, so clone +
# push of private repos work WITHOUT storing any token on disk (the EBS volume).
# git invokes this as `credential-helper get` with the request on stdin.
set -eu

[ "${1:-}" = "get" ] || exit 0

# Without the agent wiring (e.g. a bare local run) there is no broker to ask;
# exit cleanly so git falls back to unauthenticated access (public repos work).
[ -n "${EDD_CONTROL_PLANE_URL:-}" ] || exit 0
[ -n "${EDD_AGENT_TOKEN:-}" ] || exit 0
[ -n "${EDD_WORKSPACE_ID:-}" ] || exit 0

# git writes the request (host=, protocol=, …) to stdin; we serve one token for
# the session regardless, so drain it.
cat >/dev/null 2>&1 || true

_resp="$(curl -fsS --max-time 10 \
  -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
  "${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/git-credential" 2>/dev/null)" || exit 0

# Parse {"username":"…","token":"…"} without jq (not guaranteed in the image).
_user="$(printf '%s' "${_resp}" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
_pass="$(printf '%s' "${_resp}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "${_pass}" ] || exit 0

printf 'username=%s\n' "${_user:-x-access-token}"
printf 'password=%s\n' "${_pass}"
