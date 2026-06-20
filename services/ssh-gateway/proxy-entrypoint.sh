#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint for the SSH proxy container.
# Captures Docker env vars into /run/edd-env before starting sshd — the
# ForceCommand (wake-and-forward.sh) sources this file because sshd strips
# the container's environment from ForceCommand sessions.
set -eu
unset CDPATH
# Persist EDD_* (incl. the raw EDD_GATEWAY_SECRET) for the env-stripped AuthorizedKeysCommand
# + ForceCommand. Restrict it to root + the `edd` group (its only readers: `nobody` and the
# login principal) — never world-readable, so no other container principal can read the secret.
(
  umask 077
  printenv | grep '^EDD_' >/run/edd-env
) || true
chgrp edd /run/edd-env && chmod 0640 /run/edd-env
exec /usr/sbin/sshd -D -e "$@"
