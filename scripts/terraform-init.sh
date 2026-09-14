#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# `terraform init` that survives a dropped provider download.
#
# Every `terraform init` that is not served from the plugin cache fetches the
# providers from releases.hashicorp.com, and Terraform's installer has no retry:
# one TCP reset mid-download ("read: connection reset by peer", a TLS handshake
# timeout) fails the init, and a CI job with it, on a run that changed nothing
# in Terraform. That is what happened to two terraform-sim slices on
# 2026-09-13. The cache (TF_PLUGIN_CACHE_DIR, restored by actions/cache in CI)
# is what makes the download rare; this wrapper is what makes the rare download
# not fail the job: it re-runs init, at most three times, and ONLY when the
# failure is a provider download that broke — a constraint error, a bad
# configuration or a missing backend fails at once, exactly as before.
#
# Usage: scripts/terraform-init.sh <dir> [terraform init args…]
set -eu
unset CDPATH

dir="${1:?terraform directory}"
shift

# Terraform only uses the plugin cache when the directory already exists.
if [ -n "${TF_PLUGIN_CACHE_DIR:-}" ]; then
  mkdir -p "$TF_PLUGIN_CACHE_DIR"
fi

attempts=3
for attempt in $(seq 1 "$attempts"); do
  if output=$(terraform -chdir="$dir" init -input=false "$@" 2>&1); then
    printf '%s\n' "$output"
    exit 0
  fi
  printf '%s\n' "$output" >&2
  case "$output" in
    *"Failed to install provider"* | *"Failed to query available provider packages"* | *"connection reset by peer"* | *"TLS handshake timeout"* | *"i/o timeout"* | *"unexpected EOF"*)
      if [ "$attempt" -lt "$attempts" ]; then
        echo "terraform-init: the provider download broke (attempt ${attempt} of ${attempts}); trying again" >&2
        sleep $((attempt * 10))
        continue
      fi
      echo "terraform-init: the provider download broke ${attempts} times; giving up" >&2
      ;;
  esac
  exit 1
done
