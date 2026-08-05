#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Robust local integration run (`pnpm test:integ:local`): reap prior state, bring
# up the tier-2 substrate (the process-mode AWS sim, which also serves DynamoDB),
# then run the integration suite. The suites drop+create their tables idempotently,
# so re-runs and a previously-interrupted run are both safe.
set -eu
unset CDPATH
here="$(dirname "$0")"

# DynamoDB is served by the sim (the default `dynamodb.endpoint` is the sim at :4566;
# the standalone DynamoDB-Local container was retired from this tier once the sim's
# DynamoDB became conformant). `AWS_ENDPOINT_URL` may still override it if set.

sh "$here/reap-local.sh"
docker compose -f docker-compose.tier2.yml up -d --build --wait
# The AWS coordinates every client needs. The application assumes AWS and reads
# these exactly as it would in a real account: a region, where the API answers,
# and credentials to sign with. The simulator accepts any credential; naming one
# here keeps the application free of knowledge about what is answering.
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
pnpm test:integ
