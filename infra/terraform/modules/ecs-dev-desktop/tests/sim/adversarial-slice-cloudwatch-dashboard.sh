#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for CloudWatch dashboards.
# The module's aws_cloudwatch_dashboard.ops renders fleet metrics with six
# widgets referencing custom metric namespaces and ALB/TG ARN suffixes. The
# dashboard JSON round-trip is never adversarially validated.
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
dash_name="edd-dash-probe-${suffix}"

# Dashboard body: two widgets — a Metric widget and a Text widget.
dash_body='{"widgets":[{"type":"metric","x":0,"y":0,"width":12,"height":6,"properties":{"view":"timeSeries","title":"CPU","metrics":[["AWS/EC2","CPUUtilization"]],"region":"'"$region"'"}},{"type":"text","x":12,"y":0,"width":6,"height":3,"properties":{"markdown":"# Ops dashboard"}}]}'

cleanup() {
  aws cloudwatch delete-dashboards --dashboard-names "$dash_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== CloudWatch dashboard: create ==="
printf '%s' "$dash_body" | aws cloudwatch put-dashboard \
  --dashboard-name "$dash_name" \
  --dashboard-body file:///dev/stdin \
  --output json >/dev/null || fail "put-dashboard rejected"
pass "Dashboard created"

echo "=== CloudWatch dashboard: get and verify structure ==="
retrieved=$(aws cloudwatch get-dashboard \
  --dashboard-name "$dash_name" \
  --output json |
  python3 -c 'import sys,json; d=json.load(sys.stdin)["DashboardBody"]; print(d)')

widget_count=$(printf '%s\n' "$retrieved" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["widgets"]))')
if [ "$widget_count" -ne 2 ]; then
  fail "expected 2 widgets, got $widget_count"
fi
pass "Dashboard body round-trips with $widget_count widgets"

echo "=== CloudWatch dashboard: verify widget types preserved ==="
types=$(printf '%s\n' "$retrieved" | python3 -c 'import sys,json; ws=json.load(sys.stdin)["widgets"]; print(",".join(sorted(w["type"] for w in ws)))')
if [ "$types" != "metric,text" ]; then
  fail "expected widget types 'metric,text', got '$types'"
fi
pass "Widget types preserved"

echo "=== CloudWatch dashboard: verify metric widget region ==="
metric_region=$(printf '%s\n' "$retrieved" | python3 -c 'import sys,json; ws=json.load(sys.stdin)["widgets"]; print(next(w["properties"].get("region","") for w in ws if w["type"]=="metric"))')
if [ "$metric_region" != "$region" ]; then
  fail "expected metric widget region $region, got '$metric_region'"
fi
pass "Metric widget region preserved"

echo "=== CloudWatch dashboard: list includes created dashboard ==="
list=$(aws cloudwatch list-dashboards --output json |
  python3 -c 'import sys,json; print(any(e["DashboardName"]==sys.argv[1] for e in json.load(sys.stdin).get("DashboardEntries",[])))' "$dash_name")
if [ "$list" != "True" ]; then
  fail "created dashboard not found in list-dashboards"
fi
pass "Dashboard appears in list-dashboards"

echo "=== ALL CLOUDWATCH DASHBOARD ADVERSARIAL SLICE PROBES PASSED ==="
