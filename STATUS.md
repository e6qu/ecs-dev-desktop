# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-04

## Current phase

The whole **locally-testable platform is proven end-to-end with no mocks** against the
from-source sockerless sim + real Teleport/Pomerium: stateful snapshottable workspaces,
control plane + RBAC, both IdP logins, SSH, identity-aware routing, scale-to-zero, and
the portal (browser e2e). **Gated on the AWS account/region decision** (`DO_NEXT` #1)
for real deploy. Next build target: **Phase 8 — admin console & observability**
(design in `docs/admin-ui-design.md`); start with 8A (health + Inspect).

## What works (built, tested, merged)

- **Monorepo** (`@edd/*`, Turborepo+pnpm); `main` protected.
- **Core** (`@edd/core`): branded domain types, lifecycle state machine, pure functions
  (provision/stop/start/snapshot/`markActivity`/`planConnect`, base-image catalog),
  Storage/Compute ports + fakes.
- **Control plane** (`apps/web` + `@edd/control-plane`): `WorkspaceService` lifecycle
  (create/stop/start/connect/heartbeat/snapshot/remove) + `CatalogService`, over
  ElectroDB, CASL-gated API + `@edd/api-client`. Fargate managed-EBS model.
- **Auth** (`@edd/auth`): GitHub + Entra → group→role, both proven mock-free & swappable.
- **Portal** (`apps/web`): RBAC workspaces grid + lifecycle, base-image catalog admin
  page + create-from-catalog picker. "Infra control room" aesthetic.
- **Reconciler**: idle scale-to-zero, scheduled snapshots, orphan GC (pure selectors).
- **Real adapters** (endpoint-only): `@edd/storage-ec2`, `@edd/compute-ecs`.
- **SSH** (`services/ssh-gateway`) + **Pomerium routing** (`infra/proxy`): real products
  in Docker, mock-free.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim) · e2e
  (`.e2e.yml`/`.ssh.yml`: data-fidelity, lifecycle, GitHub+Entra auth, Pomerium, Teleport)
  · **portal e2e** (Playwright) · manual `e2e-aws`. All green in CI.

## Deployed

- Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

- **AWS account/region** (`DO_NEXT` #1) — top blocker; unlocks real Terraform, golden
  image, deploy, reconciler cron, `e2e-aws`, and Phase 8C cloud observability.
- **Domain/DNS** (#2) — blocks real proxy routing + ACM.
- **Phase 8A done** + **8B Overview done:** admin `/admin` shell (Overview landing,
  Health board, all-workspaces table, per-workspace Inspect) — all Playwright-covered.
  **Next (8B):** quotas, then the Logs/Audit screen.
