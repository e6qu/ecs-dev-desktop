# SPDX-License-Identifier: AGPL-3.0-or-later
# Next.js control-plane image for the live Pomerium→gate→ECS e2e harness: runs the
# production `next start` build in the compose network so the gate's PDP + the
# wake/connect-info routes are reachable, and the real EBS/ECS adapters target the
# sim by coordinates (COMPUTE_PROVIDER=ecs + AWS_ENDPOINT_URL). Build context is the
# repo root; apps/web/Dockerfile.dockerignore keeps it lean.
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
# Workspace manifests first for a cached install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages packages
COPY services services
RUN pnpm install --frozen-lockfile
# Source + build (workspace packages ship TS source; Next transpiles them).
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @edd/web build

FROM node:22-bookworm-slim AS runner
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NODE_ENV=production
# Pre-activate pnpm at build time so `next start` doesn't stall on a corepack
# download at container start.
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
# Own the tree at copy time (no extra layer) so the non-root user can read it and
# `next start` can write its runtime cache under .next.
COPY --from=builder --chown=node:node /repo /repo
# Run as the image's built-in non-root user (security best practice; CI SAST +
# Trivy require a non-root final USER).
USER node
WORKDIR /repo/apps/web
# Port 3700 (not 3000 — which collides with countless local dev servers). Bind
# 0.0.0.0 (not the default localhost) so the gate/Pomerium reach it in-network.
EXPOSE 3700
CMD ["pnpm", "exec", "next", "start", "-p", "3700", "-H", "0.0.0.0"]
