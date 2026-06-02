# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, and blockers. Update after every task;
> past tense at PR close for completed items.

---

## Open decisions (need the user)

1. **AWS account/region & data-residency** — **the top blocker.** Gates real
   Terraform, Phase 1 (Fargate + EBS), Phase 4 (SSH), Phase 7, the reconciler
   cron, and the manual `e2e-aws` tier.
2. **Domain & DNS owner** — base domain for `*.devbox.<domain>` + cert/DNS owner.
   Gates the identity-aware proxy and ACM certs.
3. **VS Code distro** — confirm **code-server / OpenVSCode + Open VSX**, or flag
   any MS-exclusive extensions users need (Pylance, official Remote/C++). Gates
   the Phase 1 golden image.
4. **Identity-aware proxy** — confirm **Pomerium** (vs Authentik / in-house).
5. **Heartbeat interval & idle threshold** — scale-to-zero tuning.

Resolved: DynamoDB + ElectroDB · sockerless substrate · manual real-AWS on `main`
· AGPL-3.0-or-later · Turborepo + pnpm · CASL · dep floor `minimumReleaseAge: 1440`.

## Available now (decision-free)

- **Entra interactive login** is now testable against the from-source sim
  (sockerless #362 fixed by PR #368) — bump the `third_party/sockerless` submodule
  past #368 and add an OIDC auth-code integration test (replaces the mock-OIDC
  stand-in for Tier-2).
- Point the control plane / `@edd/db` at the **from-source sockerless AWS sim**
  (now wired in Tier-2) to broaden the AWS API surface beyond DynamoDB Local.
- [x] Wired `Ec2StorageProvider` GC into the reconciler against the sim (with
      managed-resource tagging so GC never touches unmanaged EBS) — verified.
- **Mock-free workspace e2e** — **DONE** (sockerless #381 fixed by PR #382). The
  data-fidelity loop + the **full product lifecycle through `WorkspaceService`**
  (create → stop → start → remove) run mock-free against the container-mode sim,
  locally + a CI `e2e` job (`packages/e2e`, `docker-compose.e2e.yml`). The real
  `EcsComputeProvider` (`packages/compute-ecs`, managed-EBS Fargate) is done.
  Follow-ons:
  - [ ] **Teleport/Pomerium in Docker** for SSH/proxy e2e.
  - [ ] wire `apps/web` to the real adapters (needs the cluster/subnets/role from
        Terraform → gated on the AWS account/region decision).
- **Mock-free auth e2e** — **GitHub done** (`apps/web/lib/github-auth.e2e.ts`
  against bleephub; sockerless #384 fixed by PR #385). Next: the **Entra** path —
  drive the azure sim's auth-code flow (#368) and assert `normalizeClaims("entra")`
  - role mapping from the id token; probe whether the sim issues **group claims**
    (our role mapping needs them) and file/halt if not.
- **Playwright e2e** for the portal flows (Tier-2; app + DynamoDB + mock-OIDC or
  `EDD_DEV_AUTH`).
- Admin **base-image catalog** management, quotas, cost dashboard.
- **idle-agent heartbeat** shape (editor/terminal/SSH → `lastActivity`).
- [x] GitHub org/team → role — `read:org` scope + `/user/teams` fetch in the jwt
      callback yields `org/team` groups; endpoint-overridable for bleephub. Done.
- Broader unit/integration coverage.

## Blocked

**On decision #1 (AWS):** real `infra/terraform` baseline (VPC, ECS, ECR,
DynamoDB+GSIs, KMS, IAM, remote state); Phase 1 golden image + Fargate task + EBS;
Phase 4 SSH/Teleport; Phase 7 scale/DR; the reconciler cron runner; `e2e-aws`
execution (OIDC→AWS role + ephemeral env + auto-teardown).

**On decision #2 (DNS):** identity-aware proxy (Pomerium) + `*.devbox.<domain>`
routing + ACM.

**On real IdP credentials:** end-to-end GitHub/Entra login (Tier-3 manual);
mock-OIDC covers Tier-2.

**On upstream sockerless:** _nothing — every gap we hit is fixed._ EBS #359/#360
(PR #361), LB/SG #334/#335 (PR #364), Entra #362 (PR #368), build/docs #366/#367
(PR #370), real compute **#333** (PR #372), control/data-plane split **#381**
(PR #382), and bleephub `/user/teams` **#384** (PR #385) are all resolved; we
consume the sim from source (submodule @ `ea8c79d`). The container-mode e2e runs
with plain Docker (no KVM/nft — ECS managed EBS uses Docker named volumes,
VPC/Subnet store metadata).
