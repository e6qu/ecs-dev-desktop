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

✅ Auth.js (GitHub + Entra), CASL abilities, GitHub org/team→role, GitHub login
proven mock-free vs bleephub.

- ⬜ **Remaining:** Entra mock-free auth e2e (azure sim #368 — probe group claims);
  identity-aware proxy (**Pomerium**) + `*.devbox.<domain>` routing (needs DNS #2).
- **Gate:** CASL matrix ✅; mock-free GitHub login ✅; Entra login + proxy routing ⬜.

## Phase 4 — SSH via Teleport — ⬜ pending

- Teleport cluster; workspaces enrolled as nodes; identity federated from Entra/
  GitHub; session recording; wake-on-connect (SSH to a scaled-to-zero workspace).
- **Gate:** `tsh ssh` / Remote-SSH connect; audit + recording; SSH wakes a stopped
  workspace. (Teleport-in-Docker for the e2e; real federation = `e2e-aws`.)

## Phase 5 — Scale-to-zero + snapshot automation — 🟡

✅ Reconciler: idle stop+snapshot, scheduled point-in-time snapshots, orphan
volume/snapshot GC (pure selectors + `ReconcilerService` port), verified vs the sim.

- ⬜ **Remaining:** idle-agent activity heartbeats; the cron runner (EventBridge /
  ECS scheduled task — AWS-gated); optional warm pool + SOCI.
- **Gate:** idle→stop→snapshot→wake ✅; GC reaps orphans only ✅; cron + cost metric ⬜.

## Phase 6 — Admin UI + user portal — 🟡

✅ User portal (sign in, create-from-catalog, start/stop/snapshot/delete, RBAC-
gated) + admin "all" view.

- ⬜ **Remaining:** admin base-image catalog mgmt, quotas, cost dashboard; Playwright
  e2e for both portals.
- **Gate:** Playwright e2e + RBAC views ⬜; admin actions reflected in DynamoDB/ECS.

## Phase 7 — Hardening, scale & DR — ⬜ pending (AWS-gated)

- Autoscaling, warm pools, SOCI; cross-region snapshot copy; secrets in Secrets
  Manager; full audit; quota enforcement; DR runbook; load test to 200+.
- **Gate:** 200+ load within latency budget; DR drill (cross-region restore);
  `/security-review` clean; pen-test checklist. (Real AWS only.)
