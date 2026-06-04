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
  validated mock-free and **swappable** (bleephub via the conformant OAuth session/CSRF
  web flow + standard GHES provisioning; the azure sim via standard Graph + ROPC).
- **Admin base-image catalog** (`@edd/core` + `@edd/control-plane` + `apps/web`):
  golden-image allow-list — `CatalogService` CRUD over a pure `BaseImageEntry` core +
  a second ElectroDB entity, CASL-gated routes `/api/base-images` (admins manage,
  everyone reads) + api-client; workspace `create` is enforced against the **enabled**
  catalog. **Admin management page** `/base-images` (add / enable-disable / delete) +
  the real **create-from-catalog picker** (replaced the hardcoded image list).
- **Portal UI** (`apps/web`): RBAC-gated workspaces grid + lifecycle actions, catalog
  picker, and the admin catalog page — "infra control room" aesthetic.
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
- **Portal browser e2e** (`apps/web/e2e`, Playwright): drives the real built app
  (DynamoDB Local) through the RBAC-gated flows — admin catalog CRUD and the member
  create→stop→delete lifecycle — authenticated via a cookie dev-auth shim
  (`EDD_DEV_AUTH`). Caught three real bugs (see `WHAT_WE_DID`).
- **Test tiers** (`docker-compose.tier2.yml` / `.e2e.yml` / `.ssh.yml`, from-source sim):
  unit/contract · integration (DynamoDB Local + process-mode sim) · **e2e**
  (container-mode sim: workspace data-fidelity + full `WorkspaceService` lifecycle;
  GitHub auth via bleephub; Entra auth via the azure sim; identity-aware routing via a
  real Pomerium proxy; SSH via a real Teleport cluster) · **portal e2e** (Playwright).
- **CI**: build-test, integration, e2e, check-deps, terraform, shellcheck, sast
  (Semgrep), vuln-scan (Trivy). Manual `e2e-aws` skeleton. Local pre-commit.

**Verified locally (2026-06-03):** lint 14/14, build 13/13, unit 76. The catalog
integration tests (control-plane + web routes, DynamoDB Local) and the SSH/Pomerium/
Entra/lifecycle e2es verified against their live harnesses this session; the full e2e
suite runs in CI.

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
- **GitHub-fixture swappability rework: done** — the GitHub auth e2e now uses the
  conformant OAuth session/CSRF web flow + standard GHES provisioning (no seed token /
  `auto=1` / `POST /user/orgs`); bleephub non-conformances #399/#400 fixed upstream in #401.
- **Portal Playwright e2e: done** — browser coverage of the admin catalog + member
  lifecycle flows; it caught + fixed a browser-only `fetch` bug, a missing
  `transpilePackages` entry, and a `vitest`-leak in `@edd/core`'s public API.
- **Other decision-free work:** quotas + cost dashboard (Phase 6 tail); idle-agent
  heartbeat; broader coverage. See `DO_NEXT`.
