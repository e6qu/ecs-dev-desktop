#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Reap ALL local harness state from prior runs so a stale or half-created run can
# never block the current dev/test command. Each dev/test compose file is brought
# down with `--remove-orphans -v` (containers + networks + volumes). The dev-tier
# PROFILES (aws/github/entra) are enabled on every down, because `down` without
# the active profile leaves profile-scoped services (e.g. the sockerless sim)
# running. Idempotent and safe to run anytime (`pnpm reap`).
set -eu
unset CDPATH

for f in dev tier2 e2e ssh https gate; do
  docker compose -f "docker-compose.$f.yml" \
    --profile aws --profile github --profile entra \
    down --remove-orphans -v >/dev/null 2>&1 || true
done
echo "reaped local harness state (containers, networks, volumes)"
