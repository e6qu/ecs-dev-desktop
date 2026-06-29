#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for surfaces ecs-dev-desktop depends on:
#   ECR repository lifecycle, CloudTrail LookupEvents filters/pagination, KMS key/alias/policy.
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

repo_name="edd-adversarial-$(date +%s)"
key_alias="alias/edd-adversarial-$(date +%s)"

echo "=== ECR: create repository with KMS encryption + lifecycle policy ==="
aws ecr create-repository \
  --repository-name "$repo_name" \
  --image-tag-mutability IMMUTABLE \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=KMS \
  >/dev/null || fail "ECR CreateRepository rejected or incomplete"

aws ecr put-lifecycle-policy \
  --repository-name "$repo_name" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep 5","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' \
  >/dev/null || fail "ECR PutLifecyclePolicy rejected"

aws ecr describe-repositories --repository-names "$repo_name" >/dev/null || fail "ECR DescribeRepositories missing repo"
pass "ECR repository create + lifecycle policy round-trip"

echo "=== ECR: GetAuthorizationToken shape ==="
token_out=$(aws ecr get-authorization-token --output json)
if ! echo "$token_out" | grep -q '"authorizationToken"'; then
  fail "GetAuthorizationToken missing authorizationToken field"
fi
pass "ECR GetAuthorizationToken returns authorizationToken"

echo "=== ECR: BatchGetImage on non-existent image returns expected failure entry ==="
out=$(aws ecr batch-get-image --repository-name "$repo_name" --image-ids imageTag=nosuchtag --output json)
if ! echo "$out" | grep -q '"failureCode".*"ImageNotFound"'; then
  fail "BatchGetImage for missing tag did not return ImageNotFound failure entry: $out"
fi
pass "ECR BatchGetImage missing-tag returns ImageNotFound failure entry"

echo "=== CloudTrail: LookupEvents pagination beyond 50 ==="
# Generate >50 events cheaply via CreateCluster/DeleteCluster pairs.
for i in $(seq 1 30); do
  name="edd-ct-paginate-$i"
  aws ecs create-cluster --cluster-name "$name" >/dev/null
  aws ecs delete-cluster --cluster "$name" >/dev/null
done

total=0
next_token=""
while true; do
  if [ -z "$next_token" ]; then
    out=$(aws cloudtrail lookup-events --max-results 10 --output json)
  else
    out=$(aws cloudtrail lookup-events --max-results 10 --next-token "$next_token" --output json)
  fi
  count=$(echo "$out" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Events",[])))')
  total=$((total + count))
  next_token=$(echo "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("NextToken",""))')
  if [ "$count" -eq 0 ] || [ -z "$next_token" ]; then
    break
  fi
done
if [ "$total" -lt 50 ]; then
  fail "CloudTrail pagination returned only $total events, expected at least 50"
fi
pass "CloudTrail LookupEvents pagination returned $total events across pages"

echo "=== CloudTrail: LookupAttributes filter by EventSource ==="
ecs_count=$(aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=ecs.amazonaws.com \
  --max-results 50 --output json | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Events",[])))')
if [ "$ecs_count" -lt 1 ]; then
  fail "CloudTrail EventSource filter returned no ecs.amazonaws.com events"
fi
pass "CloudTrail EventSource filter returned $ecs_count ecs events"

echo "=== CloudTrail: StartTime/EndTime filtering ==="
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
aws ecs create-cluster --cluster-name edd-ct-timegate >/dev/null
sleep 1
end=$(date -u +%Y-%m-%dT%H:%M:%SZ)

count=$(aws cloudtrail lookup-events \
  --start-time "$start" \
  --end-time "$end" \
  --max-results 50 --output json | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Events",[])))')
if [ "$count" -lt 1 ]; then
  fail "CloudTrail StartTime/EndTime filter returned no events for a known action"
fi
pass "CloudTrail StartTime/EndTime filter returned $count events"

echo "=== KMS: create key + alias + enable rotation ==="
key_id=$(aws kms create-key --description "edd adversarial probe" --output json | python3 -c 'import sys,json; print(json.load(sys.stdin)["KeyMetadata"]["KeyId"])')
aws kms enable-key-rotation --key-id "$key_id" >/dev/null || fail "KMS EnableKeyRotation rejected"
aws kms create-alias --alias-name "$key_alias" --target-key-id "$key_id" >/dev/null || fail "KMS CreateAlias rejected"
rot=$(aws kms get-key-rotation-status --key-id "$key_id" --output json | python3 -c 'import sys,json; print(json.load(sys.stdin).get("KeyRotationEnabled","MISSING"))')
if [ "$rot" != "True" ]; then
  fail "KMS key rotation status expected True, got $rot"
fi
pass "KMS create key + alias + enable rotation round-trip"

echo "=== KMS: key policy round-trip ==="
policy='{"Version":"2012-10-17","Statement":[{"Sid":"Allow root","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":"kms:*","Resource":"*"}]}'
aws kms put-key-policy --key-id "$key_id" --policy-name default --policy "$policy" >/dev/null || fail "KMS PutKeyPolicy rejected"
retrieved=$(aws kms get-key-policy --key-id "$key_id" --policy-name default --output json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Policy"])')
if ! echo "$retrieved" | grep -q '"Action":"kms:\*"'; then
  fail "KMS key policy round-trip lost the action statement"
fi
pass "KMS key policy round-trip"

echo "=== KMS: GenerateDataKey availability ==="
datakey=$(aws kms generate-data-key --key-id "$key_id" --key-spec AES_256 --output json)
if ! echo "$datakey" | grep -q '"Plaintext"'; then
  fail "KMS GenerateDataKey missing Plaintext"
fi
if ! echo "$datakey" | grep -q '"CiphertextBlob"'; then
  fail "KMS GenerateDataKey missing CiphertextBlob"
fi
pass "KMS GenerateDataKey returns Plaintext + CiphertextBlob"

echo "=== ALL ADVERSARIAL SLICE PROBES PASSED ==="
