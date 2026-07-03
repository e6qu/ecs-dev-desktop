#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for CloudWatch alarm actions -> SNS.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://localhost:4566}"
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

topic_name="cli-repro-t"
queue_name="cli-repro-q"
alarm_name="cli-alarm-sns-sqs-process-745"
namespace="Custom/CLIAlarmProcessRepro"
metric_name="CPUUtilization"

# Create SNS topic and SQS queue; subscribe the queue to the topic so we can
# poll for the alarm notification using a standard AWS fan-out pattern.
topic_arn=$(aws sns create-topic --name "$topic_name" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["TopicArn"])')

queue_url=$(aws sqs create-queue --queue-name "$queue_name" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["QueueUrl"])')
queue_arn=$(aws sqs get-queue-attributes --queue-url "$queue_url" --attribute-names QueueArn --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Attributes"]["QueueArn"])')

policy_file=$(mktemp)
python3 -c 'import json,sys; d={"Policy":json.dumps({"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"sqs:SendMessage","Resource":sys.argv[1]}]})}; print(json.dumps(d))' \
  "$queue_arn" >"$policy_file"
aws sqs set-queue-attributes --queue-url "$queue_url" --attributes "file://${policy_file}" >/dev/null || fail "SetQueueAttributes rejected"
rm -f "$policy_file"

subscription_arn=$(aws sns subscribe \
  --topic-arn "$topic_arn" \
  --protocol sqs \
  --notification-endpoint "$queue_arn" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["SubscriptionArn"])')

# Allow the SNS subscription and queue policy to settle before the alarm
# action fires. Fan-out is eventually consistent on real AWS too.
sleep 3

cleanup() {
  aws cloudwatch delete-alarms --alarm-names "$alarm_name" >/dev/null 2>&1 || true
  aws sns unsubscribe --subscription-arn "$subscription_arn" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "$topic_arn" >/dev/null 2>&1 || true
  aws sqs delete-queue --queue-url "$queue_url" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== CloudWatch alarm -> SNS: create alarm with SNS action ==="
aws cloudwatch put-metric-alarm \
  --alarm-name "$alarm_name" \
  --metric-name "$metric_name" \
  --namespace "$namespace" \
  --statistic Average \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 50.0 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$topic_arn" >/dev/null || fail "PutMetricAlarm rejected"

alarm_actions=$(aws cloudwatch describe-alarms \
  --alarm-names "$alarm_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["MetricAlarms"][0]["AlarmActions"][0])')
if [ "$alarm_actions" != "$topic_arn" ]; then
  fail "expected alarm action $topic_arn, got $alarm_actions"
fi
pass "Alarm action points at SNS topic"

echo "=== CloudWatch alarm -> SNS: breach threshold and wait for ALARM state ==="
aws cloudwatch put-metric-data \
  --namespace "$namespace" \
  --metric-data "[{\"MetricName\":\"$metric_name\",\"Value\":95.0,\"Unit\":\"Percent\"}]" >/dev/null || fail "PutMetricData rejected"

state_value=""
for _ in $(seq 1 15); do
  state_value=$(aws cloudwatch describe-alarms \
    --alarm-names "$alarm_name" \
    --output json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["MetricAlarms"][0].get("StateValue","UNKNOWN"))')
  if [ "$state_value" = "ALARM" ]; then
    break
  fi
  sleep 1
done
if [ "$state_value" != "ALARM" ]; then
  fail "alarm did not transition to ALARM, got $state_value"
fi
# The upstream isolated test sleeps 2s here. In the integrated terraform-sim
# environment the evaluator may be busy with Terraform-managed alarms, so allow
# extra time for the SNS fan-out before polling SQS.
sleep 3
pass "Alarm transitioned to ALARM"

echo "=== CloudWatch alarm -> SNS: receive alarm notification from SQS ==="
message_body=""
raw=""
for _ in $(seq 1 30); do
  raw=$(aws sqs receive-message --queue-url "$queue_url" --output json 2>/dev/null || true)
  message_body=$(echo "$raw" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("Messages",[{}])[0].get("Body",""))' 2>/dev/null || true)
  if [ -n "$message_body" ]; then
    break
  fi
  sleep 1
done
if [ -z "$message_body" ]; then
  fail "alarm notification not received on SQS queue (upstream: e6qu/sockerless#734); raw response: $raw"
fi
pass "Alarm notification delivered to SQS"

echo "=== CloudWatch alarm -> SNS: assert alarm notification payload ==="
# The SQS body is JSON; the embedded SNS Message is itself a JSON string.
if ! echo "$message_body" | grep -qF "\"AlarmName\":\"${alarm_name}\""; then
  fail "alarm notification missing expected AlarmName"
fi
if ! echo "$message_body" | grep -qF "\"NewStateValue\":\"ALARM\""; then
  fail "alarm notification missing expected NewStateValue=ALARM"
fi
pass "Alarm notification payload contains expected fields"

echo "=== ALL CLOUDWATCH ALARM -> SNS ADVERSARIAL SLICE PROBES PASSED ==="
