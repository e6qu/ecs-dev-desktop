# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-12 (post-PR #63; no branch in flight)

## Current phase

**PRs #60–#63 are merged to `main`; nothing is in flight.** The 2026-06-12
test-gap closure arc is complete:

- **PR #60** — closed every untested seam from the coverage review, with
  hardening where tests exposed real product gaps: per-workspace HMAC
  **gateway machine-auth** (`EDD_GATEWAY_SECRET`; the old bearer token was
  never accepted server-side — masked by a stub CP), the real-control-plane
  wake-on-connect chain e2e, the LIVE user journey on `COMPUTE_PROVIDER=ecs`
  (in-workspace idle-agent heartbeats proven), reconciler scale-to-zero
  against a real stale task, Auth.js callback-route e2e, route-level integ
  suites, and the scale-to-zero tuning knobs (`EDD_HEARTBEAT_INTERVAL_S`,
  `EDD_IDLE_THRESHOLD_MS`/`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_GC_GRACE_MS`).
- **PR #61** — consumed sockerless PR #549 (pin `777ffd3`), which fixed our
  same-day reports #547/#548; Entra group→admin is asserted through the
  interactive Auth.js flow via standard `login_hint`.
- **PR #62** — LIVE portal browser e2e (`test:pw:live`): UI lifecycle clicks
  act on real golden-image ECS tasks; admin Inspect confirms real bindings.
- **PR #63** — browser OIDC login through Pomerium (`test:pw:pomerium`); the
  Pomerium harness moved to **real TLS** (Pomerium forces https in all
  absolute URLs — verified in its source), SPKI-pinned Chromium trust.

**Every live-coverage candidate in `docs/simulator-live-coverage.md` is now
covered.** No open bugs; no upstream blockers; sockerless pin current. The
project is at the decision gate: all remaining work is blocked on the open
decisions in `DO_NEXT.md` (AWS account/region foremost), except the optional
ECS Exec workspace probe (itself gated on a product decision).

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
  proxy-pass (`X-Pomerium-Jwt-Assertion`) — both proven mock-free against azure-sim,
  over real TLS (Pomerium forces https in all absolute URLs), incl. a real-browser
  OIDC login (`test:pw:pomerium`).
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
2. **Live-test candidates exhausted** (`docs/simulator-live-coverage.md`):
   browser Pomerium OIDC login landed as `test:pw:pomerium` (real-TLS Pomerium
   harness; Chromium completes gate → IdP → callback → workspace), after
   `test:pw:live` (browser lifecycle on real ECS compute). Only the optional
   ECS Exec workspace probe remains, gated on a product decision.
