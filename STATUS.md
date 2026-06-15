# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-14 (docs + launch-readiness audit branch)

## Current phase

**Docs accuracy pass — run-everywhere story.** Reviewed all docs against current
code and fixed drift: the README now frames the run spectrum (local fakes → local
sims → cloud via the Terraform module) and uses `edd.localhost`;
`docs/running-locally.md` gained the missing `+ Entra` command (with the HTTPS
caveat); `docs/deploying.md` split env into `secret_environment` vs
`extra_environment`, fixed the FARGATE/`golden_repository_urls` nits, and the SSH CA
material default; the module README inputs/outputs tables gained the alarm vars + 5
missing outputs; and the `examples/complete` composition now wires
`extra_environment` (so `EDD_ADMIN_GROUPS` is settable) with a fuller tfvars
example. `terraform fmt`/`validate` clean.

## Prior phase (merged, #86)

**Local dev login UI (seeded users) + `edd.localhost` cookie isolation.** Replaced
the hand-edit-cookies dev-auth flow with a real `/login` form (gated on
`EDD_DEV_AUTH=1`): pick a seeded account + password. The accounts are
**configuration, not app code** — `@edd/config` `devUsers()` parses `EDD_DEV_USERS`
(JSON) with a built-in default set (admin/member/viewer), and `devPassword()`
(`EDD_DEV_PASSWORD`, default `dev`); a per-account `password` overrides it. Server
actions set host-only `edd-dev-*` cookies (scoped to `edd.localhost`, so other
localhost apps' cookies aren't disturbed) and a dev-aware sign-out clears them.
Playwright tests (`e2e/login.pw.ts`) sign in via the form as each role and assert
role-appropriate access (admin reaches the console; member/viewer denied;
wrong-password rejected; sign-out clears). Also: `pnpm reap` now actually tears
down profile-scoped sim containers (it was skipping `--profile` services), and a
reusable `pnpm --filter @edd/web screenshot` captures the dev UI. Verified live
against the sockerless tier (`pnpm dev` + `EDD_DEV_PROFILES=aws`).

Also folded into this PR (CI surfaced the recurring flake): **wake-on-connect
claim-before-launch** — the wake path persists the `stopped → provisioning` claim
(version CAS) before launching, so a burst of concurrent connects starts exactly
one task and the rest wait for it, instead of N launched-then-compensated tasks (a
thundering herd that intermittently overran the sim). Two-phase domain
(`markWaking`/`markProvisioned`), a `provisioning → stopped` rollback transition,
strict `start()` + idempotent `connect()` re-dispatch. Proven deterministically in
the integ tier (N concurrent wakes → one launch, all running).

## Earlier (merged, #85)

