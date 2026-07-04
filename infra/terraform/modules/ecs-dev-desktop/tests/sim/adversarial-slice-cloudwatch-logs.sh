#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for CloudWatch Logs surfaces ecs-dev-desktop depends on.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://localhost:4566}"
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
log_group="/edd/adversarial/logs-${suffix}"
log_stream="stream-${suffix}"

# Reuse an existing KMS key if one exists, otherwise create one.
key_id=$(aws kms list-aliases --output json 2>/dev/null |
  python3 -c 'import sys,json; aliases=json.load(sys.stdin).get("Aliases",[]); print(next((a["TargetKeyId"] for a in aliases if a.get("AliasName")=="alias/aws/logs"), ""))' || true)
if [ -z "$key_id" ]; then
  key_id=$(aws kms create-key --description "edd cloudwatch logs probe" --output json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["KeyMetadata"]["KeyId"])')
fi

echo "=== CloudWatch Logs: create log group with KMS key ==="
aws logs create-log-group --log-group-name "$log_group" --kms-key-id "$key_id" >/dev/null ||
  fail "CreateLogGroup rejected"

groups=$(aws logs describe-log-groups --log-group-name-pattern "adversarial/logs-${suffix}" --output json)
if ! printf '%s\n' "$groups" | python3 -c 'import sys,json; sys.exit(0 if any("adversarial/logs-'"$suffix"'" in g.get("logGroupName","") for g in json.load(sys.stdin).get("logGroups",[])) else 1)'; then
  fail "DescribeLogGroups did not return the created group"
fi
kms=$(printf '%s\n' "$groups" | python3 -c 'import sys,json; print(next((g.get("kmsKeyId") for g in json.load(sys.stdin).get("logGroups",[]) if "adversarial/logs-'"$suffix"'" in g.get("logGroupName","")),""))')
if [ -z "$kms" ]; then
  fail "CreateLogGroup did not persist kmsKeyId"
fi
pass "CreateLogGroup + DescribeLogGroups round-trip with kmsKeyId"

echo "=== CloudWatch Logs: retention policy ==="
aws logs put-retention-policy --log-group-name "$log_group" --retention-in-days 7 >/dev/null ||
  fail "PutRetentionPolicy rejected"
retention=$(aws logs describe-log-groups --log-group-name-prefix "$log_group" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["logGroups"][0].get("retentionInDays","MISSING"))')
if [ "$retention" != "7" ]; then
  fail "Retention policy expected 7, got $retention"
fi
pass "PutRetentionPolicy round-trip"

echo "=== CloudWatch Logs: log stream + events ==="
aws logs create-log-stream --log-group-name "$log_group" --log-stream-name "$log_stream" >/dev/null ||
  fail "CreateLogStream rejected"

timestamp=$(python3 -c 'import time; print(int(time.time()*1000))')
aws logs put-log-events \
  --log-group-name "$log_group" \
  --log-stream-name "$log_stream" \
  --log-events "timestamp=${timestamp},message=probe-event-1" "timestamp=$((timestamp + 1)),message=probe-event-2" \
  >/dev/null || fail "PutLogEvents rejected"

events=$(aws logs get-log-events --log-group-name "$log_group" --log-stream-name "$log_stream" --output json)
count=$(printf '%s\n' "$events" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("events",[])))')
if [ "$count" -lt 2 ]; then
  fail "GetLogEvents expected at least 2 events, got $count"
fi
pass "CreateLogStream + PutLogEvents + GetLogEvents round-trip"

echo "=== CloudWatch Logs: FilterLogEvents ==="
filtered=$(aws logs filter-log-events \
  --log-group-name "$log_group" \
  --filter-pattern '"probe-event-1"' \
  --output json)
fcount=$(printf '%s\n' "$filtered" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("events",[])))')
if [ "$fcount" -lt 1 ]; then
  fail "FilterLogEvents expected at least 1 matching event, got $fcount"
fi
pass "FilterLogEvents pattern match"

echo "=== CloudWatch Logs: delete stream + group ==="
aws logs delete-log-stream --log-group-name "$log_group" --log-stream-name "$log_stream" >/dev/null ||
  fail "DeleteLogStream rejected"
aws logs delete-log-group --log-group-name "$log_group" >/dev/null ||
  fail "DeleteLogGroup rejected"
remaining=$(aws logs describe-log-groups --log-group-name-prefix "$log_group" --output json |
  python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("logGroups",[])))')
if [ "$remaining" -ne 0 ]; then
  fail "DeleteLogGroup did not remove the log group"
fi
pass "DeleteLogStream + DeleteLogGroup"

echo "=== ALL CLOUDWATCH LOGS ADVERSARIAL SLICE PROBES PASSED ==="
