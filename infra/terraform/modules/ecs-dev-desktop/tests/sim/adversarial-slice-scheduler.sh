#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for EventBridge Scheduler.
# The module's aws_scheduler_schedule drives the reconciler cron with
# flexible_time_window OFF, a rate() expression, an ECS Fargate target,
# retry_policy, and a DLQ. The scheduler resource is exercised by the app
# integ tier (scheduler-recurrence) but has no adversarial spec-fidelity slice.
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
sched_name="edd-sched-probe-${suffix}"
group_name="default"

cleanup() {
  aws scheduler delete-schedule --name "$sched_name" --group-name "$group_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== EventBridge Scheduler: create a rate() schedule ==="
aws scheduler create-schedule \
  --name "$sched_name" \
  --group-name "$group_name" \
  --schedule-expression "rate(1 minute)" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target '{"Arn":"arn:aws:sqs:'"$region"':123456789012:edd-sched-target","RoleArn":"arn:aws:iam::123456789012:role/edd-sched-role"}' \
  --output json >/dev/null 2>&1 || fail "create-schedule rejected"

echo "=== EventBridge Scheduler: describe and verify expression ==="
expr=$(aws scheduler get-schedule \
  --name "$sched_name" \
  --group-name "$group_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["ScheduleExpression"])')
if [ "$expr" != "rate(1 minute)" ]; then
  fail "expected 'rate(1 minute)', got '$expr'"
fi
pass "Schedule expression round-trips"

echo "=== EventBridge Scheduler: verify flexible time window ==="
ftw=$(aws scheduler get-schedule \
  --name "$sched_name" \
  --group-name "$group_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["FlexibleTimeWindow"]["Mode"])')
if [ "$ftw" != "OFF" ]; then
  fail "expected FlexibleTimeWindow Mode=OFF, got '$ftw'"
fi
pass "FlexibleTimeWindow OFF (exact-time)"

echo "=== EventBridge Scheduler: verify target structure ==="
target_arn=$(aws scheduler get-schedule \
  --name "$sched_name" \
  --group-name "$group_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Target"]["Arn"])')
if [ -z "$target_arn" ]; then
  fail "target Arn missing"
fi
case "$target_arn" in
  *sqs*) pass "Target ARN points at SQS" ;;
  *) fail "expected SQS target ARN, got '$target_arn'" ;;
esac

echo "=== EventBridge Scheduler: update schedule expression ==="
aws scheduler update-schedule \
  --name "$sched_name" \
  --group-name "$group_name" \
  --schedule-expression "rate(5 minutes)" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target '{"Arn":"arn:aws:sqs:'"$region"':123456789012:edd-sched-target","RoleArn":"arn:aws:iam::123456789012:role/edd-sched-role"}' \
  >/dev/null || fail "update-schedule rejected"

updated_expr=$(aws scheduler get-schedule \
  --name "$sched_name" \
  --group-name "$group_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["ScheduleExpression"])')
if [ "$updated_expr" != "rate(5 minutes)" ]; then
  fail "expected 'rate(5 minutes)' after update, got '$updated_expr'"
fi
pass "Schedule expression update round-trips"

echo "=== ALL EVENTBRIDGE SCHEDULER ADVERSARIAL SLICE PROBES PASSED ==="
