# STATUS.md — ecs-dev-desktop

> Snapshot of where the project is right now. Update after every task.
> Past tense at PR close (see `AGENTS.md` §0).

**Last updated:** 2026-06-01

## Current phase

**Phase 0 — Foundations & repo scaffold** — *scaffold landed; infra resources and
the live Tier-2 harness remain.*

## What exists

- Planning + architecture in `PLAN.md` / `AGENTS.md`; decisions locked.
- GitHub repo `e6qu/ecs-dev-desktop` (public), `main` protected (PR required).
- TDD + testability strategy (`AGENTS.md` §5, `TESTING.md`).
- **Monorepo scaffold (Turborepo + pnpm), all components building/testing in
  isolation:**
  - `packages/core` — `StorageProvider` port + filesystem **fake** + reusable
    **round-trip contract test** + workspace lifecycle state machine.
  - `packages/config`, `api-contracts`, `authz` (CASL), `auth` (claim→role),
    `db` (single-table keys), `api-client` (typed, injectable fetch).
  - `services/reconciler` (idle decision), `services/ssh-gateway` (Teleport
    principal helper).
  - `apps/web` — Next.js app with `/api/healthz`.
  - `infra/terraform` baseline (`versions.tf` + committed provider lock),
    `infra/images` placeholder, `docker-compose.tier2.yml`.
- **CI** (`.github/workflows/ci.yml`): `build-test`, `check-deps`
  (Node + Terraform freshness), `terraform` (fmt/validate). Manual real-AWS
  tier skeleton (`e2e-aws.yml`, `workflow_dispatch` on `main`).
- Verified locally: lint 10/10, build 10/10, **24 tests pass**, freshness gate
  green. All deps on latest (TS 6, ESLint 10, Vitest 4, Next 16, zod 4, CASL 7).

## What is deployed / working

- Nothing deployed to AWS. No cloud infrastructure provisioned.

## Immediate focus

- Land branch-protection required checks + up-to-date gate.
- Then: real `infra/terraform` resources (needs AWS account/region, `DO_NEXT` #5)
  and the live Tier-2 sockerless harness.
