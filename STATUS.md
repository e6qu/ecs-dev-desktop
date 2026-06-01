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
  pure `selectIdle` → stop+snapshot) via a `ReconcilerService` port.
- **Tier-2 harness**: `docker-compose.tier2.yml` (DynamoDB Local) + `@edd/db`
  ElectroDB entity (single table, `byOwner`/`byState` GSIs).
- **CI**: `build-test`, `integration`, `check-deps`, `terraform`, `shellcheck`
  (ubuntu+macOS), `sast` (Semgrep), `vuln-scan` (Trivy). Manual `e2e-aws` skeleton.
- **Local quality gates**: `pre-commit` (format/type-check/lint/unit/actionlint)
  - commit-msg AI-attribution stripper.

**Verified locally (2026-06-02):** lint 11/11, build 11/11, unit 47 tests / 19
files, integration 9 tests / 4 files (DynamoDB Local). Semgrep + Trivy clean.

## Deployed

- Nothing on AWS — no cloud infrastructure provisioned yet.

## Immediate focus

- **AWS account/region** (`DO_NEXT` #4) is the top blocker: real Terraform, Phase
  1 (Fargate + EBS), Phase 4 (SSH), Phase 7, the reconciler cron, and `e2e-aws`
  all sit behind it.
- **Domain/DNS** (#3) blocks the auth proxy + workspace routing.
- Sockerless **[#359](https://github.com/e6qu/sockerless/issues/359)** (snapshots
  never reach `completed`) blocks snapshot→restore at the sim level; an EBS
  lifecycle adapter is deferred until it lands (`BUGS.md` EXT-001).
- **Available now (decision-free):** admin base-image catalog, Playwright e2e.
