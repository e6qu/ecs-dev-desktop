# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace image: Node 20 + OpenVSCode Server v1.109.5 + idle-agent.
# Extensions are sourced from Open VSX (not the MS marketplace).
#
# Runtime env vars expected by the container:
#   EDD_WORKSPACE_ID    — workspace id (ws-…), passed by EcsComputeProvider
#   EDD_CONTROL_PLANE_URL — control-plane base URL, e.g. https://app.example.com
#   EDD_AGENT_TOKEN     — HMAC token for the heartbeat machine-auth path
#   EDD_HEARTBEAT_INTERVAL_S — optional, default 120
#   CONNECTION_TOKEN    — openvscode-server connection token (injected by ECS secrets)
FROM node:20-bookworm-slim

ARG OPENVSCODE_VERSION=1.109.5
ARG OPENVSCODE_TARBALL=openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz

# System packages: curl (download), tini (init), ca-certificates, git (SCM in workspace).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Download and install OpenVSCode Server.
RUN curl -fsSL \
      "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/${OPENVSCODE_TARBALL}" \
      -o /tmp/openvscode-server.tar.gz \
    && tar -xzf /tmp/openvscode-server.tar.gz -C /opt \
    && mv "/opt/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64" /opt/openvscode-server \
    && rm /tmp/openvscode-server.tar.gz \
    && ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server

# Workspace user — non-root, home is the persistent EBS mount point.
RUN useradd -m -s /bin/bash -d /home/workspace workspace
WORKDIR /home/workspace

# Copy idle-agent and entrypoint.
COPY --chmod=0755 idle-agent.sh /usr/local/bin/edd-idle-agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/edd-entrypoint

EXPOSE 3000

# tini as PID 1 — reaps zombie processes from background idle-agent.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/edd-entrypoint"]
