# PLAN.md — ecs-dev-desktop

Phased roadmap. Each phase: **Goal**, **Status**, remaining **Deliverables**, and
a **Gate**. Status: ✅ done · 🟡 partial · ⬜ pending. See `AGENTS.md` for the
architecture and `STATUS.md`/`DO_NEXT.md` for live state.

**Guiding principles:** API-first (contracts before endpoints/UI) · independently
buildable components · snapshot = persistence · prefer libraries for security ·
RBAC everywhere · sockerless sim consumed endpoint-only.

The build is **test-first against the sockerless sim**, so most phases are proven
mock-free _before_ AWS. The recurring gate is the **AWS account/region** decision,
which unlocks real Terraform + deployment for every phase below.

---

## Phase 0 — Foundations & repo scaffold — ✅ done

Monorepo (Turborepo+pnpm, all components build/test in isolation), `@edd/config`,
CI (build-test/lint/typecheck/integration/e2e/check-deps/terraform/shellcheck/
sast/vuln-scan), `infra/terraform` baseline (`versions.tf` + provider lock).

- ⬜ **Remaining (AWS-gated):** real Terraform baseline (VPC, ECS, ECR, DynamoDB+
  GSIs, KMS, IAM, remote state) + `terraform apply` in a sandbox.

## Phase 1 — Single workspace runtime — 🟡 proven on the sim

The stateful-workspace mechanism is **proven mock-free**: a real Fargate task on
the container-mode sim writes to an ECS-managed EBS volume → snapshot → a new task
restores it → data present (`packages/e2e`). `EcsComputeProvider` + the full
`WorkspaceService` lifecycle run against it.

- ⬜ **Remaining:** `infra/images` golden base (code-server + Teleport/sshd +
  idle-agent, Open VSX); real Fargate deploy; cold-start baseline; image vuln scan.
- **Gate:** done at sim level (write survives stop→snapshot→wake). Real EBS
  durability/latency + cold-start → the manual `e2e-aws` tier.

## Phase 2 — Control-plane API — ✅ done

`@edd/api-contracts` (Zod), `@edd/db` (ElectroDB), `@edd/core` state machine,
`apps/web` route handlers + CASL RBAC, `@edd/api-client`, and the real endpoint-only
`Ec2StorageProvider` + `EcsComputeProvider`.

- **Gate:** contract + integration (DynamoDB Local + sim) + e2e lifecycle — green.

## Phase 3 — Auth + RBAC + workspace routing — 🟡

✅ Auth.js (GitHub + Entra), CASL abilities, group→role mapping, **both logins proven
mock-free**: GitHub vs bleephub, and Entra via the azure sim (standard Graph
provisioning + ROPC, endpoint-only — sockerless #390/#391 fixed in #393).

✅ Identity-aware proxy (**Pomerium**) + `*.devbox.<domain>` wildcard routing proven
mock-free in Docker (`infra/proxy`, OIDC IdP = the azure sim): subdomains route to a
workspace upstream; unauthenticated access is gated to sign-in.

- ⬜ **Remaining:** real DNS/TLS/ACM for `*.devbox.<domain>` (needs DNS #2); the
  authenticated proxy-pass with identity headers (browser login → Playwright). GitHub
  e2e fixture is owed a swappability rework (now unblocked, deferred — see `DO_NEXT`).
- **Gate:** CASL matrix ✅; GitHub + Entra group→role proven on the sim ✅; wildcard
  routing + identity gate proven on the harness ✅; real DNS routing ⬜.

## Phase 4 — SSH via Teleport — 🟡

✅ Real Teleport cluster + workspace node enrolment + `tsh ssh` connect as the
workspace principal + authz deny, proven mock-free in Docker (`services/ssh-gateway`,
`docker-compose.ssh.yml`).

✅ Wake-on-connect (control-plane half): `WorkspaceService.connect()` ensures a
workspace is reachable — idempotent, waking a scaled-to-zero one from its snapshot —
proven on real ECS+EBS (lifecycle e2e).

- ⬜ **Remaining:** identity federation from Entra/GitHub into Teleport; session
  recording; the wake-on-connect **trigger** (golden image auto-enrolls its Teleport
  agent on task start; gateway calls `connect()` — deployment/AWS-tier).
- **Gate:** `tsh ssh` connect ✅; connect-time wake on the sim ✅; audit + recording ⬜;
  end-to-end SSH-wakes-a-stopped-workspace via the gateway ⬜ (`e2e-aws`).

## Phase 5 — Scale-to-zero + snapshot automation — 🟡

✅ Reconciler: idle stop+snapshot, scheduled point-in-time snapshots, orphan
volume/snapshot GC (pure selectors + `ReconcilerService` port), verified vs the sim.

- ⬜ **Remaining:** idle-agent activity heartbeats; the cron runner (EventBridge /
  ECS scheduled task — AWS-gated); optional warm pool + SOCI.
- **Gate:** idle→stop→snapshot→wake ✅; GC reaps orphans only ✅; cron + cost metric ⬜.

## Phase 6 — Admin UI + user portal — 🟡

✅ User portal (sign in, start/stop/snapshot/delete, RBAC-gated) + admin "all" view.
✅ **Base-image catalog API** — `CatalogService` CRUD, CASL-gated `/api/base-images`,
api-client, and workspace `create` enforced against the enabled catalog.

- ⬜ **Remaining:** admin catalog-management UI + a create-from-catalog picker in the
  portal; quotas; cost dashboard; Playwright e2e for both portals.
- **Gate:** catalog API + RBAC ✅; management UI + Playwright e2e ⬜.

## Phase 7 — Hardening, scale & DR — ⬜ pending (AWS-gated)

- Autoscaling, warm pools, SOCI; cross-region snapshot copy; secrets in Secrets
  Manager; full audit; quota enforcement; DR runbook; load test to 200+.
- **Gate:** 200+ load within latency budget; DR drill (cross-region restore);
  `/security-review` clean; pen-test checklist. (Real AWS only.)
