#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tear down an ecs-dev-desktop install — including a PARTIAL or BUGGY one. Runs
# the steps in reverse dependency order; each step is best-effort (a piece that
# is already gone, or never created, is logged and skipped), so a half-finished
# install is fully reclaimable. Use the SAME EDD_NAME/EDD_REGION you installed with.
#
#   EDD_NAME=<name> EDD_REGION=<region> sh scripts/uninstall.sh
#
# What it removes, in order:
#   1. Terraform-managed infra (VPC, ECS, DynamoDB, ECR, ALB, ACM, Route53, NLB,
#      CloudWatch, KMS, ...). `terraform destroy` is given the deletion-protection
#      override so a prod-protected table/ALB is still removable in a teardown.
#   2. The Secrets Manager secrets under <name>/* (the bootstrap secrets).
#   3. Leaked runtime resources (workspace ECS tasks + EBS volumes/snapshots
#      created at runtime, not by Terraform) tagged edd:managed for this name.
#   4. (Optional, EDD_PURGE_STATE=1) the remote-state S3 bucket + DynamoDB lock
#      table — off by default so you can re-apply if a destroy was incomplete.
#
# It does NOT delete: IdP app registrations, Route53 hosted zones, ACM certs you
# imported (only module-created certs, removed in step 1), or the release-workflow
# IAM OIDC role.
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Requires the AWS CLI v2 and Terraform.

set -eu
unset CDPATH

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

EDD_NAME="${EDD_NAME:?EDD_NAME is required (the module name you installed with)}"
EDD_REGION="${EDD_REGION:?EDD_REGION is required}"
EDD_TF_DIR="${EDD_TF_DIR:-infra/terraform/examples/complete}"
EDD_PURGE_STATE="${EDD_PURGE_STATE:-0}"

tfdir="$repo/$EDD_TF_DIR"
state_bucket="edd-tfstate-${EDD_NAME}"
state_key="ecs-dev-desktop/${EDD_NAME}/terraform.tfstate"

banner() { printf '\n\033[1m=== edd: %s ===\033[0m\n' "$*"; }
warn() { printf '\033[33m  (non-fatal: this step failed/skipped — continuing)\033[0m\n'; }

command -v aws >/dev/null 2>&1 || {
  echo "edd: aws CLI not found on PATH" >&2
  exit 1
}
command -v terraform >/dev/null 2>&1 || {
  echo "edd: terraform not found on PATH" >&2
  exit 1
}

# ---- 1. terraform destroy (the bulk of the infra) ---------------------------
banner "tear down Terraform-managed infra ($EDD_NAME)"

if [ -f "$tfdir/install.tfvars" ]; then
  tfvars_arg="-var-file=install.tfvars"
else
  tfvars_arg=""
  echo "edd: no install.tfvars found — destroying with module defaults (set vars if it prompts)"
fi

printf '\n--- terraform init (point at the remote state) ---\n'
(
  cd "$tfdir" && terraform init -backend-config "bucket=$state_bucket" \
    -backend-config "key=$state_key" -backend-config "region=$EDD_REGION" \
    -reconfigure -input=false
) || warn

# deletion_protection defaults ON (prod-safe); a teardown must override it, else
# `terraform destroy` hangs on the DynamoDB table + ALB. Auto-approve so a destroy
# never blocks waiting for input.
printf '\n--- terraform destroy (deletion_protection off) ---\n'
(
  cd "$tfdir" && terraform destroy -auto-approve -input=false \
    $tfvars_arg -var "deletion_protection=false"
) || warn

# ---- 2. secrets (bootstrap crypto + IdP under <name>/*) ---------------------
banner "delete Secrets Manager secrets ($EDD_NAME/*)"
arns=$(aws secretsmanager list-secrets --region "$EDD_REGION" \
  --filter Key=name,Values="${EDD_NAME}/" \
  --query "SecretList[].ARN" --output text 2>/dev/null || true)
if [ -n "$arns" ]; then
  echo "$arns" | tr '\t' '\n' | while IFS= read -r arn; do
    [ -n "$arn" ] || continue
    echo "  deleting $arn"
    aws secretsmanager delete-secret --region "$EDD_REGION" \
      --secret-id "$arn" --force-delete-without-recovery >/dev/null 2>&1 || true
  done
