# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace image: OpenVSCode Server v1.109.5 + a polyglot dev toolchain
# out of the box + idle-agent. Languages/tools: Node 22 (npm/yarn/pnpm/bun),
# C/C++ (build-essential), Go, Java (JDK + Maven + Gradle), Rust (cargo),
# Python 3 (pip/venv + uv), and Playwright (+ Chromium).
# Extensions are sourced from Open VSX (not the MS marketplace).
#
# Runtime env vars expected by the container:
#   EDD_WORKSPACE_ID    — workspace id (ws-…), passed by EcsComputeProvider
#   EDD_CONTROL_PLANE_URL — control-plane base URL, e.g. https://app.example.com
#   EDD_AGENT_TOKEN     — HMAC token for the heartbeat machine-auth path
#   EDD_SSH_CA_PUBLIC_KEY — OpenSSH CA public key trusted for workspace SSH certs
#   EDD_HEARTBEAT_INTERVAL_S — optional, default 120
#   CONNECTION_TOKEN    — openvscode-server connection token (injected by ECS secrets)
FROM node:22-bookworm-slim

ARG OPENVSCODE_VERSION=1.109.5

# System packages: curl (download), tini (init), ca-certificates, git (SCM in
# workspace), and build-essential (gcc/g++/make/libc-dev) — the image is for a
# "light editor + build workloads" (AGENTS.md §1), so a workspace must be able to
# compile, not just edit.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      gosu \
      openssh-server \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Download and install OpenVSCode Server.
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
      amd64) openvscode_arch="x64" ;; \
      arm64) openvscode_arch="arm64" ;; \
      *) echo "unsupported OpenVSCode architecture: ${arch}" >&2; exit 1 ;; \
    esac \
    && openvscode_dir="openvscode-server-v${OPENVSCODE_VERSION}-linux-${openvscode_arch}" \
    && curl -fsSL \
      "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/${openvscode_dir}.tar.gz" \
      -o /tmp/openvscode-server.tar.gz \
    && tar -xzf /tmp/openvscode-server.tar.gz -C /opt \
    && mv "/opt/${openvscode_dir}" /opt/openvscode-server \
    && rm /tmp/openvscode-server.tar.gz \
    && ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server

# --- Polyglot language toolchains (out of the box) -------------------------
# Tools install system-wide (/usr/local, /opt) so they work for the non-root
# `workspace` user over both the OpenVSCode terminal and SSH. Per-user caches
# (GOPATH, cargo registry, go-build, npm) land under the persistent EBS home.
ENV GOPATH="/home/workspace/go" \
    RUSTUP_HOME="/opt/rust/rustup" \
    CARGO_HOME="/opt/rust/cargo" \
    GRADLE_HOME="/opt/gradle" \
    BUN_INSTALL="/usr/local" \
    PLAYWRIGHT_BROWSERS_PATH="/ms-playwright" \
    JAVA_HOME="/usr/lib/jvm/default-java"
ENV PATH="/usr/local/go/bin:/home/workspace/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:${PATH}"

# Java (JDK + Maven), Python (+ pip/venv), and archive tools via apt.
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-jdk-headless \
      maven \
      python3 \
      python3-pip \
      python3-venv \
      unzip \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(command -v python3)" /usr/local/bin/python

# Go — official toolchain, latest stable for the image arch.
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in amd64) go_arch="amd64" ;; arm64) go_arch="arm64" ;; \
       *) echo "unsupported Go arch: ${arch}" >&2; exit 1 ;; esac \
    && go_ver="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)" \
    && curl -fsSL "https://go.dev/dl/${go_ver}.linux-${go_arch}.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz \
    && rm /tmp/go.tgz \
    && /usr/local/go/bin/go version

# Gradle — current stable release (Maven came from apt above).
RUN gradle_ver="$(curl -fsSL https://services.gradle.org/versions/current | sed -n 's/.*"version"[ ]*:[ ]*"\([^"]*\)".*/\1/p')" \
    && curl -fsSL "https://services.gradle.org/distributions/gradle-${gradle_ver}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && mv "/opt/gradle-${gradle_ver}" /opt/gradle \
    && rm /tmp/gradle.zip \
    && /opt/gradle/bin/gradle --version | grep -i version

# Rust — system-wide rustup/cargo (world-writable caches so `workspace` builds).
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
    && chmod -R a+rwX /opt/rust \
    && /opt/rust/cargo/bin/cargo --version

# Node package managers: yarn + pnpm as real global binaries (disable corepack
# first — its shims defer the download to first use, which fails in a no-egress
# workspace and caches per-user); bun.
RUN corepack disable 2>/dev/null || true \
    && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && npm install -g yarn pnpm \
    && curl -fsSL https://bun.sh/install | bash \
    && yarn --version && pnpm --version && bun --version

# Python project manager: uv (+ uvx).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version

# Playwright + the headless Chromium shell (browser + OS deps) preinstalled into
# a shared path. The headless shell (not full headed Chromium) keeps the image
# lean — a remote workspace has no display, so headless is the usable mode; a
# user who needs more can `npx playwright install chromium`.
RUN npm install -g playwright @playwright/test \
    && npx playwright install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# Make the toolchain PATH + env available to LOGIN/interactive shells too (the
# OpenVSCode integrated terminal and SSH source /etc/profile, which resets PATH
# and would otherwise drop the /opt and /usr/local/go additions from ENV above).
RUN printf '%s\n' \
      'export GOPATH="/home/workspace/go"' \
      'export RUSTUP_HOME="/opt/rust/rustup"' \
      'export CARGO_HOME="/opt/rust/cargo"' \
      'export GRADLE_HOME="/opt/gradle"' \
      'export JAVA_HOME="/usr/lib/jvm/default-java"' \
      'export PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"' \
      'export PATH="/usr/local/go/bin:/home/workspace/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:${PATH}"' \
      > /etc/profile.d/edd-toolchain.sh \
    && chmod 0644 /etc/profile.d/edd-toolchain.sh

# Workspace user — non-root, home is the persistent EBS mount point.
RUN useradd -m -s /bin/bash -d /home/workspace workspace \
    && usermod -p '*' workspace \
    && mkdir -p /etc/ssh/principals /run/sshd

COPY sshd_config /etc/ssh/sshd_config

# Copy idle-agent and entrypoint before switching user (they live in /usr/local/bin).
COPY --chmod=0755 idle-agent.sh /usr/local/bin/edd-idle-agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/edd-entrypoint

# Git credential helper: clone/push private repos using the session owner's token
# fetched from the control plane at use time (nothing stored on the EBS volume).
# System-wide so it applies to the entrypoint clone and user git ops alike.
COPY --chmod=0755 git-credential-helper.sh /usr/local/bin/edd-git-credential
RUN git config --system credential.helper /usr/local/bin/edd-git-credential

WORKDIR /home/workspace

EXPOSE 22 3000

# tini as PID 1 — reaps zombie processes from sshd/openvscode/idle-agent.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/edd-entrypoint"]
