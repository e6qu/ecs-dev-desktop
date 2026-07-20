#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Bootstrap the GitHub Actions -> AWS OIDC identity used by the release workflow.
# This is intentionally outside the EDD Terraform stack: release image publishing
# must work before EDD itself is deployed.
#
# Required environment:
#   EDD_RELEASE_GITHUB_REPO   GitHub owner/repo, e.g. e6qu/ecs-dev-desktop
#   EDD_RELEASE_AWS_ACCOUNT   12-digit AWS account id
#   EDD_RELEASE_AWS_REGION    AWS region for ECR
#   EDD_RELEASE_NAME_PREFIX   EDD stack/module name, e.g. edd-prod
#   EDD_RELEASE_ECS_CLUSTER   Deployed Amazon ECS cluster name
#   EDD_RELEASE_GOLDEN_VARIANTS whitespace-separated golden variants, e.g. "omnibus"
#   EDD_RELEASE_APP_URL       Public control-plane URL, e.g. https://app.example.com
#   EDD_RELEASE_DYNAMODB_TABLE Deployed EDD single-table name
#   EDD_RELEASE_DYNAMODB_KMS_KEY_ARN KMS key ARN used by the deployed table
#   EDD_RELEASE_SSH_GATEWAY_ENABLED Whether this deployment includes the optional SSH gateway
#
# Effects:
#   - creates/updates the IAM OIDC provider for token.actions.githubusercontent.com
#   - creates/updates <prefix>-github-release with a main-only trust policy
#   - attaches the least ECR/ECS/Scheduler policy needed by the release workflow
#   - writes the non-secret RELEASE_* GitHub repo variables consumed by
#     .github/workflows/release.yml and .github/workflows/golden-images.yml
#
# This script never stores static secrets in GitHub. The workflow uses OIDC to
# exchange a GitHub-issued token for short-lived STS credentials.

set -eu
unset CDPATH

GITHUB_REPO="${EDD_RELEASE_GITHUB_REPO:-}"
AWS_ACCOUNT="${EDD_RELEASE_AWS_ACCOUNT:-}"
AWS_REGION="${EDD_RELEASE_AWS_REGION:-}"
NAME_PREFIX="${EDD_RELEASE_NAME_PREFIX:-}"
ECS_CLUSTER="${EDD_RELEASE_ECS_CLUSTER:-}"
GOLDEN_VARIANTS="${EDD_RELEASE_GOLDEN_VARIANTS:-}"
APP_URL="${EDD_RELEASE_APP_URL:-}"
DYNAMODB_TABLE="${EDD_RELEASE_DYNAMODB_TABLE:-}"
DYNAMODB_KMS_KEY_ARN="${EDD_RELEASE_DYNAMODB_KMS_KEY_ARN:-}"
SSH_GATEWAY_ENABLED="${EDD_RELEASE_SSH_GATEWAY_ENABLED:-}"

missing() {
  [ -n "$2" ] && return 0
  echo "edd: missing required parameter $1 (set it as an env var)" >&2
  return 1
}

missing EDD_RELEASE_GITHUB_REPO "$GITHUB_REPO" || exit 1
missing EDD_RELEASE_AWS_ACCOUNT "$AWS_ACCOUNT" || exit 1
missing EDD_RELEASE_AWS_REGION "$AWS_REGION" || exit 1
missing EDD_RELEASE_NAME_PREFIX "$NAME_PREFIX" || exit 1
missing EDD_RELEASE_ECS_CLUSTER "$ECS_CLUSTER" || exit 1
missing EDD_RELEASE_GOLDEN_VARIANTS "$GOLDEN_VARIANTS" || exit 1
missing EDD_RELEASE_APP_URL "$APP_URL" || exit 1
missing EDD_RELEASE_DYNAMODB_TABLE "$DYNAMODB_TABLE" || exit 1
missing EDD_RELEASE_DYNAMODB_KMS_KEY_ARN "$DYNAMODB_KMS_KEY_ARN" || exit 1
missing EDD_RELEASE_SSH_GATEWAY_ENABLED "$SSH_GATEWAY_ENABLED" || exit 1

