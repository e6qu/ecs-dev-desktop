# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace OMNIBUS image: the shared BASE runtime + the FULL polyglot
# toolchain out of the box — C/C++ (build-essential), Go, Java (JDK + Maven +
# Gradle), Rust (cargo), Python 3 (pip/venv + uv), Node package managers
# (yarn/pnpm/bun), and Playwright (+ headless Chromium). The "everything" variant;
# slim per-language variants (typescript/python/go/java/rust) also build FROM base.
#
# Built FROM the base image — pass its tag via the BASE build-arg, e.g.:
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace infra/images/omnibus
ARG BASE=edd-base:latest
FROM ${BASE}

# Toolchain env. PATH prepends the toolchain dirs ahead of the inherited base PATH
# (which already carries the user-CLI dirs + system). NPM_CONFIG_PREFIX is inherited
# from base (a HOME dir) for the *runtime user* — so the system `npm install -g`
# steps below override it back to /usr/local for build time.
ENV GOPATH="/data/home/go" \
    RUSTUP_HOME="/opt/rust/rustup" \
    CARGO_HOME="/opt/rust/cargo" \
    GRADLE_HOME="/opt/gradle" \
    BUN_INSTALL="/usr/local" \
    PLAYWRIGHT_BROWSERS_PATH="/ms-playwright" \
    JAVA_HOME="/usr/lib/jvm/default-java"
ENV PATH="/usr/local/go/bin:/data/home/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:${PATH}"

# Compilers + Java (JDK + Maven), Python (+ pip/venv), and archive tools via apt.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      default-jdk-headless \
      maven \
      python3 \
      python3-pip \
      python3-venv \
      unzip \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(command -v python3)" /usr/local/bin/python

# Go -- official toolchain, PINNED. Resolving go.dev/VERSION at build time made the
# image depend on whatever Go shipped that morning, so two builds of the same
# Dockerfile could differ, and a toolchain change could break CI with no change in
# this repository. Same defect class as the google-java-format break of 2026-08-02.
ARG GO_VERSION=1.27.1
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in amd64) go_arch="amd64" ;; arm64) go_arch="arm64" ;; \
       *) echo "unsupported Go arch: ${arch}" >&2; exit 1 ;; esac \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz \
    && rm /tmp/go.tgz \
    && /usr/local/go/bin/go version

# Gradle — current stable release (Maven came from apt above).
# PINNED. Gradle 9.x needs a JDK 17+ daemon and this image's JDK is Debian's
# default-jdk-headless (17), so 9.7.1 runs here; a future Gradle that requires
# Java 21 would reproduce the google-java-format failure exactly, which is why
# "current" is not resolved at build time. Bump in lockstep with the JDK.
ARG GRADLE_VERSION=9.7.1
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
    && rm /tmp/gradle.zip \
    && /opt/gradle/bin/gradle --version | grep -i version

# Rust — system-wide rustup/cargo (world-writable caches so `workspace` builds).
# PINNED: rustup installs the named toolchain rather than whatever "stable" is today.
ARG RUST_VERSION=1.98.1
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
    && chmod -R a+rwX /opt/rust \
    && /opt/rust/cargo/bin/cargo --version

# PINNED: unversioned `npm install -g` and the bun installer both track latest.
ARG YARN_VERSION=1.22.22
ARG PNPM_VERSION=12.4.1
ARG BUN_VERSION=1.4.2
# Node package managers: yarn + pnpm as real global binaries (disable corepack
# first — its shims defer the download to first use, which fails in a no-egress
# workspace and caches per-user); bun. The system installs go to /usr/local —
# override the inherited home npm prefix for this build step.
RUN export NPM_CONFIG_PREFIX=/usr/local \
    && (corepack disable 2>/dev/null || true) \
    && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && npm install -g "yarn@${YARN_VERSION}" "pnpm@${PNPM_VERSION}" \
    && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
    && yarn --version && pnpm --version && bun --version

# Python project manager: uv (+ uvx).
# PINNED: the versioned installer URL installs exactly this uv.
ARG UV_VERSION=0.12.13
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version

# PINNED: playwright and @playwright/test must match each other exactly.
ARG PLAYWRIGHT_VERSION=1.63.0
# Playwright + the headless Chromium shell (browser + OS deps) preinstalled into a
# shared path. Export the /usr/local prefix for the WHOLE step so BOTH `npm install
# -g` and `npx` use it — otherwise npx would create the inherited home npm prefix
# (/data/home/.npm-global) as root, leaving it unwritable by the workspace user.
RUN export NPM_CONFIG_PREFIX=/usr/local \
    && npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/test@${PLAYWRIGHT_VERSION}" \
    && npx playwright install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# Per-language dev tooling (the omnibus carries every language's, to system paths so
