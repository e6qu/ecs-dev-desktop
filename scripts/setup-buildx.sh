#!/usr/bin/env bash
# setup-buildx.sh — create and boot the docker-container builder CI builds with.
#
# docker/setup-buildx-action boots that builder by pulling
# moby/buildkit:buildx-stable-1 from Docker Hub with no credentials, and Docker
# Hub rate-limits anonymous token requests per source address — an address
# GitHub's shared runners share with everyone else on them. The pull then fails
# before the job has built anything: the `e2e fixture (workspace)` job died
# exactly there on 2026-09-16 ("Get https://auth.docker.io/token ...") on a
# change that touched no CI, and every buildx job in this repository, the
# release publishes included, has the same exposure.
#
# The bootstrap is retried ONLY when the failure is that download. A bad flag,
# a missing builder or a broken daemon fails on the first attempt, as it
# should. This is the shape scripts/terraform-init.sh already uses for
# Terraform provider downloads.
set -euo pipefail

builder="${BUILDX_BUILDER:-edd-ci}"
attempts=3

if ! docker buildx inspect "${builder}" >/dev/null 2>&1; then
  docker buildx create --name "${builder}" --driver docker-container >/dev/null
fi
docker buildx use "${builder}"

for attempt in $(seq 1 "${attempts}"); do
  if output=$(docker buildx inspect --bootstrap --builder "${builder}" 2>&1); then
    printf '%s\n' "${output}"
    exit 0
  fi
  printf '%s\n' "${output}" >&2
  case "${output}" in
    *registry-1.docker.io* | *auth.docker.io* | *"TLS handshake timeout"* | \
      *"connection reset by peer"* | *"i/o timeout"* | *toomanyrequests* | *"unexpected EOF"*)
      if [ "${attempt}" -lt "${attempts}" ]; then
        echo "setup-buildx: the buildkit image download broke (attempt ${attempt} of ${attempts}); trying again" >&2
        sleep $((attempt * 10))
        continue
      fi
      echo "setup-buildx: the buildkit image download broke ${attempts} times; giving up" >&2
      ;;
  esac
  exit 1
done
