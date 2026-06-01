#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Dependency-freshness gate, mirroring sockerless's check-deps job, for every
# language in this repo: TypeScript/Node (pnpm) and Terraform (providers).
# Fails if anything is behind the latest release.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0

echo "=== Node/TypeScript: pnpm outdated (workspace-wide) ==="
# `pnpm outdated -r` exits non-zero if any dependency is behind latest.
if ! pnpm outdated -r; then
  echo "::error::JS/TS dependencies are out of date — run 'pnpm update --latest -r'."
  fail=1
else
  echo "All JS/TS dependencies are on latest."
fi

echo
echo "=== Terraform: provider lock on latest ==="
if command -v terraform >/dev/null 2>&1; then
  pushd infra/terraform >/dev/null
  terraform init -backend=false -upgrade -input=false >/dev/null
  # If a newer provider exists, -upgrade rewrites the lock; a committed lock then
  # shows a diff. (Loose check while infra is empty; tightens once it grows.)
  if [ -f .terraform.lock.hcl ] && ! git diff --quiet -- .terraform.lock.hcl; then
    echo "::error::Terraform provider lock is behind latest — commit the updated .terraform.lock.hcl."
    git --no-pager diff -- .terraform.lock.hcl || true
    fail=1
  else
    echo "Terraform providers are on latest."
  fi
  popd >/dev/null
else
  echo "terraform not installed; skipping provider freshness."
fi

exit "$fail"
