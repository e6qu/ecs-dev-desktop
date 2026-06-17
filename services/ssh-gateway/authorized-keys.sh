#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# sshd AuthorizedKeysCommand for the SSH gateway (the public hop of the dual-trust
# path). Invoked by sshd with the login user + the key the client offered; prints
# the matching authorized_keys line iff the control plane authorizes it — i.e. the
# key is registered to the owner of the workspace named by the login user
# (`dev-<workspaceId>`). No match → no output → sshd denies. The gateway never
# trusts a key on its own; the decision is the control plane's.
#
# Args (from sshd `AuthorizedKeysCommand ... %u %t %k`):
#   $1 login user (the workspace principal, "dev-<id>")
#   $2 key type   (e.g. "ssh-ed25519")
#   $3 key blob   (base64)
#
# Env (saved to /run/edd-env by proxy-entrypoint.sh — sshd strips it otherwise):
#   EDD_CONTROL_PLANE_URL  base URL of the control plane API
#   EDD_GATEWAY_SECRET     hex machine-auth secret; a per-workspace HMAC token is
#                          derived from it (the same scheme as wake-and-forward.sh)
set -eu
unset CDPATH

if [ -f /run/edd-env ]; then
  # shellcheck disable=SC1091
  . /run/edd-env
fi
: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_GATEWAY_SECRET:?EDD_GATEWAY_SECRET is required}"

login_user="${1:?login user is required}"
key_type="${2:?key type is required}"
key_blob="${3:?key blob is required}"

# "dev-abc123" -> "abc123"; reject a login that is not a dev-* principal.
workspace_id="${login_user#dev-}"
if [ "$workspace_id" = "$login_user" ]; then
  exit 0
fi

# Per-workspace machine-auth token: HMAC-SHA256(hexkey(secret), workspaceId).
token=$(printf '%s' "$workspace_id" |
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:${EDD_GATEWAY_SECRET}" |
  awk '{print $NF}')
if [ -z "$token" ]; then
  exit 0
fi

# Bound the request: a slow/unreachable control plane must NOT hang sshd's auth
# phase (this command runs pre-auth and blocks the login until it returns). On
# timeout curl prints nothing → the key is treated as not authorized → sshd denies.
response=$(curl -s --connect-timeout 3 --max-time 8 -X POST \
  "${EDD_CONTROL_PLANE_URL}/api/workspaces/${workspace_id}/ssh-authorize" \
  -H "Authorization: Bearer ${token}" \
  -H "content-type: application/json" \
  -d "{\"publicKey\":\"${key_type} ${key_blob}\"}")

# Print the authorized_keys line only when the control plane says yes.
case "$response" in
  *'"authorized":true'*) printf '%s %s\n' "$key_type" "$key_blob" ;;
  *) : ;;
esac
