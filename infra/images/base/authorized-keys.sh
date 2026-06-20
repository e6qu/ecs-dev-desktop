#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# sshd AuthorizedKeysCommand for the golden workspace image — the inner hop of the
# dual-trust SSH path. Authorizes the public key the client offered against the
# control plane: the key must be registered to this workspace's owner. Prints the
# authorized_keys line on success, nothing on denial (sshd then rejects). The
# workspace never trusts a key on its own — the decision is the control plane's,
# made per connection (revocable by removing the key).
#
# Runs pre-auth as root (AuthorizedKeysCommandUser root), reading the per-workspace
# agent token from /run/edd-ssh-env (root-only; written by the entrypoint, since
# sshd strips the environment from this command). The login user is always
# `workspace`; the workspace identifies itself by EDD_WORKSPACE_ID, not %u.
#
# Args (from sshd `AuthorizedKeysCommand ... %t %k`):  $1 key type, $2 key blob.
set -eu
unset CDPATH

if [ -f /run/edd-ssh-env ]; then
  # shellcheck disable=SC1091
  . /run/edd-ssh-env
fi
: "${EDD_WORKSPACE_ID:?EDD_WORKSPACE_ID is required}"
: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_AGENT_TOKEN:?EDD_AGENT_TOKEN is required}"

key_type="${1:?key type is required}"
key_blob="${2:?key blob is required}"

# Defense-in-depth: reject key fields outside the JSON-safe SSH charset before
# interpolating them into the request body below — a `"`/`\` could otherwise alter the
# request shape. sshd only passes validated keys, so a real key always passes; fail closed.
case "${key_type}${key_blob}" in
  *[!A-Za-z0-9@._/+=-]*) exit 0 ;;
esac

# Bound the request: a slow/unreachable control plane must NOT hang sshd's auth
# phase (this command runs pre-auth and blocks the login until it returns). On
# timeout curl prints nothing → the key is treated as not authorized → sshd denies.
response=$(curl -s --connect-timeout 3 --max-time 8 -X POST \
  "${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/ssh-authorize" \
  -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
  -H "content-type: application/json" \
  -d "{\"publicKey\":\"${key_type} ${key_blob}\"}")

case "$response" in
  *'"authorized":true'*) printf '%s %s\n' "$key_type" "$key_blob" ;;
  *) : ;;
esac
