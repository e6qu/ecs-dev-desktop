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
run "CloudWatch Alarm -> SNS" "${HERE}/adversarial-slice-cloudwatch-alarm-sns.sh"
run "Route53 DNS resolution" "${HERE}/adversarial-slice-route53-dns.sh"
run "ACM + ALB TLS termination" "${HERE}/adversarial-slice-acm-tls.sh"
run "KMS encryption-in-use" "${HERE}/adversarial-slice-kms-encryption.sh"
run "EC2 SG network-layer enforcement" "${HERE}/adversarial-slice-ec2-sg-network.sh"
run "ECS rolling update + circuit breaker" "${HERE}/adversarial-slice-ecs-rolling-update.sh"
run "S3 backend encryption/lifecycle" "${HERE}/adversarial-slice-s3-backend.sh"
run "EBS cross-region snapshot copy" "${HERE}/adversarial-slice-ebs-snapshot-copy.sh"
run "Budgets notification wiring" "${HERE}/adversarial-slice-budgets-notification.sh"
run "ECS reconciler heal" "${HERE}/adversarial-slice-ecs-reconciler-heal.sh"
run "EC2 security group egress" "${HERE}/adversarial-slice-ec2-sg-egress.sh"
run "DynamoDB table SSE + GSI" "${HERE}/adversarial-slice-dynamodb.sh"
run "EventBridge Scheduler" "${HERE}/adversarial-slice-scheduler.sh"
run "CloudWatch dashboard" "${HERE}/adversarial-slice-cloudwatch-dashboard.sh"
run "ALB target group health check" "${HERE}/adversarial-slice-alb-target-group.sh"
run "CloudFront + wake Lambda + CLOUDFRONT WAF" "${HERE}/adversarial-slice-cloudfront-wake-waf.sh"
run "IAM role/policy structure" "${HERE}/adversarial-slice-iam-roles.sh"
run "CodeBuild project" "${HERE}/adversarial-slice-codebuild.sh"
echo ""
echo "==== ALL ADVERSARIAL SLICES PASSED ===="
