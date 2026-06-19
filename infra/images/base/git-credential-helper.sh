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

# This IS a configured managed session (all three vars present), so a broker failure
# is real — surface it on stderr (git shows a helper's stderr) instead of silently
# falling back to unauthenticated access and failing the clone/push opaquely later.
# Still exit 0: returning no credential is valid, and git then reports the auth
# failure with our diagnostic visible (rather than the helper aborting git itself).
if ! _resp="$(curl -fsS --max-time 10 \
  -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
  "${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/git-credential" 2>&1)"; then
  echo "edd: could not fetch a git credential from the control plane: ${_resp}" >&2
  exit 0
fi

# Parse {"username":"…","token":"…"} without jq (not guaranteed in the image).
_user="$(printf '%s' "${_resp}" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
_pass="$(printf '%s' "${_resp}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "${_pass}" ]; then
  echo "edd: the control plane returned no git token for this session (is your Git account linked?)" >&2
  exit 0
fi

printf 'username=%s\n' "${_user:-x-access-token}"
printf 'password=%s\n' "${_pass}"
