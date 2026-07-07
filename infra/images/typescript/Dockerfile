# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace TYPESCRIPT/Node variant: the shared base (which already ships
# Node 22) + the JS/TS toolchain — yarn/pnpm/bun and a global `typescript` (tsc),
# plus build-essential for native node addons (node-gyp). Slim alternative to omnibus.
#
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace-typescript infra/images/typescript
ARG BASE=edd-base:latest
FROM ${BASE}

ENV BUN_INSTALL="/usr/local"

# C/C++ toolchain for native node addons + archive tools.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential unzip zip \
    && rm -rf /var/lib/apt/lists/*

# Node package managers + global TypeScript. Real globals in /usr/local — export
# the prefix to override the inherited home npm prefix (so they aren't installed
# under $HOME, which is the EBS mount). These land in /usr/local/bin, already on
# the base PATH for every shell — no PATH drop-in override needed.
RUN export NPM_CONFIG_PREFIX=/usr/local \
    && (corepack disable 2>/dev/null || true) \
    && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && npm install -g yarn pnpm typescript \
    && curl -fsSL https://bun.sh/install | bash \
    && yarn --version && pnpm --version && bun --version && tsc --version
