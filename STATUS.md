# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-03

## Current phase

The platform's core thesis — **stateful, snapshottable workspaces** — is now
**proven end-to-end with no mocks** against the from-source sockerless sim (real
ECS Fargate task + managed-EBS write→snapshot→restore). The local-testable spine
(control plane, RBAC, portal, reconciler, real ECS/EBS adapters, auth) is built
and green. **Gated on the AWS account/region decision** (`DO_NEXT` #1) for real
deployment; sockerless has no open blockers.

## What works (built, tested, merged)

- **Monorepo** (Turborepo + pnpm, `@edd/*`); `main` protected (PR required).
- **`@edd/core`** — functional core: branded ids, `Workspace` + pure lifecycle
  fns, state machine, `Storage`/`Compute` ports + fakes, contract test.
- **Control plane** (`apps/web` + `@edd/control-plane`): `WorkspaceService` over
  ElectroDB + the core, lifecycle API (create/list/get/stop/start/snapshot/delete)
  with CASL RBAC. **Fargate managed-EBS model**: `ComputeProvider.runTask` creates
  the task's EBS volume (snapshot-hydrated on wake) and releases it on `stopTask`;
  `StorageProvider` owns snapshots + restore-lifecycle + GC.
- **Auth** (`@edd/auth` + `apps/web`): Auth.js (GitHub + Entra) JWT; claim→role;
  **GitHub org/team→role** (`read:org` + `/user/teams`) and **Entra group→role**, both
  validated mock-free (bleephub; the azure sim via standard Graph + ROPC).
- **Portal UI** (`apps/web`): RBAC-gated workspaces grid + lifecycle actions.
- **Reconciler** (`services/reconciler`): idle scale-to-zero, scheduled snapshots,
  orphan GC — pure selectors + a `ReconcilerService` port. (Cron runner = AWS.)
- **Wake-on-connect** (control-plane half): `WorkspaceService.connect()` (idempotent —
  running→no-op, scaled-to-zero→wake from snapshot) over a pure `planConnect` core fn,
  with a `POST /workspaces/:id/connect` seam + api-client method. Proven on real ECS+EBS
  (lifecycle e2e). The Teleport→`connect()` trigger wiring is deployment/AWS-tier.
- **Real adapters** (endpoint-only, sim or AWS): `@edd/storage-ec2`
  (`Ec2StorageProvider`, EBS lifecycle + GC-safe `edd:managed` tagging) and
  `@edd/compute-ecs` (`EcsComputeProvider`, Fargate RunTask/StopTask + managed EBS).
- **SSH via Teleport** (`services/ssh-gateway`): a real Teleport cluster + workspace
  node in Docker (`docker-compose.ssh.yml`); the e2e provisions a Teleport user/role,
  signs an identity, and `tsh`-connects — session lands as the `workspacePrincipal`;
  an ungranted login is denied. (Federation, recording, wake-on-connect: remaining.)
- **Identity-aware routing via Pomerium** (`infra/proxy`): a real Pomerium proxy in
  Docker (in `docker-compose.e2e.yml`, OIDC IdP = the azure sim) proves the wildcard
  model — `<name>.devbox.<domain>` routes to a workspace upstream and unauthenticated
  access is gated to sign-in. (Authenticated-pass via browser login + real DNS/TLS:
  remaining.)
- **Test tiers** (`docker-compose.tier2.yml` / `.e2e.yml` / `.ssh.yml`, from-source sim):
  unit/contract · integration (DynamoDB Local + process-mode sim) · **e2e**
  (container-mode sim: workspace data-fidelity + full `WorkspaceService` lifecycle;
  GitHub auth via bleephub; Entra auth via the azure sim; identity-aware routing via a
  real Pomerium proxy; SSH via a real Teleport cluster).
- **CI**: build-test, integration, e2e, check-deps, terraform, shellcheck, sast
  (Semgrep), vuln-scan (Trivy). Manual `e2e-aws` skeleton. Local pre-commit.

**Verified locally (2026-06-03):** lint 14/14, build 13/13, unit 70. The sim-backed
lifecycle e2e (now exercising `connect()` wake on real ECS+EBS), control-plane integ,
SSH, Pomerium, and Entra auth e2es verified against their live harnesses this session;
the full e2e suite runs in CI.

## Deployed

- Nothing on AWS — no cloud infrastructure provisioned yet.

## Immediate focus

- **AWS account/region** (`DO_NEXT` #1) — top blocker for real Terraform, Phase 1
  deploy, SSH (Phase 4), the reconciler cron, scale/DR (Phase 7), `e2e-aws`.
- **Domain/DNS** (#2) — blocks the identity-aware proxy + workspace routing.
- **Mock-free Entra auth e2e is done** (`apps/web/lib/entra-auth.e2e.ts`): standard
  Microsoft Graph user/group provisioning → ROPC login → id_token `groups` → our real
  `normalizeClaims` + `mapClaimsToRole` → admin role. Fully endpoint-only (sockerless
  #390/#391 fixed in #393). GitHub-fixture swappability rework is now unblocked but
  deferred (tracked in `DO_NEXT`).
- **SSH (Teleport) + Pomerium routing + wake-on-connect (control-plane): e2es done.**
  Remaining on that track: the Teleport→`connect()` trigger wiring (golden image
  auto-enrolls its Teleport agent on task start; the gateway calls `connect()` —
  deployment/AWS-tier); Teleport↔Entra/GitHub federation; session recording; the
  authenticated proxy-pass (browser login).
- **GitHub-fixture swappability rework: halted** on sockerless #399/#400 — a conformance
  audit found bleephub's OAuth authorize flow non-conformant (no user session/CSRF,
  always grants the seed admin) and `POST /admin/organizations` unauthenticated. Filed +
  halted per the no-workaround policy; the merged test stays as-is, tracked.
- **Other decision-free work:** admin base-image catalog; Playwright portal e2e. See
  `DO_NEXT`.