# they survive the EBS mount): Python (uv tools → /usr/local/bin), Go (golangci-lint
# + staticcheck/deadcode/dupl → /usr/local/bin via GOBIN), Rust (clippy + rustfmt
# components + cargo-audit), Java (google-java-format, below). The Node lint/format/
# dead-code/CPD tools and the cross-cutting Trivy scanner come from base.
# PINNED: each `uv tool install <name>` resolved the newest release at build time.
ARG RUFF_VERSION=0.16.7
ARG TY_VERSION=0.0.80
ARG VULTURE_VERSION=2.16
ARG BANDIT_VERSION=1.9.4
ARG SEMGREP_VERSION=1.177.0
RUN export UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
    && uv tool install "ruff==${RUFF_VERSION}" && uv tool install "ty==${TY_VERSION}" && uv tool install "vulture==${VULTURE_VERSION}" \
    && uv tool install "bandit==${BANDIT_VERSION}" && uv tool install "semgrep==${SEMGREP_VERSION}" \
    && for t in ruff ty vulture bandit semgrep; do command -v "$t" || exit 1; done
RUN GOBIN=/usr/local/bin /usr/local/go/bin/go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install honnef.co/go/tools/cmd/staticcheck@latest \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install golang.org/x/tools/cmd/deadcode@latest \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install github.com/mibk/dupl@latest \
    && golangci-lint --version && staticcheck --version \
    && command -v deadcode && command -v dupl \
    && /usr/local/go/bin/go clean -cache -modcache
RUN /opt/rust/cargo/bin/rustup component add clippy rustfmt \
    && /opt/rust/cargo/bin/cargo install cargo-audit --locked \
    && rm -rf /opt/rust/cargo/registry \
    && chmod -R a+rwX /opt/rust \
    && /opt/rust/cargo/bin/cargo clippy --version && /opt/rust/cargo/bin/cargo fmt --version \
    && /opt/rust/cargo/bin/cargo audit --version

# Java formatter: google-java-format (the de-facto Java formatter — parity with
# prettier/ruff/rustfmt; Java's only standalone format/lint CLI). Distributed as an
# all-deps JAR; install it under /opt with a wrapper on PATH (the JDK from apt above
# provides `java`).
#
# PINNED — do NOT resolve `releases/latest` at build time. The JDK above is Debian
# bookworm's `default-jdk-headless`, i.e. Java 17 (class file 61). google-java-format
# 1.36.0 switched to a Java 21 target (class file 65), so a build that tracked
# `latest` started failing with `UnsupportedClassVersionError` the day it shipped —
# an unpinned upstream release breaking CI, and a non-reproducible image besides.
# 1.35.0 is the newest release that still targets Java 17. Bump this only in lockstep
# with the image's JDK (1.36+ needs a Java 21 JDK here).
ARG GJF_VERSION=1.35.0
RUN curl -fsSL "https://github.com/google/google-java-format/releases/download/v${GJF_VERSION}/google-java-format-${GJF_VERSION}-all-deps.jar" \
      -o /opt/google-java-format.jar \
    && printf '#!/bin/sh\nexec java -jar /opt/google-java-format.jar "$@"\n' > /usr/local/bin/google-java-format \
    && chmod 0755 /usr/local/bin/google-java-format \
    && google-java-format --version

# VS Code extensions into the built-in extensions dir: every language's (base
# already baked the cross-cutting formatter/linter/GitHub ones + the AI agents).
RUN for ext in \
      ms-python.debugpy@2026.6.0 ms-python.vscode-python-envs@1.20.1 ms-python.python@2026.4.0 detachhead.basedpyright@1.40.1 charliermarsh.ruff@2026.80.0 astral-sh.ty@2026.70.0 semgrep.semgrep@1.17.0 \
      golang.go@0.56.1 redhat.java@1.56.0 rust-lang.rust-analyzer@0.3.3049 ms-playwright.playwright@1.1.19 ; do \
      openvscode-server --install-extension "$ext" --extensions-dir /opt/openvscode-server/extensions || exit 1 ; \
    done \
    && chmod -R a+rX /opt/openvscode-server/extensions

# Belt-and-suspenders: ensure no root-owned build cruft remains under the home dir
# (it's shadowed by the EBS volume at runtime, but keep the image clean so the
# workspace user can create its own ~/.npm-global etc.).
RUN rm -rf /data/home/.npm /data/home/.cache /data/home/.npm-global \
    && chown -R workspace:workspace /data/home

# Re-export PATH + toolchain env for LOGIN/interactive shells (OpenVSCode terminal
# + interactive SSH source /etc/profile, which resets PATH). Overwrites the base
# drop-in with the toolchain-inclusive version (still carries the user-CLI dirs).
RUN printf '%s\n' \
      'export GOPATH="/data/home/go"' \
      'export RUSTUP_HOME="/opt/rust/rustup"' \
      'export CARGO_HOME="/opt/rust/cargo"' \
      'export GRADLE_HOME="/opt/gradle"' \
      'export JAVA_HOME="/usr/lib/jvm/default-java"' \
      'export PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"' \
      'export PATH="/data/home/.npm-global/bin:/data/home/.local/bin:/usr/local/go/bin:/data/home/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh

# ssh-exec PATH incl. the toolchain (overwrites the base drop-in).
RUN printf '%s\n' \
      'SetEnv PATH=/data/home/.npm-global/bin:/data/home/.local/bin:/usr/local/go/bin:/data/home/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf
