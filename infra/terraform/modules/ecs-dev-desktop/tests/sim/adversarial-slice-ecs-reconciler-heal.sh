#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for ECS service scheduler healing.
# Proves that after a task is stopped, the service scheduler reconciles runningCount
# back to desiredCount. Requires the sim to be in container mode (SIM_RUNTIME=docker)
# so that Fargate tasks actually run; in process mode tasks cannot start, so the probe
# skips with an explanatory message.
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

# Probe only runs when the simulator can execute real task containers.
if [ "${SIM_RUNTIME:-}" != "docker" ]; then
  echo "SKIP: ECS reconciler heal probe requires SIM_RUNTIME=docker (real task execution); current runtime is '${SIM_RUNTIME:-process}'"
  exit 0
fi

suffix="$(date +%s)"
vpc_cidr="10.98.0.0/16"
subnet_cidr="10.98.1.0/24"
cluster_name="edd-ecs-heal-${suffix}"
service_name="edd-ecs-heal-svc-${suffix}"
td="edd-ecs-heal-td-${suffix}"
vpc_id=""
subnet_id=""
sg_id=""

cleanup() {
  aws ecs update-service --cluster "$cluster_name" --service "$service_name" --desired-count 0 >/dev/null 2>&1 || true
  aws ecs delete-service --cluster "$cluster_name" --service "$service_name" --force >/dev/null 2>&1 || true
  aws ecs deregister-task-definition --task-definition "${td}:1" >/dev/null 2>&1 || true
  aws ecs delete-cluster --cluster "$cluster_name" >/dev/null 2>&1 || true
  if [ -n "$sg_id" ]; then aws ec2 delete-security-group --group-id "$sg_id" >/dev/null 2>&1 || true; fi
  if [ -n "$subnet_id" ]; then aws ec2 delete-subnet --subnet-id "$subnet_id" >/dev/null 2>&1 || true; fi
  if [ -n "$vpc_id" ]; then aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "=== ECS reconciler heal: VPC / subnet / security group ==="
vpc_id=$(aws ec2 create-vpc --cidr-block "$vpc_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')
subnet_id=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$subnet_cidr" --availability-zone "${region}a" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Subnet"]["SubnetId"])')
sg_id=$(aws ec2 create-security-group --group-name "edd-ecs-heal-${suffix}" --description "heal probe" --vpc-id "$vpc_id" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')
pass "Network prerequisites created"

echo "=== ECS reconciler heal: cluster + task definition + service ==="
aws ecs create-cluster --cluster-name "$cluster_name" >/dev/null || fail "CreateCluster rejected"
aws ecs register-task-definition \
  --family "$td" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 --memory 512 \
  --execution-role-arn "arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
  --container-definitions '[{"name":"probe","image":"busybox:latest","essential":true,"command":["sleep","300"]}]' >/dev/null || fail "RegisterTaskDefinition rejected"
aws ecs create-service \
  --cluster "$cluster_name" \
  --service-name "$service_name" \
  --task-definition "$td" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${subnet_id}],securityGroups=[${sg_id}],assignPublicIp=DISABLED}" \
  --output json >/dev/null || fail "CreateService rejected"
pass "Service created with desiredCount=1"

echo "=== ECS reconciler heal: wait for task RUNNING ==="
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  running=$(aws ecs describe-services --cluster "$cluster_name" --services "$service_name" --output json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["services"][0].get("runningCount",0))')
  if [ "$running" -ge 1 ]; then break; fi
  sleep 2
done
if [ "$running" -lt 1 ]; then
  fail "service did not reach runningCount=1 before stop"
fi
pass "Service reached runningCount=1"

echo "=== ECS reconciler heal: stop the running task ==="
task_arn=$(aws ecs list-tasks --cluster "$cluster_name" --service-name "$service_name" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin).get("taskArns",[""])[0])')
[ -n "$task_arn" ] || fail "no running task to stop"
aws ecs stop-task --cluster "$cluster_name" --task "$task_arn" >/dev/null || fail "StopTask rejected"
pass "Stopped running task"

echo "=== ECS reconciler heal: wait for scheduler to reconcile ==="
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  running=$(aws ecs describe-services --cluster "$cluster_name" --services "$service_name" --output json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["services"][0].get("runningCount",0))')
  if [ "$running" -ge 1 ]; then break; fi
  sleep 2
done
if [ "$running" -lt 1 ]; then
  fail "scheduler did not reconcile runningCount back to 1 after stop"
fi
pass "Scheduler reconciled runningCount back to 1"

echo "=== ALL ECS RECONCILER HEAL ADVERSARIAL SLICE PROBES PASSED ==="
