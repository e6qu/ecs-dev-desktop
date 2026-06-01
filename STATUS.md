# STATUS.md — ecs-dev-desktop

> Snapshot of where the project is right now. Update after every task.
> Past tense at PR close (see `AGENTS.md` §0).

**Last updated:** 2026-06-01

## Current phase

**Phase 5 — Reconciler (scale-to-zero)** — _idle reconcile pass: `listActive` →
pure `selectIdle` → stop (snapshot + tear down) via the control plane; on branch
`phase-5/reconciler`. Scheduled snapshots + orphan GC + the cron runner remain.
Phases 2 (#4), 3 (#5), 6 (#6) merged._

## What exists

- Planning + architecture in `PLAN.md` / `AGENTS.md`; decisions locked.
- GitHub repo `e6qu/ecs-dev-desktop` (public), `main` protected (PR required).
- TDD + testability strategy (`AGENTS.md` §5, `TESTING.md`).
- **Monorepo scaffold (Turborepo + pnpm), all components building/testing in
  isolation:**
  - `packages/core` — `StorageProvider` port + filesystem **fake** + reusable
    **round-trip contract test** + workspace lifecycle state machine.
  - `packages/config`, `api-contracts`, `authz` (CASL), `auth` (claim→role),
    `db` (single-table keys + **ElectroDB** Workspace entity + GSIs),
    `api-client` (typed, injectable fetch).
  - `services/reconciler` (idle decision), `services/ssh-gateway` (Teleport
    principal helper).
  - `apps/web` — Next.js app with `/api/healthz`.
  - `infra/terraform` baseline (`versions.tf` + committed provider lock),
    `infra/images` placeholder, `docker-compose.tier2.yml`.
- **Live Tier-2 harness:** `docker-compose.tier2.yml` (DynamoDB Local) +
  `pnpm test:integ`; `@edd/db` integration test exercises put/get + both GSIs.
- **Control-plane API** (`apps/web`): workspace lifecycle endpoints
  (create/list/get/stop/start/snapshot/delete) with CASL RBAC; `@edd/control-plane`
  `WorkspaceService` (imperative shell) over ElectroDB + the pure functional core.
- **Functional core (FCIS):** branded domain ids, `Workspace` domain object +
  pure lifecycle functions, typed `@edd/config` (endpoints/ports), no magic values.
- **CI** (`.github/workflows/ci.yml`): `build-test`, `integration` (DynamoDB
  Local), `check-deps`, `terraform`, `shellcheck` (ubuntu+macOS), **`sast`**
  (Semgrep), **`vuln-scan`** (Trivy deps/IaC/secret, fail HIGH/CRITICAL). Manual
  real-AWS tier skeleton (`e2e-aws.yml`).
- **pre-commit**: format/type-check/lint/unit-tests/actionlint for all languages
  - commit-msg AI-attribution stripper.
- Verified locally: **strict lint 11/11**, build 11/11, unit 17 tasks, integ 8
  tests, Semgrep 0 findings, Trivy 0 HIGH/CRITICAL.

## What is deployed / working

- Nothing deployed to AWS. No cloud infrastructure provisioned.

## Immediate focus

- Real `infra/terraform` resources — needs AWS account/region (`DO_NEXT` #4).
- Wire the **sockerless** backend into the Tier-2 harness once its image +
  EBS-snapshot support (sockerless #347) are available (currently DynamoDB Local
  only).
