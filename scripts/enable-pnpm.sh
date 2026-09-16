#!/usr/bin/env bash
# enable-pnpm.sh — activate the repository's pinned pnpm through Corepack.
#
# `corepack enable` fetches the pnpm the root package.json pins from
# registry.npmjs.org on every job, with no retry: the build-test job died there
# on 2026-09-16 ("Error when performing the request to
# https://registry.npmjs.org/pnpm/-/pnpm-10.33.3.tgz") on a change that touched
# no CI. The download is retried ONLY when the failure is that request; a
# corepack or Node problem fails on the first attempt, as it should. This is
# the shape scripts/terraform-init.sh uses for provider downloads and
# scripts/setup-buildx.sh for the buildkit image.
set -euo pipefail

attempts=3
for attempt in $(seq 1 "${attempts}"); do
  if output=$( { corepack enable && corepack install; } 2>&1 ); then
    printf '%s\n' "${output}"
    exit 0
  fi
  printf '%s\n' "${output}" >&2
  case "${output}" in
    *registry.npmjs.org* | *"Error when performing the request"* | *ETIMEDOUT* | *ECONNRESET* | \
      *"socket hang up"* | *EAI_AGAIN* | *"network timeout"*)
      if [ "${attempt}" -lt "${attempts}" ]; then
        echo "enable-pnpm: the pnpm download broke (attempt ${attempt} of ${attempts}); trying again" >&2
        sleep $((attempt * 10))
        continue
      fi
      echo "enable-pnpm: the pnpm download broke ${attempts} times; giving up" >&2
      ;;
  esac
  exit 1
done
