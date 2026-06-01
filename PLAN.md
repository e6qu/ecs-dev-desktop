# PLAN.md — ecs-dev-desktop

Phased roadmap for building the platform. Each phase lists **Goal**,
**Deliverables**, and a **Testing gate** that must be green before advancing.

See `AGENTS.md` for architecture decisions and component layout.

---

## Guiding principles

- **API-first.** Define contracts (`packages/api-contracts`) before
  implementing endpoints or UI. The UI consumes the same API as external clients.
- **Independently buildable components.** Every component builds and tests in
  isolation (`pnpm --filter <name> build|test`).
- **Snapshot = persistence.** Stateful, snapshottable, and scale-to-zero are one
  mechanism (EBS snapshot hydrate/restore).
- **Prefer libraries for security.** Auth.js, CASL, Teleport, AWS SDK.
- **RBAC everywhere.** Same CASL abilities enforced in API and reflected in UI.

---

## Phase 0 — Foundations & repo scaffold

**Goal:** A building, deployable skeleton with infra baseline and CI.

**Deliverables**
- Turborepo + pnpm workspace with all `apps/`, `services/`, `packages/`,
  `infra/` dirs stubbed and building.
- `packages/config` (shared tsconfig/eslint/env schema).
- `infra/terraform` baseline: VPC (public+private subnets), ECS cluster, ECR,
  **DynamoDB table** (single-table + GSIs), KMS keys, IAM scaffolding, remote
  state backend.
- Empty `apps/web` Next.js app deploys to ECS Fargate behind an ALB.
- CI: install → lint → typecheck → build → `terraform plan`.

**Testing gate**
- `pnpm build && pnpm lint && pnpm test` green at root and per-component.
- `terraform validate` + `terraform plan` clean; `apply` succeeds in a sandbox.
- Smoke: deployed Next app returns 200 on `/healthz`.

---

## Phase 1 — Single workspace runtime

**Goal:** One real VS Code workspace on Fargate with persistent, snapshottable
storage — driven by hand.

**Deliverables**
- `infra/images`: golden base image = **code-server** + `sshd`/Teleport agent +
  idle-agent, extensions via Open VSX.
- Fargate task definition with an **ECS-managed EBS volume** mounted at
  `/home/<user>` + `/workspaces`.
- Documented manual flow: `RunTask` → reach code-server in browser → write file →
  snapshot volume → relaunch task hydrated from `snapshotId` → file present.

**Testing gate**
- Manual e2e: file written in workspace survives **stop → snapshot → wake** from
  snapshot.
- Volume hydrate-from-snapshot verified; cold-start time recorded as a baseline.
- Image vulnerability scan passes in CI.

---

## Phase 2 — Control-plane API (Next.js, API-first)

**Goal:** Programmatic workspace lifecycle via a typed API.

**Deliverables**
- `packages/api-contracts`: Zod schemas for create / start / stop / snapshot /
  restore / clone / delete / list / get.
- `packages/db`: ElectroDB entities (workspace, snapshot, volume, baseImage,
  user, auditLog) + access patterns/GSIs (`byUser`, `byStatus+lastActivity`).
- `packages/core`: workspace lifecycle **state machine** (provisioning → running
  → idle → stopped/snapshotted → terminating).
- `apps/web` route handlers implementing the contracts, calling ECS
  `RunTask`/`StopTask` + EBS snapshot APIs.
- `packages/api-client`: typed client generated from contracts.

**Testing gate**
- Contract tests (schema round-trips) pass.
- Integration tests against **DynamoDB Local** + mocked/LocalStack ECS.
- E2e via API: create → snapshot → restore → clone → delete, asserting state
  machine transitions and DynamoDB records.

---

## Phase 3 — Auth + RBAC + workspace routing

**Goal:** Real login (both IdPs), enforced RBAC, and authenticated routing to
workspaces.

**Deliverables**
- `packages/auth`: Auth.js with **GitHub OAuth** + **Azure Entra ID**; map IdP
  groups/claims → roles (`admin`, group-scoped, `user`).
- `packages/authz`: **CASL** abilities; enforced in API route handlers and used
  to gate UI affordances.
- Identity-aware reverse proxy (e.g. **Pomerium**) with wildcard
  `*.devbox.<domain>` routing to the correct workspace via the registry.

**Testing gate**
- Unit: CASL ability matrix (admin vs group vs user × each action).
- E2e: login via GitHub **and** Entra; unauthorized actions return 403 in API
  and are hidden in UI.
- Proxy routes `alice.devbox.<domain>` to Alice's workspace; denies others.

---

## Phase 4 — SSH via Teleport

**Goal:** Audited SSH + VS Code Remote-SSH into workspaces.

**Deliverables**
- `services/ssh-gateway`: Teleport cluster, workspaces enrolled as nodes,
  identity federated from Entra/GitHub, session recording on.
- Wake-on-connect: SSH to a scaled-to-zero workspace triggers a wake.

**Testing gate**
- E2e: `tsh ssh` / `ssh` and VS Code Remote-SSH connect to a workspace.
- Audit log + session recording captured; unauthorized user denied.
- SSH to a stopped workspace wakes it and connects.

---

## Phase 5 — Scale-to-zero + snapshot automation

**Goal:** Hands-off cost control and persistence.

**Deliverables**
- idle-agent emits activity heartbeats (editor/terminal/SSH), written on
  transitions / coarse interval (heartbeat discipline).
- `services/reconciler`: stop idle workspaces (snapshot + tear down), wake on
  access, scheduled point-in-time snapshots, **orphan volume/snapshot GC**.
- Optional warm pool + SOCI lazy image pull to cut cold-start.

**Testing gate**
- E2e: idle → auto-stop → snapshot → wake-from-snapshot, state intact.
- GC removes orphaned volumes/snapshots and nothing live.
- Cold-start budget measured; cost-savings metric emitted.

---

## Phase 6 — Admin UI + user portal

**Goal:** Full self-service + operations UIs over the API.

**Deliverables**
- User portal: sign in, create workspace from **base-image catalog**, start/stop,
  manage snapshots, SSH instructions, "Open in VS Code".
- Admin UI: fleet list/filter, start/stop/restart/kill, snapshot/restore/clone,
  base-image catalog management, users/roles/quotas, cost dashboard.

**Testing gate**
- Playwright e2e for both portals; RBAC-gated views verified.
- Admin actions reflected in DynamoDB + ECS; accessibility smoke pass.

---

## Phase 7 — Hardening, scale & DR

**Goal:** Production-ready at 200+.

**Deliverables**
- Autoscaling, warm pools, SOCI; cross-region snapshot copy; secrets in Secrets
  Manager; full audit; quota enforcement.
- DR runbook; load test to 200+ concurrent workspaces.

**Testing gate**
- Load test sustains 200+ workspaces within latency budget.
- DR drill (restore from cross-region snapshots) succeeds.
- `/security-review` clean; pen-test checklist completed.
