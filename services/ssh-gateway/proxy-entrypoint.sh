#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint for the SSH proxy container.
# Captures Docker env vars into /run/edd-env before starting sshd — the
# ForceCommand (wake-and-forward.sh) sources this file because sshd strips
# the container's environment from ForceCommand sessions.
set -eu
unset CDPATH
# Persist EDD_* for the env-stripped AuthorizedKeysCommand (runs as `nobody`) + ForceCommand
# (runs as the dev-* login user). It must be readable by both of those distinct, unrelated
# system users; sshd's command sessions don't reliably carry a shared supplementary group, so
# the file stays world-readable here (this single-purpose proxy has no other principal — the
# ForceCommand is a forced TCP proxy, never a shell). The far-larger-blast-radius inner hop
# (node-entrypoint.sh) stores only the per-workspace derived token, umask 077.
printenv | grep '^EDD_' >/run/edd-env || true
exec /usr/sbin/sshd -D -e "$@"
