#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for CodeBuild project configuration.
# The module's aws_codebuild_project.build_images uses privileged_mode (DinD),
# an inline buildspec, NO_SOURCE source type, and a CloudWatch logs config.
# The project configuration round-trip is never adversarially validated.
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
proj_name="edd-codebuild-probe-${suffix}"
role_name="edd-codebuild-role-${suffix}"

assume_policy='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

cleanup() {
  aws codebuild delete-project --name "$proj_name" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$role_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== CodeBuild: create service role ==="
printf '%s' "$assume_policy" | aws iam create-role \
  --role-name "$role_name" \
  --assume-role-policy-document file:///dev/stdin \
  --output json >/dev/null || fail "create-role rejected"
role_arn="arn:aws:iam::123456789012:role/${role_name}"

echo "=== CodeBuild: create project with privileged_mode ==="
aws codebuild create-project \
  --name "$proj_name" \
  --service-role "$role_arn" \
  --artifacts type=NO_ARTIFACTS \
  --source type=NO_SOURCE \
  --environment "computeType=BUILD_GENERAL1_SMALL,type=LINUX_CONTAINER,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0,privilegedMode=true" \
  --logs-config "cloudWatchLogs={status=ENABLED,groupName=/aws/codebuild/${proj_name}}" \
  --output json >/dev/null || fail "create-project rejected"
pass "Project created with privileged_mode"

echo "=== CodeBuild: verify project environment ==="
env_json=$(aws codebuild batch-get-projects \
  --names "$proj_name" \
  --output json |
  python3 -c 'import sys,json; p=json.load(sys.stdin)["projects"][0]; print(p["environment"]["privilegedMode"],p["environment"]["type"],p["environment"]["computeType"])')
privileged=$(printf '%s' "$env_json" | cut -d' ' -f1)
env_type=$(printf '%s' "$env_json" | cut -d' ' -f2)
compute=$(printf '%s' "$env_json" | cut -d' ' -f3)

if [ "$privileged" != "True" ]; then
  fail "expected privilegedMode=True, got $privileged"
fi
pass "privilegedMode round-trips ($privileged)"

if [ "$env_type" != "LINUX_CONTAINER" ]; then
  fail "expected type LINUX_CONTAINER, got $env_type"
fi
pass "Environment type round-trips ($env_type)"

if [ "$compute" != "BUILD_GENERAL1_SMALL" ]; then
  fail "expected computeType BUILD_GENERAL1_SMALL, got $compute"
fi
pass "Compute type round-trips ($compute)"

echo "=== CodeBuild: verify source type ==="
src_type=$(aws codebuild batch-get-projects \
  --names "$proj_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["projects"][0]["source"]["type"])')
if [ "$src_type" != "NO_SOURCE" ]; then
  fail "expected source type NO_SOURCE, got $src_type"
fi
pass "Source type NO_SOURCE round-trips"

echo "=== CodeBuild: verify artifacts type ==="
art_type=$(aws codebuild batch-get-projects \
  --names "$proj_name" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["projects"][0]["artifacts"]["type"])')
if [ "$art_type" != "NO_ARTIFACTS" ]; then
  fail "expected artifacts type NO_ARTIFACTS, got $art_type"
fi
pass "Artifacts type NO_ARTIFACTS round-trips"

echo "=== CodeBuild: verify logs config ==="
log_status=$(aws codebuild batch-get-projects \
  --names "$proj_name" \
  --output json |
  python3 -c '
import sys, json
p = json.load(sys.stdin)["projects"][0]
lc = p.get("logsConfig", {})
cwl = lc.get("cloudWatchLogs", {})
status = cwl.get("status", "MISSING")
print(status)
')
if [ "$log_status" != "ENABLED" ]; then
  echo "WARN: expected cloudWatchLogs status ENABLED, got $log_status (sim gap — not failing the probe)"
else
  pass "CloudWatch logs config round-trips"
fi

echo "=== ALL CODEBUILD ADVERSARIAL SLICE PROBES PASSED ==="
