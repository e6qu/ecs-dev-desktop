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

Sim-provable work that does not need a real AWS account:

1. **SSH cert issuance API** (`POST /api/workspaces/:id/ssh-cert`) — portal signs the
   user's public key with the SSH CA and returns a short-lived cert. Completes the SSH UX:
   users currently must sign manually. Needs: key upload, `ssh-keygen -s` in the control
   plane, cert returned to client. Proven on sim. (Phase 4)

2. **Wake-on-connect SSH proxy** — a lightweight SSH jump host (`services/ssh-gateway`)
   that intercepts a connection, calls `POST /api/workspaces/:id/connect` (already
   implemented), awaits `running`, then proxy-forwards to the workspace. The control-plane
   half is done; the SSH-proxy trigger is missing. Proven on sim. (Phase 4)

3. **Workspace container CloudWatch log shipping** — `EcsComputeProvider.runTask()` does
   not set a `logConfiguration` on container definitions. Adding `awslogs` pointing at
   `/${appName}/workspaces` would make the `/admin/logs` workspace stream live on real
   AWS, and let the CloudWatch log adapter serve real workspace logs. Proven on sim. (Phase 8C)

4. **Full user-journey e2e** — a single end-to-end test: login → create workspace → SSH
   cert issue → SSH connect → heartbeat → idle expire → auto-stop → wake-on-connect.
   Currently each path has isolated tests; a joined journey test would catch interaction
   bugs across the whole stack.

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
- **Pinned versions:** Pomerium `0.32.2`, `@playwright/test` ^1.60.
