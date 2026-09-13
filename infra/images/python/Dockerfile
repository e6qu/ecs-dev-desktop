# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace PYTHON variant: the shared base + Python 3 (pip/venv), the `uv`
# project manager, and build-essential for native wheels. Slim alternative to omnibus.
#
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace-python infra/images/python
ARG BASE=edd-base:latest
FROM ${BASE}

# Python (+ pip/venv) and a C toolchain for native wheels. `python3`/`python` land
# in /usr/bin + /usr/local/bin (already on the base PATH) — no drop-in override needed.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(command -v python3)" /usr/local/bin/python

# Python project manager: uv (+ uvx) into /usr/local/bin (on the base PATH).
# PINNED: the versioned installer URL installs exactly this uv.
ARG UV_VERSION=0.12.13
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version

# Python dev tooling (lint/format, type-check, dead-code, SAST) as standalone CLIs.
# `uv tool install` defaults to ~/.local (the EBS mount, shadowed) — pin the tool +
# bin dirs to system paths so they survive and stay on the base PATH (/usr/local/bin).
# PINNED: each `uv tool install <name>` resolved the newest release at build time.
ARG RUFF_VERSION=0.16.7
ARG TY_VERSION=0.0.80
ARG VULTURE_VERSION=2.16
ARG BANDIT_VERSION=1.9.4
ARG SEMGREP_VERSION=1.177.0
RUN export UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
    && uv tool install "ruff==${RUFF_VERSION}" \
    && uv tool install "ty==${TY_VERSION}" \
    && uv tool install "vulture==${VULTURE_VERSION}" \
    && uv tool install "bandit==${BANDIT_VERSION}" \
    && uv tool install "semgrep==${SEMGREP_VERSION}" \
    && for t in ruff ty vulture bandit semgrep; do command -v "$t" || exit 1; done

# Python VS Code extensions into the built-in extensions dir (alongside the
# base/agent extensions).
RUN for ext in ms-python.debugpy@2026.6.0 ms-python.vscode-python-envs@1.20.1 ms-python.python@2026.4.0 detachhead.basedpyright@1.40.1 charliermarsh.ruff@2026.80.0 astral-sh.ty@2026.70.0 semgrep.semgrep@1.17.0; do \
      openvscode-server --install-extension "$ext" --extensions-dir /opt/openvscode-server/extensions || exit 1 ; \
    done \
    && chmod -R a+rX /opt/openvscode-server/extensions
