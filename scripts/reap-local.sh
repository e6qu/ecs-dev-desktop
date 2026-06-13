#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Reap ALL local harness state from prior runs so a stale or half-created run can
# never block the current dev/test command. `down --remove-orphans` targets the
# whole compose project (same project name across docker-compose.dev / tier2 / e2e
# / ssh / https), so leftovers from any of them — plus networks and volumes (-v) —
# are removed. Idempotent and safe to run anytime (`pnpm reap`).
set -eu
unset CDPATH

docker compose -f docker-compose.dev.yml down --remove-orphans -v >/dev/null 2>&1 || true
echo "reaped local harness state (containers, networks, volumes)"
