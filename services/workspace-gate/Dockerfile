# SPDX-License-Identifier: AGPL-3.0-or-later
# Workspace authorization gate (PEP): a thin reverse proxy that authorizes every
# workspace HTTP/WebSocket request against the control-plane PDP before
# forwarding to the workspace upstream. Multi-stage build from the monorepo root;
# esbuild bundles the entry point and all workspace packages into a single
# self-contained dist/run.js so the runtime image needs only Node.js.
#
# Build context: repo root.
# docker build -f services/workspace-gate/Dockerfile -t edd-workspace-gate .

# ---- Stage 1: install deps + bundle ----------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm

# Copy workspace manifests (cache-friendly layer).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/authz/package.json                       packages/authz/
COPY packages/config/package.json                      packages/config/
COPY packages/core/package.json                        packages/core/
COPY services/workspace-gate/package.json              services/workspace-gate/

RUN pnpm install --frozen-lockfile --filter @edd/workspace-gate...

# Copy sources for the gate and its workspace dependencies.
COPY tsconfig.base.json ./
COPY packages/authz/src            packages/authz/src
COPY packages/config/src           packages/config/src
COPY packages/core/src             packages/core/src
COPY services/workspace-gate/src   services/workspace-gate/src
COPY services/workspace-gate/tsconfig.json services/workspace-gate/

RUN pnpm --filter @edd/workspace-gate build

# ---- Stage 2: minimal runtime image ----------------------------------------
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/workspace-gate/dist/run.js ./services/workspace-gate/dist/run.js

RUN addgroup -S gate && adduser -S gate -G gate
USER gate

ENTRYPOINT ["node", "services/workspace-gate/dist/run.js"]
