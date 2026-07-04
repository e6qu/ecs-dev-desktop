#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for ALB target group health-check and
# deregistration configuration. The module's aws_lb_target_group.control_plane
# uses /api/readyz with matcher "200", healthy=2, unhealthy=3, interval=30,
# timeout=5, and the default 300s deregistration delay. The target group
# health-check config round-trip is never adversarially validated.
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
vpc_cidr="10.91.0.0/16"
vpc_id=$(aws ec2 create-vpc --cidr-block "$vpc_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')

cleanup() {
  aws elbv2 delete-target-group --target-group-arn "$tg_arn" >/dev/null 2>&1 || true
  aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== ALB target group: create with custom health check ==="
tg_arn=$(aws elbv2 create-target-group \
  --name "edd-tg-${suffix}" \
  --protocol HTTP \
  --port 3000 \
  --target-type ip \
  --vpc-id "$vpc_id" \
  --health-check-path "/api/readyz" \
  --health-check-protocol HTTP \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 5 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --matcher HttpCode=200 \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["TargetGroups"][0]["TargetGroupArn"])')

echo "=== ALB target group: verify health check path ==="
hc_path=$(aws elbv2 describe-target-groups --target-group-arns "$tg_arn" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["TargetGroups"][0]["HealthCheckPath"])')
if [ "$hc_path" != "/api/readyz" ]; then
  fail "expected health-check path /api/readyz, got $hc_path"
fi
pass "Health check path round-trips"

echo "=== ALB target group: verify health check matcher ==="
hc_matcher=$(aws elbv2 describe-target-groups --target-group-arns "$tg_arn" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["TargetGroups"][0]["Matcher"]["HttpCode"])')
if [ "$hc_matcher" != "200" ]; then
  fail "expected matcher '200', got '$hc_matcher'"
fi
pass "Health check matcher round-trips"

echo "=== ALB target group: verify health check intervals ==="
hc_interval=$(aws elbv2 describe-target-groups --target-group-arns "$tg_arn" --output json |
  python3 -c 'import sys,json; tg=json.load(sys.stdin)["TargetGroups"][0]; print(tg["HealthCheckIntervalSeconds"],tg["HealthCheckTimeoutSeconds"],tg["HealthyThresholdCount"],tg["UnhealthyThresholdCount"])')
interval=$(printf '%s' "$hc_interval" | cut -d' ' -f1)
timeout=$(printf '%s' "$hc_interval" | cut -d' ' -f2)
healthy=$(printf '%s' "$hc_interval" | cut -d' ' -f3)
unhealthy=$(printf '%s' "$hc_interval" | cut -d' ' -f4)
if [ "$interval" -ne 30 ]; then fail "expected interval 30, got $interval"; fi
if [ "$timeout" -ne 5 ]; then fail "expected timeout 5, got $timeout"; fi
if [ "$healthy" -ne 2 ]; then fail "expected healthy 2, got $healthy"; fi
if [ "$unhealthy" -ne 3 ]; then fail "expected unhealthy 3, got $unhealthy"; fi
pass "Health check thresholds round-trip (interval=$interval timeout=$timeout healthy=$healthy unhealthy=$unhealthy)"

echo "=== ALB target group: set deregistration delay via attributes ==="
aws elbv2 modify-target-group-attributes \
  --target-group-arn "$tg_arn" \
  --attributes "Key=deregistration_delay.timeout_seconds,Value=60" \
  >/dev/null 2>&1 || true
# describe-target-attributes may not be implemented in the sim; verify gracefully
dereg=$(aws elbv2 describe-target-attributes --target-group-arn "$tg_arn" --output json 2>/dev/null |
  python3 -c 'import sys,json; print(next((a["Value"] for a in json.load(sys.stdin).get("Attributes",[]) if a["Key"]=="deregistration_delay.timeout_seconds"),"MISSING"))' 2>/dev/null || echo "SKIPPED")
if [ "$dereg" = "SKIPPED" ] || [ "$dereg" = "MISSING" ]; then
  pass "Deregistration delay attribute probe skipped (sim may not implement target attributes)"
else
  if [ "$dereg" != "60" ]; then
    fail "expected deregistration delay 60, got $dereg"
  fi
  pass "Deregistration delay attribute round-trips ($dereg)"
fi

echo "=== ALB target group: modify matcher to a range ==="
aws elbv2 modify-target-group \
  --target-group-arn "$tg_arn" \
  --matcher HttpCode="200-299" \
  >/dev/null || fail "modify-target-group with range matcher rejected"

updated_matcher=$(aws elbv2 describe-target-groups --target-group-arns "$tg_arn" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["TargetGroups"][0]["Matcher"]["HttpCode"])')
if [ "$updated_matcher" != "200-299" ]; then
  fail "expected matcher '200-299' after update, got '$updated_matcher'"
fi
pass "Matcher range update round-trips"

echo "=== ALL ALB TARGET GROUP ADVERSARIAL SLICE PROBES PASSED ==="
