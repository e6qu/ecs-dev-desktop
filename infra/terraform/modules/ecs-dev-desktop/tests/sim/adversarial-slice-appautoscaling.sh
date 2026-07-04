#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for Application Auto Scaling target tracking on ECS.
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
vpc_cidr="10.88.0.0/16"
subnet_cidr="10.88.1.0/24"
cluster_name="edd-aas-${suffix}"
service_name="edd-aas-svc-${suffix}"
task_family="edd-aas-task-${suffix}"

vpc_id=$(aws ec2 create-vpc --cidr-block "$vpc_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')
subnet_id=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$subnet_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Subnet"]["SubnetId"])')
sg_id=$(aws ec2 create-security-group --group-name "edd-aas-sg-${suffix}" --description "appautoscaling probe" --vpc-id "$vpc_id" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')

cleanup() {
  aws application-autoscaling deregister-scalable-target \
    --service-namespace ecs \
    --resource-id "service/${cluster_name}/${service_name}" \
    --scalable-dimension ecs:service:DesiredCount >/dev/null 2>&1 || true
  aws ecs update-service --cluster "$cluster_name" --service "$service_name" --desired-count 0 >/dev/null 2>&1 || true
  aws ecs delete-service --cluster "$cluster_name" --service "$service_name" --force >/dev/null 2>&1 || true
  aws ecs delete-cluster --cluster "$cluster_name" >/dev/null 2>&1 || true
  aws ec2 delete-security-group --group-id "$sg_id" >/dev/null 2>&1 || true
  aws ec2 delete-subnet --subnet-id "$subnet_id" >/dev/null 2>&1 || true
  aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== AppAutoScaling: register scalable target and target-tracking policy ==="
aws ecs create-cluster --cluster-name "$cluster_name" >/dev/null || fail "CreateCluster rejected"

aws ecs register-task-definition \
  --family "$task_family" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 \
  --memory 512 \
  --execution-role-arn "arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
  --container-definitions '[{"name":"probe","image":"edd-workspace:e2e","essential":true,"portMappings":[{"containerPort":3000}]}]' \
  >/dev/null || fail "RegisterTaskDefinition rejected"

aws ecs create-service \
  --cluster "$cluster_name" \
  --service-name "$service_name" \
  --task-definition "$task_family" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${subnet_id}],securityGroups=[${sg_id}],assignPublicIp=DISABLED}" \
  >/dev/null || fail "CreateService rejected"

aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id "service/${cluster_name}/${service_name}" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 \
  --max-capacity 10 \
  >/dev/null || fail "RegisterScalableTarget rejected"

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/${cluster_name}/${service_name}" \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name edd-target-tracking \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration "PredefinedMetricSpecification={PredefinedMetricType=ECSServiceAverageCPUUtilization},TargetValue=70.0,ScaleOutCooldown=60,ScaleInCooldown=60" \
  >/dev/null || fail "PutScalingPolicy rejected"

policies=$(aws application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --resource-id "service/${cluster_name}/${service_name}" \
  --output json)
policy_type=$(printf '%s\n' "$policies" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ScalingPolicies"][0].get("PolicyType","MISSING"))')
if [ "$policy_type" != "TargetTrackingScaling" ]; then
  fail "expected TargetTrackingScaling policy, got $policy_type"
fi
target_value=$(printf '%s\n' "$policies" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ScalingPolicies"][0]["TargetTrackingScalingPolicyConfiguration"].get("TargetValue","MISSING"))')
if [ "$target_value" != "70.0" ]; then
  fail "expected TargetValue 70.0, got $target_value"
fi
pass "AppAutoScaling register target + target-tracking policy round-trip"

echo "=== AppAutoScaling: policy deletion is idempotent ==="
aws application-autoscaling delete-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/${cluster_name}/${service_name}" \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name edd-target-tracking \
  >/dev/null || fail "DeleteScalingPolicy rejected"
pass "DeleteScalingPolicy accepted"

echo "=== ALL APPAUTOSCALING ADVERSARIAL SLICE PROBES PASSED ==="