case "$GITHUB_REPO" in
  */*) ;;
  *)
    echo "edd: EDD_RELEASE_GITHUB_REPO must be owner/repo" >&2
    exit 1
    ;;
esac
case "$AWS_ACCOUNT" in
  *[!0-9]* | "" | ??????????? | ?????????????*)
    echo "edd: EDD_RELEASE_AWS_ACCOUNT must be a 12-digit AWS account id" >&2
    exit 1
    ;;
esac
case "$APP_URL" in
  https://*) ;;
  *)
    echo "edd: EDD_RELEASE_APP_URL must be an https:// URL" >&2
    exit 1
    ;;
esac
case "$DYNAMODB_KMS_KEY_ARN" in
  arn:aws:kms:"$AWS_REGION":"$AWS_ACCOUNT":key/*) ;;
  *)
    echo "edd: EDD_RELEASE_DYNAMODB_KMS_KEY_ARN must be a KMS key ARN in ${AWS_REGION}/${AWS_ACCOUNT}" >&2
    exit 1
    ;;
esac
case "$SSH_GATEWAY_ENABLED" in
  true | false) ;;
  *)
    echo "edd: EDD_RELEASE_SSH_GATEWAY_ENABLED must be true or false" >&2
    exit 1
    ;;
esac

ssh_service_policy_resource=
ssh_task_definition_policy_resource=
if [ "$SSH_GATEWAY_ENABLED" = true ]; then
  ssh_service_policy_resource=", \"arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:service/${ECS_CLUSTER}/${NAME_PREFIX}-ssh-gateway\""
  ssh_task_definition_policy_resource=", \"arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:task-definition/${NAME_PREFIX}-ssh-gateway:*\""
fi

for c in aws gh openssl awk sed tr; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "edd: '$c' not found on PATH" >&2
    exit 1
  }
done

caller_account=$(aws sts get-caller-identity --query Account --output text)
if [ "$caller_account" != "$AWS_ACCOUNT" ]; then
  echo "edd: AWS caller account is $caller_account, expected $AWS_ACCOUNT" >&2
  exit 1
fi

deployment_ready=true
active_service_query="services[?status==\`ACTIVE\`].serviceName | [0]"
for family in control-plane reconciler; do
  if ! aws ecs describe-task-definition \
    --region "$AWS_REGION" \
    --task-definition "${NAME_PREFIX}-${family}" >/dev/null 2>&1; then
    echo "edd: deployment is not ready: task definition ${NAME_PREFIX}-${family} is absent"
    deployment_ready=false
  fi
done
if ! aws ecs describe-services \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --services "${NAME_PREFIX}-control-plane" \
  --query "$active_service_query" \
  --output text 2>/dev/null | grep -qx "${NAME_PREFIX}-control-plane"; then
  echo "edd: deployment is not ready: ECS service ${NAME_PREFIX}-control-plane is absent"
  deployment_ready=false
fi
if ! aws scheduler get-schedule \
  --region "$AWS_REGION" \
  --name "${NAME_PREFIX}-reconciler" >/dev/null 2>&1; then
  echo "edd: deployment is not ready: Scheduler schedule ${NAME_PREFIX}-reconciler is absent"
  deployment_ready=false
fi
if [ "$SSH_GATEWAY_ENABLED" = true ]; then
  if ! aws ecs describe-task-definition \
    --region "$AWS_REGION" \
    --task-definition "${NAME_PREFIX}-ssh-gateway" >/dev/null 2>&1; then
    echo "edd: deployment is not ready: task definition ${NAME_PREFIX}-ssh-gateway is absent"
    deployment_ready=false
  fi
  if ! aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --services "${NAME_PREFIX}-ssh-gateway" \
    --query "$active_service_query" \
    --output text 2>/dev/null | grep -qx "${NAME_PREFIX}-ssh-gateway"; then
    echo "edd: deployment is not ready: ECS service ${NAME_PREFIX}-ssh-gateway is absent"
    deployment_ready=false
  fi
fi

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/edd-release-oidc.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

chain="$tmpdir/chain.pem"
if ! openssl s_client -servername token.actions.githubusercontent.com \
  -showcerts -connect token.actions.githubusercontent.com:443 </dev/null >"$chain" 2>/dev/null; then
  echo "edd: failed to fetch GitHub Actions OIDC TLS certificate chain" >&2
  exit 1
fi

cert_count=$(awk -v dir="$tmpdir" '
  /-----BEGIN CERTIFICATE-----/ { n++; file=sprintf("%s/cert%d.pem", dir, n) }
  file { print > file }
  /-----END CERTIFICATE-----/ { file="" }
  END { print n + 0 }
' "$chain")
if [ "$cert_count" -lt 1 ]; then
  echo "edd: no certificates found for token.actions.githubusercontent.com" >&2
  exit 1
fi

top_cert="$tmpdir/cert${cert_count}.pem"
thumbprint=$(openssl x509 -in "$top_cert" -fingerprint -sha1 -noout |
  sed 's/.*=//; s/://g' |
  tr '[:upper:]' '[:lower:]')

provider_arn="arn:aws:iam::${AWS_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
  echo "edd: updating GitHub OIDC provider thumbprint ($provider_arn)"
  aws iam update-open-id-connect-provider-thumbprint \
    --open-id-connect-provider-arn "$provider_arn" \
    --thumbprint-list "$thumbprint" >/dev/null
else
  echo "edd: creating GitHub OIDC provider ($provider_arn)"
  aws iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$thumbprint" >/dev/null
fi

role_name="${NAME_PREFIX}-github-release"
role_arn="arn:aws:iam::${AWS_ACCOUNT}:role/${role_name}"
trust_policy="$tmpdir/trust-policy.json"
permissions_policy="$tmpdir/permissions-policy.json"

cat >"$trust_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${provider_arn}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:ref:refs/heads/main"
        }
      }
    }
  ]
}
EOF

cat >"$permissions_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeImages",
        "ecr:DescribeRepositories",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      ],
      "Resource": [
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT}:repository/${NAME_PREFIX}/control-plane",
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT}:repository/${NAME_PREFIX}/ssh-gateway",
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT}:repository/${NAME_PREFIX}/edd-base",
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT}:repository/${NAME_PREFIX}/golden/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:UpdateService"
      ],
      "Resource": [
        "arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:service/${ECS_CLUSTER}/${NAME_PREFIX}-control-plane"${ssh_service_policy_resource}
      ]
    },
    {
      "Effect": "Allow",
      "Action": "ecs:DescribeTaskDefinition",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RegisterTaskDefinition"
      ],
      "Resource": [
        "arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:task-definition/${NAME_PREFIX}-control-plane:*",
        "arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:task-definition/${NAME_PREFIX}-reconciler:*"${ssh_task_definition_policy_resource}
      ]
    },
    {
      "Effect": "Allow",
      "Action": "scheduler:GetSchedule",
      "Resource": "arn:aws:scheduler:${AWS_REGION}:${AWS_ACCOUNT}:schedule/default/${NAME_PREFIX}-reconciler"
    },
    {
      "Effect": "Allow",
      "Action": "scheduler:UpdateSchedule",
      "Resource": "arn:aws:scheduler:${AWS_REGION}:${AWS_ACCOUNT}:schedule/default/${NAME_PREFIX}-reconciler"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT}:secret:${NAME_PREFIX}/AUTH_SECRET-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT}:table/${DYNAMODB_TABLE}"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "${DYNAMODB_KMS_KEY_ARN}",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "dynamodb.${AWS_REGION}.amazonaws.com"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::${AWS_ACCOUNT}:role/${NAME_PREFIX}-control-plane",
        "arn:aws:iam::${AWS_ACCOUNT}:role/${NAME_PREFIX}-reconciler",
        "arn:aws:iam::${AWS_ACCOUNT}:role/${NAME_PREFIX}-scheduler",
        "arn:aws:iam::${AWS_ACCOUNT}:role/${NAME_PREFIX}-task-execution"
      ]
    }
  ]
}
EOF

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  echo "edd: updating release role trust policy ($role_arn)"
  aws iam update-assume-role-policy \
    --role-name "$role_name" \
    --policy-document "file://$trust_policy" >/dev/null
else
  echo "edd: creating release role ($role_arn)"
  aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document "file://$trust_policy" >/dev/null
fi

echo "edd: attaching release role publish/deploy policy"
aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name "EddReleasePublishDeploy" \
  --policy-document "file://$permissions_policy" >/dev/null

if aws iam get-role-policy \
  --role-name "$role_name" \
  --policy-name "EddReleaseEcrPush" >/dev/null 2>&1; then
  echo "edd: deleting legacy release role ECR-only policy"
  aws iam delete-role-policy \
    --role-name "$role_name" \
    --policy-name "EddReleaseEcrPush" >/dev/null
fi

echo "edd: setting GitHub repo release variables"
gh variable set RELEASE_AWS_ACCOUNT --repo "$GITHUB_REPO" --body "$AWS_ACCOUNT"
gh variable set RELEASE_AWS_REGION --repo "$GITHUB_REPO" --body "$AWS_REGION"
gh variable set RELEASE_AWS_ROLE_ARN --repo "$GITHUB_REPO" --body "$role_arn"
gh variable set RELEASE_NAME_PREFIX --repo "$GITHUB_REPO" --body "$NAME_PREFIX"
gh variable set RELEASE_ECS_CLUSTER --repo "$GITHUB_REPO" --body "$ECS_CLUSTER"
gh variable set RELEASE_GOLDEN_VARIANTS --repo "$GITHUB_REPO" --body "$GOLDEN_VARIANTS"
gh variable set EDD_APP_URL --repo "$GITHUB_REPO" --body "$APP_URL"
gh variable set EDD_DYNAMODB_TABLE --repo "$GITHUB_REPO" --body "$DYNAMODB_TABLE"
gh variable set EDD_AUTH_SECRET_ID --repo "$GITHUB_REPO" --body "${NAME_PREFIX}/AUTH_SECRET"
gh variable set RELEASE_SSH_GATEWAY_ENABLED --repo "$GITHUB_REPO" --body "$SSH_GATEWAY_ENABLED"
gh variable set RELEASE_DEPLOYMENT_ENABLED --repo "$GITHUB_REPO" --body "$deployment_ready"

cat <<EOF
edd: release OIDC bootstrap complete
  repo    = ${GITHUB_REPO}
  account = ${AWS_ACCOUNT}
  region  = ${AWS_REGION}
  cluster = ${ECS_CLUSTER}
  role    = ${role_arn}
  golden  = ${GOLDEN_VARIANTS}
  app_url = ${APP_URL}
  ssh     = ${SSH_GATEWAY_ENABLED}
  deploy  = ${deployment_ready}
EOF
