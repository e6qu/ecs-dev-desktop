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

- ⬜ **AWS-gated:** publish the `infra/images` golden base (OpenVSCode Server +
  idle-agent, Open VSX, OpenSSH CA/principal wiring); real Fargate deploy;
  cold-start baseline; image vuln scan.
- **Gate:** sim ✅; real EBS durability/latency + cold-start → `e2e-aws`.

## Phase 2 — Control-plane API — ✅ done

`@edd/api-contracts` (Zod), `@edd/db` (ElectroDB), `@edd/core` state machine, `apps/web`
route handlers + CASL RBAC, `@edd/api-client`, endpoint-only `Ec2StorageProvider` +
`EcsComputeProvider`. **Gate:** contract + integration + e2e lifecycle green.

## Phase 3 — Auth + RBAC + workspace routing — 🟡

✅ Auth.js (GitHub + Entra), CASL, group→role; **both logins proven mock-free &
swappable** (bleephub conformant OAuth; azure sim Graph + ROPC). ✅ **Pomerium**
identity-aware `*.devbox.<domain>` wildcard routing proven mock-free (`infra/proxy`).
✅ **Authenticated proxy-pass with identity headers** — full OIDC flow via azure-sim
(code issued immediately, no browser required); `X-Pomerium-Jwt-Assertion` present
in proxied response; `_pomerium` session cookie set. (`packages/e2e/src/pomerium-authed.e2e.ts`)

- ⬜ **Remaining:** real DNS/TLS/ACM (needs DNS #2); full GitHub OAuth browser login
  (requires Playwright + DNS).
- **Gate:** CASL ✅; both group→role on the sim ✅; wildcard routing + gate ✅;
  authenticated proxy-pass with identity headers ✅; real DNS ⬜.

## Phase 4 — SSH gateway — 🟡

✅ Standard OpenSSH (`sshd`) workspace node + ephemeral SSH CA + certificate auth +
`AuthorizedPrincipalsFile` RBAC — connect-as-principal + authz-deny mock-free in Docker
(`services/ssh-gateway`). Control plane owns the CA; Auth.js handles user auth, portal
issues short-lived SSH certificates. ✅ Wake-on-connect proxy component path:
`WorkspaceService.connect()` is idempotent and wakes scaled-to-zero from snapshot;
the gateway calls `connect` + `connect-info` before forwarding to a workspace node.

- ⬜ **Remaining:** restore full golden-image SSH e2e after sockerless #526/#527;
  session recording (deploy-tier, CloudTrail for audit); full wake-on-connect through
  a real ECS workspace task.
- **Gate:** `ssh` connect-as-principal ✅; authz-deny ✅; connect-time wake ✅;
  session recording ⬜; e2e-aws SSH-wakes-stopped ⬜.

## Phase 5 — Scale-to-zero + snapshot automation — 🟡

✅ Reconciler: idle stop+snapshot, scheduled snapshots, orphan GC (pure selectors +
port, verified vs sim). ✅ **Activity heartbeat** (control-plane half): `markActivity` +
`WorkspaceService.heartbeat` + `POST /workspaces/:id/heartbeat` refresh `lastActivity`.
✅ **Reconciler container** (`services/reconciler/src/run.ts` + `Dockerfile`): esbuild
bundles the monorepo entry point into `dist/run.js`. ✅ **End-to-end scheduler→container
test** (`packages/e2e/src/reconciler-container.e2e.ts`): EventBridge `at(...)` schedule
fires → ECS RunTask → reconciler container sweeps → exits 0 → CloudWatch Logs contain
JSON result.

- ⬜ **AWS-gated:** real `COMPUTE_PROVIDER=ecs` run (idle detection over real ECS tasks);
  real in-workspace heartbeat (idle-agent already ships in the golden image); cron
  (`rate(5 minutes)` default; `cron()` syntax also works — BUG-1531/#489 fixed upstream); SOCI.
- **Gate:** idle→stop→snapshot→wake ✅; GC reaps orphans only ✅; heartbeat keep-alive ✅;
  reconciler container + scheduler e2e ✅; real cron + cost metric ⬜.

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

## Phase 8 — Admin console & observability — ✅ 8A+8B+8C done on the sim (design: `docs/admin-ui-design.md`)

A dedicated admin-only **`/admin` sidebar shell** + a troubleshooting surface (component
health, per-workspace diagnostics, logs/audit). **No custom audit store** — observability
is ports-and-adapters: events/audit/logs **derived from current state now**, from
**CloudTrail + CloudWatch** on AWS (endpoint-only swap). Sub-phases:

- ✅ **8A — Foundation + Health + Inspect (mock-free):** health roll-up
  (`summarizeHealth`, port `health()`, `pingTable`, `HealthService`), `GET /api/admin/health`,
  the admin-only `/admin` sidebar shell, the live **Health board**, the all-workspaces
  table, and per-workspace **Inspect** (detail, bindings, snapshots, pure-derived
  lifecycle timeline). All Playwright-covered.
- ✅ **8B — Overview + Quotas + Audit/Logs (now, mock-free):** admin **Overview**
  dashboard (`tallyWorkspaceStates` and catalog stats); **quotas** (per-role config
  via `EDD_QUOTA_<ROLE>`, pure `withinWorkspaceQuota`, create-time enforcement, the
  `/admin/quotas` limits-and-usage page); and the **Logs/Audit** screen — pure
  `deriveFleetAudit`/`auditToLogLines`, the `AuditSource`/`LogSource` ports with
  `DerivedAuditSource`/`DerivedLogSource` local adapters, `GET /api/admin/audit` and
  `GET /api/admin/logs`, the `/admin/logs` page (derived audit feed plus the
  control-plane log stream; reconciler/container streams marked CloudWatch-on-AWS).
  All Playwright-covered.
- ✅ **8C — CloudTrail + CloudWatch Logs adapters (sim-proven):** `@edd/cloudtrail-audit`
  (`CloudTrailAuditSource`) + `@edd/cloudwatch-logs` (`CloudWatchLogSource`) — endpoint-only,
  integration-tested against the sim (sim has `cloudtrail.go` + `cloudwatch.go`). CloudWatch
  Metrics + Cost dashboard remain account-gated.
- **Gate:** health board + Inspect ✅(8A); audit/logs/overview/quotas ✅(8B);
  CloudTrail/CloudWatch adapters ✅(8C); Metrics/Cost on real AWS ⬜.
