# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, blockers. Update after every task.

---

## Open decisions (need the user)

1. **AWS account/region & data-residency** — **the top blocker.** Gates real Terraform
   apply, Phase 1 deploy, SSH/proxy real federation, reconciler cron, real CloudTrail/
   CloudWatch, Phase 7, `e2e-aws`.
2. **Domain & DNS owner** — base domain + cert/DNS delegation. The browser editor proxy is now
   **path-based on a single domain** (`app.<domain>/w/<id>/`), so it no longer needs wildcard DNS
   or a wildcard TLS cert (a single-host ACM cert suffices); the SSH gateway still wants its own
   `<ws-id>.<ssh-base-domain>` zone. Gates ACM cert issuance + the SSH zone.
3. **Heartbeat interval & idle threshold** — scale-to-zero tuning. The knobs
   now exist (`EDD_HEARTBEAT_INTERVAL_S` injected into workspace tasks;
   `EDD_IDLE_THRESHOLD_MS`/`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_EARLY_SNAPSHOT_INTERVAL_MS`/
   `EDD_EARLY_SESSION_MS`/`EDD_GC_GRACE_MS` on the reconciler) — the open decision is
   only the production default values.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS ·
manual real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor
1440 · admin observability = derive-now + CloudTrail/CloudWatch · OpenVSCode Server ·
OpenSSH registered-key auth (no CA) · **identity-aware proxy — decided 2026-06-20: Pomerium
DROPPED.** The external Pomerium proxy + the standalone `workspace-gate` PEP/PDP were removed and the
browser→editor proxy was **folded into the Next.js control-plane app** — path-based single domain
(`app.<domain>/w/<id>/`), authorized in-process by the Auth.js session (uid-ownership/admin); no
wildcard DNS/TLS, no PDP round-trip, no gate machine-auth (`apps/web/server.ts` +
`apps/web/lib/workspace-proxy.ts`; see `WHAT_WE_DID.md` 2026-06-20 + `BUGS.md`).

---

## Code-review remediation (codex 2026-06-19) — DONE (merged #129, Phase 9)

The deep `codex` review surfaced 12 findings (4 Critical, 3 High, 4 Medium/Low) — **all remediated and
merged in #129**, re-verified against the merged code. Detail now lives in `BUGS.md` → Resolved (repo).
The previously-deferred cross-region EBS snapshot DR flow was pulled in (sim-validatable via
sockerless#602). `CONNECTION_TOKEN` injection — once parked on the future DYNAMIC wake-on-connect gate —
**shipped 2026-06-20** with the in-app path-based editor proxy: the control plane injects the per-workspace
connection token via Secrets Manager and the proxy hands the session-authorized browser the token on the
initial document navigation (see `BUGS.md` → Resolved + `WHAT_WE_DID.md` 2026-06-20).

Only genuinely AWS-account-gated work (real `terraform apply`, real DNS/ACM, real IdP federation, 200+
load, live `e2e-aws` enforcement) stays under decision #1 above — that is an external decision, not a
deferral by choice.

## Available now (decision-free — immediate)

- **Third adversarial spec-fidelity probe wave — DONE on branch `feat/adversarial-probes-wave3` (2026-07-01).** All ten probe slices are implemented, wired into `terraform-sim`, and the full CI run is green. Merge PR #179 on user go-ahead, then return to AWS-account-gated deploy readiness. **e6qu/sockerless#734** remains open (CloudWatch Alarm → SNS → SQS delivery is flaky/malformed), so the alarm probe skips SQS receipt verification pending the upstream fix.

- **Merge PR #179.** Land the sockerless #737 bump + the adversarial probe wave now that CI is green.
- **Merge PR #178.** All CI checks are green (including `terraform-sim`). Land the sockerless bump + strict adversarial probes, then return to AWS-account-gated deploy readiness. (1) **Viewer RBAC** — the demo now gates its
  mutating controls on the REAL `@edd/authz` `defineAbilityFor` (`DemoControlPlane.canMutateWorkspaces()`),
  so a viewer sees the workspace list read-only (no create form, no start/stop/delete) — the identity
  switcher tells a true CASL story. (2) **Provisioning dwell** — `create` now lands in `provisioning` and
  advances to `running` after a short dwell (`markProvisioned`, the real transition), so the scale-to-zero
  cold-start (the `StateBadge` pulse → "Open IDE appears when ready") is visible. (Boy-scout alongside:
  `persistence.loadState` now validates the top-level SHAPE, not just the version number — §6.5a.)

- **AWS deploy-readiness — DONE (PR #172 merged, 2026-06-28).** Closed every code/docs gap blocking a real AWS deploy that didn't need a user decision: Terraform examples wired for SSH ingress, control-plane Dockerfile builds the reconciler bundle, bootstrap/publish/install/uninstall scripts, `release` workflow, `docs/architecture.md` + `docs/install.md`, multi-arch image publishing convention, golden-image ECR path fix, variant-name alignment, workspace memory bumped to 2048 MiB, and dependency-freshness refresh. The module remains sim-apply-proven; real `apply` is still gated on open decisions #1/#2.

- **Terraform `*.devbox.<domain>` wildcard DNS/TLS resources — REMOVED (2026-06-25, vestigial confirmed).**
  Verified no consumer (the HTTPS listener needs only the `app.<domain>` cert); deleted the wildcard
  Route53 record, the wildcard ACM SAN, `local.workspaces_fqdn`, and `var.workspaces_subdomain`, and
  refreshed the sim assertions (ACM SAN count 2→1; the workspace-wildcard Route53 assert repurposed to the
  SSH wildcard). The SSH base domain (`<ws-id>.<ssh-base-domain>`) is separate — untouched.

- **Admin Quotas page: flag who is at/over their limit — DONE (2026-06-25).** Resolved the role-not-stored
  blocker by persisting `ownerRole` on the workspace at create time (the role is otherwise only known at
  the owner's sign-in): threaded through `@edd/core` Workspace/`provision` → `@edd/db` entity →
  `@edd/control-plane` → the `workspace`/`workspaceDetail` contracts → `fleet-status` →
  `QuotaReportDto.usage`. The page now flags `atOrOver` rows. Forward-only (records predating the field
  have no role) → those legacy rows fall back to the **strictest positive** per-role cap (viewer's 0 cap is
  excluded so it doesn't trivially flag everyone). Admin (unlimited) is never flagged.

- **DynamoDB Local retired from all CI — DONE (2026-06-22).** The integration (#148), **e2e**, and
  **playwright** tiers all run on the sim's DynamoDB now; `@edd/config` `dynamodb.endpoint` defaults to the
  sim; `amazon/dynamodb-local` is gone from `tier2`/`e2e` compose + every CI job (see `STATUS.md`/`BUGS.md`).
  The **only** remaining DynamoDB-Local consumer is the local `pnpm dev` loop — kept deliberately for instant
  startup (the CAS flake only bites under CI concurrency), overridable to the sim. A future cleanup could
  migrate the dev loop too (make the sim part of the default dev substrate) to delete DynamoDB Local
  entirely, but it trades dev inner-loop speed for one fewer image — low priority.

- **Moved two e2e-aws-only proofs onto the sim — DONE (2026-06-21).** Acting on the reframe that a sim gap
  is a slice to implement (not a real-AWS wall): **CloudWatch Metrics EMF→metric extraction** is now
  sim-proven (`@edd/cloudwatch-metrics` `test/emf-metric-sink.integ.ts` — `ListMetrics`/`GetMetricStatistics`
  read back our `EmfMetricSink` doc; closes Phase 8C "Metrics on real AWS"), and the **production recurring
  cron model** is sim-proven (`services/reconciler/src/scheduler-recurrence.integ.ts` — a `rate(1 minute)`
  schedule fires its RunTask target ≥2× and re-arms, vs the one-shot `at()` the container e2e covers). Both
  needed NO upstream slice (the sim already had #604 EMF extraction + the scheduler firing loop). Of the
  follow-on sim-first targets: **IAM call-time enforcement — DONE / PROVEN, deepened to condition keys
  (2026-06-22)**. Filed #657 → fixed by sockerless #659 (action-level enforcement) → extended via #660 (full
  condition-operator evaluator; re-pinned `9a1d4e92`). `packages/storage-ec2/src/iam-enforcement.integ.ts`
  proves both **action** level (`DescribeVolumes` allowed, `CreateVolume` denied with `UnauthorizedOperation`)
  and **condition** level (a region-locked policy allows `CreateVolume` in-region, denies it cross-region via
  `aws:RequestedRegion`). **Follow-up (#661) — DONE (2026-06-25):** sockerless #662 now populates
  RESOURCE/SERVICE-scoped condition keys, so our exact tag/cluster-conditioned grants are proven at the sim
  tier too — `storage-ec2/src/iam-enforcement.integ.ts` adds `aws:ResourceTag/edd:managed` (DeleteVolume on a
  tagged vs untagged resource) and the new `compute-ecs/src/iam-enforcement.integ.ts` adds `ecs:cluster`
  (ListTasks on the granted cluster vs another), both via the shared `@edd/aws-itest-support` helper.
  **Cost dashboard visualization — DONE (2026-06-22)**: a no-dependency
  stacked spend bar on `/admin/costs`. **SSH Slice 3 ingress — terraform DONE + sim-exercised
  (2026-06-26)**: the NLB + TCP:22 listener + target group + SSH-gateway ECS service +
  `*.<ssh_base_domain>` wildcard (`ssh-ingress.tf`, gateway image pinned/immutable, no `:latest`).
  terraform-sim asserts the full ingress (apply + idempotency re-plan both clean, re-pinned `08b7ee71`).
  The four ELBv2/NLB sim gaps it depended on are all fixed upstream — #683 (NLB raw-TCP data plane) + #685
  (TCP-TG Matcher) in #687, #688 (TCP-TG HealthCheckPath) in #690, #691 (stable NLB DNSName) in #692 —
  each found on the idempotency re-plan, one per round. Remaining real-AWS work (live byte-stream loop
  through the NLB, real SSH zone) is gated on decisions #1 (account) / #2 (the SSH zone).

- **Wave-3 adversarial spec-fidelity probes — in progress, two upstream blockers filed.** On `feat/adversarial-probes-wave3`:
  (1) **Route53 DNS probe** (`adversarial-slice-route53-dns.sh`) is written and shellcheck-clean; it fails on the wildcard-CNAME assertion because sockerless `e2fafce6` answers DNS queries with exact-name matching only. Filed **e6qu/sockerless#731**. (2) **KMS encryption probe** (`adversarial-slice-kms-encryption.sh`) is blocked by **e6qu/sockerless#732** (KMS `Encrypt`/`Decrypt` do not perform real encryption or enforce key-policy Deny). Both slices will be enabled/strictened once the respective upstream fixes land.

- **Catalog optimistic concurrency (follow-up to the 2026-06-22 sweep L2).** `CatalogService.update`/`create`
  are last-write-wins (no `version` attribute → two concurrent admin edits of the same base image clobber).
  Accepted for now (admin-only, zero-contention; recorded in `BUGS.md` → Open). The fix is to add a `version`
  attribute to the `baseImages` entity + a conditional write, mirroring the `WorkspaceEntity` version-CAS, with
  a conflict integ test. Low priority.

- **Property-based / fuzz testing — ESTABLISHED + extended (2026-06-21, two sweeps).** `fast-check` is part
  of the suite (now **14 `*.fuzz.test.ts`** over the pure functions); the **cost figure-equivalence** and
  **GC-never-reaps-referenced** safety invariants are property-pinned, along with the state machine, the
  fail-closed/never-throw security parsers, and (second sweep) the **machine-token verifier**
  (total/never-throws/exact, workspace-scoped), the **ssh fingerprint** (canonical-base64-only, collision-free),
  and **timeline/audit instant-ordering**. Extend it as new pure logic lands. The two 2026-06-21 sweeps fixed
  ~26 traced bugs total (the second incl. two HIGH: a fail-closed machine-token verifier that THREW, and a
  reconciler convergence sweep that aborted on one transient per-item error) — see `WHAT_WE_DID.md` +
  `BUGS.md`. Two items recorded under `BUGS.md` → Open (neither a code defect to chase): the cost-model
  teardown-volume approximation, and the iam-preflight IAM-path self-check coverage gap (degrades safely).

- **Reconciler runtime IAM preflight (follow-up to the IAM self-check) — DONE (2026-06-20).** The
  preflight adapter was lifted out of `apps/web/lib/iam-preflight.ts` into a shared package
  `@edd/iam-preflight` (`packages/iam-preflight`); `apps/web` imports it and dropped its now-unused
  `@aws-sdk/client-iam`/`@aws-sdk/client-sts` direct deps. `@edd/core` gained pure
  `summarizeIamPreflight`/`IamPreflightSummary` + metric `METRIC_IAM_PREFLIGHT_DENIED`. The reconciler
  (`services/reconciler`) now runs `iamPreflight(env, "reconciler")` at startup and emits the
  denied-action-count metric + a structured log (non-fatal; degrades to unknown), factored into a
  unit-tested `reportIamPreflight`.

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
  the launch path. `CONNECTION_TOKEN` injection — **DONE (2026-06-20)**: `@edd/compute-ecs` injects each
  workspace task's OpenVSCode connection token = `HMAC(EDD_CONNECTION_SECRET, workspaceId)` via Secrets
  Manager (`edd/workspace/<id>/connection`), and the in-app proxy hands the already-session-authorized
  browser the token on the initial document navigation (`editorTokenRedirect` → 302 `…?tkn=<token>`); the
  HMAC derivation is centralized in `@edd/core` (`deriveWorkspaceToken`/`verifyWorkspaceToken`). Tasks are
  also isolated to a dedicated `workspaces` security group (editor port + sshd reachable only from the
  control plane). Sim coverage: `live-ide-flow.e2e.ts` proves the injected token is the one the real editor
  runs with (workbench serves only with it) via the IDE bridge, and `agent-secret.e2e.ts` proves the
  Secrets-Manager injection; the host-process-proxy → in-VPC ENI hop is the e2e-aws tier (the sim task netns
  is not host-routable).
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
  **Graphical spend visualization — DONE (2026-06-22):** the page was tiles + text rows; it now
  also renders a no-dependency stacked proportional spend bar (compute/volume/snapshot) per
  user/session row (server-computed widths, pure div+CSS in the house style). A cost _trend_
  line would need per-day bucketing added to `computeFleetCost` first — out of scope, not queued.
- **GitHub App provider — built** (`feat/github-app-provider`): `GitProvider` seam
  (user-OAuth + GitHub-App installation-token impls), selectable by config; the
  repos/namespaces routes + clone/push broker go through it. New HARD RULE §6.9
  "Coordinates, not targets" (`AGENTS.md`): the App e2e targets the sim or real
  GitHub by coordinates alone. To run against real GitHub: register a GitHub App,
  install it on a test org with a repo, and set `EDD_GITHUB_APP_ID` /
  `EDD_GITHUB_APP_KEY` / `EDD_GITHUB_TEST_ORG` / `EDD_GITHUB_TEST_REPO` /
  `AUTH_GITHUB_API_URL`.
- **Remaining product tracks:** the browser→editor proxy is **done and simplified** — the
  external Pomerium + standalone `workspace-gate` deployment wiring (#77) was **removed 2026-06-20**
  in favor of the in-app path-based proxy (`/w/<id>/`, Auth.js session authz in-process); the
  DYNAMIC full-ECS-wake variant remains a future extension. Sim-probe/coverage pass is
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
- **Module-wide sockerless fidelity audit — DONE, all 10 gaps FIXED upstream, plus follow-up #714 fixed by #715 and probe gaps #722/#723 fixed by #725, validated through integration tier + behavioral probes + heavy container-mode e2e (2026-06-29/30).** Audited every AWS resource created by `infra/terraform/modules/ecs-dev-desktop` against sockerless `08b7ee71`; filed **#703–#712**. sockerless **#713** closed all ten with real behavioral side effects. The follow-up Budgets Terraform gap (**#714**) was fixed by **sockerless #715**. The two probe-wave gaps (**#722** revoke-not-found, **#723** metric-filter validation) were fixed by **sockerless #725**. Re-pinned the submodule to `eaf80dc`. Validated: `pnpm build`/`test` green; `pnpm test:integ` green (web 130/130, reconciler 9/9, storage-ec2 15/15, e2e integ 1/1); `terraform-sim` default apply/destroy + idempotency re-plan pass; `validate-sockerless-713.sh` **13/13 PASS**; all adversarial slices pass with strict assertions. Heavy container-mode e2e (`pnpm test:e2e:local`) passes on the Podman-backed dev workstation: **19/19 tasks**, `@edd/e2e` 46/46 tests passed, 5 skipped. Local Podman fixes: `scripts/test-e2e.sh` uses `infra/images/base/build.sh`; `build.sh` auto-detects Podman and uses `podman build`; the harness starts a local insecure registry (`localhost:15000`) and pushes reconciler/proxy/base/workspace/node images, setting `WORKSPACE_IMAGE`/`RECONCILER_IMAGE`/`PROXY_IMAGE`/`NODE_IMAGE`; `turbo.json` now passes those env vars through to tests.

- **Second adversarial spec-fidelity probe wave — DONE + STRICT (2026-06-30).** Added probe slices for **SQS DLQ redrive on `maxReceiveCount`**, **Application Auto Scaling target tracking on ECS**, **ECS service scheduler `DesiredCount` reconciliation**, **EC2 security group ingress rules**, and **CloudWatch Logs metric filters**. Wired into `terraform-sim` via `run-adversarial-slices.sh`. Hardened the existing ECR/CloudTrail/KMS slice: CloudTrail pagination now uses a time-bounded window and page cap to avoid unbounded loops from prior runs. Found and filed two genuine spec gaps upstream: **e6qu/sockerless#722** (`RevokeSecurityGroupIngress` succeeds for a non-existent rule) and **e6qu/sockerless#723** (`PutMetricFilter` accepts an invalid pattern). Both were fixed by **sockerless #725**; the submodule is re-pinned to `eaf80dc` and the probes now enforce the strict assertions. Also includes the earlier boyscout flake-hardening pass for the `terraform-sim` `ResourceAlreadyExistsException` flake and CI retries on heavy e2e tiers.

- Covered (see `docs/simulator-live-coverage.md`): the real VS Code workspace
  (OpenVSCode browser proof + polyglot toolchain compiles + OpenVSCode :3000 inside
  the sim ECS task), the in-app path-based editor proxy (vscode browser e2e under `/w/<id>/`),
  portal browser lifecycle on real ECS compute, the live user journey, Auth.js callback routes,
  the real-CP wake chain, idle-agent heartbeat, reconciler scale-to-zero, per-workspace proxy authz.

---

## Blocked

- **On AWS (#1):** Terraform module is **built and sim-apply-proven** (full stack incl.
  DNS/TLS: VPC/ECS/ECR/DynamoDB+GSIs/KMS/IAM/ALB+ACM/Route53). Blocked: real apply
  (account + remote state backend), golden image real Fargate deploy, wiring `apps/web`
  to real adapters, real DNS + single-host ACM for the app/editor domain, reconciler cron, CloudTrail/
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
- **On sockerless KMS fidelity:** wave-3 adversarial KMS-encryption probe
  (`adversarial-slice-kms-encryption.sh`) is blocked by **e6qu/sockerless#732**.
  The sim's `kms:Encrypt` does not produce real ciphertext (blob decodes to
  `kms-sim:<key-id>:<base64-plaintext>`) and an explicit `Deny kms:Decrypt`
  principal in the key policy is ignored. Implement the slice once the upstream
  fix lands.

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
- **Pinned versions:** `@playwright/test` ^1.60. (Pomerium was removed 2026-06-20 — the editor
  proxy is now in-process in the Next.js app.)
