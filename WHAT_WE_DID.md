# WHAT_WE_DID.md — ecs-dev-desktop

> Concise dated history. Each entry: what was **done**, and (where it informs
> future work) the key **lesson** or **filing**. Past tense.

---

## 2026-06-01 — Planning, architecture, repo bootstrap

- Locked the architecture (see `AGENTS.md` §1): ECS Fargate; GitHub OAuth + Azure
  Entra → CASL RBAC; Teleport SSH; Next.js API-first; DynamoDB single-table +
  ElectroDB; EBS-snapshot-as-persistence with scale-to-zero; golden images + Open
  VSX; Terraform; Turborepo + pnpm; AGPL-3.0-or-later.
- Authored `PLAN.md` (7 phases, each with a testing gate), `AGENTS.md`, the
  continuity files, and the `CLAUDE.md → AGENTS.md` symlink.
- Created public repo **`e6qu/ecs-dev-desktop`**; protected `main` (PR required,
  no force-push/delete, no admin bypass, 0 approvals for solo work).
- **Lessons:** DynamoDB over Aurora (cost, fits access patterns; accept
  GSI-per-pattern, no joins). Teleport over a custom SSH gateway (central
  auth/audit at scale). Identity-aware proxy + wildcard DNS over per-workspace ALB
  rules (ALB ~100-rule/listener cap). Git pushes over **HTTPS + `gh`** (the SSH
  key authed as `adrian-marza-monite`); local identity pinned to `e6qu` noreply.

## 2026-06-01 — Test strategy & substrate

- Adopted TDD + **ports-and-adapters** (fake + real adapter per external dep) and
  three tiers: unit/contract (commit) · integration (PR) · manual real-AWS (main).
- Chose **sockerless** as the integration substrate over LocalStack (runs real
  containers; covers our ECS/EBS/DynamoDB/IAM/Route53/ACM/KMS surface; dogfoods
  our own tool). LocalStack kept only as an optional cross-check.

## 2026-06-01 — Phase 0 scaffold (Turborepo + CI)

- Stood up the `@edd/*` monorepo; every component builds/tests in isolation.
- Built the TDD centerpiece in `packages/core`: `StorageProvider` port + fake +
  reusable round-trip **contract test** + the workspace lifecycle state machine.
- Scaffolded `config`, `api-contracts`, `authz`, `auth`, `db`, `api-client`,
  `services/reconciler`, `services/ssh-gateway`, `apps/web`; `infra/terraform`
  baseline + committed provider lock; `docker-compose.tier2.yml`.
- Authored CI (`build-test`, `check-deps`, `terraform`) + the manual `e2e-aws`
  skeleton; brought all deps to latest so the freshness gate is green.
- **Lesson:** TS 6 under pnpm needs explicit `@types/node` + `types: ["node"]`;
  Vitest 4 needs vite ≥ 6 (added vite 8 at root).

## 2026-06-01 — Tier-2 harness (DynamoDB Local + ElectroDB)

- Added the **ElectroDB** Workspace entity to `@edd/db` (single table; `byOwner`
  GSI1, `byState` GSI2) + an env-driven client; first integration test
  (put/get + both GSIs) green against DynamoDB Local; wired `pnpm test:integ` +
  the CI `integration` job. Integration files use the `*.integ.ts` suffix so
  `pnpm test` never needs Docker.

## 2026-06-01 — Dep hygiene & portable shell

- Pruned the only two unused deps (`depcheck`). Added the supply-chain floor
  **`minimumReleaseAge: 1440`**; `pnpm outdated` honours it so `check-deps` stays
  read-only and age-aware. Made the shell script portable + `shellcheck`-clean
  (bash & zsh, ubuntu & macOS CI matrix).

## 2026-06-01 — Phase 2: control-plane API + standards charter

- Built the control-plane API (`apps/web`): lifecycle endpoints
  (create/list/get/stop/start/snapshot/delete) with CASL RBAC, over a new
  `@edd/control-plane` `WorkspaceService` (imperative shell) on ElectroDB + the
  pure core; added the `ComputeProvider` port + fake. Integration-tested.
- Recorded the **engineering-standards charter** (`AGENTS.md` §6) and applied it
  repo-wide: branded ids, domain objects across boundaries, FCIS, named
  constants, typed `@edd/config`, explicit named exports, fail-loudly.
- Enabled strict type-aware lint; added **`sast`** (Semgrep) + **`vuln-scan`**
  (Trivy) gates and **`pre-commit`** (with a `commit-msg` AI-attribution stripper).
- **Lesson:** an `export *` barrel caused a `VolumeId`/`SnapshotId` collision —
  switched to explicit named exports (the wildcard antipattern in practice).

