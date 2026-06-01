<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ssh-gateway (Teleport)

SSH access to workspaces is provided by **Teleport** (auth, audit, session
recording, VS Code Remote-SSH), per `AGENTS.md` §1. Teleport is deployed
declaratively via `infra/terraform`; this package owns only the small amount of
derived, pure config (e.g. principal mapping) so it stays unit-testable.

Wiring (Phase 4):

- Teleport cluster + workspace node enrolment.
- Identity federation from Entra / GitHub.
- Wake-on-connect: SSH to a scaled-to-zero workspace triggers a wake.
