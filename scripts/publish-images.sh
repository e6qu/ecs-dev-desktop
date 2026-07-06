#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build and publish the platform's container images to the ECR repositories the
# Terraform module creates. Run AFTER the first `terraform apply` (the repos must
# exist); feed it the repository URLs from the module outputs. Closes the
# two-phase-apply friction: the module stands up infra, this pushes the images,
# then a re-apply (or `aws ecs update-service --force-new-deployment`) rolls them.
#
#   scripts/publish-images.sh <account-id> <region> <name-prefix> <tag> [variant...]
#
#   account-id   12-digit AWS account id (ECR domain)
#   region       AWS region
#   name-prefix  the module `name` (e.g. edd-dev)
#   tag          image tag (a git sha, version, or 'main')
#   variant...   golden variants to build FROM base (default: omnibus; e.g.
#                omnibus typescript python go java rust)
#
# Produces a multi-arch manifest for each image plus per-arch images with an
# architecture suffix, so runners that cannot consume manifests (e.g. Lambda)
# can pin an exact arch:
#
#   <name-prefix>/control-plane:<tag>              manifest (amd64 + arm64)
#   <name-prefix>/control-plane:<tag>-amd64        amd64 image
#   <name-prefix>/control-plane:<tag>-arm64        arm64 image
#   <name-prefix>/golden/<variant>:<tag>           manifest (amd64 + arm64)
#   <name-prefix>/golden/<variant>:<tag>-amd64     amd64 image
#   <name-prefix>/golden/<variant>:<tag>-arm64     arm64 image
#   (same pattern for ssh-gateway)
#
# Environment:
#   EDD_BUILD_ARCHS     architectures to build (default: "amd64 arm64").
#                       A manifest is created from every arch that is built; if
#                       your build host cannot emulate the other architecture
#                       (e.g. a single-arch CI runner), set this to just the
#                       host arch, e.g. "amd64".
#   EDD_BUILDX_NO_LOAD  set to "1" to omit `--load` (only needed if you are
#                       using a non-default buildx builder that stores images
#                       internally).
#
# The control-plane image MUST be built from the repo root (monorepo context).
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Requires Docker with buildx and the AWS CLI v2.

set -eu
unset CDPATH

account="${1:?usage: publish-images.sh <account-id> <region> <name-prefix> <tag> [variant...]}"
region="${2:?usage: publish-images.sh <account-id> <region> <name-prefix> <tag> [variant...]}"
prefix="${3:?usage: publish-images.sh <account-id> <region> <name-prefix> <tag> [variant...]}"
tag="${4:?usage: publish-images.sh <account-id> <region> <name-prefix> <tag> [variant...]}"
shift 4
variants="${*:-omnibus}" # default to the omnibus golden image

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

registry="${account}.dkr.ecr.${region}.amazonaws.com"
archs="${EDD_BUILD_ARCHS:-amd64 arm64}"

# Deploy provenance baked into the control-plane image: the commit it was built
# from (the image tag is the short sha) and the UTC build time. Surfaced in the
# app footer so operators can see, at a glance, which build is live and how old
# it is. Computed once here so both arch builds carry the same timestamp.
build_sha="${tag}"
build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! command -v docker >/dev/null 2>&1; then
  echo "edd: docker (or podman aliased as docker) not found on PATH" >&2
  exit 1
fi

echo "edd: authenticating to ECR $registry"
aws ecr get-login-password --region "$region" |
  docker login --username AWS --password-stdin "$registry"

# Run `docker buildx build` for a single architecture. The optional `--load` is
# appended so the image is available in the local daemon for the base -> variant
# chain; omit it only when the caller's buildx setup stores images internally.
buildx_build() { # <arch> <full-tag> <dockerfile> <context> [extras...]
  arch="$1"
  full="$2"
  dockerfile="$3"
  ctx="$4"
  shift 4

  if [ "${EDD_BUILDX_NO_LOAD:-0}" != "1" ]; then
    set -- "$@" "--load"
  fi

  docker buildx build \
    --platform "linux/${arch}" \
    -t "$full" \
    -f "$dockerfile" \
    "$@" \
    "$ctx"
}

