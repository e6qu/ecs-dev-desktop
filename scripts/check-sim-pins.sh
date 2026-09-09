#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Every tier runs the same simulator release. The digests appear in each compose
# file and in the container-mode Dockerfile's default; a bump that misses one
# leaves a tier on a release the others are not testing against, silently.
set -eu
unset CDPATH
here=$(cd "$(dirname "$0")/.." && pwd)

check_one() {
  repo=$1
  shift
  digests=$(grep -ho "ghcr.io/e6qu/sockerless-simulator-${repo}@sha256:[0-9a-f]\{64\}" "$@" | sort -u)
  count=$(printf '%s\n' "$digests" | grep -c . || true)
  if [ "$count" -ne 1 ]; then
    echo "check-sim-pins: sockerless-simulator-${repo} is pinned at ${count} digests across $*:" >&2
    printf '%s\n' "$digests" >&2
    exit 1
  fi
  for f in "$@"; do
    if ! grep -q "sockerless-simulator-${repo}@sha256:" "$f"; then
      echo "check-sim-pins: $f does not pin sockerless-simulator-${repo}" >&2
      exit 1
    fi
  done
  echo "check-sim-pins: sockerless-simulator-${repo} pinned once across $#: $digests"
}

cd "$here"
check_one aws docker-compose.tier2.yml docker-compose.e2e.yml docker-compose.https.yml docker-compose.dev.yml infra/sim/sockerless-aws-exec.Dockerfile
check_one azure docker-compose.e2e.yml docker-compose.https.yml docker-compose.dev.yml
bleephub=$(grep -ho "ghcr.io/e6qu/bleephub@sha256:[0-9a-f]\{64\}" docker-compose.e2e.yml docker-compose.https.yml docker-compose.dev.yml | sort -u)
if [ "$(printf '%s\n' "$bleephub" | grep -c .)" -ne 1 ]; then
  echo "check-sim-pins: bleephub is pinned at more than one digest, or not by digest" >&2
  exit 1
fi
echo "check-sim-pins: bleephub pinned once: $bleephub"
if git ls-files --error-unmatch third_party/sockerless >/dev/null 2>&1 || [ -e .gitmodules ] && grep -q sockerless .gitmodules; then
  echo "check-sim-pins: the sockerless source submodule is back; the simulators are consumed as published images" >&2
  exit 1
fi
