# PLAN.md — ecs-dev-desktop

Phased roadmap. Each phase: **Status** (✅ done · 🟡 partial · ⬜ pending), remaining
**Deliverables**, **Gate**. See `AGENTS.md` for architecture, `STATUS.md`/`DO_NEXT.md`
for live state. **Guiding principles:** API-first · independently buildable · snapshot
= persistence · prefer libraries for security · RBAC everywhere · sim endpoint-only.

The build is **test-first against the sockerless sim**, so most phases are proven
mock-free _before_ AWS. The recurring gate is the **AWS account/region** decision
(`DO_NEXT` #1), which unlocks real Terraform + deploy for every phase below.

---

## Phase 0 — Foundations & repo scaffold — ✅ done

Monorepo (Turborepo+pnpm), `@edd/config`, CI (build-test · lint · integration · e2e ·
playwright · check-deps · terraform · shellcheck · sast · vuln-scan), pre-commit,
`infra/terraform` baseline.

- ⬜ **AWS-gated:** real Terraform baseline (VPC, ECS, ECR, DynamoDB+GSIs, KMS, IAM,
  remote state) + `terraform apply` in a sandbox.

## Phase 1 — Single workspace runtime — 🟡 proven on the sim

Stateful-workspace mechanism proven mock-free: real Fargate task on the container-mode
sim writes to ECS-managed EBS → snapshot → new task restores → data present
(`packages/e2e`). `EcsComputeProvider` + full `WorkspaceService` lifecycle run on it.

- ⬜ **AWS-gated:** `infra/images` golden base (code-server + Teleport/sshd + idle-agent,
  Open VSX); real Fargate deploy; cold-start baseline; image vuln scan.
- **Gate:** sim ✅; real EBS durability/latency + cold-start → `e2e-aws`.

## Phase 2 — Control-plane API — ✅ done

`@edd/api-contracts` (Zod), `@edd/db` (ElectroDB), `@edd/core` state machine, `apps/web`
route handlers + CASL RBAC, `@edd/api-client`, endpoint-only `Ec2StorageProvider` +
`EcsComputeProvider`. **Gate:** contract + integration + e2e lifecycle green.

## Phase 3 — Auth + RBAC + workspace routing — 🟡

✅ Auth.js (GitHub + Entra), CASL, group→role; **both logins proven mock-free &
swappable** (bleephub conformant OAuth; azure sim Graph + ROPC). ✅ **Pomerium**
identity-aware `*.devbox.<domain>` wildcard routing proven mock-free (`infra/proxy`).

- ⬜ **Remaining:** real DNS/TLS/ACM (needs DNS #2); authenticated proxy-pass with
  identity headers (browser login → Playwright).
- **Gate:** CASL ✅; both group→role on the sim ✅; wildcard routing + gate ✅; real DNS ⬜.

## Phase 4 — SSH via Teleport — 🟡

✅ Real Teleport cluster + node enrolment + `tsh ssh` connect-as-principal + authz deny,
mock-free in Docker (`services/ssh-gateway`). ✅ Wake-on-connect (control-plane half):
`WorkspaceService.connect()` — idempotent, wakes scaled-to-zero from snapshot, proven
on real ECS+EBS.

- ⬜ **Remaining:** Entra/GitHub→Teleport federation; session recording; the wake-on-
  connect **trigger** (golden image auto-enrols its Teleport agent; gateway calls
  `connect()` — deployment/AWS-tier).
- **Gate:** `tsh ssh` ✅; connect-time wake ✅; recording + e2e-aws SSH-wakes-stopped ⬜.

## Phase 5 — Scale-to-zero + snapshot automation — 🟡

✅ Reconciler: idle stop+snapshot, scheduled snapshots, orphan GC (pure selectors +
port, verified vs sim). ✅ **Activity heartbeat** (control-plane half): `markActivity` +
`WorkspaceService.heartbeat` + `POST /workspaces/:id/heartbeat` refresh `lastActivity`
(wake idle→running) so the reconciler keeps active workspaces alive.

- ⬜ **AWS-gated:** the in-workspace idle-agent that POSTs heartbeats; the cron runner
  (EventBridge / ECS scheduled task); optional warm pool + SOCI.
- **Gate:** idle→stop→snapshot→wake ✅; GC reaps orphans only ✅; heartbeat keep-alive ✅;
  cron + cost metric ⬜.

## Phase 6 — User portal + base-image catalog — ✅ (UI complete)

✅ User portal (RBAC-gated lifecycle, admin "all" view). ✅ Base-image catalog — API
(`CatalogService` CRUD, CASL-gated `/api/base-images`, create enforced against the
enabled catalog) + UI (`/base-images` admin page + create-from-catalog picker). ✅
**Playwright portal e2e** (built app + DynamoDB Local, cookie dev-auth shim, CI job).

## Phase 7 — Hardening, scale & DR — ⬜ pending (AWS-gated)

Autoscaling, warm pools, SOCI; cross-region snapshot copy; secrets in Secrets Manager;
full audit; quota enforcement at scale; DR runbook; load test to 200+.

- **Gate:** 200+ load within latency budget; DR drill (cross-region restore);
  `/security-review` clean; pen-test checklist. (Real AWS only.)

## Phase 8 — Admin console & observability — ⬜ NEXT (design: `docs/admin-ui-design.md`)

A dedicated admin-only **`/admin` sidebar shell** + a troubleshooting surface (component
health, per-workspace diagnostics, logs/audit). **No custom audit store** — observability
is ports-and-adapters: events/audit/logs **derived from current state now**, from
**CloudTrail + CloudWatch** on AWS (endpoint-only swap). Sub-phases:

- 🟡 **8A — Foundation + Health (now, mock-free):** ✅ done — health roll-up
  (`summarizeHealth`, optional `health()` on the Storage/Compute ports, the `pingTable`
  DynamoDB check, `HealthService`), `GET /api/admin/health`, the admin-only `/admin`
  sidebar shell, and the live **Health board** (Playwright-covered). ⬜ **Remaining:**
  per-workspace **Inspect** (state, derived timeline, bindings, snapshots) via `AuditSource`.
- ⬜ **8B — Audit/Logs + Overview + Workspaces + Quotas (now, mock-free):** derived
  `AuditSource`/`LogSource`; **Logs/Audit** screen; admin **Overview** dashboard;
  all-workspaces table; **quotas** (config + create-time enforcement).
- ⬜ **8C — Real cloud data (AWS-gated):** CloudTrail audit adapter, CloudWatch Logs
  (container/app/reconciler), CloudWatch Metrics + Cost dashboard, real ECS/EBS/Teleport/
  Pomerium health. Endpoint-only swap; validated at `e2e-aws`.
- **Gate:** health board + Inspect on the sim ✅(8A); audit/logs/overview/quotas ✅(8B);
  CloudTrail/CloudWatch/cost on real AWS ⬜(8C).
