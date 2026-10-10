#!/usr/bin/env bash
# setup-buildx.sh — create and boot the docker-container builder CI builds with.
#
# docker/setup-buildx-action boots that builder by pulling
# moby/buildkit:buildx-stable-1 from Docker Hub with no credentials, and Docker
# Hub rate-limits anonymous pulls per source address — an address GitHub's
# shared runners share with everyone else on them. The pull then fails before
# the job has built anything: the `e2e fixture (workspace)` job died exactly
# there on 2026-09-16 ("Get https://auth.docker.io/token ..."). So the builder
# runs BuildKit from Google's Docker Hub mirror instead, pinned to the index
# digest Docker Hub serves for that tag.
#
# The bootstrap is retried ONLY when the failure is that download. A bad flag,
# a missing builder or a broken daemon fails on the first attempt, as it
# should. This is the shape scripts/terraform-init.sh already uses for
# Terraform provider downloads.
set -euo pipefail

builder="${BUILDX_BUILDER:-edd-ci}"
attempts=3
buildkit_image="mirror.gcr.io/moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea"

if ! docker buildx inspect "${builder}" >/dev/null 2>&1; then
  docker buildx create --name "${builder}" --driver docker-container \
    --driver-opt "image=${buildkit_image}" >/dev/null
fi
docker buildx use "${builder}"

for attempt in $(seq 1 "${attempts}"); do
  if output=$(docker buildx inspect --bootstrap --builder "${builder}" 2>&1); then
    printf '%s\n' "${output}"
    exit 0
  fi
  printf '%s\n' "${output}" >&2
  case "${output}" in
    *mirror.gcr.io* | *"TLS handshake timeout"* | \
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
