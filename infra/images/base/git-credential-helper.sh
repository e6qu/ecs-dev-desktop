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
#
# The broker answers 200 + {"username","token"} when the owner has a linked Git account,
# and an EMPTY 204 when they have none (a normal state for a public-repo session, not an
# error). Anything else is a real failure worth naming, so the status is captured
# separately from the body rather than folded into curl's -f error text.
_status_file="$(mktemp)"
_resp="$(curl -sS --max-time 10 -o - -w '%{http_code}' \
  -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
  "${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/git-credential" \
  2>"${_status_file}")" || {
  echo "edd: could not reach the control plane for a git credential: $(cat "${_status_file}")" >&2
  rm -f "${_status_file}"
  exit 0
}
rm -f "${_status_file}"
# `-w '%{http_code}'` appends the 3-digit status after the body.
_status="${_resp#"${_resp%???}"}"
_body="${_resp%???}"

case "${_status}" in
  204)
    # No linked account: git now asks the host anonymously, which is right for a public
    # repository and fails (visibly, with this hint) for a private one.
    echo "edd: no Git account is linked to this session; a private repository needs one (link it in the portal)" >&2
    exit 0
    ;;
  200) ;;
  404)
    echo "edd: the control plane no longer knows this workspace (HTTP 404); it may have been deleted" >&2
    exit 0
    ;;
  *)
    echo "edd: could not fetch a git credential from the control plane (HTTP ${_status})" >&2
    exit 0
    ;;
esac

# Parse {"username":"…","token":"…"} without jq (not guaranteed in the image).
_user="$(printf '%s' "${_body}" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
_pass="$(printf '%s' "${_body}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "${_pass}" ]; then
  echo "edd: the control plane answered 200 without a git token for this session" >&2
  exit 0
fi

printf 'username=%s\n' "${_user:-x-access-token}"
printf 'password=%s\n' "${_pass}"
