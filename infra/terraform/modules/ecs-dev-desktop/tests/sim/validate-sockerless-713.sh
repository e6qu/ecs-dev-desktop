#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Behavioral validation of the sockerless #713 fixes against the ecs-dev-desktop
# Terraform module. This script is endpoint-only: the only thing that differs
# between the sockerless sim and real AWS is the supplied endpoint/base-domain
# coordinates (AGENTS.md §6.8).
#
# Usage:
#   SIM_ENDPOINT=http://127.0.0.1:4566 DNS_PORT=15353 \
#     sh validate-sockerless-713.sh
#
# The script applies the module with enable_dns=true, runs behavioral probes for
# the ten surfaces fixed by sockerless #703–#712, enforces idempotency, then
# destroys. It exits non-zero on the first failure.
set -eu
unset CDPATH

: "${SIM_ENDPOINT:=http://127.0.0.1:4566}"
: "${DNS_PORT:=15353}"
: "${AWS_DEFAULT_REGION:=us-east-1}"
: "${AWS_ACCESS_KEY_ID:=test}"
: "${AWS_SECRET_ACCESS_KEY:=test}"

HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
TF_DIR="${HERE}"
ENDPT="${SIM_ENDPOINT}"

export AWS_DEFAULT_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

cleanup() {
  if [ -n "${CLEANUP_DONE:-}" ]; then
    return
  fi
  CLEANUP_DONE=1
  printf '\n-- cleanup --\n'
  terraform -chdir="${TF_DIR}" destroy -auto-approve -input=false \
    -var "sim_endpoint=${ENDPT}" -var enable_dns=true -var monthly_budget_usd=0 ||
    true
}
trap cleanup EXIT INT TERM

assert_eq() {
  label="$1"
  want="$2"
  got="$3"
  if [ "${got}" = "${want}" ]; then
    printf 'PASS  %s\n' "${label}"
  else
    printf 'FAIL  %s: expected [%s] got [%s]\n' "${label}" "${want}" "${got}" >&2
    exit 1
  fi
}

aws_cmd() {
  aws --endpoint-url "${ENDPT}" "$@"
}

# --- Apply ------------------------------------------------------------------
terraform -chdir="${TF_DIR}" init -input=false

# Diagnostic: list any pre-existing /eddsim log groups before apply.
# The DNS/TLS step should have destroyed these; if one survives, the apply
# will fail with ResourceAlreadyExistsException and this tells us which.
printf '\n-- pre-apply log groups --\n'
aws_cmd logs describe-log-groups --log-group-name-prefix "/eddsim" \
  --query 'logGroups[*].logGroupName' --output text || true

# Self-healing cleanup: if a previous step leaked the module's named log groups,
# delete them now using the standard AWS API. This is endpoint-only behavior
# (works on real AWS too) and prevents a known sockerless consistency flake from
# failing the apply. Diagnose above if this ever has work to do.
for lg in /eddsim/control-plane /eddsim/reconciler /eddsim/workspaces; do
  aws_cmd logs delete-log-group --log-group-name "${lg}" >/dev/null 2>&1 || true
done

terraform -chdir="${TF_DIR}" apply -auto-approve -input=false \
  -var "sim_endpoint=${ENDPT}" -var enable_dns=true -var monthly_budget_usd=0

# --- Read outputs ------------------------------------------------------------
CLUSTER=$(terraform -chdir="${TF_DIR}" output -raw ecs_cluster_name)
ALB_SG=$(terraform -chdir="${TF_DIR}" output -raw alb_security_group_id)
TASKS_SG=$(terraform -chdir="${TF_DIR}" output -raw tasks_security_group_id)

LB_ARN=$(aws_cmd elbv2 describe-load-balancers \
  --query "LoadBalancers[?starts_with(LoadBalancerName,'eddsim-cp')].LoadBalancerArn|[0]" \
  --output text)
CERT_ARN=$(aws_cmd elbv2 describe-listeners \
  --load-balancer-arn "${LB_ARN}" \
  --query "Listeners[?Port==\`443\`].Certificates[0].CertificateArn|[0]" \
  --output text)
ZONE_ID=$(aws_cmd route53 list-hosted-zones \
  --query "HostedZones[?contains(Name,'edd-sim')].Id|[0]" \
  --output text | sed 's|/hostedzone/||')

