#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
unset CDPATH

account="${1:?usage: verify-published-images.sh <account-id> <region> <name-prefix> <tag> <repository...>}"
region="${2:?usage: verify-published-images.sh <account-id> <region> <name-prefix> <tag> <repository...>}"
prefix="${3:?usage: verify-published-images.sh <account-id> <region> <name-prefix> <tag> <repository...>}"
tag="${4:?usage: verify-published-images.sh <account-id> <region> <name-prefix> <tag> <repository...>}"
shift 4

if [ "$#" -eq 0 ]; then
  echo "edd: at least one repository is required" >&2
  exit 1
fi

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/lib/validate-image-tag.sh
. "$here/lib/validate-image-tag.sh"
validate_image_tag "$tag" "tag" || exit 1

registry="${account}.dkr.ecr.${region}.amazonaws.com"
expected_platforms=$(printf 'linux/amd64\nlinux/arm64')

for repository in "$@"; do
  image="${registry}/${prefix}/${repository}:${tag}"

  for arch in amd64 arm64; do
    architecture_image="${image}-${arch}"
    media_type=$(docker buildx imagetools inspect \
      --format '{{.Manifest.MediaType}}' "$architecture_image")
    if [ "$media_type" != "application/vnd.oci.image.manifest.v1+json" ]; then
      echo "edd: $architecture_image resolved to $media_type, expected a direct OCI image manifest" >&2
      exit 1
    fi
  done

  media_type=$(docker buildx imagetools inspect --format '{{.Manifest.MediaType}}' "$image")
  if [ "$media_type" != "application/vnd.oci.image.index.v1+json" ]; then
    echo "edd: $image resolved to $media_type, expected an OCI image index" >&2
    exit 1
  fi

  platforms=$(docker buildx imagetools inspect \
    --format '{{range .Manifest.Manifests}}{{printf "%s/%s\n" .Platform.OS .Platform.Architecture}}{{end}}' \
    "$image" | sort)
  if [ "$platforms" != "$expected_platforms" ]; then
    echo "edd: $image exposed unexpected platforms:" >&2
    printf '%s\n' "$platforms" >&2
    exit 1
  fi

  echo "edd: verified $image with direct linux/amd64 and linux/arm64 images"
done
