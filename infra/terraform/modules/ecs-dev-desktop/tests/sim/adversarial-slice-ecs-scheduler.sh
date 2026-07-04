#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for ECS service scheduler DesiredCount reconciliation.
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
cluster_name="edd-ecs-scheduler-${suffix}"
service_name="edd-ecs-scheduler-svc-${suffix}"
task_family="edd-ecs-scheduler-task-${suffix}"

cleanup() {
  aws ecs update-service --cluster "$cluster_name" --service "$service_name" --desired-count 0 >/dev/null 2>&1 || true
  aws ecs delete-service --cluster "$cluster_name" --service "$service_name" --force >/dev/null 2>&1 || true
  aws ecs deregister-task-definition --task-definition "${task_family}:1" >/dev/null 2>&1 || true
  aws ecs delete-cluster --cluster "$cluster_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== ECS scheduler: create cluster + service with DesiredCount=2 ==="
aws ecs create-cluster --cluster-name "$cluster_name" >/dev/null || fail "CreateCluster rejected"

aws ecs register-task-definition \
  --family "$task_family" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 \
  --memory 512 \
  --execution-role-arn "arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
  --container-definitions '[{"name":"probe","image":"edd-workspace:e2e","essential":true}]' \
  >/dev/null || fail "RegisterTaskDefinition rejected"

aws ecs create-service \
  --cluster "$cluster_name" \
  --service-name "$service_name" \
  --task-definition "$task_family" \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-12345678],securityGroups=[sg-12345678],assignPublicIp=DISABLED}' \
  >/dev/null || fail "CreateService rejected"

desired=$(aws ecs describe-services \
  --cluster "$cluster_name" \
  --services "$service_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["services"][0].get("desiredCount","MISSING"))')
if [ "$desired" != "2" ]; then
  fail "expected desiredCount 2 after create, got $desired"
fi
pass "ECS CreateService persisted DesiredCount=2"

echo "=== ECS scheduler: UpdateService DesiredCount reconciles ==="
aws ecs update-service --cluster "$cluster_name" --service "$service_name" --desired-count 3 >/dev/null || fail "UpdateService rejected"

updated=$(aws ecs describe-services \
  --cluster "$cluster_name" \
  --services "$service_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["services"][0].get("desiredCount","MISSING"))')
if [ "$updated" != "3" ]; then
  fail "expected desiredCount 3 after update, got $updated"
fi
pass "ECS UpdateService reflected DesiredCount=3"

echo "=== ALL ECS SCHEDULER ADVERSARIAL SLICE PROBES PASSED ==="
