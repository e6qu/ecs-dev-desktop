# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

ECS compute hardening follow-ups (from the 2026-06-13 gap audit; the impactful
ones were fixed — see Resolved — these remain as deliberate follow-ups, not
active breakage):

- **No readiness gating in `runTask`.** `EcsComputeProvider.runTask` returns as
  soon as the managed-EBS volume id appears (during PROVISIONING/PENDING), before
  the container is RUNNING and before sshd/OpenVSCode listen. `WorkspaceService`
  then reports `running` and hands out `sshHost`/connect-info that may not yet
  accept connections; every caller compensates with its own retry loop. Needs a
  task-def container `healthCheck` and/or a port-readiness wait before returning.
  Not a sim-maskable correctness bug (real Fargate has the same race), so it is
  validated by the clients' retries today.
- **Per-workspace agent secret injected as plaintext env, not ECS `secrets`.**
  `EDD_AGENT_TOKEN` (HMAC machine-auth) is passed via `containerOverrides.environment`,
  so it shows in `DescribeTasks`/console/CloudTrail. Should move to ECS `secrets`
  (Secrets Manager/SSM). Also `CONNECTION_TOKEN` (OpenVSCode) is not yet injected
  by the provider at all — a random per-boot token today; the control plane should
  set it (Secrets Manager) so it can hand the token to the authenticated user via
  the proxy. Both interact with the per-workspace proxy-authz handoff.
- **Real `EcsComputeProvider` does not implement `health()`** (the port declares
  it optional); the admin Health board therefore reports compute `unknown` even on
  AWS. The in-memory fake implements it — the contract is effectively inverted.
- **Cost report scans the full ledger per request (scale optimization, NOT an
  accuracy compromise).** Cost is computed exactly: every billable transition is
  recorded in the SAME DynamoDB transaction as the transition (so the ledger can
  never drop or double-count an event — proven by `cost-ledger-atomicity.integ.ts`),
  and a running workspace's open interval is priced to `now` on each fetch (live).
  `CostService.report` reads the whole append-only ledger + current records each
  request and prices the complete history. Exact, but O(history); for a large
  long-lived fleet it should move to a time-windowed `byTime` query with periodic
  rollups (e.g. a daily per-workspace cost snapshot) to keep latency flat. This is
  a performance follow-up only — it does not change the figures.

## External blockers (upstream — `e6qu/sockerless`)

- **sockerless#559 — bleephub can't seed a pre-registered GitHub App via config.**
  Per the coordinate-only rule (`AGENTS.md` §6.9), the GitHub-App e2e treats bleephub
  exactly like real GitHub: it takes the App's coordinates (base URL + app id +
  private key + org/repo) from env and never touches a sim-internal endpoint. But
  bleephub only mints an App via the operator `/internal/apps` (key generated
  internally) or the interactive manifest flow — there is no standard, config-seeded
  App with a caller-supplied key. So CI cannot supply sim App coordinates the
  standard way, and `apps/web/lib/github-app.e2e.ts` **skips** until #559 lands (it
  runs today against real GitHub when secrets are provided). The `InstallationGitProvider`
  - app-JWT/token logic is unit-tested meanwhile.

Latest full simulator pass (2026-06-12, submodule `9d43f3d` / PR #550) found no
sockerless fidelity bugs across all live surfaces (real-CP wake chain, live
user journey, reconciler scale-to-zero + drift, Auth.js callback routes,
concurrent-wake race, TLS storage adapter). PR #550 is bleephub-Actions-only;
no downstream impact (we consume bleephub for OAuth).

## Resolved (repo)

- **ECS compute hardening + polyglot golden image (2026-06-13)** — gap audit of
  `EcsComputeProvider` fixed the impactful items: the task definition now declares
  `portMappings` for the OpenVSCode HTTP port (3000) and sshd (22); supports
  `executionRoleArn`/`taskRoleArn` (required on real Fargate to pull a private-ECR
  image + ship `awslogs`); `fromEnv` now reads task sizing (`ECS_TASK_CPU`/
  `ECS_TASK_MEMORY`/`ECS_VOLUME_GIB`) and the roles (previously hardcoded to the
  defaults in production); `awslogs-region` falls back to `DEFAULT_AWS_REGION` (not
  a literal); `stopTask` sends a reason. The golden image gained a polyglot
  toolchain out of the box (Node 22 + npm/yarn/pnpm/bun, C/C++ via build-essential,
  Go, Java + Maven + Gradle, Rust, Python + uv, Playwright + headless Chromium),
  proven by `packages/e2e/src/workspace-toolchain.e2e.ts` (compiles+runs each
  language) and the OpenVSCode browser proof (below).
- **Per-workspace proxy authorization (2026-06-12)** — the Pomerium wildcard
  route was `allow_any_authenticated_user`, so the proxy enforced no
  per-workspace ownership (only the OpenVSCode connection-token / SSH cert gated
  use). Closed via decision #5's chosen design (external-authz → control plane):
  a workspace **gate** (PEP, `services/workspace-gate`) fronts each workspace,
  verifies the Pomerium identity assertion against Pomerium's JWKS, and calls a
  control-plane **PDP** (`/api/internal/authz`, `apps/web`) that maps the
  `<ws-id>` subdomain → owner in DynamoDB and allows only the owner (by email —
  the provider-agnostic identity the Auth.js portal IdP and the Pomerium proxy
  IdP share) or an admin. Workspaces now record `ownerEmail`. Pomerium binds the
  assertion's `aud` to the workspace host (verified in v0.32.2 source), so a
  token cannot be replayed across workspaces. Proven by the gate component test
  (HTTP+WS, allow/deny/PDP-down), the PDP integration test (DynamoDB ownership,
  admin bypass, replay/expiry/forgery), and an end-to-end test with a REAL
  Pomerium assertion verified against Pomerium's real JWKS
  (`apps/web/app/api/internal/authz/route.e2e.ts`). The harness's shared
  `pomerium.yaml` keeps the direct identity-gate route for the identity-layer
  suites; production routes the workspace `to:` through the gate (documented
  inline in `pomerium.yaml`).
- **BUG-concurrent-wake-leak (2026-06-12)** — `WorkspaceService.persist` was an
  unconditional ElectroDB PutItem, so two simultaneous `connect`/`start` calls
  on a stopped workspace both read "stopped", both launched a real ECS task,
  and the last write won — the losers' tasks leaked permanently (GC reaps
  storage, not tasks). Concurrent connects are normal (SSH gateway wakes per
  connection; portal Start races it). Fixed with an optimistic-concurrency
  `version` attribute + conditional `persistTransition`; the wake loser stops
  its own just-launched task and returns the winner's state. Locked by
  `packages/e2e/src/concurrent-connect.e2e.ts`.
- **BUG-quota-bypass-pagination (2026-06-12)** — `WorkspaceService.list` used a
  single-page `.go()`. Past DynamoDB's 1 MB page it silently truncated, so the
  per-owner count behind quota enforcement undercounted (a quota BYPASS at
  scale) and the admin all-workspaces list hid records. Fixed with
  `pages:"all"`; locked by `packages/control-plane/src/scale-pagination.integ.ts`
  (seeds >1 MB) and a 450-record reconciler sweep integ.
- **BUG-gateway-token-auth (2026-06-12)** — `wake-and-forward.sh` authenticated
  with `EDD_GATEWAY_TOKEN`, but no control-plane code path ever accepted it:
  every real gateway call would have been a 401. Masked by the stub control
  plane in `ssh-proxy.e2e.ts`. Fixed by per-workspace HMAC machine-auth
  (`EDD_GATEWAY_SECRET`, `loadConnectableWorkspace`) + a chain e2e against the
  real control plane (`packages/e2e/src/ssh-wake-chain.e2e.ts`).
- **BUG-golden-image-sshd** — Fixed on the #532 follow-up branch: the golden
  workspace image now installs OpenSSH Server, writes the trusted workspace CA and
  `dev-<workspaceId>` principal file at startup, validates required SSH/agent env,
  starts `sshd`, and runs idle-agent/OpenVSCode as `workspace`.

## Resolved (sockerless — fixed upstream; full detail in `WHAT_WE_DID.md`)