## 2026-06-01 — Phase 3: Auth.js (GitHub + Entra) + RBAC

- Wired **Auth.js (NextAuth v5)** with GitHub + Entra and JWT sessions; role
  derived at sign-in via pure `normalizeClaims` (Zod) → `mapClaimsToRole`, with
  env-driven group→role config. `getPrincipal` now reads the session; the
  dev-header shim is gated by `EDD_DEV_AUTH` (tests only).
- **Lesson:** Auth.js (`next/server`) breaks under vitest — lazy `import("../auth")`
  inside `getPrincipal` keeps the module test-safe.

## 2026-06-01 — Phase 6: user portal + admin UI

- Built the Next.js portal over the existing API + Auth.js: server-rendered
  workspaces grid, create-from-catalog, per-workspace lifecycle actions; **RBAC-
  gated** (members own theirs; admins get an "all" view; viewers read-only).
  Distinctive "infra control room" aesthetic, hand-written CSS.
- **Lessons:** drove CSS-var theming via **`data-status` attributes** (inline
  custom-property styles fought the lint rules). Kept `@edd/api-client` ids as
  `string` at the HTTP edge so the browser bundle stays free of `node:` deps.

## 2026-06-01 — Phase 5: reconciler (scale-to-zero)

- Built the **idle reconcile pass** (FCIS): `WorkspaceService.listActive()` →
  pure **`selectIdle`** → `stop` each (snapshot + tear down). `@edd/reconciler`
  exposes a `ReconcilerService` port (unit-tested with a fake; `WorkspaceService`
  satisfies it structurally) + the `Reconciler` shell. Unit + DynamoDB-Local
  integration tests green. (Scheduled snapshots, orphan GC, and the cron runner
  remain — see `DO_NEXT.md`.)

## 2026-06-01 — Sockerless re-evaluation & storage findings

- Re-checked sockerless after upstream changes; verified status **per issue**
  (state_reason + code), since "closed" can mean rejected: **#347** (EBS
  lifecycle) and **#336** (VPC/ENI) genuinely landed; EKS #348 / SES #349 were
  `not_planned`.
- **Filed [#359](https://github.com/e6qu/sockerless/issues/359):** EBS snapshots
  never transition `pending → completed`, so `CreateVolume(SnapshotId)` always
  fails `IncorrectState` — blocks snapshot→restore (SDK repro + code pointer).
- **Key decision:** rejected a special-cased fs-on-`SIM_EBS_DATA_DIR` storage
  adapter (violates the §6.8 endpoint-only rule); removed it. The standard EBS
  API can't read/write a volume's _files_ without attaching it to a task, so a
  standard `StorageProvider` adapter does lifecycle only — **data fidelity needs
  the compute layer** (compute e2e / real-AWS tier), not the storage port.

## 2026-06-02 — Streamlined docs; Phase 5 GC + scheduled snapshots

- Streamlined `AGENTS.md` and the continuity files (cut ~half the lines): merged
  the duplicate component listing, added the missing no-hardcoded-endpoints
  standard (§6.2), moved live sim status to `BUGS.md`, restructured `DO_NEXT.md`
  into decisions / available-now / blocked.
- Extended Phase 5 with two more maintenance passes, decision-free and fully
  testable with fakes + DynamoDB Local (the cron runner that invokes them stays
  AWS-gated):
  - **Orphan GC** — pure `selectOrphanVolumes` / `selectOrphanSnapshots` (reap
    storage no workspace references, past a grace window) + `Reconciler.collectGarbage`
    over new endpoint-only `StorageProvider.listVolumes`/`listSnapshots`/`deleteSnapshot`
    (the `DescribeVolumes`/`DescribeSnapshots`/`DeleteSnapshot` shape) and a new
    `WorkspaceService.listReferencedStorage` keep-set.
  - **Scheduled snapshots** — pure `selectDueForSnapshot` + `Reconciler.snapshotDue`
    over `WorkspaceService.listSnapshotCandidates`; added `latestSnapshotAt` to the
    `Workspace` domain object / DB entity to time them.
- Fixed a latent correctness gap (§0 rule 5): `listActive` (and the new scans)
  now paginate with ElectroDB `{ pages: "all" }` instead of a single page —
  matters at the 200+ target.
- **Upstream:** sockerless **#359** (EBS restore) and **#360** (`DeleteItem`
  returns) were fixed by PR #361; EXT-001 resolved. The endpoint-only EBS adapter
  is now API-unblocked, gated only by EXT-004 (a runnable sim image) and AWS.
- **Stopped at the e2e boundary** (per the user): GC/snapshot logic is green on
  fakes + DynamoDB Local; running it against the real EBS sim / cron is the next,
  still-gated step.