else
  echo "  no ${EDD_NAME}/* secrets found — skipping"
fi

# ---- 3. leaked runtime resources (workspaces/volumes/snapshots) -------------
# The control plane creates per-workspace EBS volumes + snapshots + ECS tasks at
# runtime (NOT terraform-managed). A clean install has none; a partial/test one
# might. Sweep anything tagged edd:managed owned by this name. Best-effort.
banner "sweep leaked runtime resources (edd:managed, this name)"

printf '\n--- stop stray ECS workspace tasks ---\n'
cluster="${EDD_NAME}-workspaces"
tasks=$(aws ecs list-tasks --region "$EDD_REGION" --cluster "$cluster" \
  --desired-status RUNNING --query "taskArns" --output text 2>/dev/null || true)
if [ -n "$tasks" ]; then
  echo "  stopping stray tasks in $cluster"
  # shellcheck disable=SC2086 # intentional: space-separated task ARNs
  aws ecs stop-task --region "$EDD_REGION" --cluster "$cluster" $tasks >/dev/null 2>&1 || true
else
  echo "  no RUNNING tasks in $cluster"
fi

printf '\n--- delete orphan EBS volumes (tagged edd:managed, this name) ---\n'
vols=$(aws ec2 describe-volumes --region "$EDD_REGION" \
  --filters "Name=tag:edd:managed,Values=true" "Name=tag:Name,Values=$EDD_NAME" \
  --query "Volumes[*].VolumeId" --output text 2>/dev/null || true)
if [ -z "$vols" ]; then
  echo "  no orphan volumes"
else
  echo "$vols" | tr '\t' '\n' | while IFS= read -r vid; do
    [ -n "$vid" ] || continue
    echo "  deleting volume $vid"
    aws ec2 delete-volume --region "$EDD_REGION" --volume-id "$vid" >/dev/null 2>&1 || true
  done
fi

printf '\n--- delete orphan EBS snapshots (tagged edd:managed, this name) ---\n'
snaps=$(aws ec2 describe-snapshots --region "$EDD_REGION" --owners self \
  --filters "Name=tag:edd:managed,Values=true" "Name=tag:Name,Values=$EDD_NAME" \
  --query "Snapshots[*].SnapshotId" --output text 2>/dev/null || true)
if [ -z "$snaps" ]; then
  echo "  no orphan snapshots"
else
  echo "$snaps" | tr '\t' '\n' | while IFS= read -r sid; do
    [ -n "$sid" ] || continue
    echo "  deleting snapshot $sid"
    aws ec2 delete-snapshot --region "$EDD_REGION" --snapshot-id "$sid" >/dev/null 2>&1 || true
  done
fi

# ---- 4. (optional) remote-state bucket + lock table -------------------------
if [ "$EDD_PURGE_STATE" = "1" ]; then
  banner "purge remote-state backend (EDD_PURGE_STATE=1)"
  if aws s3 ls "s3://${state_bucket}" --region "$EDD_REGION" >/dev/null 2>&1; then
    echo "  emptying + deleting bucket $state_bucket"
    aws s3 rm "s3://${state_bucket}" --recursive --region "$EDD_REGION" || true
    aws s3api delete-bucket --bucket "$state_bucket" --region "$EDD_REGION" || true
  else
    echo "  bucket $state_bucket already gone"
  fi
  echo "  deleting DynamoDB lock table (shared name edd-tfstate-locks)"
  aws dynamodb delete-table --table-name edd-tfstate-locks --region "$EDD_REGION" \
    >/dev/null 2>&1 || echo "  lock table already gone (or shared — leaving it)"
else
  banner "keeping remote-state backend (set EDD_PURGE_STATE=1 to purge it too)"
fi

banner "uninstall complete"
echo "  Remaining (not owned by this stack — remove manually if unwanted):"
echo "    - Route53 hosted zones you created for app.<domain> / *.<ssh>"
echo "    - IdP app registrations (GitHub / Entra)"
echo "    - the IAM OIDC role for the release workflow (if created)"
