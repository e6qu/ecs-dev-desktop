<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# infra/images

Curated **golden base images** for workspaces: OS, toolchain, OpenVSCode Server,
`sshd`, and idle-agent. They are published to ECR and surfaced in the admin
catalog. Extensions are sourced from **Open VSX** (not the MS marketplace).

The workspace Dockerfile currently builds a Node 20 image with OpenVSCode Server,
the idle-agent entrypoint, and a non-root workspace user. Image publication to the
Terraform-created ECR repositories and real deploy scanning remain AWS-gated.
