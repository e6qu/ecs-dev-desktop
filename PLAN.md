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
  idle-agent, Open VSX, OpenSSH registered-key wiring); real Fargate deploy;
  cold-start baseline; image vuln scan.
- **Gate:** sim ✅; real EBS durability/latency + cold-start → `e2e-aws`.

## Phase 2 — Control-plane API — ✅ done

`@edd/api-contracts` (Zod), `@edd/db` (ElectroDB), `@edd/core` state machine, `apps/web`
route handlers + CASL RBAC, `@edd/api-client`, endpoint-only `Ec2StorageProvider` +
`EcsComputeProvider`. **Gate:** contract + integration + e2e lifecycle green.

## Phase 3 — Auth + RBAC + editor routing — 🟡

✅ Auth.js (GitHub + Entra), CASL, group→role; **both logins proven mock-free &
swappable** (bleephub conformant OAuth; azure sim Graph + ROPC). ✅ **Path-based
editor proxy folded into the control-plane app** — the browser reaches the editor at
`app.<domain>/w/<workspace-id>/` (no wildcard DNS/TLS, no cross-subdomain cookie),
served by the custom server (`apps/web/server.ts` + `apps/web/lib/workspace-proxy.ts`).
✅ **Single-system authorization** — the proxy authorizes off the **same Auth.js
session** that protects the portal, by uid-based ownership (`session.uid ===
workspace.ownerId`) or admin, checked in-process; no Pomerium, no PDP round-trip, no
email bridge. (`apps/web/lib/workspace-proxy.e2e.ts`)

