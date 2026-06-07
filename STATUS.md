# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-07 (submodule → def45a1: sockerless #495 — cron L/W/# qualifiers + bleephub token content-type; zero open upstream blockers)

## Current phase

The whole **locally-testable platform is proven end-to-end with no mocks** against the
from-source sockerless sim + real Teleport/Pomerium: stateful snapshottable workspaces,
control plane + RBAC, both IdP logins, SSH (with S3 session recording + GitHub connector
federation), identity-aware routing (including **authenticated** proxy-pass with
`X-Pomerium-Jwt-Assertion`), scale-to-zero + **reconciler container** (scheduler fires →
real container runs → CloudWatch Logs), the portal, and the **admin console** — all e2e
tested. **Phases 3, 4, and 5** sim-testable work is complete. What remains is the
real-deploy track (AWS account/region-gated) for real EBS/Fargate durability, real DNS/TLS,
and a full Teleport GitHub OAuth browser login.

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
  `EcsComputeProvider.fromEnv()` + `Ec2StorageProvider.fromEnv()`; `AUDIT_PROVIDER=cloudtrail`
  selects `CloudTrailAuditSource`; `LOG_PROVIDER=cloudwatch` + `EDD_APP_NAME` selects
  `CloudWatchLogSource`; fakes remain default.
- **SSH** (`services/ssh-gateway`) + **Pomerium routing** (`infra/proxy`): real products
  in Docker, mock-free. Phase 4: S3 session recording (sim-backed), full GitHub OAuth
  login via bleephub-ssh (`driveGitHubOAuthFlow`: Teleport→bleephub→callback; role mapped
  from acme/platform-admins; user created in Teleport verified via `tctl`), GitHub connector
  config proven, authenticated proxy-pass with `X-Pomerium-Jwt-Assertion` (full OIDC flow
  via azure-sim). No open sockerless blockers.
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

- **AWS account/region** (`DO_NEXT` #1) — top blocker for real deploy, `e2e-aws`,
  real Fargate/EBS, and Phase 7.
- **Domain/DNS** (#2) — blocks real proxy routing + ACM.
- **Phases 3/4/5 sim-testable work complete** (PR #55 + submodule #491/#492). Remaining per phase:
  - Phase 3: real DNS/TLS/ACM (needs DNS #2).
  - Phase 4: Teleport wake-on-connect trigger (golden image auto-enrols — AWS-gated).
  - Phase 5: ECS cron + real heartbeat agent (AWS-gated for in-container execution).
- **No open sockerless blockers.** (#493 cron L/W/# + #494 bleephub token content-type fixed in #495; #489/#490 in #492; #491 added cron() evaluation.)
