#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Dependency-freshness gate, mirroring sockerless's check-deps, for every
# language in this repo: TypeScript/Node (pnpm) and Terraform (providers).
#
# Policy: stay on the latest version that is >= 1 day old (pnpm
# `minimumReleaseAge` in pnpm-workspace.yaml — a supply-chain safeguard against
# freshly-published malicious/broken releases). `pnpm outdated` honours that age
# floor, so this check is read-only.
#
# Portable: passes shellcheck and runs under bash and zsh, on macOS and Linux.
# Avoids bashisms (BASH_SOURCE, pushd/popd, arrays).
set -eu
set -o pipefail

# Guard cd against a user's CDPATH (common in zsh setups); covers subshells too.
unset CDPATH 2>/dev/null || true

# Script dir via $0 (works in bash and zsh when executed).
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd -- "$repo_root" || exit 1

fail=0

echo "=== Node/TypeScript: pnpm outdated (latest version >= 1 day old) ==="
if pnpm outdated -r; then
  echo "All JS/TS dependencies are on the latest age-eligible version."
else
  echo "::error::JS/TS deps behind the latest age-eligible version — run 'pnpm update --latest -r' and commit."
  fail=1
fi

echo
echo "=== Terraform: provider lock on latest ==="
if command -v terraform >/dev/null 2>&1; then
  if (
    cd -- infra/terraform || exit 1
    terraform init -backend=false -upgrade -input=false >/dev/null
    if [ -f .terraform.lock.hcl ] && ! git diff --quiet -- .terraform.lock.hcl; then
      echo "::error::Terraform provider lock is behind latest — commit the updated .terraform.lock.hcl."
      git --no-pager diff -- .terraform.lock.hcl || true
      exit 1
    fi
    echo "Terraform providers are on latest."
  ); then
    :
  else
    fail=1
  fi
else
  echo "terraform not installed; skipping provider freshness."
fi

exit "$fail"
