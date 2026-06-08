# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-08 (PR #57 open; sockerless #520 pinned; e2e CI data-fidelity fix pushed)

## Current phase

**PR #57** (`feat/sockerless-519-overlap-vpc-e2e`) is open against `main`.
Covers: sockerless PR #519/#520 submodule pins, container-mode sim netns-tier harness
support, overlapping-CIDR awsvpc e2e coverage, and CI follow-up fixes for Trivy and
container-mode e2e ordering/readiness. The PR also updated stale project docs and added
`docs/simulator-live-coverage.md` to capture current AWS/Azure simulator coverage and
next live-test candidates. The latest CI e2e failure in `workspace-data-fidelity.e2e.ts`
was fixed by snapshotting the retained EBS volume only after the writer task exits cleanly.

**PR #56** (`feat/phase-9-ssh-cert-proxy-cwlogs-journey`) is also open against `main`, 14/14 green.
Covers: SSH cert issuance API, wake-on-connect proxy infrastructure + `sshHost` domain field,
workspace container CloudWatch log shipping, and full user-journey e2e.
Proxy-to-ECS-container e2e is unblocked: sockerless#516 was fixed by PR #518, and PR #519
replaced the Docker-bridge-only VPC fabric with a netns-backed path for overlapping VPC CIDRs.
Local focused verification added for the #519/#520 behavior and passed against the
container-mode sim.

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
  v1.109.5, tini PID-1, idle-agent (heartbeats every 120s, HMAC machine-auth).
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
  (data-fidelity, lifecycle, auth, Pomerium, OpenSSH, overlapping-CIDR awsvpc) · portal
  e2e (Playwright) · `e2e-https` (sims over TLS, real CA trust, no `--insecure`) ·
  manual `e2e-aws`.
- **Engineering quality**: typed `Result<T, DomainError>` channel; compile-time
  exhaustiveness guards; typed `data-testid` registry; `waitForDynamo` harness
  determinism; `knip` + `jscpd` code-health gates; SAST + Trivy.

## Deployed

Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

1. **Merge PR #57** — now pins merged sockerless PR #520 (`85a62bc`), replacing the
   temporary #523 branch pin, and includes the docs/live-simulator coverage refresh.
2. **Run/merge PR #56** — previous CI was 14/14 green; local #519 follow-up focused checks pass.
3. **AWS account/region decision** (`DO_NEXT` #1) — unlocks everything real.
4. **No open sockerless blocker** — #521/#522 were resolved by merged PR #520; #523 was
   closed as superseded.
