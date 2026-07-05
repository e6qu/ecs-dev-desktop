# SPDX-License-Identifier: AGPL-3.0-or-later
# Next.js control-plane image: runs the production build via the custom server
# (server.ts, launched with tsx) so the app serves the portal/admin/API AND the
# in-app path-based `/w/<id>/` workspace editor proxy. The real EBS/ECS adapters
# target the sim by coordinates (COMPUTE_PROVIDER=ecs + AWS_ENDPOINT_URL). Build
# context is the repo root; apps/web/Dockerfile.dockerignore keeps it lean.
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
# node-gyp (needed to compile services/editor-monaco's node-pty native binding, pulled
# in by the workspace-wide install below even though apps/web doesn't use it directly)
# requires python3 + a C/C++ toolchain, absent from the slim base image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
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
# The reconciler runs THIS image with a command override
# (`node services/reconciler/dist/run.js`, see the module's reconciler task def), so
# the control-plane image must also carry the reconciler bundle. Build it here.
RUN pnpm --filter @edd/reconciler build

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
# 0.0.0.0 so it is reachable in-network. The custom server (server.ts, run via tsx)
# serves the app AND the path-based `/w/<id>/` workspace editor proxy.
EXPOSE 3700
ENV NODE_ENV=production PORT=3700 HOSTNAME=0.0.0.0
CMD ["pnpm", "exec", "tsx", "server.ts"]
