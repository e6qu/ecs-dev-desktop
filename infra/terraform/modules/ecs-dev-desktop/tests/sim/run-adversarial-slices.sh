#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run all adversarial spec-fidelity probe slices against the configured AWS endpoint.
# Intended for CI (terraform-sim) and local use. Fails on the first strict failure.
set -eu
unset CDPATH

HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-${SIM_ENDPOINT:-http://127.0.0.1:4566}}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

run() {
  name="$1"
  shift
  echo ""
  echo "==== ${name} ===="
  sh "$@"
}

run "ECR / CloudTrail / KMS" "${HERE}/adversarial-slice-probe.sh"
run "CloudWatch Logs" "${HERE}/adversarial-slice-cloudwatch-logs.sh"
run "SQS DLQ redrive" "${HERE}/adversarial-slice-sqs.sh"
run "App Auto Scaling target tracking" "${HERE}/adversarial-slice-appautoscaling.sh"
run "ECS service scheduler DesiredCount" "${HERE}/adversarial-slice-ecs-scheduler.sh"
run "EC2 security group ingress" "${HERE}/adversarial-slice-ec2-sg.sh"
run "CloudWatch Logs metric filter" "${HERE}/adversarial-slice-cloudwatch-metric-filter.sh"

echo ""
echo "==== ALL ADVERSARIAL SLICES PASSED ===="
