# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace GO variant: the shared base + the official Go toolchain (+
# build-essential for cgo). Slim alternative to omnibus.
#
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace-go infra/images/go
ARG BASE=edd-base:latest
FROM ${BASE}

ENV GOPATH="/home/workspace/go"
ENV PATH="/usr/local/go/bin:/home/workspace/go/bin:${PATH}"

# C toolchain for cgo.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Go — official toolchain, latest stable for the image arch.
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in amd64) go_arch="amd64" ;; arm64) go_arch="arm64" ;; \
       *) echo "unsupported Go arch: ${arch}" >&2; exit 1 ;; esac \
    && go_ver="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)" \
    && curl -fsSL "https://go.dev/dl/${go_ver}.linux-${go_arch}.tar.gz" -o /tmp/go.tgz \
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
RUN GOBIN=/usr/local/bin /usr/local/go/bin/go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install honnef.co/go/tools/cmd/staticcheck@latest \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install golang.org/x/tools/cmd/deadcode@latest \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install github.com/mibk/dupl@latest \
    && golangci-lint --version && staticcheck --version \
    && command -v deadcode && command -v dupl \
    && /usr/local/go/bin/go clean -cache -modcache

# Go VS Code extension into the built-in extensions dir (baked at build).
RUN openvscode-server --install-extension golang.go --extensions-dir /opt/openvscode-server/extensions \
    && chmod -R a+rX /opt/openvscode-server/extensions

# Go dirs aren't on the base PATH — overwrite the PATH drop-ins so login shells and
# the ssh-exec channel both find `go` (the base only covers user-CLI + system dirs).
RUN printf '%s\n' \
      'export GOPATH="/home/workspace/go"' \
      'export PATH="/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/usr/local/go/bin:/home/workspace/go/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh
RUN printf '%s\n' \
      'SetEnv PATH=/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/usr/local/go/bin:/home/workspace/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf
