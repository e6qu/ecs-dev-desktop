#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint for the e2e workspace SSH node (registered-key auth, mirrors the golden
# image). Persists the coordinates the AuthorizedKeysCommand needs to a root-only
# /run/edd-ssh-env (sshd strips the pre-auth environment), then runs sshd.
set -eu
unset CDPATH

: "${EDD_WORKSPACE_ID:?EDD_WORKSPACE_ID is required}"
: "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required}"
: "${EDD_AGENT_TOKEN:?EDD_AGENT_TOKEN is required}"

(
  umask 077
  printf 'EDD_WORKSPACE_ID=%s\nEDD_CONTROL_PLANE_URL=%s\nEDD_AGENT_TOKEN=%s\n' \
    "${EDD_WORKSPACE_ID}" "${EDD_CONTROL_PLANE_URL}" "${EDD_AGENT_TOKEN}" \
    >/run/edd-ssh-env
)

exec /usr/sbin/sshd -D -e
