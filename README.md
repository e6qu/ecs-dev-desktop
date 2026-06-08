# ecs-dev-desktop

Self-hosted cloud dev-environment platform: per-user **VS Code** workspaces on
**AWS ECS Fargate**, with SSH access, stateful + snapshottable storage, a login
UI, and an admin control plane. Think self-hosted Coder / GitHub Codespaces.

> **Status:** active implementation. Core control-plane, auth, admin UI,
> Terraform simulator apply, and container-mode workspace/reconciler e2e are
> sim-proven; real AWS account/domain work remains gated. See
> [`STATUS.md`](./STATUS.md).

## Documentation

- [`AGENTS.md`](./AGENTS.md) — architecture decisions, component map, and the
  rules of engagement for contributors/agents. (`CLAUDE.md` is a symlink to it.)
- [`PLAN.md`](./PLAN.md) — phased roadmap with per-phase deliverables + testing.
- [`TESTING.md`](./TESTING.md) — unit, integration, e2e, HTTPS, Terraform, and
  real-AWS test tiers.
- [`docs/simulator-live-coverage.md`](./docs/simulator-live-coverage.md) — live
  coverage and next test candidates against the sockerless AWS/Azure simulators.
- **Continuity files** (kept in sync every task, past tense at PR close):
  [`STATUS.md`](./STATUS.md) ·
  [`WHAT_WE_DID.md`](./WHAT_WE_DID.md) ·
  [`BUGS.md`](./BUGS.md) ·
  [`DO_NEXT.md`](./DO_NEXT.md)

## Architecture at a glance

| Dimension   | Decision                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| Compute     | AWS ECS Fargate (200+ workspaces)                                                   |
| Persistence | EBS snapshot as the unit of state (stateful + snapshot + scale-to-zero)             |
| Auth        | GitHub OAuth + Azure Entra ID, groups → roles                                       |
| RBAC        | CASL (shared by API and UI)                                                         |
| SSH         | OpenSSH (`sshd`) + our SSH CA (certificate auth, RBAC via AuthorizedPrincipalsFile) |
| Web + API   | Next.js, API-first (UI consumes the same API)                                       |
| State store | DynamoDB single-table + ElectroDB                                                   |
| Simulators  | sockerless AWS + Azure/Entra + bleephub, built from source                          |
| IaC         | Terraform · Monorepo: Turborepo + pnpm                                              |

## Contributing

`main` is protected: all changes past the initial commit go through a pull
request. See [`AGENTS.md`](./AGENTS.md) for the workflow and continuity-file
rules.

## License

Licensed under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`). See [`LICENSE`](./LICENSE). New source files should carry:

```
SPDX-License-Identifier: AGPL-3.0-or-later
```
