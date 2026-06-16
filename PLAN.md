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

✅ **Auth.js callback routes** proven against the sims: the real NextAuth handlers
driven csrf → signin → IdP → callback → session (bleephub team→admin role; Entra
leg over TLS in `e2e-https`; sockerless#547 gates Entra group→role interactively).

- ⬜ **Remaining:** real DNS/TLS/ACM (needs DNS #2); full GitHub OAuth browser login
  (requires Playwright + DNS).
- **Gate:** CASL ✅; both group→role on the sim ✅; wildcard routing + gate ✅;
  authenticated proxy-pass with identity headers ✅; Auth.js callback wiring ✅;
  real DNS ⬜.

## Phase 4 — SSH gateway — 🟡

✅ Standard OpenSSH (`sshd`) workspace node + ephemeral SSH CA + certificate auth +
`AuthorizedPrincipalsFile` RBAC — connect-as-principal + authz-deny mock-free in Docker
(`services/ssh-gateway`). Control plane owns the CA; Auth.js handles user auth, portal
issues short-lived SSH certificates. ✅ Wake-on-connect proxy component path:
`WorkspaceService.connect()` is idempotent and wakes scaled-to-zero from snapshot;
the gateway calls `connect` + `connect-info` before forwarding to a workspace node.

✅ **Gateway machine-auth + real-control-plane wake chain (sim):** per-workspace
HMAC tokens (`EDD_GATEWAY_SECRET`); chain e2e proves ssh → ForceCommand → real
`/connect` wake from stopped → forward. The LIVE user journey covers
wake-on-connect against a real ECS workspace task on the container-mode sim.

- ⬜ **Remaining:** session recording (deploy-tier, CloudTrail for audit).
- **Gate:** `ssh` connect-as-principal ✅; authz-deny ✅; managed-EBS golden SSH ✅;
  connect-time wake (real CP + real sim task) ✅; session recording ⬜;
  e2e-aws SSH-wakes-stopped ⬜.

### 4b — User-registered SSH keys + per-workspace subdomain — 🟡 (foundation landed)

**Goal:** a user registers their SSH **public** key once (account settings), then
SSHes to each running workspace at its **own subdomain** (`<workspaceId>.<sshzone>`).
Decision (confirmed with the user; refines §1's "short-lived user certs"): the
**human→gateway hop authenticates by the registered key** (Codespaces/Coder-style)
and authorizes the specific workspace **by ownership at connect time**; the SSH **CA
is retained for the internal gateway↔workspace hop**. Routing is wildcard-DNS →
single public gateway (stock OpenSSH; SSH has no SNI, so the workspace id rides in
the subdomain/username — not a TLS-SNI tunnel, not a direct public endpoint).

- ✅ **Slice 1 — foundation (no AWS):** branded `SshKeyId`/`SshPublicKey`/
  `SshKeyFingerprint`, pure `fingerprintPublicKey` (matches `ssh-keygen -lf`),
  `sshKeyType`, `workspaceSshHost(id, baseDomain)` (`@edd/core`); register/list/delete
  Zod contracts reusing the boundary key validation (`@edd/api-contracts`); the
  `sshKey` ElectroDB entity — PK=ownerId/SK=keyId + `byFingerprint` GSI1 for the
  gateway lookup and **global key uniqueness** (`@edd/db`); `SshKeyService`
  (register w/ dedup + `SshKeyConflictError`, list, ownership-scoped delete,
  `ownerForKey` lookup) (`@edd/control-plane`). Unit/contract green; service+entity
  integ green on DynamoDB Local.
- ⬜ **Slice 2 — shell (no AWS):** `/api/ssh-keys` routes (register/list/delete);
  Settings → SSH keys portal page; per-workspace `ssh …` command surfaced on the
  workspace card/detail; gateway `AuthorizedKeysCommand` → control-plane key lookup;
  per-connection ownership authz (replacing the cert-principal check on the human
  hop); subdomain→workspace resolution. e2e via `docker-compose.ssh.yml`.
- ⬜ **Slice 3 — ingress (AWS-gated, decision #1):** public SSH NLB + listener;
  Route53 `*.<sshzone>` wildcard wired to the gateway.
- **Gate:** register/list/delete ✅ (unit+integ); `AuthorizedKeysCommand` lookup ⬜;
  ownership-authz-by-connection ⬜; subdomain routing ⬜; e2e key→subdomain→shell ⬜;
  e2e-aws public SSH ingress ⬜.

## Phase 5 — Scale-to-zero + snapshot automation — 🟡

✅ Reconciler: idle stop+snapshot, scheduled snapshots, orphan GC (pure selectors +
port, verified vs sim). ✅ **Activity heartbeat** (control-plane half): `markActivity` +
`WorkspaceService.heartbeat` + `POST /workspaces/:id/heartbeat` refresh `lastActivity`.
✅ **Reconciler container** (`services/reconciler/src/run.ts` + `Dockerfile`): esbuild
bundles the monorepo entry point into `dist/run.js`. ✅ **End-to-end scheduler→container
test** (`packages/e2e/src/reconciler-container.e2e.ts`): EventBridge `at(...)` schedule
fires → ECS RunTask → reconciler container sweeps → exits 0 → CloudWatch Logs contain
JSON result.

✅ **Scale-to-zero proven against real sim compute:** the reconciler container e2e
seeds a stale workspace backed by a running golden-image task; the sweep snapshots
and stops it. ✅ **In-workspace heartbeat proven live:** the idle-agent in a real
task posts HMAC heartbeats to the real control plane (live user journey). Tuning
knobs exist: `EDD_HEARTBEAT_INTERVAL_S` (task env), `EDD_IDLE_THRESHOLD_MS`/
`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_GC_GRACE_MS` (reconciler). ✅ **Drift detection:**
the reconciler sweeps first for tasks that died out-of-band (crash/eviction) via
`ComputeProvider.taskState()` and reconciles the record to `stopped`/`error`
(e2e kills a task with raw ECS StopTask). ✅ **Scale honesty:** lifecycle reads
paginate fully (`pages:"all"`) — fixing a quota-bypass-at-scale; integ sweeps a
450-record fleet. ✅ **Concurrency-safe:** optimistic-concurrency `version`
conditions every transition write so concurrent wakes can't leak ECS tasks.

- ⬜ **AWS-gated:** cron (`rate(5 minutes)` default; `cron()` also works —
  BUG-1531/#489 fixed upstream); SOCI; cost metric.
- **Gate:** idle→stop→snapshot→wake ✅; GC reaps orphans only ✅; heartbeat keep-alive ✅
  (incl. live in-workspace agent); reconciler container + scheduler e2e ✅ (incl.
  real task stop); drift detection ✅; concurrent-wake no-leak ✅; real cron + cost metric ⬜.

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
