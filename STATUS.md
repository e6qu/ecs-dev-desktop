# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-12 (correctness-hardening branch)

## Current phase

**PRs #56–#66 are merged to `main`** (test-gap closure, gateway machine-auth,
sockerless #549/#550 consumption, live portal + Pomerium browser e2e over TLS,
the lifecycle correctness-hardening pass, and the authz/concurrency depth pass —
delete-vs-wake leak fix, exhaustive CASL matrices, snapshot-vs-stop conflict fix).

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
