#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for ECS service rolling update + circuit breaker.
# Proves that CreateService persists DeploymentConfiguration (circuit breaker) and that
# UpdateService with a new task definition creates a new PRIMARY deployment.
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
cluster_name="edd-ecs-rolling-${suffix}"
service_name="edd-ecs-rolling-svc-${suffix}"
td_v1="edd-ecs-rolling-v1-${suffix}"
td_v2="edd-ecs-rolling-v2-${suffix}"

cleanup() {
  aws ecs update-service --cluster "$cluster_name" --service "$service_name" --desired-count 0 >/dev/null 2>&1 || true
  aws ecs delete-service --cluster "$cluster_name" --service "$service_name" --force >/dev/null 2>&1 || true
  aws ecs deregister-task-definition --task-definition "${td_v2}:1" >/dev/null 2>&1 || true
  aws ecs deregister-task-definition --task-definition "${td_v1}:1" >/dev/null 2>&1 || true
  aws ecs delete-cluster --cluster "$cluster_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== ECS rolling update: register task definitions v1 and v2 ==="
aws ecs create-cluster --cluster-name "$cluster_name" >/dev/null || fail "CreateCluster rejected"

aws ecs register-task-definition \
  --family "$td_v1" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 --memory 512 \
  --execution-role-arn "arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
  --container-definitions '[{"name":"probe","image":"busybox:latest","essential":true,"command":["sleep","300"]}]' >/dev/null || fail "RegisterTaskDefinition v1 rejected"

aws ecs register-task-definition \
  --family "$td_v2" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 --memory 512 \
  --execution-role-arn "arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
  --container-definitions '[{"name":"probe","image":"busybox:latest","essential":true,"command":["sleep","300"]}]' >/dev/null || fail "RegisterTaskDefinition v2 rejected"
pass "Task definitions v1 and v2 registered"

echo "=== ECS rolling update: create service with circuit breaker ==="
aws ecs create-service \
  --cluster "$cluster_name" \
  --service-name "$service_name" \
  --task-definition "$td_v1" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-12345678],securityGroups=[sg-12345678],assignPublicIp=DISABLED}' \
  --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100' \
  --output json >/dev/null || fail "CreateService rejected"

cb_enabled=$(aws ecs describe-services \
  --cluster "$cluster_name" \
  --services "$service_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["services"][0]["deploymentConfiguration"]["deploymentCircuitBreaker"]["enable"])')
if [ "$cb_enabled" != "True" ]; then
  fail "expected circuit breaker enable=True, got $cb_enabled"
fi
pass "Service created with circuit breaker enabled"

echo "=== ECS rolling update: UpdateService creates new deployment ==="
aws ecs update-service \
  --cluster "$cluster_name" \
  --service "$service_name" \
  --task-definition "$td_v2" \
  --output json >/dev/null || fail "UpdateService rejected"

primary_td=$(aws ecs describe-services \
  --cluster "$cluster_name" \
  --services "$service_name" \
  --output json |
  python3 -c 'import sys,json; print(next((d["taskDefinition"] for d in json.load(sys.stdin)["services"][0].get("deployments",[]) if d.get("status")=="PRIMARY"),"MISSING"))')
if [ "$primary_td" != "${td_v2}:1" ] && [ "$primary_td" != "$td_v2" ]; then
  fail "expected PRIMARY deployment taskDefinition ${td_v2}:1, got $primary_td"
fi
pass "UpdateService rolled PRIMARY deployment to v2"

echo "=== ALL ECS ROLLING UPDATE ADVERSARIAL SLICE PROBES PASSED ==="
