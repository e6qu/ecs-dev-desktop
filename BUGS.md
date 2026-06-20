# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

### Code-quality sweep (2026-06-20) — multi-dimension audit findings

A broad 6-agent sweep (API-first/thin-UI, fake telemetry/monitoring, weak types, fake/anemic tests,
idempotency/self-heal/fail-loud, correctness/UX), each finding traced to the code. The codebase is
high-quality overall (no fabricated metrics, no `any`/`@ts-ignore` in src, strong authz/cost tests).
Batch 1 (correctness + fail-loud + telemetry honesty), batch 2 (test fidelity), batch 3 (atomic quota),
the big combined PR (API-first thin-UI, weak-type branding, UX, idempotency follow-ups), and the
**deferred-cleanup PR** (`feat/deferred-cleanup-fat-pr` — service-signature branding, port contracts,
snapshot retention, quota-drift self-heal, billing-to-teardown) have landed **all** of these. The bullets
below record what's FIXED. The one sub-item that had stayed deferred (a UI Open/Connect affordance, gated
on the proxy-domain config) was **delivered on 2026-06-20**: a path-based **Open editor** link on the
workspace card now opens the in-app editor proxy at `app.<domain>/w/<id>/` (running/idle/stopped — stopped
wakes on connect), after Pomerium + the standalone `workspace-gate` were removed and the editor proxy was
folded into the Next.js app (see _Resolved (repo)_ + `WHAT_WE_DID.md` 2026-06-20):

