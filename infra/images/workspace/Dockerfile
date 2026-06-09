# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace image: Node 20 + OpenVSCode Server v1.109.5 + idle-agent.
# Extensions are sourced from Open VSX (not the MS marketplace).
#
# Runtime env vars expected by the container:
#   EDD_WORKSPACE_ID    — workspace id (ws-…), passed by EcsComputeProvider
#   EDD_CONTROL_PLANE_URL — control-plane base URL, e.g. https://app.example.com
#   EDD_AGENT_TOKEN     — HMAC token for the heartbeat machine-auth path
#   EDD_SSH_CA_PUBLIC_KEY — OpenSSH CA public key trusted for workspace SSH certs
#   EDD_HEARTBEAT_INTERVAL_S — optional, default 120
#   CONNECTION_TOKEN    — openvscode-server connection token (injected by ECS secrets)
FROM node:20-bookworm-slim

ARG OPENVSCODE_VERSION=1.109.5

# System packages: curl (download), tini (init), ca-certificates, git (SCM in workspace).
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# Workspace user — non-root, home is the persistent EBS mount point.
RUN useradd -m -s /bin/bash -d /home/workspace workspace \
    && usermod -p '*' workspace \
    && mkdir -p /etc/ssh/principals /run/sshd

COPY sshd_config /etc/ssh/sshd_config

# Copy idle-agent and entrypoint before switching user (they live in /usr/local/bin).
COPY --chmod=0755 idle-agent.sh /usr/local/bin/edd-idle-agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/edd-entrypoint

WORKDIR /home/workspace

EXPOSE 22 3000

# tini as PID 1 — reaps zombie processes from sshd/openvscode/idle-agent.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/edd-entrypoint"]
