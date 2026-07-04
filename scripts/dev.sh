#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run the app locally (one command: `pnpm dev`). Reaps prior harness state, brings
# up the dev substrate (sockerless AWS sim at :4566 + any tiers in EDD_DEV_PROFILES,
# e.g. "github" or "github entra"), seeds the local table idempotently, then starts
# `next dev` with dev-auth. See docs/running-locally.md.
set -eu
unset CDPATH
here="$(dirname "$0")"

# Reap first so a stale/half-created run can't block this one.
sh "$here/reap-local.sh"

# Optional tiers (compose profiles): EDD_DEV_PROFILES="github entra", etc.
profiles=""
for p in ${EDD_DEV_PROFILES:-}; do
  profiles="$profiles --profile $p"
done
# shellcheck disable=SC2086 # word-splitting the profile flags is intended
docker compose -f docker-compose.dev.yml $profiles up -d --wait

# Local-only defaults (all overridable). Dev-auth is ON by default for the fast
# inner loop, but set EDD_DEV_AUTH=0 to exercise the real OIDC login (e.g. with the
# github/entra tiers). COMPUTE_PROVIDER / AWS_ENDPOINT_URL / AUTH_GITHUB_* pass
# through from the caller's env (the tiers — see docs/running-locally.md).
# The sim's DynamoDB serves on :4566 (the unified AWS endpoint) — the same one CI
# uses. DynamoDB Local is no longer needed for the dev loop.
export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:4566}"
export EDD_DEV_AUTH="${EDD_DEV_AUTH:-1}"

# Ensure the table + a base image exist (idempotent), then run the dev server on
# port 3700 (not 3000 — which collides with countless local dev servers).
pnpm --filter @edd/web exec tsx scripts/dev-bootstrap.ts
# Use the edd.localhost subdomain so dev-auth cookies stay isolated from other
# localhost apps (browsers resolve *.localhost -> 127.0.0.1 automatically).
echo "-> open http://edd.localhost:${PORT:-3700}  (dev login: seeded users, default password 'dev')"
exec pnpm --filter @edd/web exec next dev -p "${PORT:-3700}"
