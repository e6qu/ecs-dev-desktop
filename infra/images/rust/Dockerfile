# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace RUST variant: the shared base + a system-wide rustup/cargo
# (+ build-essential for the C linker rustc needs). Slim alternative to omnibus.
#
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace-rust infra/images/rust
ARG BASE=edd-base:latest
FROM ${BASE}

ENV RUSTUP_HOME="/opt/rust/rustup" \
    CARGO_HOME="/opt/rust/cargo"
ENV PATH="/opt/rust/cargo/bin:${PATH}"

# C toolchain — rustc/cargo need a linker (cc) to produce binaries.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Rust — system-wide rustup/cargo (world-writable caches so `workspace` builds) +
# the clippy (linter) and rustfmt (formatter) components.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
    && /opt/rust/cargo/bin/rustup component add clippy rustfmt \
    && chmod -R a+rwX /opt/rust \
    && /opt/rust/cargo/bin/cargo --version \
    && /opt/rust/cargo/bin/cargo clippy --version && /opt/rust/cargo/bin/cargo fmt --version

# Rust VS Code language support into the built-in extensions dir (baked at build).
RUN openvscode-server --install-extension rust-lang.rust-analyzer --extensions-dir /opt/openvscode-server/extensions \
    && chmod -R a+rX /opt/openvscode-server/extensions

# /opt/rust/cargo/bin isn't on the base PATH — overwrite the PATH drop-ins so login
# shells and the ssh-exec channel both find `cargo` (+ export RUSTUP_HOME/CARGO_HOME).
RUN printf '%s\n' \
      'export RUSTUP_HOME="/opt/rust/rustup"' \
      'export CARGO_HOME="/opt/rust/cargo"' \
      'export PATH="/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/opt/rust/cargo/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh
RUN printf '%s\n' \
      'SetEnv PATH=/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf
