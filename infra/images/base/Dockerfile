# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace BASE image: the common runtime shared by every workspace
# variant — OpenVSCode Server, OpenSSH sshd + our SSH CA trust, the idle-agent,
# the git-credential broker, a non-root `workspace` user, and Node 22. It carries
# NO language toolchains beyond Node and NO compilers (build-essential); the
# `omnibus` and per-language variants (typescript/python/go/java/rust) extend this
# with `FROM` and add their own tools. Extensions are sourced from Open VSX.
#
# Runtime env vars expected by the container (consumed by the shared entrypoint):
#   EDD_WORKSPACE_ID, EDD_CONTROL_PLANE_URL, EDD_AGENT_TOKEN
#   EDD_HEARTBEAT_INTERVAL_S (optional), CONNECTION_TOKEN (injected by ECS secrets)
# Multi-stage builder for the first-party Monaco editor's only native dependency
# (node-pty). It is compiled for the target architecture inside the image, so a
# host of either architecture can produce correct amd64 and arm64 golden images.
FROM node:22-bookworm-slim AS node-pty-builder
WORKDIR /opt/edd-editor-monaco
COPY editor-monaco/package.json ./
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && npm install --production \
    && rm -rf /var/lib/apt/lists/* /root/.npm

FROM node:22-bookworm-slim

ARG OPENVSCODE_VERSION=1.109.5

RUN printf '%s\n' \
      '# Debian slim excludes man pages by default, but packages such as xz-utils' \
      '# register update-alternatives slave links to their man1 pages during install.' \
      '# Keep man1 pages so package installation does not emit missing-target warnings.' \
      'path-include=/usr/share/man/man1/*' \
      > /etc/dpkg/dpkg.cfg.d/zz-edd-keep-man1-for-alternatives

# System packages: curl (download), tini (init), ca-certificates, git (SCM +
# credential broker), gosu (drop to the workspace user), openssh-server (SSH),
# and bubblewrap (Codex's Linux sandbox prerequisite).
# Deliberately NO build-essential — compilers live in the variants that need them.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bubblewrap \
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

# OpenVSCode keeps window settings in browser storage and exposes no CLI flag for
# browser configuration defaults. Inject the workbench's supported
# `configurationDefaults` bootstrap option. The patch is exact and version-pinned:
# an upstream bundle change fails the image build loudly instead of silently
# reverting to the compact hamburger menu.
COPY patch-openvscode.mjs /tmp/patch-openvscode.mjs
RUN node /tmp/patch-openvscode.mjs && rm /tmp/patch-openvscode.mjs

# Default VS Code extensions (from Open VSX — OpenVSCode Server's default gallery):
# the cross-cutting dev extensions (formatter/linter/GitHub) + the AI coding agent
# companions (Claude Code, Codex/ChatGPT) — every variant gets both agent CLIs and
# their VS Code panels, not just omnibus. Installed into OpenVSCode's BUILT-IN
# extensions dir (/opt/openvscode-server/extensions) — NOT the user extensions dir
# (/data/extensions), which is on the EBS volume and shadowed at runtime.
# Built-in extensions load read-only with no runtime copy (a first-boot copy would
# slow every workspace start); the user still installs their own into the volume's
# extensions dir. Variants add their own language extensions to the same built-in dir.
RUN for ext in \
      esbenp.prettier-vscode \
      dbaeumer.vscode-eslint \
      github.vscode-pull-request-github \
      github.vscode-github-actions \
      anthropic.claude-code \
      openai.chatgpt ; do \
      openvscode-server --install-extension "$ext" --extensions-dir /opt/openvscode-server/extensions ; \
    done \
    && chmod -R a+rX /opt/openvscode-server/extensions

# First-party EDD workspace extension (plain CommonJS): the "EDD home" portal link (from
# EDD_CONTROL_PLANE_URL at runtime -- never a hardcoded URL), a visible "Open terminal (Ctrl+`)"
# control, terminal-open on startup, and the once-per-workspace CLI remote-OAuth tip. Packaged to a
# .vsix and installed like the marketplace extensions above so it registers as a real BUILT-IN
# (read-only, loads with NO runtime copy). A plain folder dropped into the extensions dir does NOT
# load -- the release archive's built-in registry is generated upstream -- which is why the old
# approach needed a first-boot copy into the user dir; `--install-extension` updates the registry.
COPY edd-ui-extension /tmp/edd-ui-extension
RUN cd /tmp/edd-ui-extension \
    && npx -y @vscode/vsce@3.9.2 package --no-dependencies --allow-missing-repository \
         -o /tmp/edd-workspace-ui.vsix \
    && openvscode-server --install-extension /tmp/edd-workspace-ui.vsix \
         --extensions-dir /opt/openvscode-server/extensions \
    && chmod -R a+rX /opt/openvscode-server/extensions \
    && rm -rf /tmp/edd-ui-extension /tmp/edd-workspace-ui.vsix /root/.npm

# Cross-cutting CLIs (installed system-wide to /usr/local BEFORE the home npm prefix
# is set below, so they land in /usr/local — on PATH for every shell): the JS/TS
# lint/format/dead-code/CPD tools that match this repo's own CI (prettier, eslint,
# knip, jscpd), and the AI coding agent CLIs (Claude Code, Codex, opencode) — every variant
# carries both, not just omnibus.
RUN npm install -g prettier eslint knip jscpd @anthropic-ai/claude-code @openai/codex opencode-ai@1.17.15 \
    && prettier --version && eslint --version \
    && knip --version && jscpd --version \
    && command -v claude && command -v codex && command -v opencode && opencode --version

# Cross-cutting security scanner: Trivy (vuln/secret/misconfig/IaC), the same tool
# this repo's CI security gate uses (`.trivyignore.yaml`) — so a workspace can scan
# its own deps/IaC/secrets exactly as CI does, for ANY language. Single static
# binary into /usr/local/bin (on PATH for every shell); its vuln DB is fetched lazily
# at first scan, not baked. Language-agnostic, so it lives in base (every variant
# inherits it); per-language SCA (e.g. cargo-audit) is added by the variants.
RUN curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
      | sh -s -- -b /usr/local/bin \
    && trivy --version

# User-installable CLIs without root: the system npm prefix is /usr/local (root-
# owned), so `npm install -g` would EACCES for the non-root `workspace` user. Point
# npm's global prefix at a HOME dir (persists on the EBS home volume) and put it —
# plus a conventional ~/.local/bin — on PATH. Variants that run their OWN system
# `npm install -g` at build time must override the prefix back to /usr/local for
# that step (e.g. `npm_config_prefix=/usr/local npm install -g …`), since this ENV
# is inherited. NB: /data/home is on the EBS mount, so these dirs are created at
# first install, not baked. PATH coverage across the shell matrix is completed by
# the /etc/profile.d and sshd drop-ins below (overridable by variants).
ENV NPM_CONFIG_PREFIX="/data/home/.npm-global"
ENV PATH="/data/home/.npm-global/bin:/data/home/.local/bin:${PATH}"

# The persisted EBS volume mounts at /data (see @edd/config DEFAULT_WORKSPACE_MOUNT_PATH). HOME
# and the editor root are kept OUT of the user's project dir so editor/tool dotfiles never pollute
# the (empty-when-fresh) pwd: HOME = /data/home (dotfiles), the editor opens /data/project (pwd),
# and OpenVSCode extensions live in /data/extensions — all persisted, none inside the project.
ENV HOME="/data/home"
ENV EDD_WORKSPACE_ROOT="/data/project"

# PATH for LOGIN/interactive shells (the OpenVSCode terminal + interactive SSH
# source /etc/profile, which resets PATH). Variants OVERWRITE this drop-in with a
# fuller version that also exports their toolchain dirs.
RUN printf '%s\n' \
      'export PATH="/data/home/.npm-global/bin:/data/home/.local/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh

# Land interactive LOGIN shells (SSH) in the clean project dir, not HOME (which holds editor/tool
# dotfiles). The web editor terminal already opens the project via the editor's cwd; this keeps SSH
# consistent so `pwd` on login is the empty-when-fresh project, not the dotfile-filled HOME. Only
# affects interactive login shells; `ssh host '<cmd>'` (non-login) keeps its own cwd. Separate
# drop-in from edd-path.sh (which variants overwrite), so every variant inherits it.
RUN printf '%s\n' \
      'case $- in *i*) [ -d /data/project ] && cd /data/project 2>/dev/null || true ;; esac' \
      > /etc/profile.d/edd-cwd.sh \
    && chmod 0644 /etc/profile.d/edd-cwd.sh

# Workspace user — non-root, home is /data/home on the persistent EBS mount (NOT the project pwd).
RUN useradd -m -s /bin/bash -d /data/home workspace \
    && usermod -p '*' workspace \
    && mkdir -p /etc/ssh/principals /run/sshd /etc/ssh/sshd_config.d

COPY sshd_config /etc/ssh/sshd_config

# PATH for the `ssh <host> '<cmd>'` exec channel (non-login, non-interactive — it
# sources no profile). A drop-in (sshd_config Includes /etc/ssh/sshd_config.d/*)
# so variants OVERWRITE it with their toolchain-inclusive PATH. Home is fixed at
# /data/home, so a literal path is correct.
RUN printf '%s\n' \
      'SetEnv PATH=/data/home/.npm-global/bin:/data/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf

# First-party Monaco editor server: the esbuild-bundled server (server.js) + its built SPA (spa/)
# + the runtime node_modules (node-pty only). The editor server.js bundle is architecture-
# independent; node-pty is compiled for the target arch in the node-pty-builder stage above.
COPY editor-monaco /opt/edd-editor-monaco
COPY --from=node-pty-builder /opt/edd-editor-monaco/node_modules /opt/edd-editor-monaco/node_modules

# Idle-agent + entrypoint (live in /usr/local/bin).
COPY --chmod=0755 idle-agent.sh /usr/local/bin/edd-idle-agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/edd-entrypoint
# sshd AuthorizedKeysCommand (dual-trust): must be root-owned and not group/other-
# writable per sshd; COPY --chmod=0755 from the build context satisfies that.
COPY --chmod=0755 authorized-keys.sh /usr/local/bin/edd-authorized-keys

# Git credential helper: clone/push private repos using the session owner's token
# fetched from the control plane at use time (nothing stored on the EBS volume).
COPY --chmod=0755 git-credential-helper.sh /usr/local/bin/edd-git-credential
RUN git config --system credential.helper /usr/local/bin/edd-git-credential

# Privilege guard: stands in (on PATH, ahead of /usr/bin) for tools that need
# privileges this sandboxed workspace intentionally does not grant. Running one is
# blocked + warned + recorded (admin monitoring), instead of failing opaquely. The
# task is already non-root/unprivileged — this makes the WHY visible and auditable.
COPY --chmod=0755 edd-privilege-guard.sh /usr/local/bin/edd-privilege-guard
RUN for tool in docker docker-compose podman nerdctl sudo su mount umount \
      nsenter unshare setcap chroot modprobe insmod; do \
      ln -sf edd-privilege-guard "/usr/local/bin/${tool}"; \
    done

WORKDIR /data/project

EXPOSE 22 3000

# tini as PID 1 — reaps zombie processes from sshd/openvscode/idle-agent.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/edd-entrypoint"]
