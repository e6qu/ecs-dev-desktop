#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint for the SSH proxy container.
# Captures Docker env vars into /run/edd-env before starting sshd — the
# ForceCommand (wake-and-forward.sh) sources this file because sshd strips
# the container's environment from ForceCommand sessions.
set -eu
unset CDPATH
printenv | grep '^EDD_' >/run/edd-env || true
# sshd_config references TrustedUserCAKeys unconditionally; ensure the file exists
# (empty when no CA is mounted → only the registered-key path is active).
[ -f /etc/ssh/workspace-ca.pub ] || : >/etc/ssh/workspace-ca.pub
exec /usr/sbin/sshd -D -e "$@"