# Build and push a per-arch image for a simple repo (control-plane, ssh-gateway).
build_push_arch() { # <repo-short> <dockerfile> <context> [extras...]
  target="$1"
  dockerfile="$2"
  ctx="$3"
  shift 3
  for arch in $archs; do
    full="${registry}/${prefix}/${target}:${tag}-${arch}"
    echo "edd: building ${full}"
    buildx_build "$arch" "$full" "$dockerfile" "$ctx" "$@"
    echo "edd: pushing ${full}"
    docker push "$full"
  done
}

# Build the golden base for one architecture and then every variant FROM it.
# Variants live in ECR under <prefix>/golden/<variant> (the module creates
# repos named "<prefix>/golden/<variant>").
build_golden_arch() { # <arch>
  arch="$1"
  base_full="${registry}/${prefix}/edd-base:${tag}-${arch}"

  echo "edd: building golden base ${base_full}"
  sh "$repo/infra/images/base/build.sh" "$base_full" \
    --platform "linux/${arch}" --load

  for v in $variants; do
    variant_full="${registry}/${prefix}/golden/${v}:${tag}-${arch}"
    echo "edd: building golden variant '$v' (${arch}) FROM ${base_full}"
    buildx_build "$arch" "$variant_full" "$repo/infra/images/${v}/Dockerfile" \
      "$repo/infra/images/${v}" --build-arg "BASE=${base_full}"
    echo "edd: pushing ${variant_full}"
    docker push "$variant_full"
  done
}

# Create and push the multi-arch manifest for a repo short name from the per-arch
# images that were just built and pushed.
push_manifest() { # <repo-short>
  target="$1"
  manifest="${registry}/${prefix}/${target}:${tag}"
  echo "edd: creating manifest ${manifest}"

  set --
  for arch in $archs; do
    set -- "$@" "${registry}/${prefix}/${target}:${tag}-${arch}"
  done

  docker manifest create --amend "$manifest" "$@"

  for arch in $archs; do
    docker manifest annotate --arch "$arch" "$manifest" "${registry}/${prefix}/${target}:${tag}-${arch}"
  done

  docker manifest push "$manifest"
}

# 1. Control-plane app (also the reconciler image — same image, command override).
build_push_arch control-plane "$repo/apps/web/Dockerfile" "$repo" \
  --build-arg "EDD_BUILD_SHA=${build_sha}" --build-arg "EDD_BUILD_TIME=${build_time}"

# 2. SSH gateway (IMMUTABLE ECR repo: each tag is pushed ONCE; never overwrite).
# Context is the repo root, matching Dockerfile.proxy's repo-root-relative COPY paths
# (the same convention as the control-plane build above) -- passing the ssh-gateway
# subdirectory itself as context here made every COPY fail with "not found" (never
# caught before: this build path had never actually been exercised until CodeBuild
# got past the control-plane image for the first time).
build_push_arch ssh-gateway "$repo/services/ssh-gateway/Dockerfile.proxy" "$repo"

# 3. Golden variants, each FROM the per-arch base.
for arch in $archs; do
  build_golden_arch "$arch"
done

# 4. Multi-arch manifests. These are what ECS Fargate pulls; runners that cannot
# consume manifests can pin the -amd64 / -arm64 tags directly.
push_manifest control-plane
push_manifest ssh-gateway
for v in $variants; do
  push_manifest "golden/${v}"
done

cat <<EOF

edd: images published to ${registry}. To roll the running services:
     aws ecs update-service --cluster ${prefix}-workspaces \
       --service ${prefix}-control-plane --force-new-deployment
     (the reconciler picks up the new image on its next scheduled invocation;
      the SSH gateway service is ${prefix}-ssh-gateway when SSH ingress is on)
EOF
