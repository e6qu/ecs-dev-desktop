#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for IAM role/policy structure.
# The module creates six IAM roles (execution, control_plane, reconciler,
# scheduler, workspace, ecs_infrastructure) with specific assume-role policies
# and inline/managed policies. This probe validates that IAM role/policy
# resources round-trip correctly through the API: assume-role-policy preservation,
# inline policy attachment, and managed policy attachment.
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
role_name="edd-iam-probe-${suffix}"
assume_policy='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

cleanup() {
  aws iam delete-role-policy --role-name "$role_name" --policy-name inline-test >/dev/null 2>&1 || true
  aws iam detach-role-policy --role-name "$role_name" --policy-arn "arn:aws:iam::aws:policy/AmazonECSTaskExecutionRolePolicy" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$role_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== IAM: create role with assume-role policy ==="
printf '%s' "$assume_policy" | aws iam create-role \
  --role-name "$role_name" \
  --assume-role-policy-document file:///dev/stdin \
  >/dev/null || fail "create-role rejected"
pass "Role created"

echo "=== IAM: verify assume-role policy round-trip ==="
# The API may return AssumeRolePolicyDocument as a URL-encoded string (real AWS)
# or a pre-parsed dict (some sim versions). Handle both.
retrieved_policy=$(aws iam get-role \
  --role-name "$role_name" \
  --output json |
  python3 -c '
import sys, json, urllib.parse
doc = json.load(sys.stdin)["Role"]["AssumeRolePolicyDocument"]
if isinstance(doc, str):
    doc = urllib.parse.unquote(doc)
if isinstance(doc, str):
    doc = json.loads(doc)
print(json.dumps(doc))
')

principal=$(printf '%s\n' "$retrieved_policy" |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Statement"][0]["Principal"]["Service"])')
if [ "$principal" != "ecs-tasks.amazonaws.com" ]; then
  fail "expected principal ecs-tasks.amazonaws.com, got $principal"
fi
action=$(printf '%s\n' "$retrieved_policy" |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Statement"][0]["Action"])')
if [ "$action" != "sts:AssumeRole" ]; then
  fail "expected action sts:AssumeRole, got $action"
fi
pass "Assume-role policy round-trips"

echo "=== IAM: put inline policy and verify ==="
inline_doc='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"dynamodb:GetItem","Resource":"*"}]}'
printf '%s' "$inline_doc" | aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name "inline-test" \
  --policy-document file:///dev/stdin \
  >/dev/null || fail "put-role-policy rejected"

get_inline=$(aws iam get-role-policy \
  --role-name "$role_name" \
  --policy-name "inline-test" \
  --output json |
  python3 -c 'import sys,json; p=json.load(sys.stdin)["PolicyDocument"]; print(p["Statement"][0]["Action"])')
if [ "$get_inline" != "dynamodb:GetItem" ]; then
  fail "expected inline policy action dynamodb:GetItem, got $get_inline"
fi
pass "Inline policy round-trips"

echo "=== IAM: attach managed policy and verify ==="
aws iam attach-role-policy \
  --role-name "$role_name" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonECSTaskExecutionRolePolicy" \
  >/dev/null || fail "attach-role-policy rejected"

attached=$(aws iam list-attached-role-policies \
  --role-name "$role_name" \
  --output json |
  python3 -c 'import sys,json; print(any(p["PolicyName"]=="AmazonECSTaskExecutionRolePolicy" for p in json.load(sys.stdin).get("AttachedPolicies",[])))')
if [ "$attached" != "True" ]; then
  fail "AmazonECSTaskExecutionRolePolicy not found in attached policies"
fi
pass "Managed policy attachment round-trips"

echo "=== IAM: verify list-role-policies shows the inline policy ==="
listed=$(aws iam list-role-policies \
  --role-name "$role_name" \
  --output json |
  python3 -c 'import sys,json; print(any(n=="inline-test" for n in json.load(sys.stdin).get("PolicyNames",[])))')
if [ "$listed" != "True" ]; then
  fail "inline-test not found in list-role-policies"
fi
pass "Inline policy appears in list-role-policies"

echo "=== ALL IAM ROLE ADVERSARIAL SLICE PROBES PASSED ==="