**Observability completion — the remaining launch-readiness gaps, in one PR.**
Building on the #84 audit, closed everything actionable left in
`docs/observability-gaps.md`: (1) a `withObservability` route wrapper emits
per-request latency/status/error metrics + a structured access log across all
business API routes; (2) the reconciler emits fleet gauges (total/running/stopped/
active) + a priced `fleet.cost.usd` each sweep; (3) reconciler health is real — a
heartbeat record + `reconcilerHealthFromHeartbeat` staleness check replace the
hardcoded `unknown` on the board; (4) the admin Logs view filters the container
stream to one workspace (`?workspaceId=` → task log-stream prefix); (5) SSH-cert
issuance accepts the CA private key as material via `EDD_SSH_CA_KEY` (Secrets
Manager ARN — the secure default, never in Terraform state). All coordinate-driven
and unit/integ-tested. The one substantial item left is **`e2e-aws`**, external —
blocked on the AWS account decision (open decision #1).

## Earlier (merged, #84)

**Docs review + launch-readiness audit.** Reviewed all docs and made them
navigable and accurate: surfaced previously-orphaned docs (`admin-ui-design`,
`infra/images`, `infra/proxy`, `services/ssh-gateway` READMEs) in the README index;
added a full AWS deployment runbook (`docs/deploying.md`); made the
`docs/running-locally.md` tier commands runnable; inventoried the
logs/health/status/metrics/testing gaps in `docs/observability-gaps.md` and closed
the headline ones — `/api/readyz` readiness probe, storage Health-board check,
structured logging, a metrics layer (`@edd/cloudwatch-metrics` EMF) with CloudWatch
alarms, and CloudTrail audit pagination.

## Earlier (merged, #83)

**On `feat/ecs-exec-datachannel-proof`:** the container-mode ECS Exec coverage now
proves the command path, not just the `ExecuteCommand` response shape — opens the
returned SSM WebSocket, sends the standard `OpenDataChannel` handshake, runs a
marker command, and asserts it in the streamed AgentMessage frames. Also hardened
the control-plane AWS clients (ECS/Secrets/EC2) to adaptive retry (`maxAttempts=6`)
so concurrent wake-on-connect bursts don't surface a transient `RunTask` 5xx.

## Earlier (merged, #82)

**On `feat/aws-price-list`:** accurate costing now sources rates from the **AWS
pricing model directly** — live from the AWS Price List API (`pricing:GetProducts`)
for the deployment's region (`apps/web/lib/aws-pricing.ts`), opt-in via
`EDD_AWS_PRICING=1`, best-effort with per-rate fallback to the configured
`@edd/config` rate (so a missing/denied API never mis-prices). The pure parser is
unit-tested against a recorded GetProducts shape; the live fetch has no simulator
(no Pricing API) so it's exercised against real AWS (`e2e-aws`), CI uses the
fallback. Formula unchanged (Fargate vCPU/GB-hr + EBS/snapshot GB-mo).

## Earlier (merged, #81)

**On `feat/cost-rollups`:** the cost report moves from O(history) to O(recent)
without changing the figures. New pure core (`deriveBillingState`/`resumeBilling`,
46 figure-equivalence cases) lets the report price each workspace by resuming a
persisted checkpoint + replaying only the events since it; a `costRollup` DynamoDB
entity (reuses GSI1, no table change) + `StoredCostRollupStore` + `CostService.rollup()`
(admin trigger `POST /api/admin/costs/rollup`) persist/regenerate the checkpoints;
`report()` uses them when present, else the exact full scan. Proven byte-identical
to the full scan against DynamoDB Local (`cost-rollup-equivalence.integ.ts`).
Pricing uses the AWS on-demand **model** (Fargate vCPU/GB-hr + EBS/snapshot GB-mo,
us-east-1 rates, `EDD_PRICE_*`-overridable); live region-accurate rate sourcing via
the AWS Price List API is the next (real-AWS-validated) follow-up — `BUGS.md` → Open.

## Earlier (merged, #80)

**On `feat/ecs-secrets-health-cost-exec`:** an ECS hardening sweep clearing the
remaining Open compute items:

- **Agent token → Secrets Manager (security).** `runTask` stores the per-workspace
  HMAC agent token in a Secrets Manager secret and references it from a
  per-workspace task def's container `secrets`, instead of plaintext
  `environment` (which surfaced in DescribeTasks/CloudTrail). ECS resolves it into
  the container env at launch. Container-mode e2e (`agent-secret.e2e.ts`) +
  user-journey heartbeat prove it.
- **Real `health()`.** DescribeClusters-backed compute health (ACTIVE→ok), closing
  the inverted contract (board showed `unknown` on AWS). Process-mode integ.
- **ECS Exec on the launch path.** `runTask` sets `enableExecuteCommand: true`.
- Found + filed a sim bug (**sockerless#569**): process-mode RunTask with managed
  EBS panics (nil Docker client), so the secret/runTask path is validated in
  container mode (not the process-mode `integration` job).

Deferred (the one explicitly perf-only item, not a bug): cost-report time-windowing

- rollups (`BUGS.md` → Open) — a correct mid-session-boundary rollup is a sizable
  subsystem and must not change figures, so it stays a follow-up. `CONNECTION_TOKEN`
  injection lands with the future DYNAMIC wake-on-connect gate it's tied to.

## Earlier (merged)

**`runTask` readiness gating (#79):** `runTask` waits for the task to be READY
(`taskReady`: RUNNING + managed-EBS volume + ENI) before returning, so the control
plane never advertises a workspace that can't yet accept connections.

**On `feat/sim-probe-coverage`:** a sim-probe coverage pass — added a
**multi-generation EBS snapshot-chain** probe to `packages/storage-ec2/src/ec2-storage.integ.ts`:
snapshot a volume that was itself hydrated from the previous generation's snapshot,
twice, asserting per-generation snapshot→source lineage and restore-from-a-restored-
snapshot. This is the scale-to-zero persistence loop over repeated idle cycles at the
EC2-API layer. The sim handles it correctly (probe green) → no upstream gap to file.
The §6.9 storage filter comment is current (the stale workaround was removed in #74).

**Prior phase (merged, #77):** the **live per-workspace-authz chain** (increment-2 /
DO_NEXT #5) — the PEP→PDP decision proven in the real Pomerium routing path.

The #77 chain also found+fixed a real PDP bug (the proxy preserves a non-default
`Host` port while Pomerium binds the assertion `aud`/`iss` to the bare hostname → the
PDP now authorizes on the port-stripped hostname) and a gate `Dockerfile` missing
`@edd/core`; it standardized the local app port 3000 → **3700**.

**Earlier (merged):** a **GitHub App** provider behind a new
`GitProvider` seam, plus a new architectural principle. `apps/web/lib/github.ts`'s
token-parametrized functions become `UserOAuthGitProvider` (default), joined by an
`InstallationGitProvider` that signs an RS256 app JWT (`jose`) → mints an
installation token (`ghs_…`) → installation-scoped REST. `getGitProvider(ownerId)`
selects by config (`EDD_GITHUB_APP_ID` + `EDD_GITHUB_APP_KEY` → App mode, else the
user's stored OAuth token); the repos/namespaces routes + the clone/push broker go
through it (the broker picks the installation by the repo's owner). The git
credential is wire-identical (`x-access-token` + bearer), so the broker + UI are
provider-agnostic. **New HARD RULE §6.9 "Coordinates, not targets — the simulators
do not exist":** to the app + tests there is no sim-vs-real branch anywhere; only
**coordinates** (endpoints, credentials, resource ids) point at a target, and the
same code/test hits a sockerless sim or the real cloud by changing coordinates
alone, through standard APIs only (never a sim's `/internal`). The App e2e
(`github-app.e2e.ts`) is **purely coordinate-driven**: it reads the App's id + key +
org/repo + base URL from env and **skips** when absent — it has no notion of
bleephub. bleephub can't yet seed a pre-registered App via standard config, so CI
can't supply sim App coordinates; filed upstream as **sockerless#559** (the e2e runs
against real GitHub when secrets are supplied; the provider + app-JWT logic is
unit-tested meanwhile — 12 tests). Gates green (lint/knip/jscpd/build/unit).

**Prior phase (merged):** the **cost visualization** track (PR #71) —
the last of "admins + costs + audit" (admins ✓, audit ✓ #70). An admin **Costs**
console (`/admin/costs` + `/api/admin/costs`) prices each workspace's running vs.
scaled-to-zero time and rolls it up per session, per user, and to a fleet total
(compute = Fargate vCPU+memory while running; storage = live EBS while running;
snapshot = EBS snapshot while scaled-to-zero). Run-time is **derived from the
lifecycle audit ledger** (user decision), and pricing defaults to **us-east-1
on-demand, env-overridable** (`@edd/config`). Making the ledger authoritative
required **centralizing lifecycle audit in `WorkspaceService`**: it now records
`session.create/start/stop/delete` on the _actual_ state transition — so
gate-wakes (`connect()`) and reconciler scale-to-zero/drift stops are captured
exactly once (route-level emits removed; actor threaded, `system` for
machine/reconciler). **Accuracy is not an MVP compromise:** each event is written
in the SAME DynamoDB transaction as its transition (`createWriteTransaction`), so
the ledger can never drop or double-count a billable event — proven by
`cost-ledger-atomicity.integ.ts`; deleted workspaces still price (events are
append-only). **Live:** a running workspace's open interval is priced to `now` on
every fetch, and the page auto-refreshes (`LiveRefresh`, 15 s) so consumption is
visible in near real time. The pure cost model is in `@edd/core`
(`deriveBillingIntervals`/`priceIntervals`/`computeFleetCost`); `CostService`
joins the ledger with current records. Gates green (lint/knip/jscpd/unit/integ/
web build/Playwright 9/9).

**Prior (merged to `main`):** PR #68 (per-workspace proxy authz — gate PEP +
PDP), PR #69 (core user loop — repo-per-session + private clone/push broker +
wake-on-connect gate + GitHub launcher UI; polyglot golden image + real-VS-Code
proof + ECS hardening), PR #70 (first-class audit log). The core-user-loop detail
below describes the now-merged #69 work:

- **Repo-per-session** (incr. 1): `repoUrl` threaded end-to-end; golden image
  clones the repo on first boot (idempotent; skips on snapshot wake). Public
  clone proven against the real image. `repoUrl` optional (blank sessions OK).
- **Private clone + push** (incr. 1b): AES-256-GCM `token-crypto`, per-owner
  `gitCredential` entity + `GitCredentialService`; GitHub token captured at
  sign-in (encrypted, server-side); **agent-only broker**
  `GET /api/workspaces/:id/git-credential` + an in-image git credential helper
  fetch the token at use time — clone+push work with **nothing on the EBS
  volume**. Token never in task metadata or the browser.
- **Wake-on-connect gate** (incr. 2 core): the workspace gate resolves each
  workspace's live address per request (ws-id from Host → `POST /connect` wake →
  `GET /connect-info?protocol=http` via gateway HMAC) and proxies HTTP+WS — one
  gate fronts every workspace (Pomerium's single static upstream), waking
  scaled-to-zero sessions on reconnect (the "reopen → session intact" behavior;
  session state persists on the EBS snapshot). OpenVSCode
  `--without-connection-token` flag for the gated deployment.
- **GitHub session launcher** (incr. 3): `GitProvider` (list repos, namespaces
  with permission flags, create repo) + `/api/github/repos|namespaces` routes
  (token server-side only) + the **`/sessions/new` UI** — search repos → start
  session, or create a repo (default private; **grayed out with the reason** when
  not permitted), or blank session.

Decisions honored: clone via the user's GitHub OAuth token (encrypted, brokered);
gate-is-the-auth (tokenless OpenVSCode behind it); many sessions per repo per
user; cross-user isolation via proxy authz. Remaining: increment-2 deployment
wiring (Pomerium→gate route + full browser e2e) and the first-class audit log +
cost-visualization tracks. SAST hardening this round: pinned GCM auth tag length;
test secrets generated at runtime.

## Prior phase

**PRs #56–#67 are merged to `main`** (test-gap closure, gateway machine-auth,
sockerless #549/#550 consumption, live portal + Pomerium browser e2e over TLS,
the lifecycle correctness-hardening pass, the authz/concurrency depth pass —
delete-vs-wake leak fix, exhaustive CASL matrices, snapshot-vs-stop conflict fix
— and data durability across a real scale-to-zero cycle + the reconciler
container drift sweep).

**PR #68 is merged** (per-workspace proxy authorization — the gate PEP +
`/api/internal/authz` PDP, ownership by owner email).

Current branch `feat/vscode-workspace-proof` proves the headline product — a
usable VS Code workspace — and hardens the ECS service:

- **Polyglot golden image, out of the box.** `infra/images/workspace` now ships
  Node 22 (npm/yarn/pnpm/bun), C/C++ (build-essential), Go, Java + Maven +
  Gradle, Rust, Python + uv, and Playwright + headless Chromium. Tools install
  system-wide with a `/etc/profile.d` entry so they're on PATH for the OpenVSCode
  terminal and SSH. ~3 GB image (headless-shell, not full Chromium, to stay
  lean). `packages/e2e/src/workspace-toolchain.e2e.ts` compiles+runs a
  hello-world in every language (real artifacts) as the `workspace` user.
- **Real VS Code, driven in a browser.** `apps/web/e2e/vscode-workspace.pwvscode.ts`
  (`test:pw:vscode`) loads the OpenVSCode workbench, opens the integrated
  terminal, types code, compiles it, and verifies the produced ELF binary on
  disk — with screenshots. The headline promise, proven end to end.
- **OpenVSCode :3000 inside the sim ECS task.** `golden-workspace-ssh.e2e.ts`
  now also asserts the awsvpc task serves OpenVSCode on :3000 (its token gate),
  not just sshd.
- **ECS compute hardening** (gap audit): task def declares `portMappings`
  (3000 + 22); `executionRoleArn`/`taskRoleArn` supported; `fromEnv` reads task
  sizing + roles (were hardcoded in production); `awslogs-region` via config;
  `stopTask` sends a reason. Remaining follow-ups in `BUGS.md` → Open (readiness
  gating, ECS secrets, real `health()`).

Earlier on this line:

- **The gap:** the Pomerium wildcard route was `allow_any_authenticated_user`, so
  the proxy enforced no per-workspace ownership.
- **The fix (external-authz → control plane):** a workspace **gate**
  (PEP, `services/workspace-gate`) fronts each workspace, verifies the Pomerium
  identity assertion against Pomerium's JWKS, and calls a control-plane **PDP**
  (`/api/internal/authz`) that maps `<ws-id>` subdomain → owner in DynamoDB and
  allows only the owner (by **email** — the identity the Auth.js portal IdP and
  the Pomerium proxy IdP share; `sub`/`oid` differ) or an admin. Workspaces now
  record `ownerEmail`. Pomerium binds the assertion `aud` to the workspace host
  (verified in v0.32.2 source: `authorize/evaluator/headers_evaluator_evaluation.go`),
  so a token can't be replayed across workspaces.
- **Proof:** core unit tests (host→id parse, access decision), the gate component
  test (HTTP + WebSocket, allow/deny/missing/PDP-down), the PDP integration test
  (DynamoDB ownership, admin bypass, replay/expiry/forgery), and an end-to-end
  test that verifies a REAL Pomerium assertion against Pomerium's real JWKS
  (`apps/web/app/api/internal/authz/route.e2e.ts`). The harness `pomerium.yaml`
  keeps the direct identity-gate route for the identity-layer suites; production
  routes the workspace `to:` through the gate (documented inline).
- No sockerless bugs found (Pomerium assertion + JWKS verified faithfully).

Current branch `feat/data-durability-container-drift` adds the two end-to-end
gaps from the latest review (no new product bugs found):

- **Data durability across a real scale-to-zero cycle** — through
  `WorkspaceService`: SSH writes a marker+checksum into the workspace, `stop()`
  snapshots, `connect()` wakes a NEW task from the snapshot, and SSH into the
  woken task confirms the file is byte-identical. Proves "your work survives
  scale-to-zero" end to end (the prior data-fidelity test only covered the EBS
  primitives via bare tasks). `packages/e2e/src/data-durability.e2e.ts`.
- **Reconciler CONTAINER drift sweep** — `reconciler-container.e2e.ts` now also
  seeds a workspace whose task is killed out-of-band; the scheduler-fired
  reconciler container's `runMaintenance` drift pass reconciles it to stopped
  (the in-process drift path was already covered by `drift-recovery.e2e.ts`).

A follow-up depth pass (PR #66, `feat/authz-matrix-concurrency-gc`) hardened the
remaining unhappy paths and found one more real bug:

- **delete-vs-wake task leak (real bug, fixed):** `remove()` used an
  unconditional `.delete()`, so a delete racing a wake could remove the record
  while `start()` launched a task — orphaning it. `remove()` is now
  version-conditioned (claim-the-delete-first) and defers snapshot reaping to GC
  (the single storage reaper, with a grace window), which also removes a
  snapshot-vs-wake race. Proven by `concurrency-pairs.integ.ts`.
- **CASL matrices:** the unit ability table is now exhaustive (every
  role × action × subject, 62 cases); a route-level matrix asserts each HTTP
  route enforces it (viewer denied across every verb, member can't mutate the
  catalog, unauth → 401).
- **Concurrency pairs:** stop-vs-snapshot, stop-vs-heartbeat, two-snapshots, and
  delete-vs-wake each prove exactly one winner + one clean conflict (no 500, no
  double side effect) under the version guard.
- **GC TOCTOU:** a freshly-created unreferenced volume within the grace window
  is never reaped (protects a create racing the sweep).
- **ssh-cert hardening:** the public-key contract now rejects malformed/oversized
  /multi-line/unknown-type keys with 400 at the boundary (was a 500 from
  `ssh-keygen`); no shell injection (key written to a file).

Current branch: `feat/hardening-races-drift-scale` (PR #65) — the unhappy-path
hardening pass (the failure modes the happy-path coverage didn't reach), each
found or fixed via a test:

- **Concurrent-wake task leak (real bug, fixed):** `WorkspaceService.persist`
  was an unconditional PutItem, so two simultaneous `connect`/`start` calls on
  a stopped workspace both launched a real ECS task and the loser's leaked
  forever. Added an optimistic-concurrency `version` field; every transition is
  a conditional update (`persistTransition`), the wake loser stops its own
  just-launched task and returns the winner's state (idempotent). E2e fires 5
  concurrent connects and asserts exactly one task survives.
- **Crash-consistency (fixed):** `create`/`start` launch the task before
  persisting; a persist failure now stops the just-launched task instead of
  orphaning it. Integ injects a DynamoDB write outage via the AWS SDK
  middleware stack.
- **Drift detection (new feature):** the reconciler now runs a drift sweep
  FIRST — a record whose task died out-of-band (crash/eviction) is reconciled
  via the new `ComputeProvider.taskState()` to `stopped` (snapshot → wake-able)
  or `error` (nothing to restore), so connect-info never hands out a dead ENI
  and the idle sweep never snapshots a released volume. E2e kills a task with
  raw ECS StopTask and asserts recovery.
- **Pagination / quota-bypass (real bug, fixed):** `WorkspaceService.list`
  used a single-page `.go()`; past DynamoDB's 1 MB page it truncated, which
  undercounted the per-owner quota check (a **quota bypass at scale**) and hid
  workspaces from the admin list. Now `pages: "all"`; integ seeds >1 MB and a
  reconciler integ sweeps a 450-record fleet.
- **Adversarial auth tests:** forged/tampered Pomerium session cookie stays
  gated; Auth.js callback rejects a missing-PKCE-verifier replay and a reused
  authorization code (PKCE is the GitHub provider's active check, verified in
  `@auth/core`); sshd rejects a wrong-CA and an expired certificate.
- **Heavy data fidelity:** 64 MiB random payload round-trips snapshot→restore
  byte-for-byte (`sha256sum -c`). **TLS storage adapter:** the EBS adapter runs
  over the TLS aws-sim with real CA trust in `e2e-https`.

Security review (`/security-review`) on the branch diff: no HIGH/MEDIUM
findings; the pagination fix is itself a quota-bypass remediation.

Upstream: sockerless **PR #550** (bleephub Actions follow-ups — cancellation,
runner groups, composite actions, runner-on-cloud volume translation) merged
and the submodule pin bumped to `9d43f3d`; none of it touches our surfaces
(we consume bleephub for OAuth only), and the bleephub auth e2e pass on it.

## What works (built, tested, merged to `main`)

- **Monorepo** (`@edd/*`, Turborepo+pnpm); `main` protected.
- **Core** (`@edd/core`): branded domain types, lifecycle state machine, pure functions
  (provision/stop/start/snapshot/`markActivity`/`planConnect`, base-image catalog),
  Storage/Compute ports + fakes.
- **Control plane** (`apps/web` + `@edd/control-plane`): `WorkspaceService` lifecycle
  (create/stop/start/connect/heartbeat/snapshot/remove) + `CatalogService`, over
  ElectroDB, CASL-gated API + `@edd/api-client`. Fargate managed-EBS model.
- **Auth** (`@edd/auth`): GitHub + Entra → group→role, both proven mock-free & swappable.
- **Portal** (`apps/web`): RBAC workspaces grid + lifecycle, base-image catalog admin
  page + create-from-catalog picker.
- **Reconciler**: idle scale-to-zero, scheduled snapshots, orphan GC (pure selectors).
  Container (`services/reconciler`): esbuild bundle; scheduler→ECS→container e2e proven.
- **Real adapters** (endpoint-only): `@edd/storage-ec2`, `@edd/compute-ecs`.
- **Deploy IaC** (`infra/terraform/modules/ecs-dev-desktop`): reusable parametric module
  (VPC + NAT [managed or fck-nat], KMS, DynamoDB+GSIs, ECR, ECS + Fargate + autoscaling,
  ALB + optional ACM/Route53, scheduler, IAM, logs). **`terraform-sim` CI job applies +
  destroys the full stack every PR** in the default, fck-nat, and DNS/TLS configs
  (resource/functional assertions + idempotency). Endpoint-only (§6.8). Real apply is AWS-gated.
- **Golden workspace image** (`infra/images/workspace/`): Node 20 + OpenVSCode Server
  v1.109.5, tini PID-1, OpenSSH `sshd` with trusted CA/principal enforcement,
  idle-agent (heartbeats every 120s, HMAC machine-auth), and multi-arch
  OpenVSCode asset selection.
- **Real adapter wiring** (`apps/web/lib/control-plane.ts`): `COMPUTE_PROVIDER=ecs`,
  `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`; fakes remain default.
- **SSH gateway** (`services/ssh-gateway`): standard `sshd` + ephemeral CA
  (`scripts/gen-ssh-ca.sh`); `TrustedUserCAKeys` + `AuthorizedPrincipalsFile` RBAC;
  connect-as-principal + authz-deny proven mock-free. PTY allocation tested (`-tt`).
- **SSH cert API** (`POST /api/workspaces/:id/ssh-cert`): control plane signs user's
  public key with `ssh-keygen -s`; returns short-lived cert for `dev-<workspaceId>` principal.
- **Wake-on-connect proxy**: `sshHost` (ENI private IP — routable since sockerless PR #518;
  overlapping-CIDR VPC fidelity improved by PR #519)
  stored on `Workspace`/DB; `GET /api/workspaces/:id/connect-info` returns `{host, port}`;
  `Dockerfile.proxy` + `wake-and-forward.sh` + `proxy-entrypoint.sh` ForceCommand gateway
  authenticating with per-workspace HMAC machine-auth (`EDD_GATEWAY_SECRET`).
  Full chain e2e: client SSH → proxy container → REAL control plane (wake from
  stopped) → nc → workspace node; the stub-CP variant remains as a component test.
- **Workspace CloudWatch log shipping**: `EcsComputeProvider` adds `awslogs` `logConfiguration`
  to every task definition; `ECS_LOG_GROUP_WORKSPACES` injected by Terraform.
- **Pomerium routing** (`infra/proxy`): identity-aware wildcard routing + authenticated
  proxy-pass (`X-Pomerium-Jwt-Assertion`) — both proven mock-free against azure-sim,
  over real TLS (Pomerium forces https in all absolute URLs), incl. a real-browser
  OIDC login (`test:pw:pomerium`).
- **Phase 8 (8A+8B+8C)**: admin console (health board, all-workspaces, Inspect, Overview,
  quotas, Logs/Audit); `@edd/cloudtrail-audit` + `@edd/cloudwatch-logs` endpoint-only
  adapters, integration-tested against the sim.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim;
  route-level lifecycle/gateway-auth/admin-data suites) · e2e (data-fidelity,
  LIVE user journey through the real API on container-mode adapters, lifecycle,
  auth incl. Auth.js callback routes, Pomerium, OpenSSH gateway + real-CP wake
  chain, overlapping-CIDR awsvpc, reconciler container incl. real scale-to-zero,
  managed-EBS golden workspace SSH, ECS Exec smoke) · live admin observability
  route tests against sockerless AWS CloudTrail/CloudWatch · portal e2e
  (Playwright) · `e2e-https` (sims over TLS, real CA trust, no `--insecure`;
  incl. the Entra Auth.js callback leg) · manual `e2e-aws`.
- **Engineering quality**: typed `Result<T, DomainError>` channel; compile-time
  exhaustiveness guards; typed `data-testid` registry; `waitForDynamo` harness
  determinism; `knip` + `jscpd` code-health gates; SAST + Trivy.

## Deployed

Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

1. **AWS account/region decision** (`DO_NEXT` #1) — the top blocker; unlocks
   everything real.
2. **Live-test candidates exhausted** (`docs/simulator-live-coverage.md`):
   browser Pomerium OIDC login landed as `test:pw:pomerium` (real-TLS Pomerium
   harness; Chromium completes gate → IdP → callback → workspace), after
   `test:pw:live` (browser lifecycle on real ECS compute). Only the optional
   ECS Exec workspace probe remains, gated on a product decision.
