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
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(command -v python3)" /usr/local/bin/python

# Python project manager: uv (+ uvx) into /usr/local/bin (on the base PATH).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version
