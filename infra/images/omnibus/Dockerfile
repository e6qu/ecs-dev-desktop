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
ENV GOPATH="/home/workspace/go" \
    RUSTUP_HOME="/opt/rust/rustup" \
    CARGO_HOME="/opt/rust/cargo" \
    GRADLE_HOME="/opt/gradle" \
    BUN_INSTALL="/usr/local" \
    PLAYWRIGHT_BROWSERS_PATH="/ms-playwright" \
    JAVA_HOME="/usr/lib/jvm/default-java"
ENV PATH="/usr/local/go/bin:/home/workspace/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:${PATH}"

# Compilers + Java (JDK + Maven), Python (+ pip/venv), and archive tools via apt.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
# workspace and caches per-user); bun. The system installs go to /usr/local —
# override the inherited home npm prefix for this build step.
RUN export NPM_CONFIG_PREFIX=/usr/local \
    && (corepack disable 2>/dev/null || true) \
    && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && npm install -g yarn pnpm \
    && curl -fsSL https://bun.sh/install | bash \
    && yarn --version && pnpm --version && bun --version

# Python project manager: uv (+ uvx).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version

# Playwright + the headless Chromium shell (browser + OS deps) preinstalled into a
# shared path. Export the /usr/local prefix for the WHOLE step so BOTH `npm install
# -g` and `npx` use it — otherwise npx would create the inherited home npm prefix
# (/home/workspace/.npm-global) as root, leaving it unwritable by the workspace user.
RUN export NPM_CONFIG_PREFIX=/usr/local \
    && npm install -g playwright @playwright/test \
    && npx playwright install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# Per-language dev tooling (the omnibus carries every language's, to system paths so
# they survive the EBS mount): Python (uv tools → /usr/local/bin), Go (golangci-lint
# + staticcheck/deadcode/dupl → /usr/local/bin via GOBIN), Rust (clippy + rustfmt
# components + cargo-audit), Java (google-java-format, below). The Node lint/format/
# dead-code/CPD tools and the cross-cutting Trivy scanner come from base.
RUN export UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
    && uv tool install ruff && uv tool install ty && uv tool install vulture \
    && uv tool install bandit && uv tool install semgrep \
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
# provides `java`). Resolve the latest version via the github.com `releases/latest`
# redirect (the release-page URL carries the tag) — NOT the api.github.com JSON API,
# which has a low unauthenticated rate limit that flakes in CI.
RUN gjf_ver="$(curl -fsS -o /dev/null -w '%{url_effective}' -L \
      https://github.com/google/google-java-format/releases/latest | sed -E 's#.*/tag/v?##')" \
    && test -n "${gjf_ver}" \
    && curl -fsSL "https://github.com/google/google-java-format/releases/download/v${gjf_ver}/google-java-format-${gjf_ver}-all-deps.jar" \
      -o /opt/google-java-format.jar \
    && printf '#!/bin/sh\nexec java -jar /opt/google-java-format.jar "$@"\n' > /usr/local/bin/google-java-format \
    && chmod 0755 /usr/local/bin/google-java-format \
    && google-java-format --version

# VS Code extensions into the built-in extensions dir: every language's (base
# already baked the cross-cutting formatter/linter/GitHub ones + the AI agents).
RUN for ext in \
      ms-python.python detachhead.basedpyright charliermarsh.ruff astral-sh.ty semgrep.semgrep \
      golang.go redhat.java rust-lang.rust-analyzer ms-playwright.playwright ; do \
      openvscode-server --install-extension "$ext" --extensions-dir /opt/openvscode-server/extensions ; \
    done \
    && chmod -R a+rX /opt/openvscode-server/extensions

# Belt-and-suspenders: ensure no root-owned build cruft remains under the home dir
# (it's shadowed by the EBS volume at runtime, but keep the image clean so the
# workspace user can create its own ~/.npm-global etc.).
RUN rm -rf /home/workspace/.npm /home/workspace/.cache /home/workspace/.npm-global \
    && chown -R workspace:workspace /home/workspace

# Re-export PATH + toolchain env for LOGIN/interactive shells (OpenVSCode terminal
# + interactive SSH source /etc/profile, which resets PATH). Overwrites the base
# drop-in with the toolchain-inclusive version (still carries the user-CLI dirs).
RUN printf '%s\n' \
      'export GOPATH="/home/workspace/go"' \
      'export RUSTUP_HOME="/opt/rust/rustup"' \
      'export CARGO_HOME="/opt/rust/cargo"' \
      'export GRADLE_HOME="/opt/gradle"' \
      'export JAVA_HOME="/usr/lib/jvm/default-java"' \
      'export PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"' \
      'export PATH="/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/usr/local/go/bin:/home/workspace/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh

# ssh-exec PATH incl. the toolchain (overwrites the base drop-in).
RUN printf '%s\n' \
      'SetEnv PATH=/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/usr/local/go/bin:/home/workspace/go/bin:/opt/rust/cargo/bin:/opt/gradle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf
