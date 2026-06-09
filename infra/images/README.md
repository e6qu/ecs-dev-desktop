<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# infra/images

Curated **golden base images** for workspaces: OS, toolchain, OpenVSCode Server,
and the idle-agent. They are published to ECR and surfaced in the admin catalog.
Extensions are sourced from **Open VSX** (not the MS marketplace).

The workspace Dockerfile currently builds a Node 20 image with OpenVSCode Server,
OpenSSH `sshd`, the idle-agent entrypoint, and a non-root workspace user.
At startup it writes the injected workspace SSH CA public key and
`dev-<workspaceId>` principal file, starts `sshd`, then runs idle-agent and
OpenVSCode Server as `workspace`. Image publication to the Terraform-created ECR
repositories and real deploy scanning remain AWS-gated.

The golden-image SSH path is implemented, but full AWS simulator e2e coverage is
blocked upstream by sockerless #526/#527; the direct OpenSSH image behavior has
been diagnosed and tracked in `BUGS.md`.
