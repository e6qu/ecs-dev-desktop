# SPDX-License-Identifier: AGPL-3.0-or-later
# Reconciler service: runs one maintenance sweep per invocation (ECS scheduled
# task). Multi-stage build from the monorepo root; esbuild bundles the entry
# point and all workspace packages into a single self-contained dist/run.js so
# the runtime image needs only Node.js.
#
# Build context: repo root.
# docker build -f services/reconciler/Dockerfile -t edd-reconciler .

# ---- Stage 1: install deps + bundle ----------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm

# Copy workspace manifests (cache-friendly layer).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json                             apps/web/
COPY packages/api-client/package.json                  packages/api-client/
COPY packages/api-contracts/package.json               packages/api-contracts/
COPY packages/auth/package.json                        packages/auth/
COPY packages/authz/package.json                       packages/authz/
COPY packages/cloudtrail-audit/package.json            packages/cloudtrail-audit/
COPY packages/cloudwatch-logs/package.json             packages/cloudwatch-logs/
COPY packages/cloudwatch-metrics/package.json          packages/cloudwatch-metrics/
COPY packages/compute-ecs/package.json                 packages/compute-ecs/
COPY packages/config/package.json                      packages/config/
COPY packages/control-plane/package.json               packages/control-plane/
COPY packages/core/package.json                        packages/core/
COPY packages/db/package.json                          packages/db/
COPY packages/e2e/package.json                         packages/e2e/
COPY packages/storage-ec2/package.json                 packages/storage-ec2/
COPY services/reconciler/package.json                  services/reconciler/
COPY services/ssh-gateway/package.json                 services/ssh-gateway/

RUN pnpm install --frozen-lockfile --filter @edd/reconciler...

# Copy sources for the reconciler and its workspace dependencies.
COPY tsconfig.base.json ./
COPY packages/api-contracts/src   packages/api-contracts/src
COPY packages/authz/src            packages/authz/src
COPY packages/config/src           packages/config/src
COPY packages/core/src             packages/core/src
COPY packages/cloudwatch-metrics/src packages/cloudwatch-metrics/src
COPY packages/compute-ecs/src      packages/compute-ecs/src
COPY packages/control-plane/src    packages/control-plane/src
COPY packages/db/src               packages/db/src
COPY packages/storage-ec2/src      packages/storage-ec2/src
COPY services/reconciler/src       services/reconciler/src
COPY services/reconciler/tsconfig.json services/reconciler/

# Type-check then bundle: esbuild follows workspace and npm imports and inlines
# them into a single ESM file.
RUN pnpm --filter @edd/reconciler build

# ---- Stage 2: minimal runtime image ----------------------------------------
FROM node:22-alpine
WORKDIR /app

# Keep node_modules available for Node's module metadata lookup and future
# runtime-only dependencies; application code is bundled into dist/run.js.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/reconciler/dist/run.js ./services/reconciler/dist/run.js

RUN addgroup -S reconciler && adduser -S reconciler -G reconciler
USER reconciler

ENTRYPOINT ["node", "services/reconciler/dist/run.js"]
