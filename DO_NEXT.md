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
4. **Heartbeat interval & idle threshold** — scale-to-zero tuning. The knobs
   now exist (`EDD_HEARTBEAT_INTERVAL_S` injected into workspace tasks;
   `EDD_IDLE_THRESHOLD_MS`/`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_GC_GRACE_MS` on the
   reconciler) — the open decision is only the production default values.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS ·
manual real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor
1440 · admin observability = derive-now + CloudTrail/CloudWatch · OpenVSCode Server ·
OpenSSH + our SSH CA · **per-workspace proxy authorization** (decision #5: chose
external-authz → control plane; built the workspace gate PEP + `/api/internal/authz`
PDP, ownership by owner email; **now proven live end-to-end** — browser → Pomerium →
gate **container** → PDP container → upstream (`docker-compose.gate.yml`, CI `e2e-gate`,
`apps/web/e2e/workspace-gate.pwgate.ts`); see `BUGS.md` Resolved + `docs/simulator-live-coverage.md`).

---

## Available now (decision-free — immediate)

- **Golden-image collection (planned sequence; decided 2026-06-15).** Split the
  single workspace image into a shared **`base`** (OpenVSCode, sshd + CA,
  idle-agent, entrypoint, git-credential helper, workspace user, Node, and the
  cross-cutting workspace-UX fixes #90/#91/#94 + agent extensions #93) plus thin
  variants `FROM base`: **omnibus** (today's all-toolchains image, renamed),
  **typescript**, **python**, **go**, **java**, **rust** (build-essential only in
  variants that need it, not base). It's just more catalog entries (the base-image
  allow-list) — no data-model change; `dev-bootstrap` seeds them; the picker already
  lets users choose. Sequence (**all done**): **PR A** = #90/#91/#94 (merged #97);
  **PR B** = base/omnibus split (merged #101); **PR C** = slim variants
  typescript/python/go/java/rust + `dev-bootstrap` collection + `image-variants.e2e.ts`
  - path-gated `golden-images` CI (merged #102); **PR D** = #93 agents (Claude Code +
    Codex + `claude` CLI) baked into `base` via a first-boot extension-seed mechanism +
    curated #95 tooling per image (`feat/golden-image-agents-and-tooling`). **Collection
    complete.** Possible follow-up: make the baked agents opt-in / omnibus-only (they add
    ~1 GB to every variant).
- **Launch-readiness / observability — essentially complete** (`BUGS.md` →
  Resolved): readiness probe, storage health, structured logging, metrics + alarms,
  CloudTrail pagination, API request latency/error metrics + access logging, fleet +
  cost gauges, reconciler health (heartbeat), per-workspace log view, and SSH CA
  key-material support (`EDD_SSH_CA_KEY`). The one substantial item left is **`e2e-aws`**
  (blocked on the AWS account decision below) — it's where the EMF→CloudWatch
  metrics, alarms, and live SSH-cert issuance get their first real check. Only _Low_
  follow-ups otherwise; see [`docs/observability-gaps.md`](./docs/observability-gaps.md).
- **Docs** — `README` doc index, [`docs/running-locally.md`](./docs/running-locally.md)
  (runnable tier commands), and the AWS [`docs/deploying.md`](./docs/deploying.md)
  runbook are current and cross-linked. Remaining deploy wiring gap:
  `EDD_SSH_CA_KEY_PATH` (CA private key) is not provisioned by the Terraform module.

- **ECS compute hardening follow-ups** (from the 2026-06-13 gap audit) — mostly
  **done** (see `BUGS.md` → Resolved): `runTask` readiness gating; `EDD_AGENT_TOKEN`
  → Secrets Manager (no plaintext); real `EcsComputeProvider.health()`; ECS Exec on
  the launch path. Remaining: `CONNECTION_TOKEN` injection (lands with the future
  DYNAMIC wake-on-connect gate).
- **Cost — done.** Figure-exact rollups (O(recent) report) + live AWS Price List
  rate sourcing (`EDD_AWS_PRICING=1`, region-accurate, config fallback); both in
  `BUGS.md` → Resolved. The live-rate fetch is real-AWS-validated (`e2e-aws`); CI
  uses the fallback (the sim has no Pricing API).
- **Cost visualization — built** (`feat/cost-visualization`): admin `/admin/costs`
  prices the lifecycle audit ledger (compute + live-volume + snapshot) per session
  / user / fleet; lifecycle audit centralized in `WorkspaceService` so the ledger
  is complete. Follow-up (time-windowing / rollups) tracked in `BUGS.md` → Open.
- **GitHub App provider — built** (`feat/github-app-provider`): `GitProvider` seam
  (user-OAuth + GitHub-App installation-token impls), selectable by config; the
  repos/namespaces routes + clone/push broker go through it. New HARD RULE §6.9
  "Coordinates, not targets" (`AGENTS.md`): the App e2e targets the sim or real
  GitHub by coordinates alone. To run against real GitHub: register a GitHub App,
  install it on a test org with a repo, and set `EDD_GITHUB_APP_ID` /
  `EDD_GITHUB_APP_KEY` / `EDD_GITHUB_TEST_ORG` / `EDD_GITHUB_TEST_REPO` /
  `AUTH_GITHUB_API_URL`.
- **Remaining product tracks:** increment-2 deployment wiring is **done** (#77 merged:
  Pomerium wildcard→gate route + live browser→Pomerium→gate→PDP authz; the DYNAMIC
  full-ECS-wake gate variant remains a future extension). Sim-probe/coverage pass is
  largely landed — CloudTrail for our EBS/ECS ops (#74) and the multi-generation EBS
  snapshot chain (sim handles it, none filed). ECS Exec now has a real data-channel
  proof: standard `OpenDataChannel` handshake → command output streamed from the task;
  no divergence was found.
- **Planned (later, not now): focused sockerless fidelity exploratory pass.** A
  deliberate sweep that drives more ECS/EBS/Secrets-Manager/CloudWatch call shapes
  against the sim and diffs each against documented AWS behaviour, filing any
  genuine, reproducible gap upstream in `e6qu/sockerless` (only there — §0.9). Scope
  it as adversarial probing (unexpected params, pagination, error shapes, idempotency)
  rather than re-running the green suites. Nothing to file from the Infrastructure
  work — `DescribeClusters`/`clusterInfo` conformed exactly. (Requested 2026-06-15;
  do after the current live-test/IDE thread.)
- Covered (see `docs/simulator-live-coverage.md`): the real VS Code workspace
  (OpenVSCode browser proof + polyglot toolchain compiles + OpenVSCode :3000 inside
  the sim ECS task), browser Pomerium OIDC login, portal browser lifecycle on real
  ECS compute, the live user journey, Auth.js callback routes, the real-CP wake
  chain, idle-agent heartbeat, reconciler scale-to-zero, per-workspace proxy authz.

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
- **jscpd 5.x:** PR #58 updated `jscpd` to `5.0.4`; the e2e AWS sim setup helper
  keeps the stricter duplication gate below 1%.
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
- **sockerless #525/#526/#527/#530:** fixed upstream by PRs #529/#531 and included
  in the #532 pin (`638f65a`) on the follow-up branch.
- **Live simulator coverage doc:** `docs/simulator-live-coverage.md` is the source of
  truth for what parts of the app are already live-tested against sockerless AWS/Azure
  and what can move there next without violating endpoint-only rules.
- **sockerless #524/#529/#531/#532:** pinned at `638f65a` (PR #59); ECS
  `ExecuteCommand` and managed-EBS golden SSH have live coverage in
  `packages/e2e/src/golden-workspace-ssh.e2e.ts`.
- **Gateway machine-auth:** the SSH gateway authenticates to the control plane
  with per-workspace HMAC bearer tokens derived from `EDD_GATEWAY_SECRET`
  (`apps/web/lib/machine-auth.ts`, `wake-and-forward.sh` via `openssl dgst
-mac HMAC -macopt hexkey:`). Wake routes accept it; destructive routes are
  session-only. Same scheme as the idle-agent's `EDD_AGENT_SECRET` (different
  trust domain → different secret).
- **Real-control-plane e2e harness:** `packages/e2e/src/web-app.ts` boots the
  production `next start` build on a free port (builds `apps/web` on demand if
  `.next` is missing); `docker-host.ts` probes whether containers reach the
  host via `host.docker.internal` (+`host-gateway`) or `host.containers.internal`
  (colima-style runtimes). Used by the wake-chain e2e and the live user journey.
- **Auth.js notes:** the Entra provider re-discovers the issuer for the
  id_token `tid` without `allowInsecureRequests`, so the Entra callback-route
  leg is HTTPS-only (runs in `e2e-https`). Auth.js defaults to
  `client_secret_basic`; we configure `client_secret_post` (MSAL convention;
  also sockerless #548). `AUTH_GITHUB_URL` = GHES/bleephub web base
  (provider's standard `enterprise.baseUrl`).
- **sockerless #547/#548 → fixed by PR #549** (pinned `777ffd3`): `/authorize`
  honours `login_hint` (code bound to the resolved user; unknown hint →
  `error=login_required`) and the token endpoint accepts `client_secret_basic`.
  The Entra callback leg asserts group→admin interactively via `login_hint`.
- **Golden image SSH:** the `infra/images` collection (shared `base`) includes
  `sshd`/CA/principal wiring and is covered through the AWS container-mode simulator
  with `EcsComputeProvider` managed EBS. Real deploy remains AWS-account gated.
- **Pinned versions:** Pomerium `0.32.2`, `@playwright/test` ^1.60.
