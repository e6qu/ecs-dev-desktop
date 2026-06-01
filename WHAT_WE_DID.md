# WHAT_WE_DID.md — ecs-dev-desktop

> Append-only history. Three lenses per entry: **Done**, **Tried** (incl. dead
> ends and rejected options), **Filed** (bugs/issues raised). Past tense.

---

## 2026-06-01 — Project planning & scaffolding decisions

### Done

- Established the project goal: per-user VS Code workspaces on AWS ECS Fargate
  with SSH, stateful+snapshottable storage, login UI, and an admin control plane.
- Locked architecture decisions (recorded in `AGENTS.md` §1):
  - Compute: **ECS Fargate**; scale target **200+**.
  - Auth: **GitHub OAuth + Azure Entra ID**, groups → roles.
  - RBAC: **CASL**, shared across API and UI.
  - SSH: **Teleport** (chosen over custom gateway / Node SSH proxy).
  - Web + control-plane API: **Next.js**, API-first.
  - State store: **DynamoDB** single-table + **ElectroDB** (pending final confirm).
  - IaC: **Terraform**; monorepo: **Turborepo + pnpm**.
  - Persistence model: **EBS snapshot as the unit of persistence**, unifying
    stateful + snapshottable + scale-to-zero.
  - Idle policy: **scale-to-zero** with snapshot/hydrate.
  - Workspace images: **curated golden base images**; extensions via Open VSX.
- Authored continuity files, `PLAN.md` (7 phases with deliverables + testing
  gates), `AGENTS.md`, and the `CLAUDE.md → AGENTS.md` symlink.
- Analyzed **DynamoDB vs Aurora**: chose DynamoDB + ElectroDB (cheaper, fits
  access patterns); accepted GSI-per-pattern / no-joins / analytics-via-Streams.

### Tried

- Considered **Aurora Postgres + Prisma/Drizzle** — set aside for DynamoDB.
- Considered **direct per-workspace SSH** and **web-proxy SSH tunnel** — rejected
  for Teleport (central auth/audit at scale).
- Considered **dynamic ALB host rules per workspace** — rejected (ALB ~100
  rule/listener cap); chose an identity-aware reverse proxy + wildcard DNS.

### Filed

- (none)

---

## 2026-06-01 — Repo bootstrap, branch protection, identity

### Done

- Created the public GitHub repo **`e6qu/ecs-dev-desktop`** containing
  `README.md`, `AGENTS.md`, `CLAUDE.md` (symlink), `PLAN.md`, and the continuity
  files; pushed the initial commit.
- Set the **local** git identity to `e6qu <2966430+e6qu@users.noreply.github.com>`
  (global identity untouched); switched the remote to HTTPS and pushed via the
  `gh` token so the `adrian-marza-monite` SSH key is never used.
- Enabled a **branch-protection ruleset** on `main`: PR required, direct/force
  push + deletion blocked, no admin bypass, 0 required approvals (solo-friendly).

### Tried

- Pushing over **SSH** failed — the machine's SSH key authenticated as
  `adrian-marza-monite`. Resolved by using HTTPS + the `gh` credential helper.

### Filed

- (none)

---

## 2026-06-01 — TDD / testability strategy, sockerless evaluation, licensing

### Done

- Adopted **TDD** for new features and a **ports-and-adapters** rule so external
  dependencies are faked; recorded in `AGENTS.md` §5 and `TESTING.md`.
- Defined three test tiers: unit/contract (every commit), integration on the
  **sockerless** substrate every PR, and a **manual `workflow_dispatch`
  real-AWS** suite on `main`.
- Evaluated **sockerless** vs LocalStack as the substrate; chose sockerless
  (covers our ECS/EBS/DynamoDB/IAM/Route53/ACM/KMS surface and **runs real
  containers**; `bleephub` provides GitHub OAuth) and dogfoods our own tool.
- Licensed the project **AGPL-3.0-or-later** (matching sockerless); added
  `LICENSE` and the SPDX-header convention.

### Tried

- **LocalStack (Community)** as substrate — kept only as an optional cross-check;
  ECS doesn't run containers and EBS/snapshots are Pro + API-level only.

### Filed

- Identified sockerless simulator gaps to file/track (see `DO_NEXT.md` /
  `BUGS.md`): **#347** EBS volume lifecycle + snapshots unimplemented (blocks our
  core snapshot round-trip at the sim level); #332–#336 compute/VPC/SG/LB are
  metadata-only; no Entra user-login OIDC simulator.
- Commented on sockerless **#347** registering our snapshot data-round-trip
  requirement.

---

