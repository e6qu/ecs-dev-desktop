# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace GO variant: the shared base + the official Go toolchain (+
# build-essential for cgo). Slim alternative to omnibus.
#
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace-go infra/images/go
ARG BASE=edd-base:latest
FROM ${BASE}

ENV GOPATH="/data/home/go"
ENV PATH="/usr/local/go/bin:/data/home/go/bin:${PATH}"

# C toolchain for cgo.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

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

# Go dev tooling: golangci-lint (a meta-linter that bundles gosec, staticcheck,
# etc.). Install to /usr/local/bin via GOBIN (the default GOPATH/bin is on the EBS
# mount, shadowed) so it's on the base PATH and survives. Alongside golangci-lint
# (a meta-linter that already bundles staticcheck + gosec): the standalone
# `staticcheck` CLI, `deadcode` (the official x/tools dead-code finder), and `dupl`
# (Go copy-paste detector) — the per-language dead-code/CPD/static-analysis set from
# #95. One `go clean` after all installs (the module/build cache is ~GBs, shadowed by
# the EBS mount anyway).
# PINNED: `@latest` resolved a different module version on every build.
ARG GOLANGCI_LINT_VERSION=v2.13.2
ARG STATICCHECK_VERSION=v0.8.1
ARG X_TOOLS_VERSION=v0.50.0
ARG DUPL_VERSION=v1.1.0
RUN GOBIN=/usr/local/bin /usr/local/go/bin/go install "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${GOLANGCI_LINT_VERSION}" \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install "honnef.co/go/tools/cmd/staticcheck@${STATICCHECK_VERSION}" \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install "golang.org/x/tools/cmd/deadcode@${X_TOOLS_VERSION}" \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install "github.com/mibk/dupl@${DUPL_VERSION}" \
    && golangci-lint --version && staticcheck --version \
    && command -v deadcode && command -v dupl \
    && /usr/local/go/bin/go clean -cache -modcache

# Go VS Code extension into the built-in extensions dir (baked at build).
RUN openvscode-server --install-extension golang.go@0.56.1 --extensions-dir /opt/openvscode-server/extensions \
    && chmod -R a+rX /opt/openvscode-server/extensions

# Go dirs aren't on the base PATH — overwrite the PATH drop-ins so login shells and
# the ssh-exec channel both find `go` (the base only covers user-CLI + system dirs).
RUN printf '%s\n' \
      'export GOPATH="/data/home/go"' \
      'export PATH="/data/home/.npm-global/bin:/data/home/.local/bin:/usr/local/go/bin:/data/home/go/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh
RUN printf '%s\n' \
      'SetEnv PATH=/data/home/.npm-global/bin:/data/home/.local/bin:/usr/local/go/bin:/data/home/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf
