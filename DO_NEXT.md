# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, blockers. Update after every task.

---

## Open decisions (need the user)

1. **AWS account/region & data-residency** — **the top blocker.** Gates real Terraform,
   Phase 1 deploy, SSH/proxy real federation, reconciler cron, Phase 8C observability,
   Phase 7, `e2e-aws`.
2. **Domain & DNS owner** — base domain for `*.devbox.<domain>` + cert/DNS owner. Gates
   the identity-aware proxy + ACM.
3. **VS Code distro** — confirm code-server / OpenVSCode + Open VSX (Phase 1 golden image).
4. **Identity-aware proxy** — confirm Pomerium (done on the sim; vs Authentik/in-house).
5. **Heartbeat interval & idle threshold** — scale-to-zero tuning.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS · manual
real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor 1440 · admin
observability = derive-now + CloudTrail/CloudWatch (no custom audit store).

## Available now (decision-free)

- **Phase 8 — admin console** (`docs/admin-ui-design.md`): ✅ **8A done** — Health board
  (`HealthService` + live DynamoDB ping), the `/admin` shell, the all-workspaces table,
  and per-workspace **Inspect** (detail, bindings, snapshots, derived lifecycle timeline).
  All Playwright-covered. **8B in progress:** ✅ admin **Overview** dashboard (the `/admin`
  landing — `tallyWorkspaceStates` and catalog stats). **NEXT:** **quotas** (per-role
  limits with create-time enforcement), then the `AuditSource`/`LogSource` ports and the
  **Logs/Audit** screen (thin pre-AWS — derived; real CloudTrail/CloudWatch is 8C,
  AWS-gated).
- **idle-agent** that POSTs `/heartbeat` (its shape; the agent binary ships with the
  golden image, AWS-gated).
- Broader unit/integration/Playwright coverage.

## Blocked

- **On AWS (#1):** real `infra/terraform` (VPC/ECS/ECR/DynamoDB+GSIs/KMS/IAM/remote
  state); golden image + real Fargate deploy; wiring `apps/web` to real adapters;
  Teleport/Pomerium real federation + DNS; reconciler cron; Phase 8C (CloudTrail/
  CloudWatch/Cost); Phase 7; `e2e-aws`.
- **On DNS (#2):** real `*.devbox.<domain>` routing + ACM.
- **On upstream sockerless:** _nothing._ Every gap filed is fixed (see `BUGS.md`).
  Sim from source (submodule pinned `fed6600`).

## Working notes (durable)

- **Sim = sockerless, endpoint-only (HARD RULE, §6.8).** Whole project — product code
  _and_ tests/fixtures — differs from real cloud by **endpoint/base-domain only**.
  Allowed: `AWS_ENDPOINT_URL`, `AUTH_GITHUB_API_URL`, Entra authority, `entraSim`/`awsSim`/
  `bleephub` base URLs. **Not allowed:** `/sim/...` endpoints, hardcoded seed tokens/values,
  non-standard endpoints (e.g. `POST /user/orgs`), branches/fallbacks. If the sim/bleephub
  **diverges from the real API/behaviour** in something that matters, **file a
  non-conformance upstream and halt** — never adapt the test around it. (A sim that
  _accepts_ your call can still be non-conformant — audit behaviour vs the real API.)
- **Web e2e quirks:** Playwright runs against `next start` (Turbopack **dev** hydration is
  unreliable headless). Workspace TS packages need listing in `next.config`
  `transpilePackages`; the browser's `fetch` must be `bind`-ed. Auth in the browser uses
  the **cookie** dev-auth shim (`edd-dev-user`/`edd-dev-role`, gated on `EDD_DEV_AUTH`).
- **DynamoDB Local readiness** races first integ run; re-run or wait for `--wait` health.
- **check-deps churn:** "latest ≥1-day-old" gate goes stale mid-PR (esp. on date rollover)
  — `pnpm update --latest -r` + commit, and `terraform providers lock -platform=linux_amd64
-platform=darwin_arm64` for the TF lock.
- **CI registry rate limits:** harness bring-up steps retry/backoff (public.ecr.aws/Docker
  Hub on shared runner IPs).
- **Pinned versions:** Teleport `18.6.2`, Pomerium `0.32.2`, `@playwright/test` ^1.60.
