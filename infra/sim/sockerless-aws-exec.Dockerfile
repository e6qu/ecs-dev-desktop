# SPDX-License-Identifier: AGPL-3.0-or-later
# Container-mode sockerless AWS sim image for ecs-dev-desktop e2e: the
# published simulator plus the Linux netns toolchain its real awsvpc fabric
# needs (PR #519). The base is the release the shared dev environment runs;
# scripts/check-sim-pins.sh keeps this default and every compose file on the
# same digest.
ARG SOCKERLESS_AWS_IMAGE=ghcr.io/e6qu/sockerless-simulator-aws@sha256:407b230954ae528313ed1f9c089636c74cfc61c889b416845599c30f73a9d7e9
FROM ${SOCKERLESS_AWS_IMAGE}
RUN apk add --no-cache iproute2 nftables procps util-linux
