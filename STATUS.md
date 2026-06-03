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
- **Real adapters** (endpoint-only, sim or AWS): `@edd/storage-ec2`
  (`Ec2StorageProvider`, EBS lifecycle + GC-safe `edd:managed` tagging) and
  `@edd/compute-ecs` (`EcsComputeProvider`, Fargate RunTask/StopTask + managed EBS).
- **Test tiers** (`docker-compose.tier2.yml` / `.e2e.yml`, from-source sim):
  unit/contract · integration (DynamoDB Local + process-mode sim) · **e2e**
  (container-mode sim: workspace data-fidelity + full `WorkspaceService` lifecycle;
  GitHub auth via bleephub; Entra auth via the azure sim).
- **CI**: build-test, integration, e2e, check-deps, terraform, shellcheck, sast
  (Semgrep), vuln-scan (Trivy). Manual `e2e-aws` skeleton. Local pre-commit.

**Verified locally (2026-06-03):** lint 14/14, build 13/13, unit 66, integration
13, e2e 3.

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
- **Next decision-free work:** Teleport/Pomerium-in-Docker SSH/proxy e2e; admin
  base-image catalog; Playwright portal e2e. See `DO_NEXT`.
