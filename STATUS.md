# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-02

## Current phase

**At a decision gate.** The locally-testable spine is built and green (Phases 0,
2, 3, 6, and Phase 5's idle pass merged). Most remaining work is blocked on user
decisions and upstream simulator fixes — see `DO_NEXT.md`.

## What works (built, tested, merged)

- **Monorepo** (Turborepo + pnpm, `@edd/*`): every component builds/tests in
  isolation. Repo `e6qu/ecs-dev-desktop`, `main` protected (PR required).
- **Functional core** (`@edd/core`): branded domain ids, `Workspace` object +
  pure lifecycle functions, lifecycle state machine, `Storage`/`Compute` ports +
  fakes, reusable round-trip **contract test**.
- **Control-plane API** (`apps/web`): lifecycle endpoints
  (create/list/get/stop/start/snapshot/delete) with CASL RBAC, over
  `@edd/control-plane` `WorkspaceService` on ElectroDB + the core. Uses the
  **Fargate managed-EBS model**: `ComputeProvider.runTask` creates the task's EBS
  volume (hydrating from a snapshot on wake) and releases it on `stopTask`; the
  `StorageProvider` owns snapshots + restore-lifecycle + GC on that volume id.
- **Auth** (`apps/web` + `@edd/auth`): Auth.js (GitHub + Entra) JWT sessions;
  claim→role mapping; `getPrincipal` from session (dev-header shim behind
  `EDD_DEV_AUTH`). **GitHub org/team → role**: the `read:org` scope + a
  `/user/teams` fetch at sign-in yields `org/team` groups (GitHub OAuth profiles
  carry no teams), matched against `EDD_ADMIN_GROUPS`/`EDD_MEMBER_GROUPS` like
  Entra groups. **Validated mock-free** against the bleephub sim (OAuth-code login
  → `/user/teams` → role) — `apps/web/lib/github-auth.e2e.ts`.
- **Portal UI** (`apps/web`): RBAC-gated workspaces grid, create-from-catalog,
  lifecycle actions, admin "all" view.
- **Reconciler** (`services/reconciler`): idle reconcile pass (`listActive` →
  pure `selectIdle` → stop+snapshot), **scheduled point-in-time snapshots**
  (`selectDueForSnapshot`), and **orphan volume/snapshot GC** (`selectOrphan*` +
  storage enumeration) via a `ReconcilerService` port. Decision logic is pure
  `@edd/core`; the cron _runner_ that invokes a sweep needs AWS.
- **Storage adapter** (`packages/storage-ec2`): real EBS `StorageProvider` over
  the EC2 API (`Ec2StorageProvider`) — endpoint-only, identical against the sim or
  real AWS; lifecycle (create/snapshot/restore/delete/enumerate) works, file I/O
  deferred to the compute layer (sockerless #333).
- **Compute adapter** (`packages/compute-ecs`): real Fargate `ComputeProvider`
  (`EcsComputeProvider`) — registers a task def per base image, RunTask with an
  **ECS-managed EBS** volume (fresh or snapshot-hydrated) on `awsvpc`, returns the
  task + the volume id ECS attached; StopTask releases it. Endpoint-only.
- **Tier-2 harness**: `docker-compose.tier2.yml` — DynamoDB Local + the
  **sockerless AWS simulator built from source** (`third_party/sockerless`
  submodule, `SIM_RUNTIME=process`). `@edd/db` ElectroDB entity (single table,
  `byOwner`/`byState` GSIs).
- **Mock-free workspace e2e** (`packages/e2e`, `docker-compose.e2e.yml`, against the
  **container-mode** sim): (1) data fidelity — a task writes a file to a managed-EBS
  volume → snapshot via `Ec2StorageProvider` → a new task hydrates from the
  snapshot → the marker is present (container exit code); (2) the full **product
  lifecycle through `WorkspaceService`** with the real `EcsComputeProvider` +
  `Ec2StorageProvider`: create → stop (snapshot) → start (restore) → remove.
- **CI**: `build-test`, `integration`, **`e2e`**, `check-deps`, `terraform`,
  `shellcheck` (ubuntu+macOS), `sast` (Semgrep), `vuln-scan` (Trivy). Manual
  `e2e-aws` skeleton.
- **Local quality gates**: `pre-commit` (format/type-check/lint/unit/actionlint)
  - commit-msg AI-attribution stripper.

**Verified locally (2026-06-03):** lint 14/14, build 13/13, unit 66 tests, integration
13, e2e 3 (workspace data-fidelity + lifecycle on the container-mode AWS sim;
GitHub auth via bleephub). Harness: `docker-compose.e2e.yml` (DynamoDB Local +
container-mode sockerless AWS sim + bleephub).

## Deployed

- Nothing on AWS — no cloud infrastructure provisioned yet.

## Immediate focus

- **AWS account/region** (`DO_NEXT` #1) is the top blocker: real Terraform, Phase
  1 (Fargate + EBS), Phase 4 (SSH), Phase 7, the reconciler cron, and `e2e-aws`
  all sit behind it.
- **Domain/DNS** (#2) blocks the auth proxy + workspace routing.
- Sockerless: we **consume the AWS sim from source** (submodule @ `8a01c62`).
  **No open blockers** — every gap we hit is fixed upstream (EBS #359/#360,
  LB/SG #334/#335, Entra #362, build/docs #366/#367, compute #333, and now the
  control/data-plane split **#381 via PR #382**). The mock-free workspace e2e runs.
- **Next:** the product lifecycle now runs mock-free through `EcsComputeProvider`.
  Remaining for a full workspace e2e: Teleport/Pomerium in Docker for SSH/proxy;
  and wiring `apps/web` to the real adapters (gated on the AWS account/region +
  the Terraform that provides the cluster/subnets/role).
- **Available now (decision-free):** mock-free **auth** e2e (bleephub + Entra),
  admin base-image catalog, Playwright e2e, idle-agent heartbeat.
