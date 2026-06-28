#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Bootstrap the Terraform remote-state backend: an S3 bucket (versioned,
# encrypted, public-access-blocked) + a DynamoDB lock table. Run ONCE per
# environment, before the first `terraform init`/`terragrunt init`. Idempotent —
# safe to re-run (skips what already exists).
#
#   scripts/bootstrap-state.sh <bucket-name> [aws-region]
#
# The bucket name must be globally unique across all of S3. Pass its name (and
# the lock-table name derived below) to the Terragrunt remote_state block — see
# infra/terraform/examples/terragrunt/terragrunt.hcl.
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Requires the AWS CLI v2 with credentials that may create S3 + DynamoDB resources.

set -eu
unset CDPATH

bucket="${1:?usage: bootstrap-state.sh <bucket-name> [aws-region]}"
region="${2:-$(aws configure get region 2>/dev/null || true)}"
region="${region:-us-east-1}"
lock_table="edd-tfstate-locks"

if ! command -v aws >/dev/null 2>&1; then
  echo "edd: aws CLI not found on PATH" >&2
  exit 1
fi

# 1. S3 bucket (idempotent: skip if it already exists and we own it).
if aws s3api head-bucket --bucket "$bucket" --region "$region" >/dev/null 2>&1; then
  echo "edd: s3 bucket '$bucket' already exists — skipping create"
else
  echo "edd: creating s3 bucket '$bucket' in $region"
  # us-east-1 rejects a LocationConstraint; every other region requires it.
  if [ "$region" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null
  else
    aws s3api create-bucket --bucket "$bucket" --region "$region" \
      --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  fi
fi

# Harden the bucket regardless of who created it (versioning, encryption, public block).
echo "edd: enabling versioning + encryption + public-access-block on '$bucket'"
aws s3api put-bucket-versioning --bucket "$bucket" --region "$region" \
  --versioning-configuration Status=Enabled >/dev/null
aws s3api put-bucket-encryption --bucket "$bucket" --region "$region" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
aws s3api put-public-access-block --bucket "$bucket" --region "$region" \
  --public-access-block-configuration \
  '{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}' >/dev/null

# 2. DynamoDB lock table (idempotent: skip if it exists).
if aws dynamodb describe-table --table-name "$lock_table" --region "$region" >/dev/null 2>&1; then
  echo "edd: dynamodb lock table '$lock_table' already exists — skipping create"
else
  echo "edd: creating dynamodb lock table '$lock_table'"
  aws dynamodb create-table --table-name "$lock_table" --region "$region" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$lock_table" --region "$region"
fi

cat <<EOF

edd: remote-state backend ready. Use these in your Terragrunt remote_state block
     (or a Terraform 'backend "s3"' block):

  bucket         = "$bucket"
  region         = "$region"
  key            = "ecs-dev-desktop/<env>/terraform.tfstate"
  encrypt        = true
  dynamodb_table = "$lock_table"
EOF