**Most-recent batch** (submodule `777ffd3`, PR #549):

- **sockerless#547 / PR #549 (BUG-1743)** — azure-sim `/authorize` now honours
  `login_hint` (UPN lookup, ROPC-style resolution), binds the resolved OID into
  the auth-code record, and mints id/access tokens for that user; unknown hint
  → `error=login_required`. Graph-provisioned users can drive the interactive
  OIDC flow — the Auth.js callback-route e2e now asserts Entra group→admin via
  `login_hint` (HTTPS leg).
- **sockerless#548 / PR #549 (BUG-1742)** — azure-sim token endpoint accepts
  `client_secret_basic` across all grants; discovery advertises both methods.
  We keep `client_secret_post` (MSAL convention, valid on real AAD).

**Previous batch** (submodule `638f65a`, PR #532):

- **sockerless PR #532** — Added Azure Logic Apps/ACI and GCP
  Spanner/Dataflow/Bigtable simulator slices plus AWS SDK coverage cleanup across
  SSM, Glue, CodeBuild, Step Functions, CloudWatch Logs, SQS, and ElastiCache.
  No new ecs-dev-desktop blocker was identified from this PR surface.

**Previous batch** (submodule `dade6ca`, PR #531):

- **sockerless#530 / PR #531** — ECS container-mode `RunTask` now applies
  `overrides.containerOverrides[].environment` to the named runtime container,
  unblocking the managed-EBS golden workspace SSH e2e path.

**Previous batch** (submodule `39d15b5`, PR #529):

- **sockerless#525 / PR #529** — Azure sim now rejects duplicate Entra
  `userPrincipalName` values and ROPC uses the same case-insensitive UPN resolver.
- **sockerless#526 / PR #529** — ECS managed-EBS awsvpc task private IP reachability
  now works from a same-VPC task, unblocking the production-shaped golden SSH e2e path.
- **sockerless#527 / PR #529** — Fargate sandbox now grants `SYS_CHROOT`, so OpenSSH
  preauth chroot works in container-mode ECS tasks.

**Previous batch** (submodule `85a62bc`, PR #520):

- **sockerless#521 / PR #520** — Netns awsvpc ECS tasks from PR #519 could not
  reach simulator-adjacent endpoints used by downstream container-mode e2e
  (e.g. DynamoDB Local). Fix: netns metadata moved to link-local DNAT,
  `host.docker.internal` env values are rewritten for pause-netns ECS tasks,
  host egress masquerade is installed, and egress is governed by the simulated
  route table. Downstream e2e now provisions an IGW/default route and
  `AssignPublicIp=ENABLED`, matching that route-table model.
- **sockerless#522 / PR #520** — Netns VPC cleanup could return 503 if the backing
  route was already absent (`RTNETLINK answers: No such process`). Fix: subnet
  route cleanup tolerates that already-clean state.

**Previous batch** (submodule `cf7df7c`, PR #519):

- **BUG-1572 / PR #519** — Follow-up to sockerless#516: the Docker-bridge VPC fabric from
  PR #518 could not represent two AWS VPCs with overlapping CIDRs, and `DeleteVpc` leaked
  backing networks. Fix: a Linux network-namespace-per-VPC fabric (`VPC = netns`,
  `subnet = bridge`) for capable hosts, with ECS awsvpc tasks sharing a pause-container
  network namespace and keeping the real ENI IP with no CIDR remap. The older Docker-network
  tier remains for distinct CIDRs when netns capabilities are unavailable; overlap fails
  loudly there. Added tier-agnostic VPC reachability/isolation tests, a netns-only
  overlapping-CIDR test, and VPC fabric cleanup coverage.

**Previous batch** (submodule `7518722`, PR #518):

- **sockerless#516** — Container-mode ECS: `privateIPv4Address` was a virtual VPC-allocated IP
  that didn't route to the Docker container. Fix: each VPC is now a real Docker user-defined
  bridge (`sockerless-sim-vpc-<vpcid>`, IPAM subnet = VPC CIDR). Task containers are pinned to
  their VPC bridge at the ENI IP via `ContainerConfig.IPAddress`. The reported IP is now the
  container's real Docker IP — routable within the VPC bridge (intra-VPC), isolated from other
  VPC bridges (cross-VPC). Our `sshHost` field on `Workspace` is now populated with an
  actionable IP; the proxy e2e tests the full forwarding chain.

**Previous batch** (submodule `4b8bcd9`, PR #515):

- **sockerless#514** — Container-mode sim: scheduler-fired `RunTask` (EcsParameters target)
  silently swallowed downstream errors. `callJSONHandler` discarded the response and
  `fireECSTarget` recorded CloudTrail success unconditionally; the task was never launched
  or stopped. Also: SG validation was skipped for scheduler-fired path but enforced for
  direct `RunTask`. Fix: `callJSONHandler` now returns `(status, body)`; a shared
  `recordSchedulerFireResult` records failures honestly with `errorCode`/`errorMessage`;
  valid-config happy path unchanged. **Our e2e test updated to use real VPC/subnet/SG
  (commit `52376c2`)**.

**Most-recent batch** (submodule `9f89ae36`, PRs #507–#511):

- **BUG-1564** ELBv2 TG `Matcher` hardcoded `"200"`, `ProtocolVersion`/`IpAddressType` not round-tripped, `SetIpAddressType` unregistered. → PR #511 / `9f89ae36`.
- **#508** azure-sim v2.0 OIDC discovery missing `userinfo_endpoint`; `GET /{tenant}/v2.0/userinfo` not implemented (OIDC Core §5.3). → PR #510 / `7c812094`.
- **BUG-1561/1562** EBS volume performance fields (`Iops`/`Throughput`/`KmsKeyId`) not round-tripped; `DescribeVolumes`/`DescribeSnapshots` filters ignored; `DescribeVolumesModifications` unregistered. → PR #507 / `a00c7e07`.
- **BUG-1560** `DescribeKeyPairs` always empty; `ModifyInstanceMetadataOptions` unimplemented; LT credit/spot not round-tripped; `DescribeImages` filters ignored. → PR #509 / `a00c7e07` (ancestor).

**Earlier batches** (full detail in `WHAT_WE_DID.md`):

- **#504/#501** azure-sim OIDC v2.0 issuer mismatch; bleephub admin token non-configurable. → PR #506 / `0a383db`.
- **#496–#498** CloudTrail `LookupEvents` filter keys, scheduler API recording, scheduler-fired calls not recorded. → PR #500 / `fc03b15`.
- **#493/#494** Scheduler cron `L/W/#` qualifiers; bleephub token response content-type. → PR #495 / `def45a1`.
- **BUG-1531/#489/#490** Scheduler `cron()` never evaluated; `N/step` mis-parsed; bleephub OIDC discovery endpoints missing. → PRs #491+#492 / `0b9af6e`.
- **#486–#488** Scheduler never fired targets; ECS `RunTask` didn't resolve `secrets`. → PR #485 / `980dc9e`.
- **#483** CloudWatch Logs `FilterLogEvents` returned empty instead of `ResourceNotFoundException`. → PR #484 / `4916e15`.
- **#467/#465** ECS task-def tags not returned by `DescribeTaskDefinition --include TAGS`; OCI `/v2/` missing `Docker-Distribution-Api-Version`. → PR #468 / `3db617e`.
- **#470–#473** `RunInstances` missing `aws:ec2launchtemplate:*` system tags; `DescribeRouteTables` routes missing `NetworkInterfaceId`; SG egress `Ipv6Ranges` absent; `DescribeListeners` missing `SslPolicy`. → PR #475 / `3d457dd`.
- **#453–#462/#464** DynamoDB SSEDescription null; ECS deploymentConfig null; EC2 `ModifySecurityGroupRules` unimplemented; 6 idempotency read-back fidelity gaps; ELBv2 listener Certificates absent. → PRs #463+#466 / `1859adf`.
- **#450–#452** OCI `/v2/` data plane (ECR/AR/ACR). → PR #456 / `8e866c3`.
- **#433–#438/#441–#447** LaunchTemplates; KMS grants/crypto; ECR policy + layer data plane; ECS capacity providers; EC2 instance type offerings; ELBv2 rules; IAM ListPolicyVersions; EC2 VPC/SG filters; CW Logs kmsKeyId; ECS DescribeClusters; IAM ListRoles. → PRs #439+#440+#448+#449.
- **#420/#421/#427/#428/BUG-1470** ACM DNS validation; IAM policy simulation; EC2 ENI ops; position-dependent filters. → PRs #424+#431+#430+#429 / `9e2640a`.
- **#411–#418** KMS rotation/tagging; NAT Gateway; DynamoDB GSIs; ECS Service capacity providers; Application Auto Scaling; EventBridge Scheduler. → PRs #410+#415+#418 / `aa33123`.
- **#359–#410** EBS snapshots; Entra authorize; sim Dockerfile; EC2 AttachVolume; control/data-plane coupling; bleephub /user/teams; Entra groups claim; bleephub OAuth non-conformance. → PRs #361–#401.
