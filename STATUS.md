# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-12 (test-gap closure + gateway machine-auth branch)

## Current phase

**PRs #56–#59 are merged to `main`** (SSH cert API + wake-on-connect proxy +
CloudWatch log shipping; overlapping-CIDR awsvpc e2e; golden SSH + live sim
coverage; sockerless #532 pin with managed-EBS golden SSH active).

Current branch: `feat/close-test-gaps-one-pr` — closed every untested seam the
2026-06-12 coverage review found, with hardening where the tests exposed real
product gaps:

- **Gateway machine-auth (product fix):** `wake-and-forward.sh` sent a bearer
  token the control plane never accepted (masked by the stub CP in the proxy
  e2e). The gateway now derives a per-workspace HMAC token from
  `EDD_GATEWAY_SECRET` (same scheme as the idle-agent); `POST /connect`,
  `GET /:id`, `GET /connect-info` accept it (`loadConnectableWorkspace`);
  destructive routes stay session-only.
- **Wake-on-connect chain e2e** against the REAL control plane (production
  `next start`): ssh → gateway ForceCommand → real `/connect` wake from
  stopped → `/connect-info` → forward to the workspace node, with the user
  cert issued by the real `/ssh-cert` route.
- **LIVE user journey**: `user-journey.e2e.ts` now drives the real HTTP API
  with `COMPUTE_PROVIDER=ecs` on the container-mode sim — create launches the
  golden image with managed EBS, the in-workspace **idle-agent posts real HMAC
  heartbeats** (lastActivity advances), snapshot/stop/wake/delete act on real
  sim tasks/volumes.
- **Reconciler scale-to-zero proven**: the container e2e seeds a stale
  workspace backed by a real running task; the sweep snapshots and stops it
  (previously it swept an empty table). `run.ts` gained
  `EDD_IDLE_THRESHOLD_MS`/`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_GC_GRACE_MS`;
  `EcsComputeProvider` gained `ECS_ASSIGN_PUBLIC_IP` and
  `EDD_HEARTBEAT_INTERVAL_S` injection (DO_NEXT #4 tuning knobs).
- **Auth.js callback-route e2e**: the real NextAuth handlers driven through
  csrf → signin → IdP → callback → session against bleephub (team→admin role)
  and the Azure sim (HTTPS leg in `e2e-https`). `AUTH_GITHUB_URL` (standard
  GHES `enterprise.baseUrl`) added; Entra provider uses `client_secret_post`
  and skips the stock graph.microsoft.com photo fetch.
- **Route-level integ tests** for stop/start/snapshot/connect (+ healthz, +
  admin data routes' positive paths); gateway-auth integ suite.

Upstream: filed sockerless **#547** (azure-sim authorize not user-bound) and
**#548** (token endpoint rejects `client_secret_basic`) — both fidelity gaps,
neither blocking.

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
  `Dockerfile.proxy` + `wake-and-forward.sh` + `proxy-entrypoint.sh` ForceCommand gateway
  authenticating with per-workspace HMAC machine-auth (`EDD_GATEWAY_SECRET`).
  Full chain e2e: client SSH → proxy container → REAL control plane (wake from
  stopped) → nc → workspace node; the stub-CP variant remains as a component test.
- **Workspace CloudWatch log shipping**: `EcsComputeProvider` adds `awslogs` `logConfiguration`
  to every task definition; `ECS_LOG_GROUP_WORKSPACES` injected by Terraform.
- **Pomerium routing** (`infra/proxy`): identity-aware wildcard routing + authenticated
  proxy-pass (`X-Pomerium-Jwt-Assertion`) — both proven mock-free against azure-sim.
- **Phase 8 (8A+8B+8C)**: admin console (health board, all-workspaces, Inspect, Overview,
  quotas, Logs/Audit); `@edd/cloudtrail-audit` + `@edd/cloudwatch-logs` endpoint-only
  adapters, integration-tested against the sim.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim;
  route-level lifecycle/gateway-auth/admin-data suites) · e2e (data-fidelity,
  LIVE user journey through the real API on container-mode adapters, lifecycle,
  auth incl. Auth.js callback routes, Pomerium, OpenSSH gateway + real-CP wake
  chain, overlapping-CIDR awsvpc, reconciler container incl. real scale-to-zero,
  managed-EBS golden workspace SSH, ECS Exec smoke) · live admin observability
  route tests against sockerless AWS CloudTrail/CloudWatch · portal e2e
  (Playwright) · `e2e-https` (sims over TLS, real CA trust, no `--insecure`;
  incl. the Entra Auth.js callback leg) · manual `e2e-aws`.
- **Engineering quality**: typed `Result<T, DomainError>` channel; compile-time
  exhaustiveness guards; typed `data-testid` registry; `waitForDynamo` harness
  determinism; `knip` + `jscpd` code-health gates; SAST + Trivy.

## Deployed

Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

1. **AWS account/region decision** (`DO_NEXT` #1) — the top blocker; unlocks
   everything real.
2. **Remaining live-test candidates** (`docs/simulator-live-coverage.md`):
   portal browser lifecycle against real ECS compute, browser Pomerium OIDC
   login.
