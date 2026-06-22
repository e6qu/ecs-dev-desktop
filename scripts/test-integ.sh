#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Robust local integration run (`pnpm test:integ:local`): reap prior state, bring
# up the tier-2 substrate (the process-mode AWS sim, which also serves DynamoDB),
# then run the integration suite. The suites drop+create their tables idempotently,
# so re-runs and a previously-interrupted run are both safe.
set -eu
unset CDPATH
here="$(dirname "$0")"

# DynamoDB is served by the sim (the standalone DynamoDB-Local container was retired
# from this tier once the sim's DynamoDB became conformant). Point the suite at it.
DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:4566}"
export DYNAMODB_ENDPOINT

sh "$here/reap-local.sh"
docker compose -f docker-compose.tier2.yml up -d --build --wait
pnpm test:integ
