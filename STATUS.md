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
  `@edd/control-plane` `WorkspaceService` on ElectroDB + the core.
- **Auth** (`apps/web` + `@edd/auth`): Auth.js (GitHub + Entra) JWT sessions;
  claim→role mapping; `getPrincipal` from session (dev-header shim behind
  `EDD_DEV_AUTH`).
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
- **Tier-2 harness**: `docker-compose.tier2.yml` — DynamoDB Local + the
  **sockerless AWS simulator built from source** (`third_party/sockerless`
  submodule, `SIM_RUNTIME=process`). `@edd/db` ElectroDB entity (single table,
  `byOwner`/`byState` GSIs).
- **CI**: `build-test`, `integration`, `check-deps`, `terraform`, `shellcheck`
  (ubuntu+macOS), `sast` (Semgrep), `vuln-scan` (Trivy). Manual `e2e-aws` skeleton.
- **Local quality gates**: `pre-commit` (format/type-check/lint/unit/actionlint)
  - commit-msg AI-attribution stripper.

**Verified locally (2026-06-02):** lint 12/12, build 12/12, unit 57 tests, integration
13 tests (DynamoDB Local + the from-source sockerless AWS sim).

## Deployed

- Nothing on AWS — no cloud infrastructure provisioned yet.

## Immediate focus

- **AWS account/region** (`DO_NEXT` #1) is the top blocker: real Terraform, Phase
  1 (Fargate + EBS), Phase 4 (SSH), Phase 7, the reconciler cron, and `e2e-aws`
  all sit behind it.
- **Domain/DNS** (#2) blocks the auth proxy + workspace routing.
- Sockerless: we **consume the AWS sim from source** (submodule @ `41480ae`,
  upstream `simulators/aws/Dockerfile`). EBS lifecycle (#359/#360 via PR #361),
  LB/SG (#334/#335 via PR #364), Entra `/authorize` (#362 via PR #368), and the
  build-context + `SIM_RUNTIME` docs we filed (#366/#367 via PR #370) are all
  resolved. The **sole remaining functional blocker** is **#333** (real compute —
  gates workspace execution + volume _data_ fidelity at the sim level).
- **Available now (decision-free):** admin base-image catalog, Playwright e2e,
  idle-agent heartbeat shape.
