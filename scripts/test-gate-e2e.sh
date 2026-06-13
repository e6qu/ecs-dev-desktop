#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Robust local run of the live PEP→PDP gate e2e (`pnpm test:pw:gate:local`): reap
# prior state, generate the sim TLS cert, build the web + gate images, bring up
# docker-compose.gate.yml (Pomerium + azure-sim + gate + PDP + echo upstream),
# then drive the browser through Pomerium → gate → PDP. Idempotent + self-reaping,
# so a half-finished prior run won't block this one. See TESTING.md.
set -eu
unset CDPATH
here="$(dirname "$0")"

docker compose -f docker-compose.gate.yml down --remove-orphans -v || true
sh "$here/gen-sim-tls-cert.sh"
docker compose -f docker-compose.gate.yml up -d --build --wait

# The seeding global-setup + the PDP container share one DynamoDB Local table.
export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:8000}"
export DYNAMODB_TABLE="${DYNAMODB_TABLE:-edd-gate-e2e}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-dummy}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-dummy}"

pnpm --filter web exec playwright install chromium
pnpm --filter web test:pw:gate
