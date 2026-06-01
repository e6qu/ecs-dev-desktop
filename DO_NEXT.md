# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks and open decisions awaiting the user.
> Update after every task; past tense at PR close for completed items.

---

## Open decisions (need the user)

1. **VS Code distro:** confirm **code-server / OpenVSCode + Open VSX**, or flag
   any **MS-exclusive extensions** users depend on (Pylance, official Remote/C++).
2. **Identity-aware proxy:** confirm **Pomerium** (vs Authentik / in-house).
3. **Domain & DNS:** base domain for `*.devbox.<domain>` and DNS/cert owner.
4. **AWS account/region & data-residency** — **gates real Terraform resources and
   the manual `e2e-aws` tier.**
5. **Heartbeat interval & idle threshold** (scale-to-zero tuning).
6. **Entra interactive login flow:** verify in Phase 3 whether sockerless covers
   `/authorize`→login→code (token/JWKS exist per #261/#272); file a precise issue
   only if an endpoint is missing (EXT-003).

## Resolved decisions

- State store: **DynamoDB** (single-table + ElectroDB). Test substrate:
  **sockerless**. Real-AWS tier: **manual on `main`**. License: **AGPL-3.0-or-later**.
  Repo tooling: **Turborepo + pnpm**. RBAC: **CASL**. Dep policy: **latest version
  that is ≥ 1 day old** (pnpm `minimumReleaseAge: 1440`; enforced by `check-deps`).

## Next tasks

### Phase 2 — Control-plane API (done, on branch `phase-2/control-plane-api`)

- [x] Lifecycle endpoints + CASL RBAC; `@edd/control-plane` WorkspaceService (FCIS).
- [x] Engineering-standards charter (`AGENTS.md` §6) applied repo-wide.
- [x] Strict type-aware lint; `sast` (Semgrep) + `vuln-scan` (Trivy) gates; pre-commit.
- [x] Phase 3 (auth core): Auth.js (GitHub + Entra) + JWT, replacing the dev-header
      principal shim with the session.

### Phase 3 — remaining

- [ ] Identity-aware proxy (Pomerium) + wildcard `*.devbox.<domain>` routing —
      needs the domain/DNS decision.
- [ ] mock-OIDC integration test of the full Auth.js login flow (Tier-2); real
      GitHub/Entra federation is Tier-3 manual (verify Entra `/authorize`, EXT-003).
- [ ] GitHub org/team → role (needs a teams API call in the jwt callback; groups
      are empty for GitHub today).

### Phase 0 — remaining

- [x] **Tier-2 harness**: DynamoDB Local via `docker-compose.tier2.yml`,
      `pnpm test:integ`, `@edd/db` integration test + CI `integration` job.
- [x] **ElectroDB** Workspace entity in `@edd/db` over the single-table keys.
- [ ] Wire the **sockerless** backend into Tier-2 (pending its image + #347).
- [ ] `infra/terraform` real baseline (VPC, ECS, ECR, DynamoDB + GSIs, KMS, IAM,
      remote state) — **blocked on decision #4**.
- [ ] Flesh out `e2e-aws.yml`: OIDC→AWS role + ephemeral env + auto-teardown.

### Phase 1 (next)

- [ ] Golden base image (code-server + Teleport/sshd + idle-agent) in
      `infra/images`; Fargate task def with ECS-managed EBS volume.
- [ ] Add a **sockerless-backed `StorageProvider` adapter** and run it through the
      existing contract test (lands when sockerless #347 ships EBS snapshots).

## Upstream (sockerless)

- [x] Commented on **#347** with our snapshot data-round-trip requirement.
- [ ] Verify Entra `/authorize` login flow in Phase 3 (EXT-003).

## Blocked / waiting

- Real Terraform + manual `e2e-aws` gated on decision #4 (AWS account/region).
- Sim-level snapshot round-trip gated on sockerless #347 (EXT-001).
