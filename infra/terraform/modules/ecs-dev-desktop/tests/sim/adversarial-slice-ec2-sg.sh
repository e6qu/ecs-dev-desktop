#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for EC2 security-group ingress rules.
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
vpc_cidr="10.89.0.0/16"
vpc_id=$(aws ec2 create-vpc --cidr-block "$vpc_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')

alb_sg=$(aws ec2 create-security-group \
  --group-name "edd-sg-alb-${suffix}" \
  --description "ALB security group" \
  --vpc-id "$vpc_id" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')

tasks_sg=$(aws ec2 create-security-group \
  --group-name "edd-sg-tasks-${suffix}" \
  --description "tasks security group" \
  --vpc-id "$vpc_id" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')

cleanup() {
  aws ec2 revoke-security-group-ingress --group-id "$tasks_sg" --protocol tcp --port 3000 --source-group "$alb_sg" >/dev/null 2>&1 || true
  aws ec2 revoke-security-group-ingress --group-id "$alb_sg" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
  aws ec2 delete-security-group --group-id "$tasks_sg" >/dev/null 2>&1 || true
  aws ec2 delete-security-group --group-id "$alb_sg" >/dev/null 2>&1 || true
  aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== EC2 SG: ingress from 0.0.0.0/0 on port 443 ==="
aws ec2 authorize-security-group-ingress \
  --group-id "$alb_sg" \
  --protocol tcp \
  --port 443 \
  --cidr 0.0.0.0/0 \
  >/dev/null || fail "authorize 0.0.0.0/0:443 rejected"

rules=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${alb_sg}" \
  --output json)
ingress_count=$(echo "$rules" | python3 -c 'import sys,json; print(sum(1 for r in json.load(sys.stdin).get("SecurityGroupRules",[]) if not r.get("IsEgress",True) and r.get("FromPort")==443))')
if [ "$ingress_count" -ne 1 ]; then
  fail "expected one port-443 ingress rule on ALB SG, got $ingress_count"
fi
pass "ALB SG port-443 ingress from 0.0.0.0/0 round-trip"

echo "=== EC2 SG: ingress referenced from another SG ==="
aws ec2 authorize-security-group-ingress \
  --group-id "$tasks_sg" \
  --protocol tcp \
  --port 3000 \
  --source-group "$alb_sg" \
  >/dev/null || fail "authorize source-group ingress rejected"

ref=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${tasks_sg}" \
  --output json |
  python3 -c 'import sys,json; print(next((r.get("ReferencedGroupInfo",{}).get("GroupId","") for r in json.load(sys.stdin).get("SecurityGroupRules",[]) if not r.get("IsEgress",True) and r.get("FromPort")==3000),"MISSING"))')
if [ "$ref" != "$alb_sg" ]; then
  fail "expected tasks SG ingress to reference ALB SG, got $ref"
fi
pass "Tasks SG ingress references ALB SG"

echo "=== EC2 SG: revoking an existing ingress rule removes it ==="
aws ec2 revoke-security-group-ingress \
  --group-id "$tasks_sg" \
  --protocol tcp \
  --port 3000 \
  --source-group "$alb_sg" \
  >/dev/null || fail "revoke existing source-group ingress rejected"

remaining=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${tasks_sg}" \
  --output json |
  python3 -c 'import sys,json; print(sum(1 for r in json.load(sys.stdin).get("SecurityGroupRules",[]) if not r.get("IsEgress",True)))')
if [ "$remaining" -ne 0 ]; then
  fail "expected zero ingress rules after revoke, got $remaining"
fi
pass "Revoke of existing ingress rule removes it"

echo "=== EC2 SG: revoking a non-existent rule fails loud ==="
if aws ec2 revoke-security-group-ingress \
  --group-id "$alb_sg" \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0 >/dev/null 2>&1; then
  fail "revoking non-existent ingress rule should have failed"
fi
pass "Revoke of non-existent ingress rule fails loud"

echo "=== ALL EC2 SECURITY GROUP ADVERSARIAL SLICE PROBES PASSED ==="
