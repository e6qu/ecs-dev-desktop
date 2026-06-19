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
   `EDD_IDLE_THRESHOLD_MS`/`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_EARLY_SNAPSHOT_INTERVAL_MS`/
   `EDD_EARLY_SESSION_MS`/`EDD_GC_GRACE_MS` on the reconciler) — the open decision is
   only the production default values.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS ·
manual real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor
1440 · admin observability = derive-now + CloudTrail/CloudWatch · OpenVSCode Server ·
OpenSSH registered-key auth (no CA) · **per-workspace proxy authorization** (decision #5: chose
external-authz → control plane; built the workspace gate PEP + `/api/internal/authz`
PDP, ownership by owner email; **now proven live end-to-end** — browser → Pomerium →
gate **container** → PDP container → upstream (`docker-compose.gate.yml`, CI `e2e-gate`,
`apps/web/e2e/workspace-gate.pwgate.ts`); see `BUGS.md` Resolved + `docs/simulator-live-coverage.md`).

---

## Code-review remediation (codex 2026-06-19) — DONE (merged #129, Phase 9)

The deep `codex` review surfaced 12 findings (4 Critical, 3 High, 4 Medium/Low) — **all remediated and
merged in #129**, re-verified against the merged code. Detail now lives in `BUGS.md` → Resolved (repo).
The previously-deferred cross-region EBS snapshot DR flow was pulled in (sim-validatable via
sockerless#602). `CONNECTION_TOKEN` injection stays correctly coupled to the future DYNAMIC
wake-on-connect gate (the image already consumes it; the STATIC gate runs tokenless, so building a
control-plane token now would be dead code, §6.5) — it lands with that gate extension.

Only genuinely AWS-account-gated work (real `terraform apply`, real DNS/ACM, real IdP federation, 200+
load, live `e2e-aws` enforcement) stays under decision #1 above — that is an external decision, not a
deferral by choice.

## Available now (decision-free — immediate)

- **User-registered SSH keys + per-workspace subdomain — IN PROGRESS (Phase 4b).**
  Design confirmed with the user (registered-key human auth + ownership authz at connect
  time; wildcard-DNS routing). **Slices 1+2 landed** on `feat/ssh-key-registration`:
  foundation (core helpers + contracts + `sshKey` entity + `SshKeyService`), `/api/ssh-keys`
  CRUD, the gateway `ssh-authorize` decision endpoint, api-client, Settings page, and the
  per-workspace `ssh` command — unit + route integ green; web typecheck/lint/build green.
  **Slices 1–2c DONE — dual-trust SSH, docker-e2e validated** (#110 merged).
  `ssh-authorize` accepts gateway + agent tokens; gateway + golden-image sshd authorize
  the registered key via `AuthorizedKeysCommand`; `ssh-proxy.e2e.ts` rewritten
  self-contained (worker-thread stub + docker-run node/proxy) and 2/2 green.
  **Clean-break CA removal DONE** (`feat/ssh-registered-key-only`): deleted the
  `/ssh-cert` route + `lib/ssh-cert.ts`, `sshCert*` contracts + api-client, `gen-ssh-ca.sh`,
  `docker-compose.ssh.yml`, `EDD_SSH_CA_*` config + compute-provider injection, the
  Terraform `ssh_ca_public_key` var + #108 precondition, and all CA image wiring; migrated
  the cert-based e2e suites to registered keys (stub CP for the golden-image tests; real CP
  for user-journey + ssh-wake-chain). **Only Slice 3 remains — public SSH NLB + Route53
  `*.ssh`, AWS-gated by the account decision (#1).** Once AWS is unblocked, wire the single
  public SSH ingress. Full plan in `PLAN.md` §4b.
- **Catalog metadata picker + admin UX cleanup — DONE.** Mainline now carries the
  catalog metadata picker **and** the broader admin/navigation cleanup:
  `/admin/catalog`, legacy `/base-images` redirect, top-nav active state, unified
  session-creation entry point, stronger workspace naming/context, labeled catalog form,
  and responsive admin/data-view improvements. Verification for that pass is already
  complete: targeted web/control-plane integ green against real DynamoDB Local, full
  portal Playwright green 13/13, offline `@edd/web build` green. No additional
  implementation work is queued on that slice beyond normal post-merge follow-up if
  review turns up something concrete.
- **Dependency freshness follow-up — DONE.** The PR-era `check-deps` failure was just
  release drift under the repo's own age gate: `vitest` moved `4.1.8 → 4.1.9` and
  `@playwright/test` moved `1.60.0 → 1.61.0`. The manifests + `pnpm-lock.yaml` were
  refreshed, `pnpm check-deps` is green again, and the newer Playwright/browser stack
  re-ran the full portal suite cleanly (`13/13`).
- **Live portal e2e selector follow-up — DONE.** The container-mode live Playwright spec
  was still trying to use the removed `/workspaces` inline creator (`select.select` +
  `+ new workspace`). It now uses the current `/sessions/new` catalog picker flow, so
  the live ECS lifecycle test matches the merged UX instead of timing out on a missing
  control.
- **Golden-image collection — DONE (all PRs merged).** Split the single workspace
  image into a shared **`base`** (OpenVSCode, sshd + registered-key authorizer, idle-agent, entrypoint,
  git-credential helper, workspace user, Node, the workspace-UX fixes #90/#91/#94,
  the AI agents #93, and cross-cutting JS/TS tooling) plus thin variants `FROM base`:
  **omnibus** (all toolchains), **typescript**, **python**, **go**, **java**,
  **rust**. Just more catalog entries (the base-image allow-list) — no data-model
  change; `dev-bootstrap` seeds them; the picker already lets users choose. Sequence
  (**all merged**): **PR A** = #90/#91/#94 (#97); **PR B** = base/omnibus split (#101);
  **PR C** = slim variants + `dev-bootstrap` collection + `image-variants.e2e.ts` +
  path-gated `golden-images` CI (#102); **PR D** = #93 agents (Claude Code + Codex +
  `claude` CLI) baked into `base` + curated #95 tooling per image, extensions installed
  into OpenVSCode's **built-in** dir (no first-boot copy → no startup race) (#103).
  **Done (#104, #95 follow-ons):** rounded out the curated dev tooling — Trivy security
  scanner in base (cross-cutting, matches CI); Go staticcheck/deadcode/dupl (go+omnibus);
  cargo-audit (rust+omnibus). **Follow-ups done (#105):** (a) **Java formatter** —
  `google-java-format` added to java+omnibus (every variant now has a format CLI);
  (b) **agents omnibus-only** — moved Claude Code + Codex + the `claude` CLI out of base
  into omnibus, slimming every variant ~1 GB (slim-variant users install agents at runtime
  via #90/#91). **The golden-image collection is complete** (#97/#101/#102/#103/#104/#105).
- **Launch-readiness / observability — essentially complete** (`BUGS.md` →
  Resolved): readiness probe, storage health, structured logging, metrics + alarms,
  CloudTrail pagination, API request latency/error metrics + access logging, fleet +
  cost gauges, reconciler health (heartbeat), and a per-workspace log view. The one
  substantial item left is **`e2e-aws`** (blocked on the AWS account decision below) —
  it's where the EMF→CloudWatch metrics, alarms, and live registered-key SSH get their
  first real check. Only _Low_ follow-ups otherwise; see
  [`docs/observability-gaps.md`](./docs/observability-gaps.md).
- **Docs** — `README` doc index, [`docs/running-locally.md`](./docs/running-locally.md)
  (runnable tier commands), and the AWS [`docs/deploying.md`](./docs/deploying.md)
  runbook are current and cross-linked. **SSH CA fully removed** (2026-06-17 clean
  break): no `EDD_SSH_CA_KEY` secret, no `ssh_ca_public_key` Terraform var, no #108
  precondition. SSH is registered-key only — the gateway/workspace authorize keys via
  `ssh-authorize` using `EDD_GATEWAY_SECRET`/`EDD_AGENT_SECRET` (already provisioned);
  nothing SSH-specific is left to provision.

- **ECS compute hardening follow-ups** (from the 2026-06-13 gap audit) — mostly
  **done** (see `BUGS.md` → Resolved): `runTask` readiness gating; `EDD_AGENT_TOKEN`
  → Secrets Manager (no plaintext); real `EcsComputeProvider.health()`; ECS Exec on
  the launch path. Remaining: `CONNECTION_TOKEN` injection — **now actionable** (Phase 9):
  generate + persist the token in the control plane and hand it to the authenticated user
  via the proxy; no longer parked on the future DYNAMIC wake-on-connect gate.
- **Cost — done.** Figure-exact rollups (O(recent) report) + live AWS Price List
  rate sourcing (`EDD_AWS_PRICING=1`, region-accurate, config fallback); both in
  `BUGS.md` → Resolved. The live-rate fetch is real-AWS-validated (`e2e-aws`); CI
  uses the fallback (the sim has no Pricing API).
- **Cost visualization — built** (`feat/cost-visualization`): admin `/admin/costs`
  prices the lifecycle audit ledger (compute + live-volume + snapshot) per session
  / user / fleet; lifecycle audit centralized in `WorkspaceService` so the ledger
  is complete. **Time-windowing — DONE** (`feat/cost-time-windowing`): `?window=all|1d|7d|30d`
  scopes the report to the last N days (pure interval-clipping in `@edd/core`; lifetime
  path unchanged, so the rollup figure-equivalence invariant is untouched). The earlier
  "sizable bucketed-rollup subsystem" was unnecessary — on-the-fly clipping is exact.
  The O(history)→O(recent) cost **rollups** were already done (`BUGS.md` → Resolved).
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
- **Focused sockerless fidelity exploratory pass — first slice DONE (2026-06-17).**
  Adversarial conformance sweep of the AWS call shapes we depend on (process-mode sim,
  pin `c69cd278`), diffing each against documented AWS behaviour. **EBS/ECS/Secrets-Manager/
  CloudWatch error+filter shapes are largely conformant**; filed three genuine cloud-spec
  gaps upstream — **#590** (EC2 `DescribeSnapshots` ignores `MaxResults`/`NextToken`),
  **#591** (EC2 `CreateVolume` accepts a missing required `AvailabilityZone`), **#592** (ECS
  cluster-scoped ops don't raise `ClusterNotFoundException`) — **all fixed by upstream #593 and
  confirmed downstream** (submodule re-pinned `c69cd278` → `fcb58281`; see `BUGS.md`). Two
  would-be findings were discarded as probe errors, not sim bugs.
  - **Slice 2 DONE (2026-06-19, pin `322d16ad`):** ECS `RegisterTaskDefinition`/`RunTask`/`DescribeTasks`
    request-validation, EventBridge Scheduler `CreateSchedule`, CloudWatch Logs pagination, Secrets
    Manager error shapes. Filed **#618** (ECS under-validates: Fargate task def w/o cpu+mem; `RunTask
count>10`; `DescribeTasks` empty `tasks`) and **#619** (Scheduler accepts an invalid
    `ScheduleExpression`) — both non-blocking (sim is more lenient than AWS). Pagination + error shapes
    on the probed surfaces were otherwise conformant; see `BUGS.md` → External blockers. Adopt on the
    next re-pin once fixed upstream. **S3/IAM/STS were dropped from scope** — product code imports none
    of them (only EC2/ECS/CloudWatch-Logs/CloudTrail/Secrets-Manager/Pricing/Scheduler), so probing
    them would violate §6.8 "surfaces we depend on".
  - **Remaining for a later slice:** ECR (image pulls), CloudTrail filter/lookup edge cases, and KMS
    (DR) — keep it adversarial (unexpected params, pagination, error shapes), validate every probe
    against the AWS spec first, and file genuine gaps only in `e6qu/sockerless` (§0.9).
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
  - **`e2e-aws` first slice is BUILT (2026-06-17), gated only on the role/secrets.** The
    workflow (`.github/workflows/e2e-aws.yml`) wires OIDC → role, a self-contained real-EBS
    snapshot round-trip smoke (`packages/e2e/src/aws-ebs-smoke.ts`), an `always()` tag-sweep
    teardown, and a 30-min cost cap. To run when AWS lands: set repo vars `E2E_AWS_ROLE_ARN`
    (+ optional `E2E_AWS_REGION`) and dispatch on `main` with `confirm=RUN`. **Untested until
    a real account exists** — validate the teardown on the first run. Fuller suites (Fargate
    cold-start, federation, IAM enforcement, 200+ load, wake-on-connect) follow as further jobs.
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
- **sockerless submodule re-pinned `1ca1f71 → c69cd27` (2026-06-16):** picks up
  **#569** (process-mode managed-EBS `RunTask` panic fix — see `BUGS.md`) plus later
  Azure/GCP/GitLab simulator cells (none touch our AWS ECS/EBS surfaces). Follow-up:
  re-enable a process-mode managed-EBS `RunTask` in the `integration` job to confirm #569.
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
