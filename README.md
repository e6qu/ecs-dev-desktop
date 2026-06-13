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
- [`docs/running-locally.md`](./docs/running-locally.md) — run/develop/test the app
  locally: `pnpm dev` and the tiered options (fakes → bleephub → sockerless AWS).
- [`PLAN.md`](./PLAN.md) — phased roadmap with per-phase deliverables + testing.
- [`TESTING.md`](./TESTING.md) — unit, integration, e2e, HTTPS, Terraform, and
  real-AWS test tiers.
- [`infra/terraform/README.md`](./infra/terraform/README.md) — the AWS Terraform
  module (inputs, outputs, prerequisites, deploy flow) — see [Deploying](#deploying).
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

## Running locally

```sh
git submodule update --init --recursive   # the sims build from third_party/sockerless
pnpm install
pnpm dev                                   # app on http://localhost:3000 (fakes + DynamoDB Local + dev-auth)
```

`pnpm dev` reaps any prior local harness state, starts DynamoDB Local, seeds the
table, and runs the dev server. Add real surfaces by coordinates — e.g.
`EDD_DEV_PROFILES=aws COMPUTE_PROVIDER=ecs AWS_ENDPOINT_URL=http://127.0.0.1:4566 pnpm dev`
for the real EBS/ECS adapters against the sockerless AWS sim. Full tier matrix,
dev-auth sign-in, and the self-reaping local test commands
(`pnpm test:integ:local`, `pnpm test:e2e:local`, `pnpm reap`) are in
[`docs/running-locally.md`](./docs/running-locally.md).

## Deploying

Nothing is provisioned on AWS yet — the Terraform module is built and
**simulator-apply-proven** every PR, with real `apply` gated on an AWS account +
domain (see [`DO_NEXT.md`](./DO_NEXT.md) open decisions). To deploy a real
environment:

1. **Provision infra** with the Terraform module —
   [`infra/terraform/README.md`](./infra/terraform/README.md) and
   [`infra/terraform/modules/ecs-dev-desktop/README.md`](./infra/terraform/modules/ecs-dev-desktop/README.md)
   (VPC, DynamoDB, ECR, KMS, IAM, ECS control-plane service, ALB + ACM/Route53,
   reconciler schedule, CloudWatch logs) — inputs, outputs, prerequisites, and the
   deploy flow are there. A runnable example is in `infra/terraform/examples/complete`.
2. **Publish images** to the created ECR (the golden workspace image
   `infra/images/workspace`, the reconciler, the SSH proxy).
3. **Configure the control plane** with the production coordinates/secrets:
   `COMPUTE_PROVIDER=ecs`, `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`,
   the ECS cluster/subnets/roles, `EDD_TOKEN_ENC_KEY`, `EDD_GATEWAY_SECRET`,
   `EDD_AGENT_SECRET`, and the Auth.js + IdP creds (GitHub OAuth/App + Entra). The
   same code path the local tiers exercise targets real cloud by these coordinates
   alone (`AGENTS.md` §6.8/§6.9).
4. **Wire DNS/TLS + the identity-aware proxy** (`*.devbox.<domain>` via Pomerium →
   the workspace gate → workspaces; ACM cert + Route 53).

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
