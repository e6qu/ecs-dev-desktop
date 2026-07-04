#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for DynamoDB table behavioral properties.
# The module's aws_dynamodb_table uses PAY_PER_REQUEST, SSE with a KMS key, two
# GSIs (ALL projection), and optional PITR. The app integ tier exercises DynamoDB
# via ElectroDB, but the table-level spec fidelity (SSE description, GSI shape,
# billing mode) is never adversarially probed.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment.
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
region="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_ENDPOINT_URL="$endpoint"
export AWS_DEFAULT_REGION="$region"
export AWS_PAGER=""

aws() {
  command aws "$@"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

suffix="$(date +%s)"
table_name="edd-ddb-probe-${suffix}"

cleanup() {
  aws dynamodb delete-table --table-name "$table_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== DynamoDB: create table with SSE + PAY_PER_REQUEST + GSI ==="
aws dynamodb create-table \
  --table-name "$table_name" \
  --attribute-definitions \
  AttributeName=PK,AttributeType=S \
  AttributeName=SK,AttributeType=S \
  AttributeName=GSI1PK,AttributeType=S \
  AttributeName=GSI1SK,AttributeType=S \
  --key-schema \
  AttributeName=PK,KeyType=HASH \
  AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true,SSEType=KMS \
  --global-secondary-indexes \
  '[
      {
        "IndexName": "byOwner",
        "KeySchema": [
          {"AttributeName": "GSI1PK", "KeyType": "HASH"},
          {"AttributeName": "GSI1SK", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      }
    ]' \
  --output json >/dev/null || fail "create-table rejected"

echo "=== DynamoDB: describe table and verify billing mode ==="
billing_mode=$(aws dynamodb describe-table \
  --table-name "$table_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Table"]["BillingModeSummary"]["BillingMode"])')
if [ "$billing_mode" != "PAY_PER_REQUEST" ]; then
  fail "expected PAY_PER_REQUEST billing mode, got $billing_mode"
fi
pass "Billing mode PAY_PER_REQUEST round-trips"

echo "=== DynamoDB: verify SSE description ==="
sse_status=$(aws dynamodb describe-table \
  --table-name "$table_name" \
  --output json |
  python3 -c 'import sys,json; t=json.load(sys.stdin)["Table"]; sse=t.get("SSEDescription",{}); print(sse.get("Status","MISSING"),sse.get("SSEType","MISSING"))')
sse_enabled=$(printf '%s' "$sse_status" | cut -d' ' -f1)
sse_type=$(printf '%s' "$sse_status" | cut -d' ' -f2)
if [ "$sse_enabled" != "ENABLED" ]; then
  fail "expected SSE Status=ENABLED, got $sse_enabled"
fi
if [ "$sse_type" != "KMS" ]; then
  fail "expected SSE Type=KMS, got $sse_type"
fi
pass "SSE encryption KMS enabled"

echo "=== DynamoDB: verify GSI shape ==="
gsi_name=$(aws dynamodb describe-table \
  --table-name "$table_name" \
  --output json |
  python3 -c 'import sys,json; gsis=json.load(sys.stdin)["Table"].get("GlobalSecondaryIndexes",[]); print(gsis[0]["IndexName"] if gsis else "MISSING")')
if [ "$gsi_name" != "byOwner" ]; then
  fail "expected GSI 'byOwner', got $gsi_name"
fi

gsi_projection=$(aws dynamodb describe-table \
  --table-name "$table_name" \
  --output json |
  python3 -c 'import sys,json; gsis=json.load(sys.stdin)["Table"].get("GlobalSecondaryIndexes",[]); print(gsis[0]["Projection"]["ProjectionType"] if gsis else "MISSING")')
if [ "$gsi_projection" != "ALL" ]; then
  fail "expected GSI ProjectionType=ALL, got $gsi_projection"
fi
pass "GSI byOwner with ALL projection round-trips"

echo "=== DynamoDB: put and query via GSI ==="
aws dynamodb put-item \
  --table-name "$table_name" \
  --item '{"PK":{"S":"WS#001"},"SK":{"S":"META"},"GSI1PK":{"S":"OWNER#alice"},"GSI1SK":{"S":"WS#001"},"status":{"S":"running"}}' \
  >/dev/null || fail "put-item rejected"

items=$(aws dynamodb query \
  --table-name "$table_name" \
  --index-name "byOwner" \
  --key-condition-expression "GSI1PK = :owner" \
  --expression-attribute-values '{":owner":{"S":"OWNER#alice"}}' \
  --output json |
  python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Items",[])))')
if [ "$items" -ne 1 ]; then
  fail "expected 1 item via GSI query, got $items"
fi
pass "GSI query returns correct items"

echo "=== ALL DYNAMODB ADVERSARIAL SLICE PROBES PASSED ==="
