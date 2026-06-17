<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ssh-gateway

SSH access to workspaces uses standard **OpenSSH** (`sshd`). The connecting human
authenticates by their **registered SSH key** (dual-trust): the gateway proxy and the
workspace `sshd` each run an `AuthorizedKeysCommand` that asks the control plane
(`POST /api/workspaces/:id/ssh-authorize`) whether the presented key is registered to
the workspace's owner — authenticated by the gateway token on the public hop and the
per-workspace agent token on the inner hop, so each is per-connection and revocable.
The session is a transparent `nc` tunnel, so it stays end-to-end to the workspace
`sshd` (shells, `scp`, port-forwarding, VS Code Remote-SSH all work). The control
plane's **SSH CA** cert path is retained on the golden image alongside this, for
compatibility while clients migrate.

This package owns only the pure, testable derived config — e.g. the OS principal
a user maps to on a workspace node (`workspacePrincipal`).

## e2e (`src/ssh-proxy.e2e.ts`)

Self-contained (no compose): an in-process stub control plane runs in a **worker
thread** (so it keeps serving while the test blocks on synchronous `ssh`/`docker`),
and the test `docker run`s its own workspace node (`Dockerfile.node`) + gateway proxy
(`Dockerfile.proxy`) on a fresh network. It asserts:

- a **registered key** is authorized at both hops and lands on the workspace node
  (`whoami` = `workspace`);
- an **unregistered key** is denied at the gateway.

Wiring:

- ✅ Dual-trust registered-key auth at both hops (gateway + workspace node).
- ✅ Wake-on-connect proxy path — `WorkspaceService.connect()` at
  `POST /workspaces/:id/connect`; `GET /workspaces/:id/connect-info`; gateway calls
  both before forwarding.
- ✅ Production workspace image integration — the golden image runs `sshd` with the
  same `AuthorizedKeysCommand`, covered through the AWS container-mode simulator via
  the managed-EBS `EcsComputeProvider` path.
- ⬜ Public SSH ingress (NLB + Route53 `*.ssh`) — AWS-gated (Slice 3).
- ⬜ Session recording (deploy-tier; CloudTrail events for audit).
