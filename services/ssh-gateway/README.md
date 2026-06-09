<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ssh-gateway

SSH access to workspaces uses standard **OpenSSH** (`sshd`) with certificate-based
auth. The control plane owns the SSH CA; it issues short-lived user certificates after
authenticating the user via Auth.js (GitHub / Entra). `sshd` trusts the CA public key
(`TrustedUserCAKeys`) and enforces RBAC via `AuthorizedPrincipalsFile` — one file per
OS user listing the certificate principals the CA may assert for that user.

This package owns only the pure, testable derived config — e.g. the OS principal
a user maps to on a workspace node (`workspacePrincipal`).

## e2e (`docker-compose.ssh.yml`)

A single `workspace-node` container runs `sshd`. Before bringing up the compose
stack, run `scripts/gen-ssh-ca.sh` to generate an ephemeral CA into
`services/ssh-gateway/temp/ssh-ca/` by default (gitignored); its public key is
mounted into the container as `TrustedUserCAKeys`.

The e2e (`src/ssh-connect.e2e.ts`) signs a short-lived user certificate in `beforeAll`
and connects with standard `ssh`, asserting:

- Session lands as the principal `workspacePrincipal` derives.
- A login not listed in the node's `AuthorizedPrincipalsFile` is denied.

The proxy e2e (`src/ssh-proxy.e2e.ts`) builds/runs `Dockerfile.proxy`, joins it to
the same Docker network as the workspace node, and uses a stub control plane. It
asserts:

- the proxy container can reach the workspace node over Docker DNS;
- `wake-and-forward.sh` calls `connect` and `connect-info`;
- the outer SSH client can traverse proxy → workspace node and land as the
  expected principal.

Wiring:

- ✅ workspace node + connect-as-principal + authz deny (certificate RBAC).
- ✅ Wake-on-connect proxy component path — `WorkspaceService.connect()` at
  `POST /workspaces/:id/connect`; `GET /workspaces/:id/connect-info`; gateway calls
  both before forwarding.
- ✅ Production workspace image integration — the golden image runs `sshd`,
  installs CA/principal wiring, and is covered through the AWS container-mode
  simulator via the managed-EBS `EcsComputeProvider` path.
- ⬜ Session recording (deploy-tier; CloudTrail events for audit).