- **[weak types] — FIXED (big PR + deferred-cleanup PR).**
  Done (big PR): `Principal.id` → `OwnerId` (branded once at the identity edge — the per-call
  `ownerId(principal.id)` re-brands are gone); `ownerEmail` contract → `z.email()`; the audit-action
  vocabulary is now a typed `AuditAction` union (a typo'd action is a compile error, protecting the cost
  ledger's exact-string filter — and now includes `session.terminated`). Done (deferred-cleanup PR):
  `SshKeyService`/`GitCredentialService` public methods take branded ids (`OwnerId`/`SshKeyId`/
  `SshPublicKey`); `ownerForKey` returns branded ids; a closed `GitProviderId` union replaces the bare
  provider string (a typo is a compile error; named `GitProviderId` to avoid the existing `GitProvider`
  app-interface clash).
- **[fake tests] — FIXED (batch 2 + deferred-cleanup PR).**
  Done (batch 2): `ec2-storage-provider.test.ts` / `ecs-compute-provider.test.ts` assert `command.input`
  (the `edd:managed` tag, `edd:workspace-id` tag, `deleteOnTermination`, the Size↔snapshot branch, the
  `tag:` filters with `OwnerIds:self`, `copySnapshot` destination region); `role-mapping.test.ts` covers
  the `member` branch and admin precedence; the `pricing.test.ts` / `contracts.test.ts` tautologies were
  replaced with real assertions. Done (deferred-cleanup PR): `storageProviderContract` gained a `{dataIo}`
  gate so its control-plane subset (lifecycle + snapshot-hydration lineage + retain) runs against the REAL
  `Ec2StorageProvider` in the integ tier (`dataIo:false`; EBS file bytes stay §6.8); a new
  `computeProviderContract` runs against the fake (tier-1) AND the real `EcsComputeProvider`
  (container-mode e2e — the tier where `runTask` reaches RUNNING), proving task-lifecycle +
  snapshot-hydration parity.
- **[API-first / thin UI] — FIXED (big PR).** The workspace DTO is now self-rendering:
  `availableActions` (from the core state machine), the catalog `imageName`/description/tags/tools join,
  and the `sshCommand` are all server-computed and ride the contract (`toWorkspaceDto` + a shared
  `enrichWorkspace` shell helper); the client-side state-machine mirror (`lib/workspace-view.availableActions`)
  and the per-page catalog join (`lib/catalog-details.ts`) are **deleted**, and `WorkspaceCard` is a pure
  renderer. The two admin views that had no API now do: `quotaReport` + `overviewReport` contracts,
  `GET /api/admin/quotas` + `/api/admin/overview` routes, `adminQuotas()`/`adminOverview()` client
  methods + shared report builders (pages render them, no in-page tally). Costs uses the route's
  `costReportQuery` validation (the silent `.catch` is gone) + an `adminCosts()` client method.
- **[idempotency] quota TOCTOU race — FIXED (batch 3, atomic counter).** The create transaction now
  conditionally increments a per-owner `ownerWorkspaceCount` item (`ADD count 1` guarded by
  `attribute_not_exists(count) OR count < limit`) atomically with the workspace insert, and
  `finishDeleting` decrements it — so concurrent creates can never race past the cap (proven by a
  concurrent-burst integ test). **`recordSecurityEvent` idempotency FIXED (big PR)** — a deterministic
  event id per (workspace, tool, time bucket) + conditional `create` dedupes the in-workspace guard's
  `curl --retry`, so a retry writes no duplicate audit row and no double metric (proven by an integ test).
  Idempotency follow-ups — FIXED (deferred-cleanup PR): (a) **billing-to-teardown** — billing ran only to
  the delete _request_, so the EBS volume + retained snapshot cost money through teardown for free; the
  cost model gained a fourth **teardown** phase (`session.delete` opens it billing volume+snapshot, no
  compute; a new `session.terminated` emitted by `finishDeleting` closes it), threaded through
  `BillingState`/`CostBreakdown`/the rollup record + DB entity + contract, with the figure-equivalence
  invariant preserved + extended (user-chosen policy: "bill until teardown completes"). (b) **snapshot
  retention** — `finishDeleting`'s data-safety snapshot is now RETAINED per the Middle policy via an
  `edd:retain` tag through the storage port (`createSnapshot({retain})` + `tagSnapshotRetained`) and a GC
  keep-set (`selectOrphanSnapshots` never reaps a retained snapshot). (c) **counter-vs-actual
  drift-reconciliation** — a reconciler sweep step (`reconcileOwnerCounts`) recomputes each owner's true
  live count and corrects a drifted quota counter (conditioned on the observed value so a racing
  create/delete is never clobbered), emitting `reconciler.quota.drift_corrected`.
- **[UX] — FIXED (big PR + deferred-cleanup PR).** Workspace delete takes a **two-step confirm** (a
  mis-click can't destroy the EBS volume/snapshot) + auto-refresh-on-409; the Health/Infra boards **keep
  the last-known state** on a transient poll error (a "stale" banner, not a blank); the GitHub repo-load
  failure resolves to an empty list (no eternal spinner); the owner card shows a **degraded** indicator
  when `functional !== ok`; the environment picker has `aria-pressed`. Done (deferred-cleanup PR): the
  per-row **SSH-key** and **base-image** deletes now take the same two-step confirm (SSH-key confirm keyed
  by id so arming one row doesn't arm the rest). The previously-deferred Open/Connect affordance is
  **DONE (2026-06-20)** — the path-based **Open editor** link on the workspace card opens the in-app editor
  proxy (`app.<domain>/w/<id>/`), now that the proxy is in-process in the Next.js app (no external
  proxy-domain config to wire). See _Resolved (repo)_.

The codex code-review findings (2026-06-19) that were tracked here are **all remediated and merged
in #129** (Phase 9; "12 findings, none deferred") — moved to _Resolved (repo)_ below, re-verified
against the merged code (e.g. `assertFakeProvidersAllowed` prod guard; IAM `CreateSecret`/`PutSecretValue`/
`TagResource` + `ECS_TASK_ROLE_ARN`/`ECS_EXECUTION_ROLE_ARN` + `iam:PassRole`; the fingerprint sentinel;
`DEFAULT_EARLY_SNAPSHOT_INTERVAL_MS`; `.edd-bootstrap-status`; `deleteAgentSecret` + reconciler secret GC;
`DeregisterTaskDefinition` revision GC; `resolveOwnerEmail`; `costWindow` enum without `.catch`; topology
registered-key text).

- **`concurrency-pairs.integ.ts` "delete vs wake" — rare DynamoDB-Local flake (2026-06-18).**
  The test fires `remove` + `start` concurrently and asserts exactly one wins. Both methods use
  proper version-CAS (`start`'s PHASE-1 claim and `remove`'s delete are each conditioned on the read
  `version`), so on real DynamoDB exactly one commits. **DynamoDB Local**'s weaker conditional-write
  isolation can, very rarely under load, let both `version == V` writes commit — observed once in CI
  (`delOk=true, startOk=true`); not reproducible locally (18/18). It is a test-substrate fidelity gap,
  not a control-plane bug, and **not** filed upstream (DynamoDB Local is not sockerless). Production
  impact is nil (real DynamoDB serializes the CAS); and even the hypothetical resulting orphan — a
  running task with no record — is now **self-healed by the orphan-task reaper** (this branch).
  Re-running the job passes. Revisit only if the rate climbs.

**Launch-readiness gaps (logs / health / status / metrics / testing)** are
inventoried, prioritized, and cross-referenced in
[`docs/observability-gaps.md`](./docs/observability-gaps.md). Nearly all are now
**fixed** (see Resolved): readiness probe, storage Health-board check, structured
logging, metrics + alarms, CloudTrail pagination, API request latency/error
metrics + access logging, fleet + cost gauges, reconciler health (heartbeat), and the
per-workspace log view. The **one substantial item left is
external**: `e2e-aws` (the whole real-cloud tier — EBS durability, real Fargate
cold-start, IAM, ACM/DNS, EMF→CloudWatch metrics + alarms, live registered-key SSH)
is unrun, blocked on the AWS account/region decision (`DO_NEXT.md` #1). Otherwise
the triaged observability follow-ups are now closed (2026-06-17): **`parseLevel` done**
(reads the structured log `level`); **cached fleet status done** (short-TTL
single-flight memo on the admin Overview); **per-user quota gauges done**
(`quota.utilization` + `quota.denied`, emitted event-driven from the create path);
**control-plane self-health** (_Low_) deliberately hardcoded `ok` by construction. So
the only observability item left is the AWS-gated `e2e-aws` tier. See
[`docs/observability-gaps.md`](./docs/observability-gaps.md).

The ECS compute hardening follow-ups (from the 2026-06-13 gap audit) are **all fixed** —
see Resolved. The last one, `CONNECTION_TOKEN` injection, shipped 2026-06-20: the
in-app path-based proxy hands the session-authorized browser the token, superseding the
old STATIC-gate "tokenless behind the gate" framing (see _Resolved (repo)_).

## External blockers (upstream — `e6qu/sockerless`)

- **sockerless#629/#630 (fixed upstream — confirmed downstream 2026-06-20)** — two GC-safety
  filter/ordering gaps found in a deeper fidelity pass that adversarially probed the AWS call shapes our
  reaper/prune paths depend on (filed against `47b6a2a1`, `SIM_RUNTIME=process`; standard SDK,
  endpoint-only). Both are the same bug class as the already-fixed EC2 `tag:` filter — a server-side filter
  the sim doesn't apply — so production (real AWS) was unaffected, only the sim under-validated. **Both
  fixed by sockerless #631** and **confirmed downstream** after re-pinning the submodule to `693b39a7`
  (from `47b6a2a1`; the pin also adopts the #632 audit/fuzz sweep) and re-probing the rebuilt process-mode
  sim — each now behaves to AWS spec, and our `storage-ec2` (9/9) + `compute-ecs` (4/4) integ tiers pass
  unchanged against the new pin:
  - **#629 — Secrets Manager `ListSecrets` `tag-key` Filter.** Was: returned **all** secrets (a `tag-key`
    matching nothing still returned everything). Now (re-probed): `Filters:[{Key:"tag-key",Values:[…]}]`
    returns only secrets bearing that tag key, and a no-match value returns `[]`. Our orphan-secret reaper
    enumerates with this filter (it also has a tag-VALUE backstop, so reaping was always correct).
  - **#630 — ECS `ListTaskDefinitions` `sort` + `status`.** Was: `sort:"DESC"` returned ascending
    (identical to `ASC`); `status:"ACTIVE"` still listed a deregistered (`INACTIVE`) revision. Now
    (re-probed): `sort:"DESC"` returns newest-first (the reverse of `ASC`), and `status:"ACTIVE"` excludes
    a deregistered revision (it appears in `status:"INACTIVE"`; `DescribeTaskDefinition` reports
    `INACTIVE`). Our `pruneTaskDefinitions` (lists `familyPrefix` + `status:ACTIVE` + `sort:DESC` to keep
    the newest N) is now correctly modelled by the sim.

  The same pass **confirmed conformant** (previously unprobed surfaces, no issue needed): **STS
  `GetCallerIdentity`** returns a well-formed `arn:aws:iam::<acct>:user/simulator` (our
  `callerToPrincipalArn` regex accepts it); **IAM `SimulatePrincipalPolicy`** genuinely evaluates identity
  policy — a granted action → `allowed`, an ungranted action → `implicitDeny`, AND **condition keys are
  honored** (a `Condition` on `ecs:cluster`: matching `ContextEntries` → `allowed`, non-matching →
  `implicitDeny`, omitted → `implicitDeny` + `MissingContextValues:["ecs:cluster"]`) — so the IAM
  self-check / drift preflight is NOT false-green against the sim; **ECS `RunTask`** managed-EBS + awsvpc
  `DescribeTasks` read-back exposes the exact attachment detail names `taskReady` blocks on
  (`AmazonElasticBlockStorage`→`volumeId`/`deleteOnTermination`, `ElasticNetworkInterface`→
  `privateIPv4Address`), plus `enableExecuteCommand`, `stoppedReason`, and `include:TAGS` round-trip;
  **Secrets Manager** `SecretListEntry.Tags`/`CreatedDate` populate and `DeleteSecret
ForceDeleteWithoutRecovery` reclaims the name immediately; **CloudTrail `LookupEvents`** populates
  `Username` + `Resources[].ResourceName` + `EventSource` + `EventId`/`EventTime` (what `mapEvent`
  reads); **CloudWatch Logs `FilterLogEvents`** honors `limit` and round-trips `timestamp`/`message`/
  `logStreamName`; **EventBridge Scheduler** `CreateSchedule`→`GetSchedule` round-trips the full
  `EcsParameters` Target (`LaunchType`/`TaskCount`/`TaskDefinitionArn`/awsvpc `Subnets`/`AssignPublicIp`/
  `ActionAfterCompletion`); **EC2 `CreateSnapshot`** models the `pending`→`completed` transition (the
  `waitUntilSnapshotCompleted` waiter, incl. the cross-region copy path, sees it). One benign
  simplification (NOT a bug, not filed): `CreateVolume` returns `available` immediately with no
  intermediate `creating` state — the `waitUntilVolumeAvailable` waiter still terminates correctly and no
  code path depends on observing `creating`.

- **sockerless#602/#603/#604/#605/#606 (fixed upstream — confirmed downstream 2026-06-19)** —
  the five observability/DR fidelity gaps from the two fidelity passes, all fixed by sockerless
  **#607** (merge `74c0a3d2`) and **confirmed downstream** after re-pinning the submodule to it
  (from `fcb58281`) and re-probing the rebuilt process-mode sim:
  - **#602 — EC2 `CopySnapshot`** — `copy-snapshot --source-snapshot-id …` now returns a new
    `snapshotId` (cross-region EBS **DR** flow snapshot→copy→restore is exercisable).
  - **#603 — CloudWatch alarm API** — `PutMetricAlarm`/`DescribeAlarms`/`DeleteAlarms` work across
    all three CW wire protocols; `DescribeAlarms` evaluates `StateValue` live from metric data
    honouring `TreatMissingData` (probed: a `sweep.count < 1` alarm reads `ALARM`). All 9 module
    alarm resources apply + round-trip idempotently via terraform (the wake-latency p99 alarm
    needed the #609 fix below).
  - **#604 — CloudWatch Logs EMF extraction** — an EMF `PutLogEvents` doc is now queryable through
    the metric APIs (`get-metric-statistics`/`list-metrics`) with no `PutMetricData` call (probed:
    `quota.utilization=42` round-tripped).
  - **#605 — `FilterLogEvents` `logStreamNamePrefix`** — now scopes to the prefix and rejects
    `logStreamNames`+`logStreamNamePrefix` together (`InvalidParameterException`).
  - **#606 — CloudTrail `LookupEvents` pagination** — the `NextToken` is now an opaque
    `(EventTime, EventId)` cursor (no page overlap on a growing trail; probed with a mid-walk
    mutation → zero duplicate `EventId`s); read-only `LookupEvents` is no longer self-recorded.

- **sockerless#608/#609 (fixed upstream — confirmed downstream 2026-06-19)** — the two residual
  CloudWatch gaps that had kept the alarm/dashboard resources off for the sim apply, both fixed by
  sockerless **#611** (merge `322d16ad`) and **confirmed downstream** after re-pinning the submodule
  to it (from `74c0a3d2`) and re-probing the rebuilt sim:
  - **#608 — CloudWatch dashboard API** — new `cloudwatch_dashboards.go` implements
    `PutDashboard`/`GetDashboard`/`ListDashboards`/`DeleteDashboards` over all three CW wire
    protocols (probed: put→`[]`, get echoes the body, list→`["ops"]`, delete clears).
  - **#609 — alarm percentile `ExtendedStatistic`** — the alarm store now carries `ExtendedStatistic`
    (mutually exclusive with `Statistic`) across all three protocols and evaluates the percentile from
    metric data (probed: a `p99` alarm round-trips `ExtendedStatistic=p99`, `Statistic=null`).

  With both fixed, the sim fixture runs `enable_metric_alarms=true` **and**
  `enable_cloudwatch_dashboard=true`: all 9 alarm resources + the ops dashboard apply against the sim
  and `plan -detailed-exitcode` is **0 (idempotent)** — confirmed locally (apply + clean destroy of
  66 resources). As of that pass there were no open sockerless blockers (the 2026-06-20 deeper fidelity
  pass since found two non-blocking GC-safety filter gaps, #629/#630 above — both now fixed upstream
  (#631) and confirmed downstream); the
  AWS surface our code/terraform drives is sim-validatable: CloudWatch metric write/read + EMF + \*\*alarms
  - dashboards**, the
    full EBS create/snapshot/restore **and copy\*\* lifecycle, EC2 `tag:` filters + `OwnerIds:self` +
    pagination + the volume/snapshot waiters, Secrets Manager
    `CreateSecret`→`ResourceExistsException`→`PutSecretValue` upsert, ECS `RunTask --tags` →
    `DescribeTasks include:TAGS` / `ListTasks --desired-status` / `DescribeClusters` counts, CloudTrail
    `LookupEvents` cursor pagination, and the `create→wake→connect→delete` journey (the container-mode
    `user-journey` e2e).

- **sockerless#569 (fixed upstream — confirmed downstream 2026-06-16)** —
  process-mode (`SIM_RUNTIME=process`) `ecs:RunTask` with a managed-EBS volume used
  to **panic** the sim (nil Docker client in the async transition: `ec2.go:3800` ←
  `ecs.go:1027`). **Fixed by sockerless #569** (`05217316`), included in the
  submodule re-pin to `c69cd278` (2026-06-16). **Confirmed downstream:** issuing the
  managed-EBS `RunTask` against the re-pinned process-mode sim now returns a task
  ARN and the sim survives the async EBS transition (stays healthy) — where it
  previously crashed. The full launch-to-RUNNING path with the agent-token secret
  injection is exercised in **container mode** (`agent-secret.e2e.ts`, the
  workspace-lifecycle e2e, and the user-journey/golden e2e). **No lightweight
  integration variant is possible:** the `integration` tier is the **API-surface**
  process-mode sim with no container runtime (CLAUDE.md §5), so a workspace `RunTask`
  cannot reach RUNNING there (`EcsComputeProvider.runTask` waits for READY and the
  container start fails with no Docker runtime); asserting it reached RUNNING in
  process mode would be a target-specific assertion (forbidden by §6.9). Container
  execution belongs to the `e2e` tier, which is exactly where this path is covered.
  **Follow-up: none** — the panic regression is closed and the path is covered in the
  correct tier.

- **sockerless#583 (open)** — the ECS sim advertises a task's `Limits`
  (`CPU`/`Memory`) in task metadata but launches the container with **no cgroup
  limits**, so the sim doesn't enforce the declared Fargate sizing (our workspace
  used ~1214 MiB against an advertised 1024 MB with no OOM). Code pointer:
  `simulators/aws/ecs.go` builds metadata `Limits` (~L1718) but the launched
  `ContainerConfig` (~L1573) sets no `Memory`/`NanoCPU`. Local tracker: this repo's
  issue #92. **Before adopting the enforced-limits fix, bump `DEFAULT_WORKSPACE_MEMORY`**
  or the golden workspace will OOM at the current 1024 MB sizing.

- **sockerless#590/#591/#592 (fixed upstream — confirmed downstream 2026-06-17)** — the
  three conformance gaps from the focused fidelity pass, all fixed by sockerless **#593**
  (`fcb58281`) and **confirmed downstream** after re-pinning the submodule to it and
  re-running the probes against the process-mode sim:
  - **#590** — EC2 `DescribeSnapshots` ignored `MaxResults`/`NextToken`. Now
    `DescribeSnapshots({OwnerIds:["self"], MaxResults:5})` over 6 snapshots returns 5 +
    a `NextToken` (paginates).
  - **#591** — EC2 `CreateVolume` accepted a missing required `AvailabilityZone`. Now
    `CreateVolume({Size:8})` (no AZ) returns `MissingParameter`/400.
  - **#592** — ECS cluster-scoped ops didn't raise `ClusterNotFoundException` for an
    unknown cluster. Now `DescribeTasks`/`ListTasks`/`StopTask` against an unknown cluster
    all throw `ClusterNotFoundException`.

Latest focused fidelity pass (2026-06-17, probed against `c69cd278`, `SIM_RUNTIME=process`;
the three gaps it found were fixed by #593 and the submodule re-pinned to `fcb58281`)
adversarially probed the AWS call shapes we depend on vs documented behaviour, across
four surfaces:

- **EBS** — not-found error codes (`InvalidVolume.NotFound` / `InvalidSnapshot.NotFound`,
  HTTP 400) and server-side `Filter`s **conformant**; 2 gaps filed (#590 pagination, #591
  CreateVolume AZ validation).
- **ECS** — `MISSING` task/cluster failures and `InvalidParameterException` (unknown
  task) **conformant**; 1 gap filed (#592 no `ClusterNotFoundException` for an unknown
  cluster).
- **Secrets Manager** — `ResourceNotFoundException` (Get/PutSecretValue) +
  `ResourceExistsException` (duplicate CreateSecret) **fully conformant**.
- **CloudWatch Logs** — `ResourceNotFoundException` (Filter/GetLogEvents on a missing
  group) + `ResourceAlreadyExistsException` (duplicate CreateLogGroup) **fully conformant**.

Two would-be findings were discarded as probe errors, not sim bugs (`CreateSnapshot`
has no `ClientToken` idempotency in AWS; `DescribeSnapshots MaxResults` min is 5) — a
reminder to validate each probe against the AWS spec before filing.

- **sockerless#618/#619 (fixed upstream — confirmed downstream 2026-06-20)** — the two
  under-validation gaps from the second fidelity slice (filed against `322d16ad`), both fixed by
  sockerless **#621** (merge `47b6a2a`) and **confirmed downstream** after re-pinning the submodule to
  it (from `322d16ad`) and re-probing the rebuilt process-mode sim — each now rejects with the correct
  AWS-spec error, and the valid-form control cases still pass:
  - **#618 — ECS request validation.** `RegisterTaskDefinition` with `requiresCompatibilities:["FARGATE"]`
    and no task-level `cpu`/`memory` now → `ClientException` ("Task definition does not support launch
    type FARGATE: task-level memory and cpu are required"); `RunTask count:11` → `InvalidParameterException`
    ("count cannot be greater than 10"); `DescribeTasks` with an empty `tasks:[]` →
    `InvalidParameterException` ("Tasks cannot be empty.").
  - **#619 — Scheduler `CreateSchedule`** now rejects a non-`at()`/`rate()`/`cron()` `ScheduleExpression`
    with `ValidationException` ("Invalid Schedule Expression …"); a valid `rate(5 minutes)` is still
    accepted. Distinct from the closed cron-_evaluation_ gaps (#489/#493) — input validation at create time.
    The behaviours the slice recorded as conformant (ECS unknown-taskdef → `ClientException` + `ListTasks`
    pagination; Scheduler `GetSchedule` unknown → `ResourceNotFoundException`; CWL `GetLogEvents` pagination +
    unknown-group → `ResourceNotFoundException`; Secrets Manager unknown → `ResourceNotFoundException` +
    duplicate-create → `ResourceExistsException`) are untouched by #621.

Earlier full simulator pass (2026-06-12, submodule `9d43f3d` / PR #550) found no
sockerless fidelity bugs across all live surfaces (real-CP wake chain, live
user journey, reconciler scale-to-zero + drift, Auth.js callback routes,
concurrent-wake race, TLS storage adapter). PR #550 is bleephub-Actions-only;
no downstream impact (we consume bleephub for OAuth).

## Resolved (repo)

- **Editor reach now authenticates end-to-end + reconciler IAM self-check (2026-06-20).** Two follow-ups
  that closed the last items on the editor-proxy + IAM tracks (landed after, and separate from, the
  Pomerium-removal entry below):
  - **`CONNECTION_TOKEN` injection — DONE.** `@edd/compute-ecs` injects each workspace task's OpenVSCode
    connection token = `HMAC(EDD_CONNECTION_SECRET, workspaceId)` via Secrets Manager
    (`edd/workspace/<id>/connection`), mirroring the agent-token path (plaintext-env fallback when no
    secrets client); new config `connectionSecret`, `EcsComputeProvider.fromEnv(agentSecret,
connectionSecret)` reads `EDD_CONNECTION_SECRET`. The in-app proxy (`apps/web/lib/workspace-proxy.ts`
    `editorTokenRedirect` + `apps/web/server.ts`) hands the **already session-authorized** browser the
    token on the initial document navigation (302 → `…?tkn=<token>`); the user never sees/handles it. The
    HMAC derivation was centralized once in `@edd/core`
    (`deriveWorkspaceToken`/`verifyWorkspaceToken`, `packages/core/src/domain/machine-token.ts`), replacing
    the duplicated `@edd/compute-ecs` `agentToken` + `apps/web` `machine-auth` copies. This supersedes the
    old STATIC-gate "tokenless behind the gate" framing — the in-app path-based proxy is the PEP and the
    token is now defence-in-depth, not the sole control. **Network hardening:** the terraform module places
    workspace tasks in a dedicated `workspaces` security group whose editor port (`workspace_port`, default 3000) + sshd (22) are reachable only from the control-plane SG (never workspace-to-workspace); new
    `workspace_port` var + `workspaces_security_group_id` output; `EDD_CONNECTION_SECRET` added to the
    deployer-supplied secrets list. Tested: core machine-token + compute-ecs connection-token env tests;
    proxy `editorTokenRedirect` unit tests; `agent-secret.e2e.ts` asserts the Secrets-Manager injection;
    `live-ide-flow.e2e.ts` reaches the real OpenVSCode workbench through the IDE bridge and asserts the token
    the running editor uses equals the injected per-workspace `HMAC(EDD_CONNECTION_SECRET, id)` (workbench
    serves only with it); the LIVE portal e2e (`portal-live.pwlive.ts`) asserts the **Open editor** affordance
    and now boots the production custom server (`tsx server.ts`). (The host-process proxy → in-VPC workspace
    ENI hop is the e2e-aws tier: the sim task netns is not host-routable — `ide-bridge.ts`.)
  - **Reconciler runtime IAM preflight — DONE.** `apps/web/lib/iam-preflight.ts` (+ test) moved to a new
    `@edd/iam-preflight` package (`packages/iam-preflight`); `apps/web` imports it and dropped its
    now-unused `@aws-sdk/client-iam`/`@aws-sdk/client-sts` direct deps. `@edd/core` gained pure
    `summarizeIamPreflight`/`IamPreflightSummary` + metric `METRIC_IAM_PREFLIGHT_DENIED`. The reconciler
    (`services/reconciler`) now runs `iamPreflight(env, "reconciler")` at startup, emitting the
    denied-action-count metric + a structured log (non-fatal; degrades to unknown), factored into a
    unit-tested `reportIamPreflight`.

- **Pomerium + the standalone `workspace-gate` removed; editor proxy folded into the Next.js app
  (2026-06-20).** The browser→VS Code editor reach moved out of the external identity-aware proxy (Pomerium)
  and the separate `workspace-gate` PEP/PDP chain and INTO the control-plane app (clean break — no
  production users/legacy). A custom Next.js server (`apps/web/server.ts`, run via `tsx` in dev AND prod —
  replaced `next start`) proxies the per-user editor at the **path-based single domain** `app.<domain>/w/<id>/`
  (HTTP + WS upgrade; `apps/web/lib/workspace-proxy.ts`), authorized **in-process** by the Auth.js session —
  **uid-based ownership** (`session.uid === workspace.ownerId`) or admin — via the pure
  `decideWorkspaceAccessBySubject` + `workspaceIdFromPath` (`@edd/core`; the old email-based
  `decideWorkspaceAccess`/`workspaceIdFromHost` were deleted). No more wildcard DNS/TLS, no cross-subdomain
  cookie, no Pomerium JWT assertion, no PDP `/api/internal/authz` round-trip, no gate machine-auth token, no
  email bridge. The golden image runs OpenVSCode with `--server-base-path /w/<id>/`; the path-based **Open
  editor** link landed on the workspace card (closing the long-deferred Open/Connect affordance);
  `connect-info` is now SSH-only (the SSH gateway is its only caller). **Removed:** `services/workspace-gate/`,
  `infra/proxy/`, `apps/web/app/api/internal/authz/`, `apps/web/lib/pomerium-assertion.*`, the
  `pomerium-*`/`workspace-gate.pwgate`/`gate-global-setup` e2e + playwright configs,
  `packages/e2e/src/pomerium-*` + `proxy-routing.e2e.ts`, `docker-compose.gate.yml`,
  `scripts/test-gate-e2e.sh`, the `e2e-gate` CI job, and the
  `POMERIUM_*`/`WORKSPACE_HOST_HEADER`/`WORKSPACE_AUTHZ_PATH`/`GATE_PDP_TIMEOUT_MS`/`workspaceGate`/
  `WORKSPACE_BASE_DOMAIN` config (`GATE_UPSTREAM_TIMEOUT_MS` → `WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS`).
  **Kept** (these serve the Entra-over-TLS + EBS-over-TLS e2e, NOT Pomerium): the SSH gateway, the
  `e2e-https` CI job + `gen-sim-tls-cert.sh` + `docker-compose.https.yml` (only the Pomerium-specific cert
  SANs were trimmed). New test `apps/web/lib/workspace-proxy.test.ts` (authz glue: unauthenticated→login,
  unknown-ws→forbidden, owner→allow, other→forbidden, admin→allow, no-subject→forbidden); the vscode browser
  e2e (`test:pw:vscode`) drives the editor under `/w/<id>/`. Green at close: `pnpm build`/`test`/`lint`,
  `actionlint`, `shellcheck`, `pnpm install --frozen-lockfile`. **The earlier gate-as-current notes (e.g. the
  "Gate (HIGH) — one PEP fronts every workspace" hardening, the `pomerium-assertion exp` fix, the 2026-06-12
  per-workspace proxy authorization) are now history** — the gate they hardened no longer exists; those
  entries remain below as the record of work that was done.

- **UI/contract/perf/gate sweep (2026-06-20) — 4-agent audit + type-safety hardening, all fixed.** Targeted
  the still-under-covered surface (UI/React, Zod contract tightness, 200+ scale, gate/harness + an
  adversarial re-check of #138/#139/#140). Genuine bugs fixed, with type-safety changes that make whole
  classes non-representable (the user's directive): **contracts** — `quotaReport.limit` →
  `int().nonnegative().nullable()`, `quotaReport.role` → a closed enum (was a bare string), `costBreakdown`
  USD/Ms → `nonnegative()`/`int()`, `sshConnectInfo.host` → `min(1)`; **`workspaceLimit`** now THROWS on a
  negative/fractional/non-numeric `EDD_QUOTA_*` override (a negative would lock the role out of creating)
  rather than silently driving quota — keeping the stricter contract invariant true at the source.
  **Gate (HIGH — one PEP fronts every workspace)**: added a PDP-fetch timeout (fails closed 502), upstream
  HTTP + upgrade timeouts, and registered the upgrade-path client-close teardown BEFORE the upstream
  upgrades — closing socket/fd-leak vectors a slow PDP/upstream could exploit (named timeouts in
  `@edd/config`). **Scale**: the cost rollup was wired but NEVER regenerated, so every cost read full-scanned
  the whole append-only ledger O(history) — added `CostService.rollupIfStale(cadence)` called each reconciler
  sweep so `report()` (+ the fleet-cost gauge + `/admin/costs`) stay O(recent), figures unchanged; the quota
  report now shares the short-TTL cached fleet scan instead of re-scanning per load. **Correctness**:
  `finishDeleting` now uses a `deleteRequestedAt`-based `needsFreshTeardownSnapshot` (replacing the age-based
  heuristic from #139) so a stuck-teardown retry can never re-create the retained snapshot — the prior >6h
  leak window is gone, and it's more data-safe; `NewSession` surfaces a failed namespaces fetch instead of a
  false "no permission"; `BaseImageActions` re-syncs on error like `WorkspaceActions`; `usePoll` applies only
  the latest-started run (a slow earlier poll can't overwrite newer data). **Harness**: the `ssh-authorize`
  e2e stub now verifies the per-workspace HMAC bearer (derived from the secret + the workspace id in the
  path), so an `authorized-keys.sh` HMAC regression fails the e2e instead of passing silently. **API-first**:
  the off-contract `POST /admin/costs/rollup` gained a `costRollupResponse` contract + `adminCostsRollup()`
  client method. Verified clean: machine-auth, token-crypto, the gate auth ordering, the cost walkers, DTO
  faithfulness, branded ids. NOTED as optimizations-of-correct-code (not bugs; not done to avoid regression
  risk for speculative >200 scale): the per-sweep reconciler re-scans of the workspace table (correct +
  paginated), the drift sweep's per-workspace `DescribeTasks` (works, just serial), and the single-partition
  `auditEvent.byTime` GSI (DynamoDB on-demand adaptive capacity handles 200-scale bursts; sharding is a
  risky data-model change touching the figure-equivalence invariant — would need a deliberate decision).

- **Breadth sweep (2026-06-20) — 5-agent audit of the under-covered surface, all fixed (no deferrals).**
  Prior sweeps went deep on control-plane/cost/reconciler/storage; this one targeted the gateway/proxy/auth
  chain, the DB + cloud-adapter layer, the HTTP route surface, and shell/IaC/config. No critical bypass (the
  auth chain fails closed); a set of genuine MEDIUM/LOW bugs, all remediated + tested: **(auth)**
  `mapClaimsToRole` matched groups case-SENSITIVELY → an admin-group config/claim casing mismatch (GitHub
  slugs are lowercased) silently downgraded the role; now case-insensitive. **(github-teams)** `/user/teams`
  fetched only page 1 → a role-granting team on a later page was dropped; now follows all pages, fails loud
  past a hard cap. **(routes)** `base-images` POST caught EVERY error → 409 + leaked the raw message (no
  conflict condition exists; removed the catch so genuine errors surface as a logged 500); `github/repos`
  POST surfaced a 422 name-collision as a bodiless 500 (typed `GitHubApiError` → 409, re-throw the rest);
  `connect-info` validated the query before authenticating (pre-auth 400-vs-401 leak) and returned 404 for a
  running workspace whose ENI host wasn't bound yet (now auth-first + a retry-able 409). **(auth hardening)**
  `pomerium-assertion` didn't require `exp` present (a token without it was valid forever) → `requiredClaims:
['exp']` + `clockTolerance`. **(adapters, §6.5 fail-loud)** `cloudwatch-logs` `toLogLine` coerced a missing
  timestamp to the Unix epoch → now throws; the EMF sink now throws on a dimension key colliding with the
  metric name / `_aws`; `db.ensureTable` now waits for the table to reach ACTIVE (real-AWS `CreateTable`
  returns CREATING). **(misc)** `api-client.connectInfo` gained the `protocol` arg (the `?protocol=http`
  branch was unreachable — API-first drift); `cli status` gates its exit code on cluster health (was always
  0); `withObservability` guards the request-id header set against an immutable Response. **(gateway)**
  Both `authorized-keys.sh` hops gained a fail-closed charset guard on the sshd-supplied key fields before
  JSON interpolation. (A `/run/edd-env` group-restriction was attempted but **reverted**: its two readers —
  `nobody` for AuthorizedKeysCommand and the dev-\* login for ForceCommand — are distinct system users, and
  sshd's command sessions don't reliably carry a shared supplementary group, so restricting the file broke
  the wake chain. The file stays world-readable in this single-purpose proxy, where the only principal is a
  forced TCP-proxy ForceCommand — never a shell; the larger-blast-radius inner hop already stores only the
  per-workspace derived token under `umask 077`.) Verified clean: machine-auth
  (timing-safe, fail-closed), token-crypto (AES-256-GCM, pinned tag), the PDP/gate fail-closed paths, IAM
  least-privilege (tag/`PassedToService` conditions), config validation, the golden-image entrypoint, and
  time handling (§6.10). One agent note dismissed after verification: `nc -q0` in `wake-and-forward.sh` is
  fine — Debian's `netcat-openbsd` supports `-q` (a Debian addition).

- **Resiliency + correctness sweep (2026-06-20) — 5-agent audit, all fixed (no deferrals).** The audit
  (resiliency/concurrency, correctness/cost-model, types/fail-loud/telemetry, test-fidelity,
  security/data-safety) confirmed the codebase is high-quality and converged on a tight set of genuine
  bugs — all remediated + tested: **(1) HIGH data-loss on delete** — `snapshotStale` checked only snapshot
  _absence_, so deleting a `running` workspace with a stale prior snapshot retained the OLD snapshot while
  the live volume (newer work) was destroyed; now age-aware (`>= DEFAULT_SNAPSHOT_INTERVAL_MS`), so
  `finishDeleting` takes a FRESH retained snapshot of the live volume when the existing one is stale.
  **(2) HIGH retained-snapshot leak** — `finishDeleting` created a fresh retained snapshot but never
  recorded it, so a transaction-cancel retry (e.g. a `TransactionConflict` on the owner-count item from a
  concurrent same-owner create) created another each sweep — and retained snapshots are never GC'd; now
  the snapshot id is recorded on the tombstone (version-conditioned), so a re-run re-tags it instead
  (idempotent). **(3) HIGH credential over-scoping** — GitHub-App `gitCredential` fell back to
  `installs[0]` when the repo owner had no matching installation, minting a token for an UNRELATED org;
  now fails closed (→ 404). **(4) MEDIUM retain-tag eventual-consistency window** — `tagSnapshotRetained`
  now confirms the tag is durably visible (strongly-consistent by-id `DescribeSnapshots`) before
  `finishDeleting` unreferences the snapshot, closing the GC window (fail-loud → safe retry; the
  `createSnapshot({retain})` path already had no window — the tag is applied at creation). Tests added for
  every fix + adjacent gaps the audit named (stale-snapshot data-loss, stopped-delete tag branch,
  idempotent re-run, GC keep-set spares retained, start-during-teardown, terminate-without-delete,
  teardown-nonzero sentinel, credential fail-closed). Everything else the agents probed (the two cost
  walkers' figure-equivalence brute-forced to length-4 sequences, the lifecycle state machine, DTO
  faithfulness, authz/secret-handling, telemetry honesty) verified clean.

- **Code-quality sweep batch 1 (2026-06-20) — correctness + fail-loud + telemetry honesty.** Fixed +
  tested: (A1) `toWorkspaceDto` dropped `repoUrl` though the contract declares it and the in-workspace
  git-credential broker reads it back via `get()` → private-repo tokens were mis-scoped; now round-trips.
  (A2) the heartbeat `functional` self-report was applied on the agent path but silently dropped on the
  session path; now honoured on both (proven via admin Inspect). (A3) `snapshot()` had no lifecycle
  guard, so a `deleting` tombstone (keeps its volume) could be snapshotted onto the record being torn
  down; now rejected as a conflict. (A4) `/api/admin/logs` silently fell through to the unfiltered
  all-container stream on an unknown `workspaceId`; now 404 (unknown) / empty (no running task). (H2)
  `create()` compensation masked the original error and leaked the task if the cleanup `stopTask` threw;
  now the stop is best-effort (reaper backstop) and the ORIGINAL error always propagates. (MED-1) the
  reconciler heartbeat was written last, after `cost.report()`, so a flaky cost/gauge step made a
  healthy reconciler report `degraded`; the heartbeat is now written first in its own try. (L1)
  `pruneTaskDefinitions` returned a success-shaped `{deregistered:0}` on failure; now surfaces
  `failed` + new metrics `reconciler.taskdefs.pruned`/`.prune_failed` so a persistent failure is
  observable instead of silently growing revisions.

- **Code-review findings (codex, 2026-06-19) — all 12 fixed, merged #129 (Phase 9).** The deep
  `codex` review's findings, re-verified against the merged code: **[Critical]** silent prod
  fake-provider fallback → `assertFakeProvidersAllowed()` requires a real provider unless
  `NODE_ENV!=production` + dev-auth; terraform IAM agent-secret path → `iam.tf` grants scoped
  `CreateSecret`/`PutSecretValue`/`TagResource` (+ execution-role read) under `edd/workspace/*`;
  workspace exec/task role ARNs → `ecs.tf` sets `ECS_EXECUTION_ROLE_ARN`/`ECS_TASK_ROLE_ARN` with a
  least-privilege workspace role + `iam:PassRole`; SSH-key fingerprint race → transactional
  fingerprint-sentinel entity (`attribute_not_exists`). **[High]** no early snapshot →
  `DEFAULT_EARLY_SNAPSHOT_INTERVAL_MS` + reconciler early-session cadence; hidden repo-clone/git-cred
  failures → `.edd-bootstrap-status` surfaced in the portal; un-GC'd agent secrets → `deleteAgentSecret`
  on terminate + reconciler secret GC. **[Medium]** task-def revision sprawl → `DeregisterTaskDefinition`
  keep-newest GC; missing owner email → `resolveOwnerEmail` rejects at create; `?window=bad` →
  `costWindow` is a plain enum (no `.catch`) so `badRequest` fires. **[Low]** topology text → registered-key
  `ssh-authorize` (no CA). The deferred cross-region EBS DR flow was pulled in (sim-validatable via
  sockerless#602); `CONNECTION_TOKEN` stays correctly coupled to the future DYNAMIC wake gate (building
  it now = dead code, §6.5).

- **Portal IA/UI inconsistencies around catalog + creation flow (2026-06-16)** — the
  admin catalog lived outside the admin shell (`/base-images`), the top nav had no active
  state while the admin nav did, and `/workspaces` exposed a second, thinner creation flow
  that bypassed the richer `/sessions/new` environment/repo launcher. Closed in one pass:
  catalog now lives at **`/admin/catalog`** (legacy `/base-images` redirects there), the
  top nav has active-state location awareness, and `/workspaces` now points creation
  traffic through the single session launcher. Also improved workspace information scent by
  resolving catalog display names/metadata into the user grid and admin views, plus
  responsive behavior for the admin shell, timeline, and audit/log layouts.
- **`next build` depended on live Google Fonts fetches (2026-06-16)** — the web app
  imported `next/font/google` (`Chakra Petch`, `IBM Plex Sans`, `IBM Plex Mono`) from
  the root layout, so a production build in a restricted or offline environment failed
  before even reaching app code (`Failed to fetch ... from Google Fonts`). Replaced the
  build-time network dependency with local/fallback font-family CSS variables in
  `globals.css`; `apps/web/app/layout.tsx` no longer performs outbound font fetches and
  `pnpm --filter @edd/web build` is clean again in the sandbox.
- **Missing DynamoDB Local surfaced as opaque Vitest hook timeouts (2026-06-16)** —
  `waitForDynamo()` used the same 30000ms budget as Vitest's hook timeout, so when
  `127.0.0.1:8000` was absent the suite died with generic `Hook timed out in 30000ms`
  noise instead of the real endpoint error. Tightened the readiness budget to 10000ms
  and included the target endpoint in the thrown error, so the same condition now fails
  clearly and early (`DynamoDB at http://127.0.0.1:8000 did not become ready within
10000ms`, with the underlying `connect EPERM/ECONNREFUSED` cause). This does not
  hide the infrastructure problem; it makes it diagnosable.
- **Workspace create against the sim returned a cryptic client error + an on-purpose
  500 (2026-06-15)** — creating a workspace in the `+AWS` dev tier failed because the
  sockerless sim has no ECS cluster; `runTask` threw "Cluster not found", the route
  let it propagate to a framework 500 with an empty body, and the browser then died
  with "Unexpected end of JSON input". Fixes: (1) a compute-launch failure is now a
  **handled** condition — `create()` throws a typed `ComputeUnavailableError` (route → 503) and `start()` returns the new `unavailable` domain error (→ 503), both with a
  clear message; never a 500. (2) `withObservability` no longer catches-and-500s — it
  observes and re-raises, so only genuinely unexpected errors are 500s. (3) the
  api-client tolerates an empty/non-JSON error body (clean `ApiError` with the status,
  no "Unexpected end of JSON input"). (4) `dev-bootstrap` seeds the full golden catalog
  (node-20/go-1.22/python-3.12), not just Node 20. Note: full workspace create against
  the process-mode sim still can't complete — the API-surface tier has no container
  runtime, so the managed-EBS task never reaches RUNNING (independent of sockerless#569,
  whose _panic_ on that path is now fixed). The `+AWS` tier is for adapter call shapes;
  use tier-0 fakes or container-mode e2e to create.
- **Concurrent wake-on-connect thundering herd → flaky `concurrent-connect` e2e
  (2026-06-15)** — N simultaneous `/connect` on a stopped workspace each launched
  their own `RunTask` (read→launch→persist; losers compensated), so a burst fired N
  real-container launches at once and intermittently overran the sim, surfacing a
  transient `RunTask` 5xx as an uncaught route 500 ("expected 500 to be 200"). The
  adaptive-retry hardening (#84) only reduced it. Real root-cause fix:
  **claim-before-launch** — `start()` persists the `stopped → provisioning` claim
  with the version CAS FIRST, so exactly ONE waker launches a task; the rest lose
  the claim and `awaitWoken` (wait for the winner to reach running). `connect()`
  re-dispatches on a raced wake and waits out an in-flight `provisioning` instead of
  returning a half-woken workspace. On launch failure the claim rolls back to
  stopped (new `provisioning → stopped` transition), keeping the workspace
  wake-able. Eliminates the herd (and the wasted N-1 task launches) in production
  too. Proven deterministically in the integ tier (N concurrent wakes → exactly one
  launch, every caller running — 10/10 runs); crash-consistency updated for the new
  two-phase wake.
- **Flaky "two concurrent snapshots" concurrency test (2026-06-14)** — the test
  raced two `snapshot()` calls via `Promise.all` and asserted exactly one conflicts,
  but the calls could serialize (CI scheduling) and both legitimately succeed
  (`{ok:2}`), failing intermittently. Made the overlap deterministic: a
  `BarrierSnapshotStorage` holds both `createSnapshot`s until both have arrived, so
  both read the same version before either persists and the version CAS is genuinely
  raced. No production code changed; the strict one-conflict assertion stays.
- **`pnpm reap` left profile-scoped sim containers running (2026-06-14)** —
  `reap-local.sh` ran `docker compose down` on the dev file without the active
  `--profile`, so profile-gated services (the sockerless sim, bleephub, entra sim)
  survived a "reap" (the sockerless container was found still `Up` after `pnpm reap`).
  Fixed: the reaper now downs each dev/test compose file with the dev profiles
  (aws/github/entra) enabled — verified it removes the sockerless container.
- **Observability completion: API request metrics, fleet/cost gauges, reconciler
  health, per-workspace logs, SSH CA key material (2026-06-14)** — closed the
  remaining launch-readiness gaps in one pass: (1) a `withObservability` route
  wrapper emits per-request latency/status/error metrics + a structured access log
  across all business API routes; (2) the reconciler emits fleet gauges
  (`fleet.workspaces.{total,running,stopped,active}`) and a priced `fleet.cost.usd`
  each sweep; (3) the reconciler stamps a heartbeat and the Health board reports it
  `ok`/`degraded`/`unknown` via `reconcilerHealthFromHeartbeat` (replacing the
  hardcoded `unknown`); (4) the admin Logs view filters the container stream to one
  workspace (`?workspaceId=` → task log-stream prefix); (5) SSH-cert issuance accepts
  the CA private key as material via `EDD_SSH_CA_KEY` (Secrets Manager ARN, the
  secure default — never in Terraform state), materialized to a 0600 temp file, with
  `EDD_SSH_CA_KEY_PATH` still honored. All coordinate-driven and unit/integ-tested.
- **Observability layer: readiness, structured logging, metrics, audit pagination
  (2026-06-14)** — closed the launch-readiness gaps found in the audit:
  (1) `/api/readyz` is a real readiness probe (DynamoDB ping → 200/503) wired to the
  ALB target group, while `/api/healthz` stays liveness — an unhealthy task is now
  pulled from the LB instead of staying routable; (2) a structured JSON logger
  (`createLogger`/`formatLogLine` in `@edd/core`) replaces ad-hoc `console.*` in the
  control plane and adds per-sweep/error logging in the reconciler; (3) a metrics
  port (`MetricSink` + `@edd/cloudwatch-metrics` EMF adapter) emits wake-on-connect
  cold-start latency and reconciler action/failure counts, with CloudWatch alarms
  (`alarms.tf`, gated `enable_metric_alarms`); (4) `CloudTrailAuditSource.recent`
  paginates via `NextToken` instead of truncating to the first 50. All EMF/metrics
  are coordinate-driven (EMF on AWS, no-op locally — §6.8). Remaining items tracked
  in [`docs/observability-gaps.md`](./docs/observability-gaps.md).
- **Storage Health board reported `unknown` even on AWS (2026-06-14)** — the admin
  Health board calls each provider's optional `health()`; compute had one but
  `Ec2StorageProvider` did not, so the storage row fell through to `unknown` on real
  AWS while the fake reported a status — the same inverted contract just closed for
  compute. Added `Ec2StorageProvider.health()` (a read-only `DescribeAvailabilityZones`
  probe: reachable AZs → ok, API error → down), verified live against the sockerless
  AWS sim (`ec2-storage.integ.ts`). EBS/EC2 control-plane degradation is now visible.
- **Concurrent wake-on-connect transient 5xx — AWS SDK retry hardening (2026-06-14)**
  — the `concurrent-connect` e2e fires N simultaneous `/connect` on a stopped
  workspace; each racer's wake calls `RunTask`, so the wake path issues several
  concurrent `RunTask`s. The control-plane AWS clients used the SDK default retry
  (`standard`, 3 attempts), so a transient `RunTask` 5xx/throttle under that burst
  exhausted retries and propagated as an uncaught route 500 (empty body) — failing
  the strict "every racer gets an idempotent 200" assertion. `RunTask` is
  throttle-prone in real AWS too, so the fix is real-cloud-correct, not a sim
  workaround (§6.8): the ECS, Secrets Manager, and EC2 clients now use
  `retryMode: "adaptive"` (client-side rate limiter) with `maxAttempts: 6`
  (`AWS_SDK_MAX_ATTEMPTS`/`AWS_SDK_RETRY_MODE` in `@edd/config`). Endpoint-agnostic;
  the race assertion stays strict (no test weakened).
- **ECS Exec data-channel command proof (2026-06-14)** — the prior e2e stopped at
  asserting `ExecuteCommand` session metadata. It now opens the returned SSM
  WebSocket, sends the standard token-bearing `OpenDataChannel` handshake, runs a
  unique marker command in the task, and asserts the marker arrives in the streamed
  AgentMessage frames. This exercised the real command path through standard AWS
  coordinates only; the container-mode simulator matched it, so no upstream issue
  was filed.
- **AWS pricing model — live region-accurate rate sourcing (2026-06-14)** — costing
  can now source rates LIVE from the AWS Price List API (`pricing:GetProducts`) for
  the deployment's region (`apps/web/lib/aws-pricing.ts`): opt-in via
  `EDD_AWS_PRICING=1`, best-effort, with each rate falling back to the configured
  `@edd/config` value (us-east-1 default, `EDD_PRICE_*`-overridable) so a
  missing/denied API or unexpected product shape never mis-prices. The pure parser
  (`parseOnDemandUsd`/`parseUsageType`) is unit-tested against a recorded
  GetProducts shape; the live fetch has no simulator (no Pricing API) so it is
  exercised against real AWS (`e2e-aws`) — CI uses the safe fallback. The pricing
  _formula_ is unchanged (Fargate vCPU/GB-hr + EBS/snapshot GB-mo).
- **Cost report O(history) → O(recent) via figure-exact rollups (2026-06-14)** —
  `CostService.report` priced the whole audit ledger each request. Now an optional
  cost-checkpoint path (`costRollup` entity, reuses GSI1 — no table change) prices
  each workspace by resuming its persisted `BillingState` and replaying only the
  events since the checkpoint (`StoredAuditSource.since`, byTime tail).
  `CostService.rollup()` regenerates checkpoints (a periodic job; admin trigger
  `POST /api/admin/costs/rollup`); `report` uses them when present, else the exact
  full scan. **Figures are unchanged** — pure `deriveBillingState`/`resumeBilling`
  (46 equivalence cases) + a shared canonical-order `aggregateFleetCost` (float
  sums match), proven against DynamoDB Local (`cost-rollup-equivalence.integ.ts`).
- **Agent token → ECS `secrets` (Secrets Manager), no plaintext (2026-06-14)** —
  `EcsComputeProvider.runTask` now stashes the per-workspace HMAC agent token in a
  Secrets Manager secret (`edd/workspace/<id>/agent`) and references it from a
  per-workspace task definition's container `secrets`, instead of injecting it as
  plaintext `containerOverrides.environment` (where it surfaced in DescribeTasks/
  CloudTrail). ECS resolves it into the container env at launch (transparent to the
  agent). Active whenever an agent secret + Secrets Manager client are configured
  (`fromEnv` wires both); the plaintext path remains only for local/fakes without
  a secrets client. Proven against the container-mode sim
  (`packages/e2e/src/agent-secret.e2e.ts`: secret holds the HMAC; task def
  references it; no plaintext env) + the user-journey heartbeat e2e (functional).
- **Real `EcsComputeProvider.health()` (2026-06-14)** — implemented via
  DescribeClusters (ACTIVE → ok; other → degraded; API error → down), closing the
  inverted contract where the admin Health board showed compute `unknown` on AWS
  while the fake reported `ok`. Real integ: `packages/compute-ecs/src/ecs-compute.integ.ts`.
- **ECS Exec enabled on the launch path (2026-06-14)** — `runTask` now sets
  `enableExecuteCommand: true`, so `aws ecs execute-command` works into a live
  workspace (debug/break-glass). The capability was already sim-proven on a
  standalone task; this puts it on the production path.
- **`runTask` readiness gating (2026-06-14)** — `EcsComputeProvider.runTask` now
  waits for the task to be **READY** (a pure `taskReady` predicate: `lastStatus`
  RUNNING + managed-EBS volume attached + ENI private IP assigned) before
  returning, instead of returning as soon as the volume id appeared during
  PROVISIONING/PENDING. So `WorkspaceService` no longer reports `running` (or hands
  out `sshHost`/connect-info) for a task that can't yet accept connections — the
  race callers used to paper over with their own retries. Endpoint-only; the sim
  reaches RUNNING+attached in <1s, real Fargate within the 180s budget. Verified by
  the `taskReady` unit tests + the container-mode e2e (golden SSH / data-fidelity /
  user-journey) which drive `runTask`.
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

**Most-recent batch** (submodule bumped `9d43f3d` → `1ca1f717`, PRs #563/#564/#565;
#565 is ACA/Actions-runner-only — no downstream impact on our consumed surfaces):

- **sockerless#562 (fixed upstream)** — the AWS-sim ECS `ExecuteCommand` WebSocket
  now consumes the SSM `OpenDataChannel` token handshake real clients (session-
  manager-plugin) send before streaming, so a coordinate-pure ECS-Exec client works
  identically against the sim and real AWS. (Filed by us this cycle.)
- **sockerless#559 → PR #564 (fixed upstream)** — bleephub now seeds a pre-registered
  GitHub App from operator config (`BLEEPHUB_SEED_APPS` / `_FILE`): caller-chosen app
  id + slug, caller-supplied RSA private key, and pre-created installation(s) on
  org(s). This lets CI bring bleephub up "with the App already registered" and hand
  the consumer the same coordinate shape real GitHub gives, so
  `apps/web/lib/github-app.e2e.ts` can run coordinate-purely against the sim (no
  `/internal`). (Filed by us this cycle.)

**Earlier batch** (submodule `777ffd3`, PR #549):

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