✅ **Auth.js callback routes** proven against the sims: the real NextAuth handlers
driven csrf → signin → IdP → callback → session (bleephub team→admin role; Entra
leg over TLS in `e2e-https`; sockerless#547 gates Entra group→role interactively).

- ⬜ **Remaining:** real DNS/TLS/ACM for `app.<domain>` (needs DNS #2); full GitHub
  OAuth browser login (requires Playwright + DNS).
- **Gate:** CASL ✅; both group→role on the sim ✅; path-based `/w/<id>/` editor
  proxy + uid-ownership authz ✅; Auth.js callback wiring ✅; real DNS ⬜.

## Phase 4 — SSH gateway — 🟡

✅ Standard OpenSSH (`sshd`) workspace node + **registered-key auth** —
connect-as-user and authz-deny proven mock-free in Docker (`services/ssh-gateway`).
The gateway and workspace sshd both authorize the user's registered public key via
the control plane's `ssh-authorize`; Auth.js handles user auth. (The original
ephemeral-CA / short-lived certificate approach was superseded and removed in 4b —
registered-key only, no CA.) ✅ Wake-on-connect proxy component path:
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

### 4b — User-registered SSH keys + per-workspace subdomain — 🟡 (dual-trust SSH done; only AWS-gated ingress left)

**Goal:** a user registers their SSH **public** key once (account settings), then
SSHes to each running workspace at its **own subdomain** (`<workspaceId>.<sshzone>`).
Decision (confirmed with the user; **replaces** §1's original "short-lived user
certs" — SSH is now registered-key only, no CA):
authenticate the human by the **registered key** (Codespaces/Coder-style) and
authorize the specific workspace **by ownership at connect time**. Routing is
wildcard-DNS → single public gateway (stock OpenSSH; SSH has no SNI, so the
workspace id rides in the subdomain/username — not a TLS-SNI tunnel, not a direct
public endpoint). **Sub-decision resolved → dual-trust (no Teleport).** The proxy
is a transparent tunnel, so the user authenticates end-to-end with the workspace
node; both the gateway and the workspace sshd authorize the **same registered key**
via `ssh-authorize`. Chosen over a terminating bastion because public surface is
**identical** either way (only the bastion is public; workspaces stay private) — the
differentiator is internal trust, and a terminating bastion in stock OpenSSH is
shell-only (breaks VS Code Remote-SSH / scp / forwarding), while a transparent
terminating proxy would mean adopting/​building Teleport. Dual-trust keeps full
transparency at the same public surface; the workspace authorizes per-connection
(revocable), so it never stands-trusts a user key.

- ✅ **Slice 1 — foundation (no AWS):** branded `SshKeyId`/`SshPublicKey`/
  `SshKeyFingerprint`, pure `fingerprintPublicKey` (matches `ssh-keygen -lf`),
  `sshKeyType`, `workspaceSshHost(id, baseDomain)` (`@edd/core`); register/list/delete
  Zod contracts reusing the boundary key validation (`@edd/api-contracts`); the
  `sshKey` ElectroDB entity — PK=ownerId/SK=keyId + `byFingerprint` GSI1 for the
  gateway lookup and **global key uniqueness** (`@edd/db`); `SshKeyService`
  (register w/ dedup + `SshKeyConflictError`, list, ownership-scoped delete,
  `ownerForKey` lookup) (`@edd/control-plane`). Unit/contract green; service+entity
  integ green on DynamoDB Local.
- ✅ **Slice 2 — API + portal + authorize seam (no AWS):** `/api/ssh-keys`
  (register/list/delete, 409 on conflict, ownership-scoped delete); the gateway's
  connect-time decision endpoint `POST /api/workspaces/:id/ssh-authorize`
  (gateway machine-auth; authorize iff the presented key is registered to the
  workspace owner; returns the principal) — the integration seam the gateway
  consumes; api-client methods; Settings → SSH keys page + per-workspace `ssh …`
  command on the workspace card (shown when `EDD_SSH_BASE_DOMAIN` is set); config
  `SSH_BASE_DOMAIN`. Route integ green on DynamoDB Local; web typecheck/lint/build
  green.
- ✅ **Slice 2c — dual-trust sshd wiring (no AWS; docker e2e validated).** Both
  sshds authorize the registered key via `ssh-authorize`.
  - `ssh-authorize` accepts the gateway token **and** the workspace agent token
    (integ green).
  - **Gateway** sshd → `AuthorizedKeysCommand` (`authorized-keys.sh`, gateway token);
    transparent `nc` forward unchanged, so the session stays end-to-end.
  - **Golden image** (`infra/images/base`): added `AuthorizedKeysCommand`
    (`authorized-keys.sh`, agent token, root, root-only `/run/edd-ssh-env`).
  - **e2e** (`ssh-proxy.e2e.ts`): rewritten self-contained — an in-process stub
    control plane in a **worker thread** (keeps serving while the main thread blocks on
    `spawnSync`) + docker-run node + proxy. Asserts a registered key is authorized at
    both hops and lands on the node (`whoami=workspace`), and an unregistered key is
    denied. **Validated locally 2/2 green.** Deleted the obsolete cert-based
    `ssh-connect.e2e.ts` + `docker-compose.ssh.yml`; CI/test-e2e build
    `edd-workspace-node:e2e` and pass `NODE_IMAGE`.
- ✅ **Slice 2d — clean-break CA removal (no AWS)** (`feat/ssh-registered-key-only`).
  With dual-trust proven, deleted the entire SSH-CA path (no additive shim, no legacy):
  the `/ssh-cert` route + `lib/ssh-cert.ts`, `sshCert*` contracts + api-client method,
  `scripts/gen-ssh-ca.sh`, `docker-compose.ssh.yml`, the `EDD_SSH_CA_*` config +
  compute-provider env injection, the Terraform `ssh_ca_public_key` var **and** its #108
  half-config `precondition`, and all CA wiring from the golden/gateway/node images.
  Migrated the cert-based e2e suites to registered keys: `golden-workspace-ssh` +
  `data-durability` use an in-process `ssh-authorize` **stub** control plane;
  `user-journey` registers an account key via the API; `ssh-wake-chain` registers a key
  and proves the gateway wakes a STOPPED workspace through the **real** control plane
  (landing-on-node stays covered by `ssh-proxy`). Docs + the architecture table +
  the `EDD_SSH_CA_KEY` deploy secret all updated.
- 🟦 **Slice 3 — ingress: terraform DONE (2026-06-25), live proof e2e-aws.** The gated NLB + TCP:22
  listener + target group + SSH-gateway ECS service + Route53 `*.<ssh_base_domain>` wildcard ship in
  `ssh-ingress.tf`; terraform-sim asserts the resources are created to spec. The live ssh-through-NLB
  byte-stream proof is e2e-aws-only until sockerless **#683** (raw-TCP NLB data plane) — and is gated on
  decisions #1 (account) / #2 (SSH zone).
- **Gate:** register/list/delete ✅; ssh-authorize decision (both tokens) ✅; Settings
  page + per-workspace command ✅; dual-trust registered-key auth at both hops ✅
  (docker e2e); subdomain DNS + public SSH ingress ⬜ (e2e-aws, Slice 3).

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

- ✅ **Recurring cron firing — sim-proven** (`scheduler-recurrence.integ.ts`): a `rate(1 minute)`
  EventBridge schedule fires its ECS RunTask target repeatedly (≥2 fires, CloudTrail) and re-arms (survives
  `ActionAfterCompletion: DELETE`, unlike a one-shot `at()`). The production `rate(5 minutes)` schedule's
  _creation_ is covered by terraform-sim; this proves a _recurring_ schedule fires on cadence.
- ⬜ **AWS-gated:** SOCI; real-cadence cost metric at scale. (Cron is now sim-proven above; `cron()` also
  works — BUG-1531/#489 fixed upstream.)
- **Gate:** idle→stop→snapshot→wake ✅; GC reaps orphans only ✅; heartbeat keep-alive ✅
  (incl. live in-workspace agent); reconciler container + scheduler e2e ✅ (incl.
  real task stop); drift detection ✅; concurrent-wake no-leak ✅; recurring cron firing ✅ (sim);
  SOCI + real-scale cost metric ⬜.

## Phase 6 — User portal + base-image catalog — ✅ (UI complete)

✅ User portal (RBAC-gated lifecycle, admin "all" view). ✅ Base-image catalog — API
(`CatalogService` CRUD, CASL-gated `/api/base-images`, create enforced against the
enabled catalog) + UI (`/base-images` admin page + create-from-catalog picker). ✅
**Playwright portal e2e** (built app + DynamoDB Local, cookie dev-auth shim, CI job).

## Phase 9 — Code-review remediation & pre-AWS hardening — ⬜ actionable now (no AWS gate)

From the 2026-06-19 `codex` review (12 findings, 4 re-verified) plus previously-deferred items that
became actionable. **None of this is gated on the AWS account decision** — code fixes land + unit/integ
test on fakes/DynamoDB-Local; the terraform/IAM fixes validate against the `terraform-sim` IAM
simulation; `e2e-aws` only adds final real-enforcement proof. Tracked as bugs in `BUGS.md` → Open and
prioritized in `DO_NEXT.md`. **Deliverables (do not defer any actionable item):**

- **Critical** — (1) require a real compute/storage provider in production (kill the silent fake
  fallback, `apps/web/lib/control-plane.ts`); (2) terraform IAM for the per-workspace agent-secret
  create/inject path (scoped `CreateSecret`/`PutSecretValue`/tag + execution-role read on
  `edd/workspace/*/agent`); (3) create + pass the workspace execution/task role ARNs (ECR pull,
  awslogs, secret injection, `iam:PassRole`); (4) transactional SSH-key fingerprint uniqueness.
- **High** — (5) early/initial snapshot so a fresh workspace is recoverable before the 6h cadence;
  (6) fail-loud + portal-visible bootstrap status for repo-clone / git-credential failures (non-dev
  safety); (7) GC per-workspace Secrets Manager agent secrets on terminate + periodic secret GC.
- **Medium / Low** — (8) bound ECS task-definition revision growth; (9) editor-proxy ownership is now
  by a stable subject (the Auth.js session `uid` vs `workspace.ownerId`), not a fragile email match —
  the former "require a valid owner identity for proxy-routed workspaces" concern is closed by the
  path-based in-app proxy; (10) reject invalid `?window=` instead of coercing to `all`; (11) fix the
  stale topology CA-cert edge text.
- **Deferred → now actionable:** **cross-region EBS snapshot DR** (snapshot → `CopySnapshot` →
  restore) — **DONE**: `StorageProvider.copySnapshot` + the EC2 adapter (cross-region client by
  coordinates alone, §6.9), proven by a sim integ (snapshot→copy→restore) now that **sockerless#602**
  landed. `CONNECTION_TOKEN` — on review this is **correctly coupled to a future DYNAMIC
  per-connection token**, NOT a free-standing fix: the image already consumes `CONNECTION_TOKEN` when
  injected (`entrypoint.sh`), but the current model runs the IDE **tokenless behind the in-app
  `/w/<id>/` proxy** (`EDD_DISABLE_CONNECTION_TOKEN=1` — the control-plane app's path proxy is the
  authorization point, gating each request on the Auth.js session/ownership). Generating/persisting/
  injecting a token has no consumer until the proxy forwards it, so building it now would be dead
  code (§6.5). It stays with that extension; the image side is already ready.

- **Gate:** each item proven by a unit/integ/e2e test on fakes / DynamoDB-Local / the sim (incl. the
  `terraform-sim` IAM simulation for the IAM/role items + a sim DR copy e2e); real-enforcement checks
  for the IAM/role items roll into `e2e-aws` when AWS lands.

## Phase 7 — Hardening, scale & DR — ⬜ pending (AWS-gated)

Autoscaling, warm pools, SOCI; cross-region snapshot copy; secrets in Secrets Manager;
full audit; quota enforcement at scale; DR runbook; load test to 200+. (The **cross-region
snapshot-copy DR flow** is no longer parked here — it is sim-validatable now via
**sockerless#602** and pulled forward into Phase 9; only the real cross-region/200+-load
proofs remain AWS-gated here.)

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
  integration-tested against the sim (sim has `cloudtrail.go` + `cloudwatch.go`). **CloudWatch Metrics
  (EMF) now sim-proven too** (`@edd/cloudwatch-metrics` `emf-metric-sink.integ.ts`): a real `EmfMetricSink`
  document shipped via `PutLogEvents` is extracted + queryable through the CloudWatch metric APIs
  (`ListMetrics`/`GetMetricStatistics`) — our EMF shape is conformant (sockerless #604). Only the Cost
  _dashboard_ visualization remains account-gated.
- **Gate:** health board + Inspect ✅(8A); audit/logs/overview/quotas ✅(8B);
  CloudTrail/CloudWatch-Logs adapters ✅(8C); CloudWatch-Metrics EMF extraction ✅ (sim); Cost dashboard
  on real AWS ⬜.
