#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint for the SSH proxy container.
# Captures Docker env vars into /run/edd-env before starting sshd — the
# ForceCommand (wake-and-forward.sh) sources this file because sshd strips
# the container's environment from ForceCommand sessions.
set -eu
unset CDPATH
printenv | grep '^EDD_' >/run/edd-env || true
exec /usr/sbin/sshd -D -e "$@"
