# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace BASE image: the common runtime shared by every workspace
# variant — OpenVSCode Server, OpenSSH sshd + our SSH CA trust, the idle-agent,
# the git-credential broker, a non-root `workspace` user, and Node 22. It carries
# NO language toolchains beyond Node and NO compilers (build-essential); the
# `omnibus` and per-language variants (typescript/python/go/java/rust) extend this
# with `FROM` and add their own tools. Extensions are sourced from Open VSX.
#
# Runtime env vars expected by the container (consumed by the shared entrypoint):
#   EDD_WORKSPACE_ID, EDD_CONTROL_PLANE_URL, EDD_AGENT_TOKEN, EDD_SSH_CA_PUBLIC_KEY
#   EDD_HEARTBEAT_INTERVAL_S (optional), CONNECTION_TOKEN (injected by ECS secrets)
FROM node:22-bookworm-slim

ARG OPENVSCODE_VERSION=1.109.5

# System packages: curl (download), tini (init), ca-certificates, git (SCM +
# credential broker), gosu (drop to the workspace user), openssh-server (SSH).
# Deliberately NO build-essential — compilers live in the variants that need them.
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

# User-installable CLIs without root: the system npm prefix is /usr/local (root-
# owned), so `npm install -g` would EACCES for the non-root `workspace` user. Point
# npm's global prefix at a HOME dir (persists on the EBS home volume) and put it —
# plus a conventional ~/.local/bin — on PATH. Variants that run their OWN system
# `npm install -g` at build time must override the prefix back to /usr/local for
# that step (e.g. `npm_config_prefix=/usr/local npm install -g …`), since this ENV
# is inherited. NB: /home/workspace is the EBS mount, so these dirs are created at
# first install, not baked. PATH coverage across the shell matrix is completed by
# the /etc/profile.d and sshd drop-ins below (overridable by variants).
ENV NPM_CONFIG_PREFIX="/home/workspace/.npm-global"
ENV PATH="/home/workspace/.npm-global/bin:/home/workspace/.local/bin:${PATH}"

# PATH for LOGIN/interactive shells (the OpenVSCode terminal + interactive SSH
# source /etc/profile, which resets PATH). Variants OVERWRITE this drop-in with a
# fuller version that also exports their toolchain dirs.
RUN printf '%s\n' \
      'export PATH="/home/workspace/.npm-global/bin:/home/workspace/.local/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh

# Workspace user — non-root, home is the persistent EBS mount point.
RUN useradd -m -s /bin/bash -d /home/workspace workspace \
    && usermod -p '*' workspace \
    && mkdir -p /etc/ssh/principals /run/sshd /etc/ssh/sshd_config.d

COPY sshd_config /etc/ssh/sshd_config

# PATH for the `ssh <host> '<cmd>'` exec channel (non-login, non-interactive — it
# sources no profile). A drop-in (sshd_config Includes /etc/ssh/sshd_config.d/*)
# so variants OVERWRITE it with their toolchain-inclusive PATH. Home is fixed at
# /home/workspace, so a literal path is correct.
RUN printf '%s\n' \
      'SetEnv PATH=/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf

# Idle-agent + entrypoint (live in /usr/local/bin).
COPY --chmod=0755 idle-agent.sh /usr/local/bin/edd-idle-agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/edd-entrypoint

# Git credential helper: clone/push private repos using the session owner's token
# fetched from the control plane at use time (nothing stored on the EBS volume).
COPY --chmod=0755 git-credential-helper.sh /usr/local/bin/edd-git-credential
RUN git config --system credential.helper /usr/local/bin/edd-git-credential

WORKDIR /home/workspace

EXPOSE 22 3000

# tini as PID 1 — reaps zombie processes from sshd/openvscode/idle-agent.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/edd-entrypoint"]
