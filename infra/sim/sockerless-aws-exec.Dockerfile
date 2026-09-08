# SPDX-License-Identifier: AGPL-3.0-or-later
# Container-mode sockerless AWS sim image for ecs-dev-desktop e2e: the
# published simulator plus the Linux netns toolchain its real awsvpc fabric
# needs (PR #519). The base is the release the shared dev environment runs;
# scripts/check-sim-pins.sh keeps this default and every compose file on the
# same digest.
ARG SOCKERLESS_AWS_IMAGE=ghcr.io/e6qu/sockerless-simulator-aws@sha256:77f2e38f40ebd17a6e960428d7f4660b5eb8b70b36c27ccac232639c3cbe1a76
FROM ${SOCKERLESS_AWS_IMAGE}
RUN apk add --no-cache iproute2 nftables procps util-linux
