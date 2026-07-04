#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for CloudWatch Logs metric filters.
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
log_group="/edd/adversarial/metric-filter-${suffix}"
log_stream="stream-${suffix}"
namespace="edd/adversarial/metricfilter"
metric_name="ProbeErrors"

echo "=== CloudWatch Logs metric filter: create log group and put filter ==="
aws logs create-log-group --log-group-name "$log_group" >/dev/null || fail "CreateLogGroup rejected"
aws logs create-log-stream --log-group-name "$log_group" --log-stream-name "$log_stream" >/dev/null || fail "CreateLogStream rejected"

aws logs put-metric-filter \
  --log-group-name "$log_group" \
  --filter-name probe-filter \
  --filter-pattern 'ERROR' \
  --metric-transformations "metricName=${metric_name},metricNamespace=${namespace},metricValue=1" \
  >/dev/null || fail "PutMetricFilter rejected"

filters=$(aws logs describe-metric-filters --log-group-name "$log_group" --output json)
filter_count=$(printf '%s\n' "$filters" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("metricFilters",[])))')
if [ "$filter_count" -ne 1 ]; then
  fail "expected one metric filter, got $filter_count"
fi
pass "PutMetricFilter + DescribeMetricFilters round-trip"

echo "=== CloudWatch Logs metric filter: matching events publish metrics ==="
timestamp=$(python3 -c 'import time; print(int(time.time()*1000))')
aws logs put-log-events \
  --log-group-name "$log_group" \
  --log-stream-name "$log_stream" \
  --log-events "timestamp=${timestamp},message=ERROR probe" "timestamp=$((timestamp + 1)),message=INFO ignored" \
  >/dev/null || fail "PutLogEvents rejected"

found=0
for _ in 1 2 3 4 5; do
  count=$(aws cloudwatch list-metrics \
    --namespace "$namespace" \
    --metric-name "$metric_name" \
    --output json |
    python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Metrics",[])))')
  if [ "$count" -gt 0 ]; then
    found=1
    break
  fi
  sleep 1
done
if [ "$found" -ne 1 ]; then
  fail "metric filter did not publish metric to CloudWatch"
fi
pass "Metric filter published CloudWatch metric"

echo "=== CloudWatch Logs metric filter: invalid pattern should fail ==="
if aws logs put-metric-filter \
  --log-group-name "$log_group" \
  --filter-name bad-filter \
  --filter-pattern '{' \
  --metric-transformations "metricName=Bad,metricNamespace=${namespace},metricValue=1" \
  >/dev/null 2>&1; then
  fail "invalid metric-filter pattern should have been rejected"
fi
pass "Invalid metric-filter pattern rejected"

echo "=== CloudWatch Logs metric filter: cleanup ==="
aws logs delete-metric-filter --log-group-name "$log_group" --filter-name probe-filter >/dev/null 2>&1 || true
aws logs delete-metric-filter --log-group-name "$log_group" --filter-name bad-filter >/dev/null 2>&1 || true
aws logs delete-log-group --log-group-name "$log_group" >/dev/null 2>&1 || true

echo "=== ALL CLOUDWATCH METRIC FILTER ADVERSARIAL SLICE PROBES PASSED ==="
