# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, blockers. Update after every task.

---

## Open decisions (need the user)

1. **AWS account/region & data-residency** — **the top blocker.** Gates real Terraform
   apply, Phase 1 deploy, SSH/proxy real federation, reconciler cron, real CloudTrail/
   CloudWatch, Phase 7, `e2e-aws`.
2. **Domain & DNS owner** — base domain for `*.devbox.<domain>` + cert/DNS delegation.
   Gates the identity-aware proxy + ACM cert issuance.
3. **Identity-aware proxy** — confirm Pomerium (sim-proven; vs Authentik/in-house).
4. **Heartbeat interval & idle threshold** — scale-to-zero tuning.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS ·
manual real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor
1440 · admin observability = derive-now + CloudTrail/CloudWatch · OpenVSCode Server ·
OpenSSH + our SSH CA.

---

## Available now (decision-free — immediate)

- **Review the combined follow-up PR** — it contains the docs/live-simulator audit,
  golden workspace SSH wiring, admin observability live route coverage, sockerless
  #524 pin/ECS Exec smoke, and CI/test hardening.
- **Unskip golden-image SSH awsvpc e2e after upstream fixes** — once sockerless #526
  and #527 are resolved, restore the full WorkspaceService-managed-EBS golden SSH
  path and remove the temporary skipped same-VPC OpenSSH assertion.
- **Expand live app tests further** — `docs/simulator-live-coverage.md` lists the next
  decision-free candidates: portal browser lifecycle against ECS container-mode sim,
  browser Pomerium login, full user journey without fake compute, and Auth.js callback
  route coverage against sim IdPs.

---

## Blocked

- **On AWS (#1):** Terraform module is **built and sim-apply-proven** (full stack incl.
  DNS/TLS: VPC/ECS/ECR/DynamoDB+GSIs/KMS/IAM/ALB+ACM/Route53). Blocked: real apply
  (account + remote state backend), golden image real Fargate deploy, wiring `apps/web`
  to real adapters, Pomerium real federation + DNS, reconciler cron, CloudTrail/
  CloudWatch/Cost observability, Phase 7, `e2e-aws`.
- **On DNS (#2):** real `*.devbox.<domain>` routing + ACM (the module is sim-proven;
  the real hosted zone + cert issuance is AWS/registrar-gated).

---

## Working notes (durable)

- **Sim = sockerless, endpoint-only (HARD RULE, §6.8).** Product code _and_
  tests/fixtures differ from real cloud by **endpoint/base-domain only**. Allowed:
  `AWS_ENDPOINT_URL`, `AUTH_GITHUB_API_URL`, Entra authority, `entraSim`/`awsSim`/
  `bleephub` base URLs. **Not allowed:** sim-specific branches, fallbacks, or
  non-standard endpoints. If the sim diverges from the real API, **file upstream and
  halt**. (A sim that _accepts_ a call can still be non-conformant — audit vs the spec.)
- **Web e2e quirks:** Playwright runs against `next start` (Turbopack dev hydration is
  unreliable headless). Workspace TS packages need listing in `next.config`
  `transpilePackages`; browser `fetch` must be `bind`-ed. Auth uses the cookie dev-auth
  shim (`edd-dev-user`/`edd-dev-role`, gated on `EDD_DEV_AUTH`).
- **check-deps churn:** "latest ≥1-day-old" gate goes stale mid-PR — `pnpm update
--latest -r` + commit; `terraform providers lock -platform=linux_amd64
-platform=darwin_arm64` for the TF lock.
- **Trivy `.trivyignore.yaml` format:** key is `misconfigurations:` (not `misconfigs:`);
  ID is exact string match (e.g. `DS-0002` not `DS002`). Source: Trivy
  `pkg/result/ignore.go` `IgnoreConfig` struct.
- **CI registry rate limits:** harness bring-up steps retry/backoff (public.ecr.aws /
  Docker Hub on shared runner IPs).
- **Container-mode AWS sim netns tier:** overlapping-CIDR awsvpc e2e requires the sim
  container to include `ip`/`nft`/`nsenter`/`sysctl` and run with `pid: host`, so the
  simulator can attach veths into sibling task network namespaces.
- **sockerless #520 route-table egress:** netns ECS tasks need normal AWS egress state
  (`0.0.0.0/0` via IGW + `AssignPublicIp=ENABLED`, or NAT) before they can reach
  simulator-adjacent endpoints such as DynamoDB Local. This keeps tests endpoint-only
  while matching the sim's route-table model.
- **sockerless #525/#526/#527:** #525 remains an Azure uniqueness fidelity bug but is
  avoided downstream with unique UPNs. #526/#527 block full golden workspace SSH e2e:
  managed-EBS awsvpc reachability and Fargate `SYS_CHROOT` for OpenSSH preauth.
- **Live simulator coverage doc:** `docs/simulator-live-coverage.md` is the source of
  truth for what parts of the app are already live-tested against sockerless AWS/Azure
  and what can move there next without violating endpoint-only rules.
- **sockerless #524:** pinned at `39a4291`; ECS `ExecuteCommand` has a live smoke test
  in `packages/e2e/src/golden-workspace-ssh.e2e.ts`.
- **Golden image SSH:** `infra/images/workspace` includes `sshd`/CA/principal wiring,
  but full simulator SSH remains blocked upstream (#526/#527); do not describe that
  path as fully e2e-proven until those are fixed and the skipped test is restored.
- **Pinned versions:** Pomerium `0.32.2`, `@playwright/test` ^1.60.
