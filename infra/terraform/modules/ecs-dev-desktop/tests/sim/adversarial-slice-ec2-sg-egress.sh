#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for EC2 security-group EGRESS rules.
# The ingress probe (adversarial-slice-ec2-sg.sh) covers ingress CRUD + revoke
# conformance; this is the egress counterpart — the module's
# aws_vpc_security_group_egress_rule resources are never adversarially probed.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment.
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

suffix="$(date +%s)"
vpc_cidr="10.90.0.0/16"
vpc_id=$(aws ec2 create-vpc --cidr-block "$vpc_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')

sg=$(aws ec2 create-security-group \
  --group-name "edd-sg-egress-${suffix}" \
  --description "egress test SG" \
  --vpc-id "$vpc_id" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')

cleanup() {
  aws ec2 revoke-security-group-egress --group-id "$sg" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
  aws ec2 revoke-security-group-egress --group-id "$sg" --protocol tcp --port 5432 --cidr 10.90.1.0/24 >/dev/null 2>&1 || true
  aws ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1 || true
  aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== EC2 SG egress: authorize 0.0.0.0/0:443 ==="
aws ec2 authorize-security-group-egress \
  --group-id "$sg" \
  --protocol tcp \
  --port 443 \
  --cidr 0.0.0.0/0 \
  >/dev/null || fail "authorize egress 0.0.0.0/0:443 rejected"

rules=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${sg}" \
  --output json)
egress_count=$(printf '%s\n' "$rules" | python3 -c 'import sys,json; print(sum(1 for r in json.load(sys.stdin).get("SecurityGroupRules",[]) if r.get("IsEgress",False) and r.get("FromPort")==443))')
if [ "$egress_count" -ne 1 ]; then
  fail "expected one port-443 egress rule, got $egress_count"
fi
pass "Egress 0.0.0.0/0:443 round-trip"

echo "=== EC2 SG egress: authorize to a specific CIDR ==="
aws ec2 authorize-security-group-egress \
  --group-id "$sg" \
  --protocol tcp \
  --port 5432 \
  --cidr 10.90.1.0/24 \
  >/dev/null || fail "authorize egress to specific CIDR rejected"

cidr_check=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${sg}" \
  --output json |
  python3 -c 'import sys,json; print(next((r.get("CidrIpv4","") for r in json.load(sys.stdin).get("SecurityGroupRules",[]) if r.get("IsEgress",False) and r.get("FromPort")==5432),"MISSING"))')
if [ "$cidr_check" != "10.90.1.0/24" ]; then
  fail "expected egress CIDR 10.90.1.0/24, got $cidr_check"
fi
pass "Egress to specific CIDR round-trips correctly"

echo "=== EC2 SG egress: revoking an existing egress rule removes it ==="
aws ec2 revoke-security-group-egress \
  --group-id "$sg" \
  --protocol tcp \
  --port 5432 \
  --cidr 10.90.1.0/24 \
  >/dev/null || fail "revoke existing egress rule rejected"

remaining=$(aws ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${sg}" \
  --output json |
  python3 -c 'import sys,json; print(sum(1 for r in json.load(sys.stdin).get("SecurityGroupRules",[]) if r.get("IsEgress",False) and r.get("FromPort")==5432))')
if [ "$remaining" -ne 0 ]; then
  fail "expected zero port-5432 egress rules after revoke, got $remaining"
fi
pass "Revoke of existing egress rule removes it"

echo "=== EC2 SG egress: revoking a non-existent rule fails loud ==="
if aws ec2 revoke-security-group-egress \
  --group-id "$sg" \
  --protocol tcp \
  --port 22 \
  --cidr 10.90.2.0/24 >/dev/null 2>&1; then
  fail "revoking non-existent egress rule should have failed"
fi
pass "Revoke of non-existent egress rule fails loud"

echo "=== ALL EC2 SG EGRESS ADVERSARIAL SLICE PROBES PASSED ==="
