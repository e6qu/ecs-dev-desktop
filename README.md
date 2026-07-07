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
- [`docs/architecture.md`](./docs/architecture.md) — the block diagram, component
  roles, the deployment sequence, and the browser/SSH connection sequences.
- [`docs/install.md`](./docs/install.md) — **install to AWS**: a linear,
  parameter-driven, paste-able runbook (install → verify → cleanup), fail-fast.
- [`docs/running-locally.md`](./docs/running-locally.md) — run/develop/test the app
  locally: `pnpm dev` and the tiered options (fakes → bleephub → sockerless AWS).
- [`docs/runbook.md`](./docs/runbook.md) — operations runbook: incident response
  (alarms → diagnosis → remediation), the ops dashboard, and where to look.
- [`docs/deploying.md`](./docs/deploying.md) — the AWS deployment runbook
  (Terraform → images → env/secrets → SSH access → DNS/TLS → seed) — see
  [Deploying](#deploying).
- [`PLAN.md`](./PLAN.md) — phased roadmap with per-phase deliverables + testing.
- [`TESTING.md`](./TESTING.md) — unit, integration, e2e, HTTPS, Terraform, and
  real-AWS test tiers.
- [`docs/observability-gaps.md`](./docs/observability-gaps.md) — logs/health/status/
  metrics + testing gaps and the pre-launch priority list.
- [`docs/admin-ui-design.md`](./docs/admin-ui-design.md) — the admin console design
  (overview, health, logs, costs, quotas).
- [`infra/terraform/README.md`](./infra/terraform/README.md) — the AWS Terraform
  module (inputs, outputs, prerequisites, deploy flow) — see [Deploying](#deploying).
- **Component docs:**
  [`infra/images/README.md`](./infra/images/README.md) (golden workspace image) ·
  [`services/ssh-gateway/README.md`](./services/ssh-gateway/README.md) (OpenSSH, registered-key auth).
- [`docs/simulator-live-coverage.md`](./docs/simulator-live-coverage.md) — live
  coverage and next test candidates against the sockerless AWS/Azure simulators.
- **Continuity files** (kept in sync every task, past tense at PR close):
  [`STATUS.md`](./STATUS.md) ·
  [`WHAT_WE_DID.md`](./WHAT_WE_DID.md) ·
  [`BUGS.md`](./BUGS.md) ·
  [`DO_NEXT.md`](./DO_NEXT.md)

## Architecture at a glance

| Dimension   | Decision                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Compute     | AWS ECS Fargate (200+ workspaces)                                                                              |
| Persistence | EBS snapshot as the unit of state (stateful + snapshot + scale-to-zero)                                        |
| Auth        | GitHub OAuth + Azure Entra ID, groups → roles                                                                  |
| RBAC        | CASL (shared by API and UI)                                                                                    |
| SSH         | OpenSSH (`sshd`); registered-key auth via the control plane (dual-trust ssh-authorize)                         |
| Web + API   | Next.js, API-first (UI consumes the same API); custom server also proxies the editor at `app.<domain>/w/<id>/` |
| State store | DynamoDB single-table + ElectroDB                                                                              |
| Simulators  | sockerless AWS + Azure/Entra + bleephub, built from source                                                     |
| IaC         | Terraform · Monorepo: Turborepo + pnpm                                                                         |

## Running the app

The same code runs across a spectrum — it reaches AWS/IdPs only through
**coordinates** (endpoints + credentials), so you move from fakes to real cloud by
changing coordinates alone (`AGENTS.md` §6.8/§6.9):

| How                   | What's real                                                  | Where                                                                |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Local — fakes**     | nothing (in-process fakes + DynamoDB Local + dev-auth)       | `pnpm dev`, below                                                    |
| **Local — sims**      | GitHub/Entra OIDC, EBS/ECS, via the sockerless/bleephub sims | [`docs/running-locally.md`](./docs/running-locally.md) (tier matrix) |
| **Cloud — Terraform** | real AWS (Fargate/EBS/DynamoDB/ALB) + real IdPs              | [`docs/deploying.md`](./docs/deploying.md) + [Deploying](#deploying) |

### Local quickstart

```sh
git submodule update --init --recursive   # the sims build from third_party/sockerless
pnpm install
pnpm dev                                   # app on http://edd.localhost:3700 (fakes + DynamoDB Local + dev-auth)
```

`pnpm dev` reaps any prior local harness state, starts DynamoDB Local, seeds the
table, and runs the dev server. Open **http://edd.localhost:3700** and sign in on the
`/login` form with a seeded dev account (`admin`/`member`/`viewer`, password `dev`) —
the `edd.localhost` subdomain keeps the dev-auth cookies off plain `localhost`. Add
real surfaces by coordinates — e.g.
`EDD_DEV_PROFILES=aws COMPUTE_PROVIDER=ecs AWS_ENDPOINT_URL=http://127.0.0.1:4566 … pnpm dev`
for the real EBS/ECS adapters against the sockerless AWS sim. Full tier matrix,
seeded-user config, and the self-reaping local test commands
(`pnpm test:integ:local`, `pnpm test:e2e:local`, `pnpm reap`) are in
[`docs/running-locally.md`](./docs/running-locally.md).

## Deploying

Nothing is provisioned on AWS yet — the Terraform module is built and
**simulator-apply-proven** every PR, with real `apply` gated on an AWS account +
domain (see [`DO_NEXT.md`](./DO_NEXT.md) open decisions).

- **Install to AWS (linear runbook):** **[`docs/install.md`](./docs/install.md)** —
  set parameters once, then one pasteable command (`scripts/install.sh`) that runs
  the whole flow fail-fast; a separate verify step; and a full cleanup
  (`scripts/uninstall.sh`) that reclaims even a partial/failed install.
- **Conceptual picture:** [`docs/architecture.md`](./docs/architecture.md) — block
  diagram, deploy sequence, browser/SSH connection sequences.
- **Step-by-step runbook:** [`docs/deploying.md`](./docs/deploying.md) — every
  module input, every secret, DNS/TLS, the editor proxy, explained in order.

In short, the install flow is:

1. **Decide** the external facts: an AWS account + region, a domain (Route53 zone)
   for `app.<domain>`, and optionally a separate zone for `*.<ssh-base-domain>`,
   plus the IdP app registrations (GitHub and/or Entra).
2. **Bootstrap** the remote-state backend (`scripts/bootstrap-state.sh` → S3 +
   DynamoDB lock) and the secrets (`scripts/bootstrap-secrets.sh` → crypto +
   IdP creds in Secrets Manager).
3. **Provision infra** with the Terraform module
   ([module README](./infra/terraform/modules/ecs-dev-desktop/README.md); examples in
   `infra/terraform/examples/{complete,terragrunt}`) — VPC, DynamoDB, ECR, KMS, IAM,
   ECS control-plane service, ALB + ACM/Route 53, reconciler schedule, CloudWatch
   logs/alarms/dashboard, and (optionally) the SSH NLB.
4. **Publish images** (`scripts/publish-images.sh`) to the ECR repos the apply
   created: the **control-plane app image** (`apps/web` — the control-plane
   service _and_ the reconciler run it, via a command override), a **golden
   workspace image** (the [`infra/images`](infra/images/README.md) collection),
   and the **SSH-gateway image** (a pinned tag — the repo is immutable). For
   ongoing releases, the `release` workflow uses GitHub OIDC to build, publish,
   register new ECS task definitions, roll the control-plane and SSH-gateway
   services, and update the reconciler schedule. EDD-owned post-merge rebuilds
   cover only workspace/golden images. Images are published as multi-arch
   manifests (`:<tag>`) plus per-arch tags (`:<tag>-amd64` and `:<tag>-arm64`) so
   runners that cannot consume manifests can pin an exact arch.
5. **Configure secrets** the module does not inject — Auth.js (`AUTH_SECRET`,
   `AUTH_URL`/`AUTH_TRUST_HOST`) + IdP creds, RBAC groups (`EDD_ADMIN_GROUPS` — set
   this or no one is an admin), and crypto (`EDD_TOKEN_ENC_KEY`, `EDD_GATEWAY_SECRET`,
   `EDD_AGENT_SECRET`, `EDD_CONNECTION_SECRET`). SSH needs no extra secret — it is registered-key only, and
   the gateway/workspace authorize keys via `EDD_GATEWAY_SECRET`/`EDD_AGENT_SECRET`.
   The infra coordinates (`COMPUTE_PROVIDER`, `AUDIT_PROVIDER`, `LOG_PROVIDER`,
   cluster/subnets/roles, …) are injected by the module. Same code, real cloud by
   coordinates alone (`AGENTS.md` §6.8/§6.9).
6. **Wire DNS/TLS** (`app.<domain>` ACM cert + Route 53; no wildcard — the editor
   is path-based at `app.<domain>/w/<id>/`, proxied in-process by the control-plane
   app and authorized off the Auth.js session), then **seed the base-image catalog**
   so workspaces can launch.

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
