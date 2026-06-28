#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Bootstrap the Secrets Manager entries the control plane needs. Creates one
# secret per required env var, generating strong random values for the CRYPTO
# secrets and prompting for the IdP / Auth.js ones you must supply. Idempotent —
# a secret that already exists is left untouched (re-run after collecting a new
# IdP value; delete the stale secret first to regenerate).
#
#   scripts/bootstrap-secrets.sh <name-prefix> [aws-region]
#
# <name-prefix> is the module `name` (e.g. "edd-dev"); secrets are created as
# "<name-prefix>/<key>" (e.g. edd-dev/AUTH_SECRET). After apply, pass the ARNs
# the script prints as the module's `secret_environment` map.
#
# Crypto secrets generated here (random, never typed in):
#   AUTH_SECRET              Auth.js session/JWT signing key
#   EDD_TOKEN_ENC_KEY        32-byte hex AES key (git-credential storage)
#   EDD_GATEWAY_SECRET       hex HMAC (gateway<->control-plane machine auth)
#   EDD_AGENT_SECRET         hex HMAC (idle-agent heartbeat + workspace auth)
#   EDD_CONNECTION_SECRET    hex HMAC (per-workspace editor connection token)
#
# You-must-supply secrets (prompted; leave blank to SKIP and create later):
#   AUTH_GITHUB_ID / AUTH_GITHUB_SECRET          GitHub OAuth/App
#   AUTH_MICROSOFT_ENTRA_ID_ID / _SECRET         Azure Entra OIDC
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Requires the AWS CLI v2.

set -eu
unset CDPATH

prefix="${1:?usage: bootstrap-secrets.sh <name-prefix> [aws-region]}"
region="${2:-$(aws configure get region 2>/dev/null || true)}"
region="${region:-us-east-1}"

if ! command -v aws >/dev/null 2>&1; then
  echo "edd: aws CLI not found on PATH" >&2
  exit 1
fi

rand_hex() { # <byte-count> -> hex string (openssl base64 then xxd, no openssl -rand portability issues)
  # openssl rand is portable across macOS (LibreSSL) and Linux (OpenSSL).
  openssl rand -hex "$1"
}

rand_url() { # a URL-safe random string for Auth.js AUTH_SECRET
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
}

# put <key> <value>: create-or-skip, print the ARN. Fails loud on any AWS error.
put_secret() { # <key> <value> <kind>
  key="$1"
  val="$2"
  kind="$3"
  name="${prefix}/${key}"
  if aws secretsmanager describe-secret --secret-id "$name" --region "$region" >/dev/null 2>&1; then
    echo "edd: $name already exists — skipping ($kind)"
  else
    aws secretsmanager create-secret --name "$name" --region "$region" \
      --secret-string "$val" >/dev/null
    echo "edd: created $name ($kind)"
  fi
  aws secretsmanager describe-secret --secret-id "$name" --region "$region" \
    --query 'ARN' --output text
}

printf '%s\n' "edd: generating crypto secrets for '${prefix}' in ${region}"

arn_AUTH_SECRET=$(put_secret AUTH_SECRET "$(rand_url)" "Auth.js session/JWT key")
arn_EDD_TOKEN_ENC_KEY=$(put_secret EDD_TOKEN_ENC_KEY "$(rand_hex 32)" "AES key (git-credential storage)")
arn_EDD_GATEWAY_SECRET=$(put_secret EDD_GATEWAY_SECRET "$(rand_hex 32)" "HMAC (gateway machine auth)")
arn_EDD_AGENT_SECRET=$(put_secret EDD_AGENT_SECRET "$(rand_hex 32)" "HMAC (idle-agent + workspace auth)")
arn_EDD_CONNECTION_SECRET=$(put_secret EDD_CONNECTION_SECRET "$(rand_hex 32)" "HMAC (editor connection token)")

