<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ssh-gateway (Teleport)

SSH access to workspaces is provided by **Teleport** (auth, audit, session
recording, VS Code Remote-SSH), per `AGENTS.md` §1. Teleport is deployed
declaratively via `infra/terraform`; this package owns only the small amount of
derived, pure config (e.g. principal mapping) so it stays unit-testable.

## e2e (`docker-compose.ssh.yml`)

A real Teleport cluster (auth+proxy) plus a workspace SSH node run in Docker
(`teleport/auth.yaml`, `teleport/node.yaml`, `Dockerfile.node`). The e2e
(`src/ssh-connect.e2e.ts`) provisions a Teleport user + role via `tctl`, signs a
short-lived identity file, then connects with `tsh` and asserts the session lands on
the node as the `workspacePrincipal`. A login the role doesn't grant is denied.
Teleport is the **real product**, deployed declaratively as in production.

Wiring (Phase 4):

- ✅ Teleport cluster + workspace node enrolment + connect-as-principal + authz deny.
- 🟡 Wake-on-connect: the control-plane half is done — `WorkspaceService.connect()`
  (idempotent; wakes a scaled-to-zero workspace from its snapshot) at
  `POST /workspaces/:id/connect`. The gateway calls it before forwarding; the
  golden image auto-enrols its Teleport agent on task start (deployment/AWS-tier).
- ⬜ Identity federation from Entra / GitHub (the auth layer is proven separately).
- ⬜ Session recording.