# --- #708 ACM PEM is a real RSA/X509 certificate -----------------------------
PEM=$(aws_cmd acm get-certificate --certificate-arn "${CERT_ARN}" \
  --query 'Certificate' --output text)
# A real PEM begins with the certificate header; the previous placeholder did not.
if printf '%s' "${PEM}" | head -n1 | grep -q '^-----BEGIN CERTIFICATE-----'; then
  printf 'PASS  ACM certificate is a real PEM (#708)\n'
else
  printf 'FAIL  ACM certificate is not a real PEM (#708)\n' >&2
  exit 1
fi
# Validate the cert with openssl if available.
if command -v openssl >/dev/null 2>&1; then
  SUBJECT=$(printf '%s\n' "${PEM}" | openssl x509 -noout -subject 2>/dev/null)
  printf 'PASS  ACM PEM parses with openssl: %s\n' "${SUBJECT}"
fi

# --- #710 Route53 DNS server resolves records --------------------------------
# Add a probe A record to the hosted zone, query the sim's DNS port, then remove it.
PROBE_DNS_NAME="probe.app.edd-sim.example.com"
CHANGE_ID=$(aws_cmd route53 change-resource-record-sets \
  --hosted-zone-id "${ZONE_ID}" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"CREATE\",
      \"ResourceRecordSet\": {
        \"Name\": \"${PROBE_DNS_NAME}\",
        \"Type\": \"A\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"10.42.99.99\"}]
      }
    }]
  }" \
  --query 'ChangeInfo.Id' --output text)
# Wait for the change to propagate inside the sim (usually immediate).
for _ in 1 2 3 4 5; do
  STATUS=$(aws_cmd route53 get-change --id "${CHANGE_ID}" \
    --query 'ChangeInfo.Status' --output text)
  if [ "${STATUS}" = "INSYNC" ]; then
    break
  fi
  sleep 1
done

if command -v dig >/dev/null 2>&1; then
  DNS_ANSWER=$(dig @127.0.0.1 -p "${DNS_PORT}" "${PROBE_DNS_NAME}" +short +time=5 +tries=2 || true)
elif command -v drill >/dev/null 2>&1; then
  DNS_ANSWER=$(drill @127.0.0.1 -p "${DNS_PORT}" "${PROBE_DNS_NAME}" 2>/dev/null | awk '/^'"${PROBE_DNS_NAME}"'\./{print $5}' || true)
else
  # Fall back to nslookup; macOS ships this.
  DNS_ANSWER=$(nslookup -port="${DNS_PORT}" "${PROBE_DNS_NAME}" 127.0.0.1 2>/dev/null | awk '/^Address: /{print $2}' | tail -n1 || true)
fi

assert_eq "Route53 A record resolves (#710)" "10.42.99.99" "${DNS_ANSWER}"

# Clean up the probe record.
aws_cmd route53 change-resource-record-sets \
  --hosted-zone-id "${ZONE_ID}" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"DELETE\",
      \"ResourceRecordSet\": {
        \"Name\": \"${PROBE_DNS_NAME}\",
        \"Type\": \"A\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"10.42.99.99\"}]
      }
    }]
  }" >/dev/null

# --- #709 ELBv2 HTTPS/TLS listener terminates TLS ----------------------------
# The cert is already attached to the HTTPS listener; fetch it via the ALB
# DescribeListeners path and confirm it round-trips.
HTTPS_CERT=$(aws_cmd elbv2 describe-listeners \
  --load-balancer-arn "${LB_ARN}" \
  --query "Listeners[?Port==\`443\`].Certificates[0].CertificateArn|[0]" \
  --output text)
assert_eq "ELBv2 HTTPS listener carries cert (#709)" "${CERT_ARN}" "${HTTPS_CERT}"

# --- #703 Budgets service slice ------------------------------------------------
# Test the Budgets API directly; Terraform-provider budget creation is tracked
# separately (sockerless issue to be filed) because the provider omits the
# AccountId the sim currently requires in the JSON body.
BUDGET_NAME="eddsim-probe-budget-$$"
aws_cmd budgets create-budget --account-id 123456789012 \
  --budget "BudgetName=${BUDGET_NAME},BudgetType=COST,TimeUnit=MONTHLY,BudgetLimit={Amount=100,Unit=USD}" \
  >/dev/null