# IdP secrets: take from ENV if set (headless mode, e.g. install.sh), else prompt;
# blank = skip (create later by deleting + re-running). For GitHub:
#   EDD_BOOTSTRAP_GITHUB_ID / EDD_BOOTSTRAP_GITHUB_SECRET
# For Entra:
#   EDD_BOOTSTRAP_ENTRA_ID / EDD_BOOTSTRAP_ENTRA_SECRET
# (Prefixed to avoid colliding with the app's own AUTH_* runtime vars.)
arn_AUTH_GITHUB_ID=""
arn_AUTH_GITHUB_SECRET=""
arn_AUTH_ENTRA_ID=""
arn_AUTH_ENTRA_SECRET=""

gh_id="${EDD_BOOTSTRAP_GITHUB_ID:-}"
if [ -z "$gh_id" ]; then
  printf '%s' "GitHub OAuth App client id (AUTH_GITHUB_ID) [blank=skip]: "
  read -r gh_id
fi
if [ -n "$gh_id" ]; then
  gh_secret="${EDD_BOOTSTRAP_GITHUB_SECRET:-}"
  if [ -z "$gh_secret" ]; then
    printf '%s' "GitHub OAuth App client secret (AUTH_GITHUB_SECRET): "
    read -r gh_secret
  fi
  [ -n "$gh_secret" ] || {
    echo "edd: EDD_BOOTSTRAP_GITHUB_ID set but no secret provided — aborting" >&2
    exit 1
  }
  arn_AUTH_GITHUB_ID=$(put_secret AUTH_GITHUB_ID "$gh_id" "GitHub OAuth client id")
  arn_AUTH_GITHUB_SECRET=$(put_secret AUTH_GITHUB_SECRET "$gh_secret" "GitHub OAuth client secret")
fi

entra_id="${EDD_BOOTSTRAP_ENTRA_ID:-}"
if [ -z "$entra_id" ]; then
  printf '%s' "Azure Entra app client id (AUTH_MICROSOFT_ENTRA_ID_ID) [blank=skip]: "
  read -r entra_id
fi
if [ -n "$entra_id" ]; then
  entra_secret="${EDD_BOOTSTRAP_ENTRA_SECRET:-}"
  if [ -z "$entra_secret" ]; then
    printf '%s' "Azure Entra app client secret (AUTH_MICROSOFT_ENTRA_ID_SECRET): "
    read -r entra_secret
  fi
  [ -n "$entra_secret" ] || {
    echo "edd: EDD_BOOTSTRAP_ENTRA_ID set but no secret provided — aborting" >&2
    exit 1
  }
  arn_AUTH_ENTRA_ID=$(put_secret AUTH_MICROSOFT_ENTRA_ID_ID "$entra_id" "Entra OIDC client id")
  arn_AUTH_ENTRA_SECRET=$(put_secret AUTH_MICROSOFT_ENTRA_ID_SECRET "$entra_secret" "Entra OIDC client secret")
fi

cat <<EOF

edd: secrets ready. Paste the present ARNs into the module's secret_environment
     (only the ones you created; the control plane fails loud for a missing
     REQUIRED one, but IdP creds are optional per provider).

EOF
for kv in \
  "AUTH_SECRET=$arn_AUTH_SECRET" \
  "EDD_TOKEN_ENC_KEY=$arn_EDD_TOKEN_ENC_KEY" \
  "EDD_GATEWAY_SECRET=$arn_EDD_GATEWAY_SECRET" \
  "EDD_AGENT_SECRET=$arn_EDD_AGENT_SECRET" \
  "EDD_CONNECTION_SECRET=$arn_EDD_CONNECTION_SECRET" \
  "AUTH_GITHUB_ID=$arn_AUTH_GITHUB_ID" \
  "AUTH_GITHUB_SECRET=$arn_AUTH_GITHUB_SECRET" \
  "AUTH_MICROSOFT_ENTRA_ID_ID=$arn_AUTH_ENTRA_ID" \
  "AUTH_MICROSOFT_ENTRA_ID_SECRET=$arn_AUTH_ENTRA_SECRET"; do
  val="${kv#*=}"
  [ -n "$val" ] && printf '  %s = "%s"\n' "${kv%%=*}" "$val"
done
