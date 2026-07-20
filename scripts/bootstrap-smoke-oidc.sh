#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Bootstrap the separate GitHub Actions identity used only by the manually
# dispatched post-deployment browser smoke. Image publication never assumes it.

set -eu
unset CDPATH

GITHUB_REPO="${EDD_SMOKE_GITHUB_REPO:-}"
AWS_ACCOUNT="${EDD_SMOKE_AWS_ACCOUNT:-}"
AWS_REGION="${EDD_SMOKE_AWS_REGION:-}"
NAME_PREFIX="${EDD_SMOKE_NAME_PREFIX:-}"
APP_URL="${EDD_SMOKE_APP_URL:-}"
DYNAMODB_TABLE="${EDD_SMOKE_DYNAMODB_TABLE:-}"
DYNAMODB_KMS_KEY_ARN="${EDD_SMOKE_DYNAMODB_KMS_KEY_ARN:-}"
AUTH_SECRET_ID="${EDD_SMOKE_AUTH_SECRET_ID:-}"

missing() {
  [ -n "$2" ] && return 0
  echo "edd: missing required parameter $1 (set it as an env var)" >&2
  return 1
}

missing EDD_SMOKE_GITHUB_REPO "$GITHUB_REPO" || exit 1
missing EDD_SMOKE_AWS_ACCOUNT "$AWS_ACCOUNT" || exit 1
missing EDD_SMOKE_AWS_REGION "$AWS_REGION" || exit 1
missing EDD_SMOKE_NAME_PREFIX "$NAME_PREFIX" || exit 1
missing EDD_SMOKE_APP_URL "$APP_URL" || exit 1
missing EDD_SMOKE_DYNAMODB_TABLE "$DYNAMODB_TABLE" || exit 1
missing EDD_SMOKE_DYNAMODB_KMS_KEY_ARN "$DYNAMODB_KMS_KEY_ARN" || exit 1
missing EDD_SMOKE_AUTH_SECRET_ID "$AUTH_SECRET_ID" || exit 1

case "$GITHUB_REPO" in
  */*) ;;
  *)
    echo "edd: EDD_SMOKE_GITHUB_REPO must be owner/repo" >&2
    exit 1
    ;;
esac
case "$AWS_ACCOUNT" in
  *[!0-9]* | "" | ??????????? | ?????????????*)
    echo "edd: EDD_SMOKE_AWS_ACCOUNT must be a 12-digit AWS account id" >&2
    exit 1
    ;;
esac
case "$APP_URL" in
  https://*) ;;
  *)
    echo "edd: EDD_SMOKE_APP_URL must be an https:// URL" >&2
    exit 1
    ;;
esac
case "$DYNAMODB_KMS_KEY_ARN" in
  arn:aws:kms:"$AWS_REGION":"$AWS_ACCOUNT":key/*) ;;
  *)
    echo "edd: EDD_SMOKE_DYNAMODB_KMS_KEY_ARN must be a KMS key ARN in ${AWS_REGION}/${AWS_ACCOUNT}" >&2
    exit 1
    ;;
esac

for command in aws gh openssl awk sed tr; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "edd: '$command' not found on PATH" >&2
    exit 1
  }
done

caller_account=$(aws sts get-caller-identity --query Account --output text)
if [ "$caller_account" != "$AWS_ACCOUNT" ]; then
  echo "edd: AWS caller account is $caller_account, expected $AWS_ACCOUNT" >&2
  exit 1
fi

auth_secret_arn=$(aws secretsmanager describe-secret \
  --secret-id "$AUTH_SECRET_ID" \
  --query ARN \
  --output text)
case "$auth_secret_arn" in
  arn:aws:secretsmanager:"$AWS_REGION":"$AWS_ACCOUNT":secret:*) ;;
  *)
    echo "edd: EDD_SMOKE_AUTH_SECRET_ID did not resolve to a Secrets Manager secret in ${AWS_REGION}/${AWS_ACCOUNT}" >&2
    exit 1
    ;;
esac

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/edd-smoke-oidc.XXXXXX")
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
  aws iam update-open-id-connect-provider-thumbprint \
    --open-id-connect-provider-arn "$provider_arn" \
    --thumbprint-list "$thumbprint" >/dev/null
else
  aws iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$thumbprint" >/dev/null
fi

role_name="${NAME_PREFIX}-github-smoke"
role_arn="arn:aws:iam::${AWS_ACCOUNT}:role/${role_name}"
trust_policy="$tmpdir/trust-policy.json"
permissions_policy="$tmpdir/permissions-policy.json"

cat >"$trust_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "${provider_arn}"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {"StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:ref:refs/heads/main"
    }}
  }]
}
EOF

cat >"$permissions_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "${auth_secret_arn}"
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
      "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "${DYNAMODB_KMS_KEY_ARN}",
      "Condition": {"StringEquals": {
        "kms:ViaService": "dynamodb.${AWS_REGION}.amazonaws.com"
      }}
    }
  ]
}
EOF

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "$role_name" \
    --policy-document "file://$trust_policy" >/dev/null
else
  aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document "file://$trust_policy" >/dev/null
fi

aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name "EddPostDeploySmoke" \
  --policy-document "file://$permissions_policy" >/dev/null

gh variable set EDD_SMOKE_AWS_ROLE_ARN --repo "$GITHUB_REPO" --body "$role_arn"
gh variable set EDD_SMOKE_AWS_REGION --repo "$GITHUB_REPO" --body "$AWS_REGION"
gh variable set EDD_APP_URL --repo "$GITHUB_REPO" --body "$APP_URL"
gh variable set EDD_DYNAMODB_TABLE --repo "$GITHUB_REPO" --body "$DYNAMODB_TABLE"
gh variable set EDD_AUTH_SECRET_ID --repo "$GITHUB_REPO" --body "$AUTH_SECRET_ID"

cat <<EOF
edd: post-deployment smoke OIDC bootstrap complete
  repo    = ${GITHUB_REPO}
  account = ${AWS_ACCOUNT}
  region  = ${AWS_REGION}
  role    = ${role_arn}
  app_url = ${APP_URL}
  table   = ${DYNAMODB_TABLE}
  secret  = ${AUTH_SECRET_ID}
EOF