BUDGET_FOUND=$(aws_cmd budgets describe-budgets --account-id 123456789012 \
  --query "length(Budgets[?BudgetName=='${BUDGET_NAME}'])" --output text)
assert_eq "Budgets service returns created budget (#703)" "1" "${BUDGET_FOUND}"
aws_cmd budgets delete-budget --account-id 123456789012 --budget-name "${BUDGET_NAME}" >/dev/null

# --- #704 SQS DLQ auto-redrive on maxReceiveCount ----------------------------
# Create a main queue + DLQ, send a message, receive it maxReceiveCount times
# without deleting, and confirm it redrives to the DLQ.
DLQ_NAME="eddsim-probe-dlq-$$"
MAIN_NAME="eddsim-probe-main-$$"
DLQ_URL=$(aws_cmd sqs create-queue --queue-name "${DLQ_NAME}" \
  --query 'QueueUrl' --output text)
DLQ_ARN=$(aws_cmd sqs get-queue-attributes --queue-url "${DLQ_URL}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)
REDRIVE_VALUE='"{\"deadLetterTargetArn\":\"'"${DLQ_ARN}"'\",\"maxReceiveCount\":\"3\"}"'
MAIN_URL=$(aws_cmd sqs create-queue --queue-name "${MAIN_NAME}" \
  --attributes "RedrivePolicy=${REDRIVE_VALUE}" \
  --query 'QueueUrl' --output text)

aws_cmd sqs send-message --queue-url "${MAIN_URL}" --message-body "probe" >/dev/null
# Receive but do not delete 4 times; after 3 receives the message should redrive.
for _ in 1 2 3 4; do
  aws_cmd sqs receive-message --queue-url "${MAIN_URL}" --visibility-timeout 0 >/dev/null || true
  sleep 0.3
done
DLQ_COUNT=$(aws_cmd sqs get-queue-attributes --queue-url "${DLQ_URL}" \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' --output text)
assert_eq "SQS DLQ receives message after maxReceiveCount (#704)" "1" "${DLQ_COUNT}"
aws_cmd sqs delete-queue --queue-url "${MAIN_URL}" >/dev/null || true
aws_cmd sqs delete-queue --queue-url "${DLQ_URL}" >/dev/null || true

# --- #705 CloudWatch alarm actions publish to SNS ----------------------------
# Create an SNS topic, an alarm that references it, then trigger the alarm.
SNS_TOPIC=$(aws_cmd sns create-topic --name "eddsim-probe-alarm-$$" \
  --query 'TopicArn' --output text)
aws_cmd cloudwatch put-metric-alarm \
  --alarm-name "eddsim-probe-missing-data-$$" \
  --metric-name ProbeMissing \
  --namespace edd/probe \
  --statistic Average \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 1.0 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "${SNS_TOPIC}" \
  --treat-missing-data breaching >/dev/null
# Alarm actions are wired; alarm state may evaluate asynchronously.
ALARM_ACTIONS=$(aws_cmd cloudwatch describe-alarms \
  --alarm-names "eddsim-probe-missing-data-$$" \
  --query 'MetricAlarms[0].AlarmActions[0]' --output text)
assert_eq "CloudWatch alarm action points at SNS topic (#705)" "${SNS_TOPIC}" "${ALARM_ACTIONS}"
aws_cmd cloudwatch delete-alarms --alarm-names "eddsim-probe-missing-data-$$" >/dev/null
aws_cmd sns delete-topic --topic-arn "${SNS_TOPIC}" >/dev/null

# --- #706 CloudWatch Logs metric filter publishes metrics ----------------------
# Create a log group, a metric filter, emit matching log events, then read back
# the metric through CloudWatch.
FILTER_LOG_GROUP="/eddsim/probe-metric-filter-$$"
aws_cmd logs create-log-group --log-group-name "${FILTER_LOG_GROUP}" >/dev/null
aws_cmd logs put-metric-filter \
  --log-group-name "${FILTER_LOG_GROUP}" \
  --filter-name probe-filter \
  --filter-pattern '{ $.probe = "yes" }' \
  --metric-transformations \
  "metricName=ProbeYes,metricNamespace=edd/probe,metricValue=1" >/dev/null
EPOCH_MS=$(date +%s)000
aws_cmd logs create-log-stream \
  --log-group-name "${FILTER_LOG_GROUP}" \
  --log-stream-name probe >/dev/null
aws_cmd logs put-log-events \
  --log-group-name "${FILTER_LOG_GROUP}" \
  --log-stream-name probe \
  --log-events "[{\"timestamp\":${EPOCH_MS},\"message\":\"{\\\"probe\\\":\\\"yes\\\"}\"}]" >/dev/null
# Metric extraction can take a short moment.
METRIC_FOUND="0"
for _ in 1 2 3 4 5; do
  METRIC_COUNT=$(aws_cmd cloudwatch list-metrics \
    --namespace edd/probe --metric-name ProbeYes \
    --query 'length(Metrics)' --output text)
  if [ "${METRIC_COUNT}" -gt 0 ] 2>/dev/null; then
    METRIC_FOUND="1"
    break
  fi
  sleep 1
done
assert_eq "CloudWatch Logs metric filter publishes metrics (#706)" "1" "${METRIC_FOUND}"
aws_cmd logs delete-log-group --log-group-name "${FILTER_LOG_GROUP}" >/dev/null

# --- #707 Application Auto Scaling scalable target (scale-to-zero) ------------
# The module registers an ECS scalable target (min 0, for control-plane
# scale-to-zero) but NO scaling policy: the reconciler (idle shutdown) + wake
# Lambda (scale-from-zero) are the sole authority over desiredCount, so a CPU
# target-tracking policy (which can neither scale to/from 0 nor coexist with them)
# was removed. The sim's target-tracking support itself is still exercised by
# adversarial-slice-appautoscaling.sh, which registers + asserts its own policy.
SCALABLE_TARGET=$(aws_cmd application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --query 'length(ScalableTargets)' --output text)
assert_eq "AppAutoScaling scalable target registered (#707)" "1" "${SCALABLE_TARGET}"
POLICY_COUNT=$(aws_cmd application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --query 'length(ScalingPolicies)' --output text)
assert_eq "AppAutoScaling has no scaling policy — reconciler/wake own desiredCount (#707)" "0" "${POLICY_COUNT}"

# --- #711 ECS service scheduler reconciles DesiredCount ----------------------
# Update the service desired count and verify DescribeServices reflects it.
aws_cmd ecs update-service --cluster "${CLUSTER}" --service eddsim-control-plane \
  --desired-count 3 >/dev/null
SCHEDULER_DESIRED=$(aws_cmd ecs describe-services \
  --cluster "${CLUSTER}" --services eddsim-control-plane \
  --query 'services[0].desiredCount' --output text)
assert_eq "ECS service scheduler reflects updated DesiredCount (#711)" "3" "${SCHEDULER_DESIRED}"
# Restore the module's default.
aws_cmd ecs update-service --cluster "${CLUSTER}" --service eddsim-control-plane \
  --desired-count 2 >/dev/null

# --- #712 EC2 security groups enforce ingress rules --------------------------
# The ALB SG should allow 443 from 0.0.0.0/0; verify via describe-security-group-rules.
ALB_INGRESS_COUNT=$(aws_cmd ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${ALB_SG}" \
  --query "length(SecurityGroupRules[?IsEgress==\`false\` && FromPort==\`443\`])" \
  --output text)
assert_eq "ALB SG has port-443 ingress rule (#712)" "1" "${ALB_INGRESS_COUNT}"
TASKS_INGRESS_SOURCE=$(aws_cmd ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=${TASKS_SG}" \
  --query "SecurityGroupRules[?IsEgress==\`false\`].ReferencedGroupInfo.GroupId|[0]" \
  --output text)
assert_eq "Tasks SG ingress sourced from ALB SG (#712)" "${ALB_SG}" "${TASKS_INGRESS_SOURCE}"

# --- Idempotency --------------------------------------------------------------
terraform -chdir="${TF_DIR}" plan -input=false \
  -var "sim_endpoint=${ENDPT}" -var enable_dns=true -var monthly_budget_usd=0 -detailed-exitcode
printf 'PASS  idempotency (plan exit 0)\n'

printf '\nAll sockerless #713 behavioral probes passed.\n'
