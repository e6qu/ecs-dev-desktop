#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for SQS dead-letter-queue redrive.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
region="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

aws() {
  command aws --endpoint-url "$endpoint" --region "$region" "$@"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

suffix="$(date +%s)"
dlq_name="edd-adversarial-sqs-dlq-${suffix}"
main_name="edd-adversarial-sqs-main-${suffix}"

echo "=== SQS: create DLQ and main queue with RedrivePolicy ==="
dlq_url=$(aws sqs create-queue --queue-name "$dlq_name" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["QueueUrl"])')
dlq_arn=$(aws sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Attributes"]["QueueArn"])')

redrive_value='"{\"deadLetterTargetArn\":\"'"$dlq_arn"'\",\"maxReceiveCount\":\"3\"}"'
main_url=$(aws sqs create-queue \
  --queue-name "$main_name" \
  --attributes "RedrivePolicy=${redrive_value}" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["QueueUrl"])')

main_attrs=$(aws sqs get-queue-attributes --queue-url "$main_url" --attribute-names RedrivePolicy --output json)
if ! printf '%s\n' "$main_attrs" | python3 -c 'import sys,json; rp=json.load(sys.stdin)["Attributes"].get("RedrivePolicy",""); sys.exit(0 if "deadLetterTargetArn" in rp else 1)'; then
  fail "main queue RedrivePolicy did not round-trip"
fi
pass "SQS queue create + RedrivePolicy round-trip"

echo "=== SQS: message redrives to DLQ after maxReceiveCount receives without delete ==="
aws sqs send-message --queue-url "$main_url" --message-body "probe-redrive" >/dev/null || fail "SendMessage rejected"

# Receive the message 4 times without deleting; after the 3rd receive it should redrive.
for _ in 1 2 3 4; do
  aws sqs receive-message --queue-url "$main_url" --visibility-timeout 0 >/dev/null || true
  sleep 0.3
done

dlq_count=$(aws sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names ApproximateNumberOfMessages \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Attributes"]["ApproximateNumberOfMessages"])')
if [ "$dlq_count" != "1" ]; then
  fail "expected 1 message in DLQ after maxReceiveCount, got $dlq_count"
fi
pass "SQS DLQ received message after maxReceiveCount=3"

echo "=== SQS: cleanup ==="
aws sqs delete-queue --queue-url "$main_url" >/dev/null || true
aws sqs delete-queue --queue-url "$dlq_url" >/dev/null || true

echo "=== ALL SQS ADVERSARIAL SLICE PROBES PASSED ==="
