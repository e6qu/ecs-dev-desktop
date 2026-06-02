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
- Wire `Ec2StorageProvider` into the reconciler **GC** path as the real
  (endpoint-only) storage adapter against the sim (lifecycle only; data fidelity
  awaits #333).
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

**On upstream sockerless (see `BUGS.md`):** the one remaining functional blocker
is real workspace **execution** + volume _data_-fidelity at the sim level — needs
real compute, **#333** (EXT-002, reopened). _Resolved: EBS restore #359 +
`DeleteItem` #360 (PR #361); LB #334 + SG #335 (PR #364); Entra `/authorize` #362
(PR #368). We consume the sim **from source** (submodule), so no release is needed
— #363 closed; build/doc fixes #366/#367 filed. The `Ec2StorageProvider` lifecycle
is verified against the sim; data fidelity through a running task still needs #333._
