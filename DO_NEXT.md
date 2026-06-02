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
- **Full mock-free e2e** is sockerless-ready (audit 2026-06-02): the sim provides
  real GitHub/Entra login, ECS exec, and ECS-managed-EBS data fidelity. Gated on
  **our** infra, not sockerless: (a) a **Docker/KVM-capable e2e CI job** (the sim
  needs a real runtime; `SIM_RUNTIME=process` won't run containers), (b) the real
  ECS `ComputeProvider` (either EBS model now has sim data fidelity — managed EBS,
  or pre-create + AttachVolume now that #378/PR #379 wired it), (c)
  Teleport/Pomerium in Docker for SSH/proxy.
- **Playwright e2e** for the portal flows (Tier-2; app + DynamoDB + mock-OIDC or
  `EDD_DEV_AUTH`).
- Admin **base-image catalog** management, quotas, cost dashboard.
- **idle-agent heartbeat** shape (editor/terminal/SSH → `lastActivity`).
- GitHub org/team → role (teams API call in the jwt callback; GitHub groups are
  empty today).
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
(PR #370), and real compute **#333** (PR #372) are all resolved; we consume the
sim from source (submodule @ `41480ae`). Real compute needs **KVM**, so sim-level
workspace execution + data fidelity is a KVM-CI / real-AWS concern (see above),
not our default Tier-2.
