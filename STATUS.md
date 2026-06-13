# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-13 (github-app-provider branch)

## Current phase

**In flight on `feat/github-app-provider`:** a **GitHub App** provider behind a new
`GitProvider` seam, plus a new architectural principle. `apps/web/lib/github.ts`'s
token-parametrized functions become `UserOAuthGitProvider` (default), joined by an
`InstallationGitProvider` that signs an RS256 app JWT (`jose`) → mints an
installation token (`ghs_…`) → installation-scoped REST. `getGitProvider(ownerId)`
selects by config (`EDD_GITHUB_APP_ID` + `EDD_GITHUB_APP_KEY` → App mode, else the
user's stored OAuth token); the repos/namespaces routes + the clone/push broker go
through it (the broker picks the installation by the repo's owner). The git
credential is wire-identical (`x-access-token` + bearer), so the broker + UI are
provider-agnostic. **New HARD RULE §6.8→§6.9 "Coordinates, not targets":** a test
is parameterised by coordinates (endpoints, credentials, resource ids) and runs
against the sim OR the real provider by changing coordinates alone, never knowing
which; provider-only out-of-band setup (registering an App) lives in the harness,
not the test. The App e2e (`github-app.e2e.ts`) is coordinate-driven — supply real
GitHub App coordinates via env to target real GitHub; otherwise the bleephub
harness (`test-support/github-app-coords.ts`) provisions an equivalent App.
Verified: core/app-JWT/provider unit tests (12) + the bleephub App e2e (CI). Gates
green (lint/knip/jscpd/build/unit).

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
