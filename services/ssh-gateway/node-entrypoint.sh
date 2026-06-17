#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint for the e2e workspace SSH node (additive auth, mirrors the golden
# image). When the registered-key coordinates are present, persist them to a
# root-only /run/edd-ssh-env (sshd strips the pre-auth environment) so the
# AuthorizedKeysCommand can authorize a registered key. The SSH CA path needs no
# env — sshd_config references workspace-ca.pub unconditionally, so ensure it
# exists (empty unless a CA pubkey is mounted) and the principals dir is present.
set -eu
unset CDPATH

if [ -n "${EDD_WORKSPACE_ID:-}" ]; then
  : "${EDD_CONTROL_PLANE_URL:?EDD_CONTROL_PLANE_URL is required with EDD_WORKSPACE_ID}"
  : "${EDD_AGENT_TOKEN:?EDD_AGENT_TOKEN is required with EDD_WORKSPACE_ID}"
  (
    umask 077
    printf 'EDD_WORKSPACE_ID=%s\nEDD_CONTROL_PLANE_URL=%s\nEDD_AGENT_TOKEN=%s\n' \
      "${EDD_WORKSPACE_ID}" "${EDD_CONTROL_PLANE_URL}" "${EDD_AGENT_TOKEN}" \
      >/run/edd-ssh-env
  )
fi

mkdir -p /etc/ssh/principals
[ -f /etc/ssh/workspace-ca.pub ] || : >/etc/ssh/workspace-ca.pub

exec /usr/sbin/sshd -D -e
