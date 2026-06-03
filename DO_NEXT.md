# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, and blockers. Update after every task;
> past tense at PR close for completed items.

---

## Open decisions (need the user)

1. **AWS account/region & data-residency** — **the top blocker.** Gates real
   Terraform, Phase 1 deploy, Phase 4 (SSH), Phase 7, the reconciler cron, `e2e-aws`.
2. **Domain & DNS owner** — base domain for `*.devbox.<domain>` + cert/DNS owner.
   Gates the identity-aware proxy + ACM.
3. **VS Code distro** — confirm **code-server / OpenVSCode + Open VSX**, or flag
   any MS-exclusive extensions users need. Gates the Phase 1 golden image.
4. **Identity-aware proxy** — confirm **Pomerium** (vs Authentik / in-house).
5. **Heartbeat interval & idle threshold** — scale-to-zero tuning.

Resolved: DynamoDB+ElectroDB · sockerless substrate (from source) · Fargate
**managed-EBS** model · manual real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm
· CASL · dep floor `minimumReleaseAge: 1440`.

## Available now (decision-free)

- **SSH via Teleport** — ✅ connect e2e done (`services/ssh-gateway`, real cluster in
  `docker-compose.ssh.yml`: enrol → `tsh` connect as principal → authz deny).
- **Pomerium routing** — ✅ identity-aware wildcard routing e2e done (`infra/proxy`,
  real Pomerium in `docker-compose.e2e.yml`, OIDC IdP = azure sim: `<name>.devbox.<domain>`
  routes to the workspace upstream; unauthenticated → sign-in gate). Remaining:
  **wake-on-connect** (SSH to a stopped workspace → wake; touches the AWS sim —
  file+halt on any gap); Teleport↔Entra/GitHub federation; session recording; the
  **authenticated proxy-pass** with identity headers (needs a browser login →
  Playwright); real DNS/TLS/ACM (blocked on #2).
- Admin **base-image catalog** management, quotas, cost dashboard (Phase 6 remainder).
- **idle-agent heartbeat** shape (editor/terminal/SSH → `lastActivity`).
- **Playwright e2e** for the portal (app + DynamoDB + `EDD_DEV_AUTH`/mock-OIDC).
- Broader unit/integration coverage.

## Blocked

- **On AWS (#1):** real `infra/terraform` baseline (VPC, ECS, ECR, DynamoDB+GSIs,
  KMS, IAM, remote state); Phase 1 golden image + real Fargate deploy; wiring
  `apps/web` to the real adapters (needs cluster/subnets/EBS-role from Terraform);
  Phase 4 SSH/Teleport; Phase 7 scale/DR; reconciler cron; `e2e-aws` execution.
- **On DNS (#2):** identity-aware proxy + `*.devbox.<domain>` routing + ACM.
- **On real IdP credentials:** real GitHub/Entra federation (Tier-3 manual);
  bleephub + the azure sim cover the mock-free path.
- **On upstream sockerless:** _nothing._ Every gap we filed is fixed (see `BUGS.md`).
  Sim consumed from source (submodule pinned; currently `5c8397f`, with #393's standard
  Entra Graph/ROPC + bleephub `POST /admin/organizations`).

## Working notes (durable)

- **Sim consumption:** from source, endpoint-only (`AGENTS.md` §6.8). Tier-2 =
  process-mode sim (API surface). e2e = container-mode sim (`--privileged` + Docker
  socket; runs real task containers). bleephub built with `-tags noui`.
- **macOS/podman quirks:** container-mode sim needs `--privileged` + the podman
  socket; works (#382 removed the KVM/nft requirement via Docker named volumes).
- **check-deps churn:** the "latest ≥ 1-day-old" gate often goes stale mid-PR; run
  `pnpm update --latest -r` + commit, or pre-run `scripts/check-latest-deps.sh`.
- **Entra provisioning via Terraform is upstream-blocked:** the `azuread` Terraform
  provider has no `microsoft_graph_endpoint` override, so it can't target the sim
  (sockerless #394 → `hashicorp/terraform-provider-azuread#1837`). Not a blocker for us —
  our Entra e2e uses standard Graph REST + ROPC (swappable by base URL). Relevant only
  if future IaC wants to provision Entra via the azuread provider.
- **Endpoint-only / swappability (HARD RULE, `AGENTS.md` §6.8):** the whole project —
  product code _and_ tests/fixtures — must differ from real cloud by endpoint/base
  domain only. Allowed: `AWS_ENDPOINT_URL`, `AUTH_GITHUB_API_URL`/`githubApiBaseUrl()`,
  Entra authority host. **Not allowed:** any `/sim/...` endpoint, hardcoded sim seed
  tokens, non-standard endpoints (`POST /user/orgs`), endpoint branches/fallbacks.
  Audit (2026-06-03): product code is clean; the **auth-test fixtures** were the gap.
- **Owed remediation — `apps/web/lib/github-auth.e2e.ts`** (now UNBLOCKED, #391 landed
  in #393; deferred by choice — "leave as-is, tracked"): rework to be swappable — take
  the admin token + org/team from env (fail loudly, drop the hardcoded `ghp_0…` seed)
  and create the org via standard `POST /admin/organizations` instead of the
  non-standard `POST /user/orgs`. (The Entra e2e `apps/web/lib/entra-auth.e2e.ts` is the
  reference for the swappable, standard-surface pattern.)
