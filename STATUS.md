# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-07 (CI fixes round 2: Pomerium pass_identity_headers + Teleport S3 creds; Teleport Enterprise endpoint_url blocker filed in BUGS.md; PR #54 e2e still failing)

## Current phase

Most of the **locally-testable platform is proven end-to-end with no mocks**. PR #54
(`feat/phase-8c-cloudtrail-cloudwatch-adapters-v2`) is open against `main` with 12 of 14
CI jobs green. Two CI jobs are still failing (`e2e`, `e2e-https`) due to a hard external
blocker: `endpoint_url` in Teleport GitHub connectors is restricted to Enterprise in all
OSS Teleport builds since v14 (see `BUGS.md` → `gravitational/teleport#67533`). This blocks
two Phase 4 SSH tests (GitHub connector + OAuth login). Fix being evaluated: vendor/patch
Teleport from source vs carry a patch file. Until resolved, CI is not fully green and PR
#54 is not mergeable.

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
  in Docker, mock-free. SSH connect-as-principal + authz-deny proven. Pomerium identity-aware
  wildcard routing + authenticated proxy-pass (`X-Pomerium-Jwt-Assertion`) — the fix
  (`pass_identity_headers: true`) was applied in the current PR; pending CI confirmation.
  Phase 4 S3 session recording: `audit_sessions_uri` + AWS credentials in `teleport-auth`
  added; pending CI confirmation. **Phase 4 GitHub connector + OAuth**: blocked by Teleport
  Enterprise restriction on `endpoint_url` (see `BUGS.md`).
- **CloudTrail-based tests + post-Terraform functional probes** (submodule → `fc03b15`):
  integration tests verify specific event content (CreateCluster event appears in `recent()`,
  `LookupAttributes` filter path); e2e workspace-lifecycle test asserts RunTask/StopTask/
  CreateSnapshot in CloudTrail and via `CloudTrailAuditSource`; reconciler e2e test 3 asserts
  scheduler-fired RunTask appears in CloudTrail (unblocked by #500); `terraform-sim` CI step
  audits 8 post-apply provisioning events incl. `CreateSchedule` (unblocked by #500) and probes
  DynamoDB write/read, CloudWatch Logs write/read, ECS task-def registration. No open blockers.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim) · e2e
  (`.e2e.yml`/`.ssh.yml`: data-fidelity, lifecycle, GitHub+Entra auth, Pomerium, Teleport)
  · **portal e2e** (Playwright) · **`e2e-https`** (the sims served over TLS — mock-free Entra
  auth + SSH with real CA trust, no `--insecure`) · manual `e2e-aws`. **12/14 CI jobs green;
  e2e + e2e-https failing** (Teleport Enterprise blocker — see `BUGS.md`).
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

- **Fix Teleport `endpoint_url` Enterprise restriction** — gate on PR #54 CI going green.
  Evaluating: vendor Teleport from source + patch vs carry a patch file only. Fix is ~10
  lines removed from `lib/services/github.go`. Build cost is the key factor.
- **AWS account/region** (`DO_NEXT` #1) — top blocker for real deploy, `e2e-aws`,
  real Fargate/EBS, and Phase 7.
- **Domain/DNS** (#2) — blocks real proxy routing + ACM.
- **No open sockerless blockers.**
