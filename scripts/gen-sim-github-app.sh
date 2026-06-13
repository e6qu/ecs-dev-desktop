#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Bring the local GitHub target up "with a GitHub App already registered" — the
# coordinate-only way to test the App flow (AGENTS.md §6.9). Generates a throwaway
# RSA key and writes, into the output dir (default ./temp/github-app):
#   app.pem     the App's private key (PKCS#1) — mounted into bleephub as the seed
#   seed.json   bleephub operator seed (BLEEPHUB_SEED_APPS_FILE): a pre-registered
#               App with this key + an installation on the test org
#   coords.env  the COORDINATES the e2e consumes (sourced before `pnpm test:e2e`):
#               AUTH_GITHUB_API_URL + EDD_GITHUB_APP_ID/_KEY/_TEST_ORG/_TEST_REPO
#
# bleephub seeds the App from seed.json at startup (sockerless #564); the test
# then uses ONLY the coordinates in coords.env — identical to how it would target
# real GitHub with a real App's secret. No key is committed (temp/ is gitignored).
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.

set -eu
unset CDPATH

out_dir="${1:-./temp/github-app}"
mkdir -p "$out_dir"

# Coordinates (deterministic; the harness/operator supplies them — the test never
# hardcodes them). The api URL is how the host reaches bleephub's published port.
app_id="100001"
app_org="edd-app-org"
app_repo="edd-app-repo"
api_url="${EDD_GITHUB_APP_API_URL:-http://127.0.0.1:5555/api/v3}"
# The seed reads the key at this path INSIDE the bleephub container (the out dir
# is mounted at /seed); see docker-compose.e2e.yml.
seed_key_path="${EDD_GITHUB_APP_SEED_KEY_PATH:-/seed/app.pem}"

# 1. The App's RSA private key (openssl genrsa emits PKCS#1, which the app-JWT
#    signer and bleephub's seed both accept).
openssl genrsa -out "$out_dir/app.pem" 2048 >/dev/null 2>&1
chmod 644 "$out_dir/app.pem" # mounted read-only into bleephub (non-root uid)

# 2. The operator seed: a pre-registered App + an installation on the test org
#    (unknown org is created by bleephub). Permissions allow repo admin so the
#    App can create the test repo.
cat >"$out_dir/seed.json" <<JSON
[
  {
    "id": $app_id,
    "name": "edd-app-e2e",
    "private_key_pem_file": "$seed_key_path",
    "owner": "admin",
    "permissions": { "administration": "write", "contents": "write", "metadata": "read" },
    "installations": [
      {
        "account": "$app_org",
        "target_type": "Organization",
        "permissions": { "administration": "write", "contents": "write", "metadata": "read" }
      }
    ]
  }
]
JSON

# 3. The coordinates the e2e consumes. EDD_GITHUB_APP_KEY is base64 (single line)
#    of the PEM, so it survives a sourced env file; the reader base64-decodes it.
key_b64="$(openssl base64 -A -in "$out_dir/app.pem")"
cat >"$out_dir/coords.env" <<ENV
export AUTH_GITHUB_API_URL="$api_url"
export EDD_GITHUB_APP_ID="$app_id"
export EDD_GITHUB_APP_KEY="$key_b64"
export EDD_GITHUB_TEST_ORG="$app_org"
export EDD_GITHUB_TEST_REPO="$app_repo"
ENV

echo "GitHub App seed generated in $out_dir (app id $app_id, org $app_org, repo $app_repo)"
