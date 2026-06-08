# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-08 (PR #58 open: golden SSH/live-sim follow-up)

## Current phase

**PR #56** (`feat/phase-9-ssh-cert-proxy-cwlogs-journey`) and **PR #57**
(`feat/sockerless-519-overlap-vpc-e2e`) are merged to `main`.

PR #56 delivered SSH cert issuance API, wake-on-connect proxy infrastructure,
`sshHost` domain storage, workspace CloudWatch log shipping, and full user-journey e2e.

PR #57 delivered sockerless PR #519/#520 submodule pins, container-mode sim netns-tier
harness support, overlapping-CIDR awsvpc e2e coverage, route-table egress alignment,
CI fixes, `docs/simulator-live-coverage.md`, and the data-fidelity snapshot-race fix.

Current follow-up PR: **#58** (`feat/golden-ssh-live-sim-e2e`) — golden workspace
SSH integration, live simulator app coverage, and sockerless #524 consumption are
implemented in one PR.

Upstream note: sockerless PR #524 is now pinned (`39a4291`) and covered by an ECS
Exec smoke test in the container-mode AWS simulator.

## What works (built, tested, merged to `main`)

- **Monorepo** (`@edd/*`, Turborepo+pnpm); `main` protected.
- **Core** (`@edd/core`): branded domain types, lifecycle state machine, pure functions
  (provision/stop/start/snapshot/`markActivity`/`planConnect`, base-image catalog),
  Storage/Compute ports + fakes.
- **Control plane** (`apps/web` + `@edd/control-plane`): `WorkspaceService` lifecycle
  (create/stop/start/connect/heartbeat/snapshot/remove) + `CatalogService`, over
  ElectroDB, CASL-gated API + `@edd/api-client`. Fargate managed-EBS model.
- **Auth** (`@edd/auth`): GitHub + Entra → group→role, both proven mock-free & swappable.
- **Portal** (`apps/web`): RBAC workspaces grid + lifecycle, base-image catalog admin
  page + create-from-catalog picker.
- **Reconciler**: idle scale-to-zero, scheduled snapshots, orphan GC (pure selectors).
  Container (`services/reconciler`): esbuild bundle; scheduler→ECS→container e2e proven.
- **Real adapters** (endpoint-only): `@edd/storage-ec2`, `@edd/compute-ecs`.
- **Deploy IaC** (`infra/terraform/modules/ecs-dev-desktop`): reusable parametric module
  (VPC + NAT [managed or fck-nat], KMS, DynamoDB+GSIs, ECR, ECS + Fargate + autoscaling,
  ALB + optional ACM/Route53, scheduler, IAM, logs). **`terraform-sim` CI job applies +
  destroys the full stack every PR** in the default, fck-nat, and DNS/TLS configs
  (resource/functional assertions + idempotency). Endpoint-only (§6.8). Real apply is AWS-gated.
- **Golden workspace image** (`infra/images/workspace/`): Node 20 + OpenVSCode Server
  v1.109.5, tini PID-1, OpenSSH `sshd` with trusted CA/principal enforcement,
  idle-agent (heartbeats every 120s, HMAC machine-auth), and multi-arch
  OpenVSCode asset selection.
- **Real adapter wiring** (`apps/web/lib/control-plane.ts`): `COMPUTE_PROVIDER=ecs`,
  `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`; fakes remain default.
- **SSH gateway** (`services/ssh-gateway`): standard `sshd` + ephemeral CA
  (`scripts/gen-ssh-ca.sh`); `TrustedUserCAKeys` + `AuthorizedPrincipalsFile` RBAC;
  connect-as-principal + authz-deny proven mock-free. PTY allocation tested (`-tt`).
- **SSH cert API** (`POST /api/workspaces/:id/ssh-cert`): control plane signs user's
  public key with `ssh-keygen -s`; returns short-lived cert for `dev-<workspaceId>` principal.
- **Wake-on-connect proxy**: `sshHost` (ENI private IP — routable since sockerless PR #518;
  overlapping-CIDR VPC fidelity improved by PR #519)
  stored on `Workspace`/DB; `GET /api/workspaces/:id/connect-info` returns `{host, port}`;
  `Dockerfile.proxy` + `wake-and-forward.sh` + `proxy-entrypoint.sh` ForceCommand gateway.
  Full chain e2e: client SSH → proxy container → stub CP → nc → workspace node.
- **Workspace CloudWatch log shipping**: `EcsComputeProvider` adds `awslogs` `logConfiguration`
  to every task definition; `ECS_LOG_GROUP_WORKSPACES` injected by Terraform.
- **Pomerium routing** (`infra/proxy`): identity-aware wildcard routing + authenticated
  proxy-pass (`X-Pomerium-Jwt-Assertion`) — both proven mock-free against azure-sim.
- **Phase 8 (8A+8B+8C)**: admin console (health board, all-workspaces, Inspect, Overview,
  quotas, Logs/Audit); `@edd/cloudtrail-audit` + `@edd/cloudwatch-logs` endpoint-only
  adapters, integration-tested against the sim.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim) · e2e
  (data-fidelity, lifecycle, auth, Pomerium, OpenSSH gateway, overlapping-CIDR
  awsvpc, reconciler container, ECS Exec smoke) · live admin observability route
  tests against sockerless AWS CloudTrail/CloudWatch · portal e2e (Playwright) ·
  `e2e-https` (sims over TLS, real CA trust, no `--insecure`) · manual `e2e-aws`.
- **Engineering quality**: typed `Result<T, DomainError>` channel; compile-time
  exhaustiveness guards; typed `data-testid` registry; `waitForDynamo` harness
  determinism; `knip` + `jscpd` code-health gates; SAST + Trivy.

## Deployed

Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

1. **Review PR #58** — golden image SSH wiring, live simulator app coverage,
   sockerless #524 pin/ECS Exec smoke, CI/test hardening, and docs sync.
2. **Track sockerless blockers for full golden SSH e2e** — #526/#527 block full
   WorkspaceService-managed-EBS/golden-image SSH through the AWS simulator.
3. **AWS account/region decision** (`DO_NEXT` #1) — unlocks everything real.