## 2026-06-01 — Phase 0 scaffold (Turborepo, components, CI)

### Done

- Stood up the **Turborepo + pnpm** monorepo: every component builds/tests in
  isolation (`pnpm --filter <name> ...`). Scope `@edd/*`.
- Built the TDD centerpiece in `packages/core`: a `StorageProvider` **port**, a
  filesystem-backed **fake**, a reusable **round-trip contract test** (write →
  snapshot → hydrate → bytes present), and the workspace lifecycle state machine.
- Scaffolded `config`, `api-contracts` (zod), `authz` (CASL), `auth`
  (claim→role), `db` (single-table keys), `api-client`; `services/reconciler`,
  `services/ssh-gateway`; `apps/web` (Next.js + `/api/healthz`).
- Added `infra/terraform` baseline + committed cross-platform provider lock,
  `infra/images` placeholder, and `docker-compose.tier2.yml`.
- Authored **CI** (`ci.yml`): `build-test`, `check-deps` (Node + Terraform
  freshness, mirroring sockerless's check-deps), `terraform` fmt/validate; plus
  the manual `e2e-aws.yml` skeleton. Added `scripts/check-latest-deps.sh`.
- Brought all dependencies to **latest** so the freshness gate is green
  (TS 6, ESLint 10, Vitest 4, Next 16, zod 4, CASL 7, @types/node 25, vite 8).
- Verified: lint 10/10, build 10/10, **24 tests pass**, freshness gate green.

### Tried

- **TS 6** dropped automatic `@types/node` discovery under pnpm's isolated
  layout → `node:`/`Buffer`/`process` unresolved. Fixed by declaring
  `@types/node` and setting `types: ["node"]` in `core`/`config`/`api-client`.
- **Vitest 4** failed to start against a stray **vite 5** (`./module-runner`
  missing). Fixed by adding latest **vite 8** at the workspace root.
- Kept library `build` as `tsc --noEmit` (typecheck) for the scaffold; Turbo
  emits harmless "no output files" warnings for those tasks.

### Filed

- (none)

---

## 2026-06-01 — Tier-2 integration harness (DynamoDB Local + ElectroDB)

### Done

- Added **ElectroDB** to `@edd/db`: a Workspace entity over the single table with
  `byOwner` (GSI1) and `byState` (GSI2) indexes, a `CreateTable`/`DeleteTable`
  schema helper, and an env-driven DynamoDB client (`DYNAMODB_ENDPOINT`).
- Wrote the first **integration test** (`*.integ.ts`, separated from the unit
  run) covering put/get + both GSIs, verified locally against **DynamoDB Local**
  (3/3 pass).
- Wired `pnpm test:integ` (Turbo) + a CI **`integration`** job using an
  `amazon/dynamodb-local` service container.
- Added deps at latest (electrodb 3, @aws-sdk/client-dynamodb 3); freshness gate
  stayed green. Verified: lint 10/10, build 10/10, unit 24/24, integration 3/3.

### Tried

- Separated integration from unit by suffix (`*.integ.ts`) + a dedicated
  `vitest.integ.config.ts`, so `pnpm test` never needs Docker.
- Left the **sockerless** backend commented in `docker-compose.tier2.yml`: no
  published image yet and EBS snapshots unimplemented (sockerless #347), so
  Tier-2 currently covers DynamoDB Local only.

### Filed

- (none)

---

## 2026-06-01 — Dep prune, 1-day min release age, portable shell scripts

### Done

- Audited deps with `depcheck` (surface already lean). Pruned the only two unused
  declarations: `@edd/core` from `services/reconciler` and `@types/react-dom`
  from `apps/web`.
- Added supply-chain safeguard **`minimumReleaseAge: 1440`**
  (`pnpm-workspace.yaml`): no version adopted until public ≥ 1 day. `pnpm
outdated` honours it, so the `check-deps` gate stays read-only and age-aware.
- Made the one shell script **portable + `shellcheck`-clean** (no `BASH_SOURCE`/
  `pushd`; `$0`-derived path; `unset CDPATH`); runs under **bash and zsh**.
- Added a **`shellcheck` CI job** matrixed over **ubuntu + macOS** that runs
  shellcheck + `bash -n` + `zsh -n` on every `*.sh`.

### Tried

- `pnpm update --latest -r` under the floor **downgraded** vite 8.0.16→8.0.14 and
  vitest 4.1.8→4.1.7 (published <24h) — kept the age-compliant versions.
- An `update --latest` + `git diff` freshness gate — rejected: it conflated
  uncommitted edits with drift. `pnpm outdated` is read-only and age-aware.

### Filed

- (none)
