# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-06 (PR #52: golden workspace image — OpenVSCode Server v1.109.5 + idle-agent + machine-auth heartbeat + real adapter wiring)

## Current phase

The whole **locally-testable platform is proven end-to-end with no mocks** against the
from-source sockerless sim + real Teleport/Pomerium: stateful snapshottable workspaces,
control plane + RBAC, both IdP logins, SSH, identity-aware routing, scale-to-zero, the
portal, and the **admin console** (Overview, Health, Workspaces+Inspect, Quotas, and
Logs/Audit) — all browser-tested. **Phase 8A and 8B are complete**; what's left in
Phase 8 is **8C real cloud data** (CloudTrail/CloudWatch), which is **gated on the AWS
account/region decision** (`DO_NEXT` #1) alongside the entire real-deploy track.

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
- **Deploy IaC** (`infra/terraform/modules/ecs-dev-desktop`): a reusable, parametric
  Terraform/Terragrunt module for the whole platform (VPC + NAT [managed or **fck-nat**
  instance], KMS, DynamoDB single-table w/ GSIs, ECR, ECS cluster + Fargate service +
  capacity providers + autoscaling, ALB + optional ACM/Route53, scheduler reconciler cron,
  IAM, logs) with `examples/complete`, `examples/terragrunt`, and a full README. The
  **`terraform-sim` CI job applies + destroys the entire stack against the sockerless sim
  every PR** in **four active** configurations (default with ~175 assertions, fck-nat, DNS/TLS,
  all idempotency checks green). Module now also injects `COMPUTE_PROVIDER`, `CONTROL_PLANE_URL`,
  `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `ECS_EBS_ROLE_ARN` into the control-plane task env.
  Endpoint-only (§6.8). Real apply is AWS-gated.
- **Golden workspace image** (`infra/images/workspace/`): Node 20 + **OpenVSCode Server
  v1.109.5** (MIT, Gitpod), tini PID-1, port 3000, idle-agent (POST `/heartbeat` every
  120s). Machine-auth: `EcsComputeProvider.runTask` injects `EDD_AGENT_TOKEN` =
  HMAC-SHA256(secret, wsId); heartbeat route verifies it; 4 integ tests.
- **Real adapter wiring** (`apps/web/lib/control-plane.ts`): `COMPUTE_PROVIDER=ecs` selects
  `EcsComputeProvider.fromEnv()` + `Ec2StorageProvider.fromEnv()`; fakes remain default.
- **SSH** (`services/ssh-gateway`) + **Pomerium routing** (`infra/proxy`): real products
  in Docker, mock-free.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim) · e2e
  (`.e2e.yml`/`.ssh.yml`: data-fidelity, lifecycle, GitHub+Entra auth, Pomerium, Teleport)
  · **portal e2e** (Playwright) · **`e2e-https`** (the sims served over TLS — mock-free Entra
  auth + SSH with real CA trust, no `--insecure`) · manual `e2e-aws`. All green in CI.
- **Engineering quality** (a 2026-06-04 wave; see `WHAT_WE_DID.md`): domain failures flow
  through a typed `Result<T, DomainError>` channel mapped to HTTP by one exhaustive table
  (`@edd/api-client` surfaces the server's `{error}` strictly — no fallbacks); compile-time
  guards (`assertNever`, `Record<Union,_>` literals, `expectTypeOf` contract↔domain
  alignment); a typed `data-testid` registry so Playwright asserts attributes not text;
  deterministic DynamoDB readiness (`waitForDynamo`); and **code-health gates** —
  `knip` (dead code) + `jscpd` (copy-paste) in CI + pre-commit.

## Deployed

- Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

- **AWS account/region** (`DO_NEXT` #1) — top blocker; unlocks real Terraform, golden
  image, deploy, reconciler cron, `e2e-aws`, and Phase 8C cloud observability.
- **Domain/DNS** (#2) — blocks real proxy routing + ACM.
- **Phase 8A + 8B complete:** the admin `/admin` shell (Overview, Health board,
  Workspaces table, per-workspace Inspect, Quotas with create-time enforcement, and
  Logs/Audit with the derived audit feed + control-plane log stream) — all
  Playwright-covered. The remaining admin work (8C) is AWS-gated cloud data.
