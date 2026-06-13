#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Robust local integration run (`pnpm test:integ:local`): reap prior state, bring
# up the tier-2 substrate (DynamoDB Local + process-mode AWS sim), then run the
# integration suite. The suites drop+create their tables idempotently, so re-runs
# and a previously-interrupted run are both safe.
set -eu
unset CDPATH
here="$(dirname "$0")"

sh "$here/reap-local.sh"
docker compose -f docker-compose.tier2.yml up -d --build --wait
pnpm test:integ
