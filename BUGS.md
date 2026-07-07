# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

- **Production release published images but did not roll ECS services (2026-07-07) —
  FIXED in follow-up branch.** Live ECS still ran `edd-prod-control-plane:26` and
  `edd-prod-ssh-gateway:26` with image tag `2d231f5` after `main` had advanced
  through PR #201 merge commit `992b22cc334937956c2309ef0fd09de6c1235527`.
  `/api/healthz`, `/api/readyz`, ALB targets, SSH NLB targets, and login rendering
  were healthy, and both image-build paths worked: GitHub Actions release run
  `28898272647` pushed `edd-prod/control-plane:992b22cc3349` plus
  `edd-prod/ssh-gateway:992b22cc3349`, and CodeBuild run
  `edd-prod-build-images:651e5bbf-2ba6-47d2-98f2-f01ab00af0a5` pushed
  `edd-prod/golden/omnibus:992b22cc3349`. The root defect was that the `release`
  workflow only published images and never registered new task definitions or
  updated services/Scheduler, so the code that fixed image-source reconciliation
  was not deployed. The follow-up branch added `scripts/deploy-release-images.sh`,
  called it from `release.yml`, and expanded the release OIDC policy to the exact
  ECR/ECS/Scheduler/`iam:PassRole` surface required. No fallback deploy path was
  added.

- **Production image-source trigger still showed `queued` after successful
  CodeBuild because the fixed reconciler was not deployed (2026-07-07).** DynamoDB
  `imageSource` row `github-main` had `lastObservedSha` and `lastHandledSha` equal
  to `992b22cc334937956c2309ef0fd09de6c1235527`, but trigger
  `0ca8ebcf-d392-4331-a1d3-49f4d6324d41` still had `status=queued` even though its
  CodeBuild build succeeded. This was expected evidence of the stale production
  task image above; after the release-roll branch is merged and deployed, the
  long-lived image-source reconcile sweep should observe that build result and
  update the visible trigger/catalog state.

- **Production operational alarms remained active after the release inspection
  (2026-07-07).** `edd-prod-reconciler-dlq` was ALARM because the DLQ contained old
  Scheduler failures from `2026-07-06T08:03:55Z` targeting inactive task definition
  `edd-prod-reconciler:7`; the current Scheduler target was already
  `edd-prod-reconciler:26`. `edd-prod-workspaces-stuck-error` was ALARM because one
  workspace (`ws-34afea9b-ca52-4484-ad73-8dd299dbefd5`) was still
  `state=error`, `desiredState=present`. These were operational cleanup items, not
  additional code findings from the release script.

- **Control-plane release publishing skipped instead of failing loudly — FIXED
  in PR #200 plus the release-bootstrap follow-up (2026-07-07).** The `release`
  workflow was tag/manual-only and carried `if: vars.RELEASE_AWS_ROLE_ARN != ''`;
  `gh variable list` and `gh secret list` returned no configured repo
  variables/secrets, and ECR had no control-plane tags for PR #198/#199. PR #200
  changed release publishing to run on main pushes, publish web images only with
  `EDD_BUILD_TARGET=web`, keep workspace/golden images under the EDD app-owned
  webhook flow, and remove the skip guard so missing release configuration failed
  visibly. The follow-up branch added the AWS bootstrap script/docs, required
  explicit non-secret GitHub coordinate variables with no region/account
  fallback, updated age-eligible action pins, and configured the real AWS OIDC
  provider/role. The rerun for PR #200 merge commit
  `2c5fe20b99a675a19eb35ee937e4033f79942489` succeeded and pushed
  `edd-prod/control-plane:2c5fe20b99a6` plus
  `edd-prod/ssh-gateway:2c5fe20b99a6`. No static secrets were stored in GitHub
  variables or secrets.

- **Production Terraform state was local-only, so `install --verify` could not
  verify the deployed stack (2026-07-07).** The state bucket
  `edd-tfstate-edd-prod` existed, but `aws s3api list-objects-v2` returned no
  objects and `head-object` for
  `ecs-dev-desktop/edd-prod/terraform.tfstate` returned 404. Matching live
  outputs existed only in ignored local files under
  `infra/terraform/examples/complete/`. The current branch made
  `scripts/install.sh --verify` check the exact remote state object and fail
  loudly when absent, refusing to verify from local state or migrate state during
  a read-only verify run.

- **Image-source build reconciliation initially depended on an admin page read —
  FIXED in PR #198 but not yet deployed to production (2026-07-07).** The PR #197 source-sync path started
  golden CodeBuild runs from signed webhooks and exposed trigger state in
  `/admin/images`, but build-result reconciliation only ran inside
  `GET /api/admin/image-source`. A successful golden build therefore stayed
  `queued` and did not roll the catalog unless an admin had the page open. The
  follow-up branch moved reconciliation into the long-lived custom server as a
  startup + periodic sweep; missing source-sync coordinates fail startup loudly.

- **Terraform-seeded base-image catalog row lacked CAS `version` — FIXED in
  PR #198 but not yet deployed to production (2026-07-07).** Catalog CAS correctly required a numeric
  version, but `catalog-seed.tf` created the initial DynamoDB item without one.
  The first live source-triggered catalog rollout failed loudly with ElectroDB's
  `Special numeric value NaN is not allowed`. No compatibility fallback was added:
  Terraform now seeds `version = 0`, and `CatalogService` rejects any persisted
  catalog row missing a numeric version. The live `edd-prod` seed row was corrected
  and rolled through `CatalogService` to `omnibus:2d231f50fad8`.

- **`jscpd` still reports below-threshold clone blocks** (2026-07-07). The
  `pnpm cpd` gate exits 0, but the report remains noisy with repeated
  route/table/schema patterns, including the Images console table sections and
  ElectroDB entity index declarations. The unsupported `.jscpd.json` `$schema`
  warning was removed in the follow-up branch, and the `pnpm cpd` script now passes
  `--no-tips` so CI/pre-commit logs do not include jscpd promotional output.
  Immediate duplicate trigger-object construction in the new image-source service
  was refactored, but the remaining findings are below the configured failure
  threshold and need a dedicated cleanup pass rather than a risky broad refactor
  in this feature PR.

- **sockerless DynamoDB read path panicked under concurrent mutation — FIXED
  upstream and pinned (2026-07-07).** Full
  `pnpm test:integ:local` initially crashed the Tier-2 target with
  `fatal error: concurrent map iteration and map write` in `main.ddbItemSizeBytes`
  while `handleDDBGetItem` computed consumed capacity. The issue was filed as
  `e6qu/sockerless#777` and merged upstream via `e6qu/sockerless#778`. The pinned
  submodule now points at upstream main commit `b5126463`, which fixed `GetItem`,
  `Query`, and `Scan` by snapshotting stored DynamoDB item maps under `ddbItemsMu`
  before projection and capacity accounting, with a concurrent mutation regression
  test. After the fix, `pnpm test:integ:local` passed 27/27 tasks.

- **`pnpm test:e2e:local` production web harness missed required image-source
  coordinates — FIXED in follow-up branch (2026-07-07).** The app correctly failed
  startup when `EDD_IMAGE_SOURCE_REPO` and sibling required config were absent, but
  the e2e production-server harness had not supplied those coordinates. The harness
  now injects explicit e2e image-source repo/branch/app/golden/webhook-secret values;
  no optional config path was added. Full `pnpm test:e2e:local` then passed.

- **CI `playwright` production web harness missed required image-source
  coordinates — FIXED in follow-up branch (2026-07-07).** PR #198 CI failed in the
  `playwright` job because `apps/web/playwright.config.ts` started `server.ts`
  without `EDD_IMAGE_SOURCE_REPO` and the related required source-sync config. The
  fix supplied explicit Playwright-only coordinates in the harness env, preserving
  production fail-loud behavior. The local repro also surfaced and fixed the
  inherited `NO_COLOR`/`FORCE_COLOR` warning by unsetting `NO_COLOR` before
  Playwright and its webServer children start. `pnpm --filter web test:pw` passed
  18/18 with clean warning output.

- **GitHub Actions emitted stale-action warnings in PR #198 CI — FIXED in
  follow-up branch (2026-07-07).** The failed `playwright` job also warned that
  `actions/cache@v4` targeted deprecated Node 20, and the pnpm setup step was one
  maintenance release behind. The branch verified the current upstream releases
  via the GitHub API, then bumped `actions/cache` to `v6.1.0` and
  `pnpm/action-setup` to `v6.0.9`, both older than the one-day dependency floor.
  `pnpm actionlint` and `pnpm check-deps` passed.

- **`editor-token-handshake` test timed out and double-failed on local bind
  errors — FIXED in follow-up branch (2026-07-07).** A sandboxed `pnpm test`
  reproduced a local `listen EPERM` for the test's loopback servers; the harness
  then hid the real startup failure behind a 10s hook timeout and a teardown
  crash on `proxy.close()` before initialization. The test now rejects immediately
  on `listen` errors, closes only initialized listening servers, and removes its
  temp root. The focused handshake test passed, and full `pnpm test` passed when
  loopback listeners were allowed.

- **Live Playwright e2e harness missed required image-source coordinates —
  FIXED in follow-up branch (2026-07-07).** After the standard Playwright job was
  fixed, PR #198 CI `e2e` failed in `pnpm --filter web test:pw:live` with the same
  fail-loud startup error, `EDD_IMAGE_SOURCE_REPO is required`. The live harness
  now writes explicit image-source repo/branch/app/golden/webhook-secret
  coordinates into `temp/live-pw.env`; no production fallback was added. Local
  `pnpm --filter web test:pw:live` passed the browser create-stop-wake-delete
  lifecycle against the container-mode simulator.

- **`pnpm/action-setup` emitted npm self-installer audit warnings in CI — FIXED
  in follow-up branch (2026-07-07).** Bumping to `v6.0.9` removed the stale pin but
  did not remove the warning because the action installs itself through npm and
  reports its own transitive audit state. Workflows now use `actions/setup-node`
  plus `corepack enable`, so CI consumes the repo-pinned `packageManager`
  (`pnpm@10.33.3`) without the pnpm action self-installer.

- **Circle-`i` infoboxes broke layout by rendering inside page/card flow —
  FIXED in follow-up branch (2026-07-07).** The topbar help panel used a sticky
  in-page block and workspace details had bespoke inline modal sizing, which made
  narrow content and layout shifts likely. Both controls now render fixed
  page-overlays with shared sizing/scroll behavior; Playwright asserted that page
  help opened without changing document height and that both help/workspace-info
  overlays were fixed-position.

- **Deleted workspaces must not be snapshotted further — PINNED in follow-up
  branch (2026-07-07).** The control-plane snapshot path already rejected non-live
  states, and the reconciler snapshot candidate scan only considered
  `running`/`idle`; the branch added explicit regressions so a `terminated`
  tombstone snapshot call returned conflict without creating a new snapshot, and
  scheduled snapshot reconciliation scanned zero terminated candidates.

- **Dev-auth used a shared password fallback — FIXED in follow-up branch
  (2026-07-07).** `matchDevUser` previously accepted per-account password or
  shared `EDD_DEV_PASSWORD`/default `dev`. That hid missing per-user passwords.
  `DevUser.password` is now required, built-in dev accounts carry explicit
  passwords, invalid `EDD_DEV_USERS` entries fail schema parsing, and the matcher
  compares only the account password.

- **Unknown editor values silently became OpenVSCode — FIXED in follow-up branch
  (2026-07-07).** `asEditorKind` now defaults only an omitted value and throws on
  unknown persisted/requested editor values, so malformed state fails loudly.

- **`claude`/`codex` workspace modes used the Monaco-terminal wrapper, not the
  vendor web harnesses — FAIL-LOUD FIX in follow-up branch (2026-07-07).** Product
  decision is explicit: do not build an EDD-authored Claude/Codex chat UI and do
  not treat a terminal-booted CLI as the final UX. `claude` mode should run
  Anthropic's Claude Code Remote Control/local-process harness and direct the user
  to `claude.ai/code`; `codex` mode should run OpenAI's Codex local harness
  (`codex app-server` / first-party client protocol). Until that wiring lands,
  `infra/images/base/entrypoint.sh` exits with a clear error for `EDD_EDITOR_MODE`
  `claude` or `codex` instead of serving the wrong harness.

- **editor-monaco tests bound wildcard addresses — FIXED in follow-up branch
  (2026-07-07).** The local server/terminal tests listened on an unspecified host,
  which is noisier and more environment-sensitive than needed for loopback-only
  assertions. They now bind `127.0.0.1` explicitly and the terminal test cleans its
  temp root after each run. `pnpm --dir services/editor-monaco test` passed.

- **editor-monaco loopback bind failures surfaced as hook timeouts — FIXED in
  release-bootstrap follow-up (2026-07-07).** A full `pnpm test` run in the
  sandbox reproduced `listen EPERM: operation not permitted 127.0.0.1`, but the
  server and terminal tests reported that real bind error as 10-second
  `beforeEach` hook timeouts plus unhandled exceptions. The tests now use a
  shared helper that installs an explicit `error` listener before `listen`,
  resolves only after the server is actually listening, and closes only initialized
  servers. Focused `pnpm --dir services/editor-monaco test` and full `pnpm test`
  passed with loopback permission.

- **Cost model doesn't price the undelete window or restored sessions** (2026-07-06).
  Deleted workspaces now keep a retained snapshot for the 7-day undelete window —
  that snapshot storage bills in AWS but `deriveBillingIntervals` treats
  `session.terminated` as the end of all billing, and `session.undelete` is not a
  billing event (a restored session's later intervals are dropped because the
  timeline was closed as terminated). Under-attribution only (fleet totals from
  real AWS billing are unaffected); fix = model a `retained` interval terminated →
  purge/undelete, and reopen the timeline on `session.undelete`.

- **CodeBuild image rebuild silently no-ops on a re-run against the same branch — known footgun (2026-07-06).**
  `terraform_data.build_images_codebuild`'s `triggers_replace` (`infra/terraform/modules/ecs-dev-desktop/build-codebuild.tf`)
  is keyed on the literal `var.image_tag`/`var.codebuild_source_ref` **strings**, not the commit the ref
  resolves to. Re-running `scripts/install.sh` with `EDD_CODEBUILD_SOURCE_REF` set to the same branch name
  after pushing new commits to that branch reports `Apply complete! Resources: 0 added, 0 changed, 0 destroyed`
  and does **not** rebuild or redeploy anything — the live images stay pinned to whatever commit the last
  build actually used. Separately, `EDD_CODEBUILD_SOURCE_REF` must be a real branch/tag name: the buildspec's
  `git clone -b "$SOURCE_REF"` rejects a raw commit SHA (`-b` only accepts branch/tag refs), so passing a SHA
  there fails the build immediately. **Workaround**: keep `EDD_CODEBUILD_SOURCE_REF` as the branch name, and
  bump `EDD_IMAGE_TAG` to a new distinct value (e.g. the short commit SHA) every time you want a rebuild to
  actually pick up new commits on the same branch — that's the only field in `triggers_replace` meant to be
  varied per-rebuild. Not filed upstream (this is our own terraform, not a sockerless gap).

- **`terraform-sim` CloudWatch Logs `ResourceAlreadyExistsException` flake (2026-06-29).** The first CI run of PR #175 failed in the `terraform-sim` job during `validate-sockerless-713.sh` apply with `ResourceAlreadyExistsException: The specified log group already exists: /eddsim/control-plane`. The preceding DNS/TLS step had reported a successful destroy (`95 destroyed`). A re-run passed. Local attempts to reproduce the exact sequence have not yet succeeded. Mitigated (boyscout rule) with: (1) failure-time sockerless container logs in CI, (2) a pre-apply `describe-log-groups` dump in the probe script, (3) standard-API cleanup of the three module log groups before apply in `validate-sockerless-713.sh`, and (4) a post-bring-up sim health wait in the `terraform-sim` CI job. Root cause unknown — under investigation; will file upstream on `e6qu/sockerless` only once a reproduction or clear evidence is in hand.

- **Cross-arch golden-image builds require QEMU/binfmt on the build host (2026-06-28).**
  The base workspace image now compiles `node-pty` for the target architecture
  inside the Dockerfile builder stage, so the correct native binary is produced
  for both `linux/amd64` and `linux/arm64`. Emulation is only needed when the
  build host architecture differs from the target architecture. If your runner
  cannot emulate the other architecture (e.g. a standard AWS CodeBuild x86_64
  project without binfmt), limit `scripts/publish-images.sh` to the host arch with
  `EDD_BUILD_ARCHS=amd64` (the CodeBuild project in the Terraform module does
  this). Full dual-arch manifests require either a multi-arch-capable runner or
  two single-arch runners that each publish the `-amd64`/`-arm64` tags and then
  create/merge the manifest.

- **Catalog (base-image) create/update now uses optimistic-concurrency CAS — FIXED (2026-07-04).**
  `CatalogService.update`/`remove` (`packages/control-plane/src/catalog-service.ts`) now carry a
  `version` attribute and use ElectroDB `.where(({ version }, { eq }) => eq(version, observedVersion))`
  conditional writes — mirroring the `WorkspaceEntity` version-CAS. Two concurrent admin edits of the
  same image now resolve to one winner + one `conflict` domain error instead of silently clobbering.
  The `isVersionConflict` helper was extracted to a shared `version-conflict.ts` utility. Proven by
  two new integ tests (concurrent update race + concurrent update-vs-remove race).

- **DynamoDB Local retired from the dev loop — FIXED (2026-07-04).** `docker-compose.dev.yml` no longer
  ships `amazon/dynamodb-local`; the default substrate now uses the sockerless AWS sim (which serves
  DynamoDB on `:4566`). `scripts/dev.sh` defaults `DYNAMODB_ENDPOINT` to `:4566`. The `aws` compose
  profile was removed — the sim is always started. DynamoDB Local is fully eliminated from the project.

- **IAM preflight skips a path-scoped role — known limitation (2026-06-21).** `callerToPrincipalArn`
  (`@edd/iam-preflight`) reconstructs the role/user ARN from the STS caller ARN, but AWS DROPS the IAM
  **path** in the STS assumed-role ARN (`assumed-role/<RoleNameOnly>/<session>`), so a role created under a
  non-default IAM path (e.g. `role/eng/team/edd-cp`) is reconstructed without the path. `SimulatePrincipalPolicy`
  requires the full ARN incl. path, so the simulate call fails → the preflight self-check silently never
  runs for a path-scoped control-plane/reconciler role. **Degrades safely** (→ `unknown`, never a false
  `drift`/green), so it's a self-check coverage gap, not a security hole. The path is genuinely unrecoverable
  from the STS ARN alone; the mitigation is to deploy the roles at the default path (the terraform module
  does). Recorded so it isn't silently lost; revisit only if a deployment needs path-scoped roles.

- **Cost-model teardown-volume over-bill — known approximation, DEFERRED (2026-06-21).** When a _stopped_
  workspace is deleted there is no live EBS volume (it was released at stop), but the cost model's single
  `teardown` bucket bills the live-volume line for the whole teardown window — so a stopped-then-deleted
  workspace is over-billed on volume across teardown. **Magnitude is sub-cent** (teardown is
  seconds-to-minutes). A precise fix requires splitting the `teardown` bucket by its _prior_ phase
  (running vs stopped) through the **persisted** `BillingState` rollup schema — a `@edd/db` entity change —
  and then re-proving the cost figure-equivalence invariant (now property-tested). Judged **not worth the
  persisted-schema churn + regression risk** for the magnitude; recorded here so it isn't silently lost.
  Revisit if teardown windows or the rate make the figure material.

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

- **AWS sim: ECS task metadata advertised CPU/memory limits that Podman did not enforce
  — OPEN upstream as sockerless #776 (2026-07-07).** This was originally filed in
  EDD as #92 but belonged upstream per the repo rule. The simulator reported task
  definition limits in metadata while launching an unbounded container cgroup, so local
  capacity tests could pass when real Fargate would throttle or OOM. The EDD duplicate
  was closed after moving the issue upstream.

- **AWS sim: KMS Encrypt/Decrypt does not perform real encryption and key-policy Deny on Decrypt is not enforced — FIXED upstream by sockerless #737 (2026-07-01).** Filed as **e6qu/sockerless#732**; fixed by **e6qu/sockerless#737**. Against earlier sockerless builds, `kms:Encrypt` returned a blob leaking the key ID and plaintext, and `kms:Decrypt` succeeded even after an explicit key-policy `Deny`. After re-pinning to `38e311ac`, real encryption and key-policy Deny enforcement work. The wave-3 KMS adversarial spec-fidelity probe (`adversarial-slice-kms-encryption.sh`) is enabled and passes.

- **AWS sim: Route53 wildcard DNS records do not resolve via the sim DNS server — FIXED upstream by sockerless #737 (2026-07-01).** Filed as **e6qu/sockerless#731**; fixed by **e6qu/sockerless#737**. The sim's Route53 DNS server now expands wildcard records per RFC 4592. The wave-3 Route53 DNS adversarial spec-fidelity probe (`adversarial-slice-route53-dns.sh`) is enabled and passes.

- **CloudWatch alarm SNS notification on ALARM transition — FIXED (2026-07-03).** Originally filed as **e6qu/sockerless#734**. The upstream fix chain: sockerless #739 (JSON body), #741/#742 (process-mode fan-out), #748 (isolated regression test), #756 (evaluator state per-alarm), #759 (dangling-alarm test), #761 (atomic read/dispatch/write), #764 (fan-out observability logging), #767 (SQS receive diagnostics). The remaining "delivery succeeded but ReceiveMessage empty" was **our bug**: the probe used `echo "$raw"` to pipe JSON to python, but POSIX `echo` corrupts backslash sequences in the nested-JSON SQS Body, causing `json.load` to fail silently. Fixed by using `printf '%s\n'` and parsing the nested SNS→CloudWatch JSON structure correctly. The sim was working all along. Closed **e6qu/sockerless#766** (not a sim bug).

- **bleephub `GET /user/teams` returns empty list — FIXED upstream by sockerless #767 (2026-07-03).** sockerless #756 removed the OAuth-scope gate (#754), #764 attempted OAuth team fidelity, and **#767** fixed the root cause: `POST /orgs/{org}/teams` now auto-maintains the creator as a team member (matching real GitHub behaviour). Filed as **e6qu/sockerless#765**, closed by #767. Awaiting downstream CI verification.

- **EC2 `RevokeSecurityGroupIngress`/`Egress` by `SecurityGroupRuleIds` returned `InvalidPermission.NotFound` even when the rule existed — FIXED upstream on sockerless main, confirmed, issue closed (2026-06-30).** Filed as **e6qu/sockerless#727** after sockerless #725 fixed spec-based revoke-not-found (#722) but regressed rule-id-based revokes. Re-pinned the submodule past the fix (to `e2fafce6`) and verified locally that `revoke-security-group-ingress --security-group-rule-ids <id>` succeeds for an existing rule and is idempotent for a missing rule. Closed **e6qu/sockerless#727**. Terraform `aws_vpc_security_group_*_rule` destroy now works against the sim.

- **EC2 `RevokeSecurityGroupIngress` succeeds for a non-existent rule — FIXED upstream by sockerless #725 (2026-06-30).** Filed as **e6qu/sockerless#722**; fixed by **e6qu/sockerless#725**. Real AWS returns `InvalidPermission.NotFound`; the sim now returns the same error. Made `adversarial-slice-ec2-sg.sh` strict — it fails the probe if revoke of a non-existent ingress rule succeeds.

- **CloudWatch Logs `PutMetricFilter` accepts an invalid filter pattern — FIXED upstream by sockerless #725 (2026-06-30).** Filed as **e6qu/sockerless#723**; fixed by **e6qu/sockerless#725**. Real AWS rejects `{` with `InvalidParameterException`; the sim now returns the same error. Made `adversarial-slice-cloudwatch-metric-filter.sh` strict — it fails the probe if an invalid pattern is accepted.

- **Module-wide sockerless fidelity audit — ALL 10 GAPS FIXED upstream, re-pinned to `eaf80dc`, validated downstream through integration tier + new behavioral probes (2026-06-29/30).** Audited every AWS resource created by `infra/terraform/modules/ecs-dev-desktop` against sockerless `08b7ee71` and filed **#703–#712**. sockerless **#713** closed all ten by adding the real behavioral side effects: Budgets service slice (#703), SQS DLQ auto-redrive (#704), CloudWatch alarm actions → SNS (#705), CloudWatch Logs metric filters → metrics (#706), Application Auto Scaling target tracking → ECS DesiredCount (#707), ACM `AMAZON_ISSUED` real RSA/X509 PEM (#708), ELBv2 HTTPS/TLS termination (#709), Route53 UDP+TCP DNS server (#710), ECS service scheduler reconciles `DesiredCount` (#711), EC2 security-group ingress enforcement at nftables (#712). sockerless **#715** closed the follow-up Budgets Terraform lifecycle gap (**#714**), and sockerless **#725** fixed the two spec-fidelity gaps found in the adversarial probe wave (**#722** revoke-not-found, **#723** metric-filter validation). Re-pinned the submodule to `eaf80dc`. Validated: `pnpm build`/`test` green; `pnpm test:integ` green (web 130/130, reconciler 9/9, storage-ec2 15/15, e2e integ 1/1); new `validate-sockerless-713.sh` probe suite **13/13 PASS** against the module with `enable_dns=true` and `monthly_budget_usd=100`; `terraform-sim` default apply/destroy and idempotency re-plan pass; all adversarial slices pass with strict assertions.

- **AWS Budgets Terraform lifecycle — FIXED upstream by sockerless #715 (2026-06-29).** Was: `aws_budgets_budget` creation through the Terraform AWS provider failed against the sim because `ListTagsForResource` was unimplemented and `CreateBudget` rejected an omitted `AccountId`. Filed as **e6qu/sockerless#714**; fixed by **#715**. Verified downstream: re-pinned to `35f0f087`, rebuilt the sim, and the probe suite now runs with `monthly_budget_usd=100`; the budget resource creates, refreshes, and destroys cleanly.

- **SSH ingress (Slice 3) sim-exercise — ALL gaps FIXED upstream, CONFIRMED + RE-ENABLED (re-pinned
  `08b7ee71`, 2026-06-26).** The four-gap chain to get the NLB SSH front door through a clean terraform
  apply→idempotency loop on the sim is closed: **#683** (NLB raw-TCP data plane, `elbv2_nlb_proxy.go`) +
  **#685** (TCP target group `Matcher`) in **#687**; **#688** (TCP target group `HealthCheckPath`) in
  **#690**; **#691** (NLB `DescribeLoadBalancers` returned the proxy `host:port` as `DNSName` — a
  regression from #683's proxy) in **#692** (now a stable `eddsim-ssh-<hash>.elb.<region>.amazonaws.com`).
  Each upstream fix surfaced the next, found on the idempotency re-plan. Re-validated against #692: the SSH
  ingress `terraform apply` **and** the idempotency re-plan are clean (94 added, then `No changes`), the
  destroy is clean, and every CI assertion passes locally — so `tests/sim` sets `ssh_base_domain` and the
  terraform-sim DNS/TLS config asserts the full ingress (NLB type=network, TCP:22 listener, TCP target
  group, the `*.<ssh-base-domain>` wildcard, the gateway ECS service). Integration tier 26/26 against #692.
  The live `ssh <principal>@<ws-id>.<ssh-base-domain>` byte-stream loop through the NLB is now sim-capable
  (#683) but exercised at deploy/e2e-aws. See `infra/terraform/modules/ecs-dev-desktop/ssh-ingress.tf`.

- **IAM enforcement RESOURCE/SERVICE-scoped condition keys — FIXED upstream (#661→#662), CONFIRMED
  downstream (2026-06-25).** Was: `iamAuthorize` (`iam_enforcement.go`) populated only **global** keys
  (`aws:username`/`userid`/`SourceIp`/`RequestedRegion`) into the request context, not **resource-scoped**
  `aws:ResourceTag/<key>` (from the target's tags) or **service** keys like `ecs:cluster` — so a tag-scoped
  Allow behaved as a blanket deny (key absent from context), and our exact tag/cluster-conditioned grants
  stayed e2e-aws-only. Filed **#661**; fixed by **sockerless #662** (resource/service condition-key
  population, building on the #660 operator evaluator). **Confirmed downstream** after re-pinning the
  submodule to `6918fb81` (also adopting the #663–#679 conformance ratchet that drove ECS/S3/DynamoDB/
  EventBridge/CloudWatch/IAM and many query/REST services to 100%): both condition halves now enforce at the
  sim tier — `packages/storage-ec2/src/iam-enforcement.integ.ts` proves `aws:ResourceTag/edd:managed`
  (`DeleteVolume` on a tagged resource allowed, untagged denied) and the new
  `packages/compute-ecs/src/iam-enforcement.integ.ts` proves `ecs:cluster` (`ListTasks` on the granted
  cluster allowed, another denied), both via the shared `@edd/aws-itest-support` provisioning helper. Full
  integ tier 26/26 against the rebuilt sim. The tag/cluster-conditioned least-privilege grants no longer
  need e2e-aws.

- **sockerless DynamoDB + CloudTrail conformance — ALL FIXED + tier MIGRATED (2026-06-22).** Seven gaps,
  found by moving the integration tier off **DynamoDB Local** onto the sim's own DynamoDB (endpoint-only,
  `DYNAMODB_ENDPOINT` → `:4566`) to fix a rare DynamoDB-Local CAS-isolation flake (`concurrency-pairs`). Each
  was confirmed with a minimal AWS-CLI/SDK repro vs DynamoDB Local + the AWS spec + a `simulators/aws/*.go`
  code pointer (NOT worked around). All fixed upstream and **confirmed downstream** after re-pinning the
  submodule to `0e46585e`:
  - **DynamoDB (#646):** **#641** `TransactWriteItems` silently ignored the `Update` action (dropped, 200 OK
    — broke transactional version-CAS + atomic counters); **#642** `TransactionCanceledException` omitted the
    per-item `CancellationReasons` array (conflict→domain-error mapping); **#644** `DeleteTable` didn't purge
    the table's items.
  - **DynamoDB (#649):** **#643/#648** the `SET` RHS evaluator stored `null` for `(if_not_exists(c,:0) - :v)`
    (it never stripped an enclosing `( … )`; ElectroDB always parenthesizes `.subtract()`).
  - **CloudTrail (#653):** **#650** the sim self-generated phantom `ListBuckets` events (a bare `GET /`
    healthcheck recorded as an API call); **#651** `LookupEvents` returned DynamoDB **data**-plane ops
    (PutItem/GetItem/Query), but AWS only returns **management** events there. Fixed by registration-time
    management-vs-data classification.
  - **Architecture (#652) — CLOSED by sockerless #655.** The meta-issue on the "silent incompleteness"
    failure mode (succeed-with-wrong-result instead of compute-or-fail-loud) was fully addressed: all five
    proposed prevention levers landed across #653/#654/#655 (spec as source of truth + required-field
    validation; fail-loud-by-default for DynamoDB expressions + CloudWatch; closed types + real parsers;
    modelled CloudTrail event classification; differential testing vs DynamoDB Local).
  - The maintainer also confirmed the principle: the sim must be conformant via **all** official access
    methods (CLI, SDK, Terraform providers, the official API/spec), not some.

  **Migration DONE — DynamoDB Local retired from all CI (merged #148 + this PR).** #148 migrated the
  integration tier; this PR finished it: **e2e** (the container-mode sim already serves DynamoDB) and
  **playwright** (now brings up the process-mode sim) both run on the sim too, and `@edd/config`
  `dynamodb.endpoint` now **defaults to the sim** (`:4566`) — the per-tier `DYNAMODB_ENDPOINT` overrides were
  removed, and `amazon/dynamodb-local` is gone from `tier2`/`e2e` compose + all three CI jobs. Re-pinned to
  `5fb1341a` (#654/#655). `observability-live` is isolation-robust (server-side EventName-scoped
  `LookupEvents` instead of the shared, capped audit feed). Validated: full integ 25/25 (via config default),
  portal Playwright 18/18 vs the sim locally; e2e validates in CI. **The only remaining DynamoDB-Local
  consumer is the local `pnpm dev` loop** (pins `:8000` for instant startup; the CAS flake only bites under
  CI concurrency) — overridable to the sim, kept deliberately for inner-loop speed.

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
  limits**, so the sim doesn't enforce the declared Fargate sizing. Code pointer:
  `simulators/aws/ecs.go` builds metadata `Limits` (~L1718) but the launched
  `ContainerConfig` (~L1573) sets no `Memory`/`NanoCPU`. Local tracker: this repo's
  issue #92. **Mitigation applied:** `DEFAULT_WORKSPACE_MEMORY` was raised from 1024
  MiB to 2048 MiB, so the default omnibus workspace has headroom when real Fargate
  enforces the limit. The sim gap itself (no enforcement) remains open upstream.
  Revisit #583 adoption once the fix lands to confirm no OOM on the default image.

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

- **Docker package installs emitted `update-alternatives` warnings in CI image
  builds — FIXED (2026-07-07).** Debian slim images excluded man pages, while
  packages such as `netcat-openbsd` and `xz-utils` registered man1 slave links
  through `update-alternatives`. Workspace and SSH Dockerfiles now keep man1 pages
  for those package-managed alternatives, and apt installs run with
  `DEBIAN_FRONTEND=noninteractive`. Disposable Debian/Node package-install
  reproductions emitted no `update-alternatives` warnings, and the SSH proxy image
  built successfully with `docker build --load`.

- **Shell parse sweep emitted a zsh `nice(5)` warning for the base entrypoint —
  FIXED (2026-07-07).** The CI shell sweep now runs `zsh --emulate sh -n` for the
  repo's POSIX shell scripts instead of parsing them as native zsh. The full local
  shell sweep (`shellcheck`, `bash -n`, and `zsh --emulate sh -n`) passed.

- **`scripts/install.sh` passed S3 backend config to a Terraform example with no
  backend block — FIXED (2026-07-07).** The complete Terraform example now
  declares `backend "s3" {}`, matching the install/uninstall scripts' explicit
  S3 backend configuration. `terraform init -backend=false`, `terraform validate`,
  and `terraform fmt -check -recursive infra/terraform` passed.

- **Golden-image builds did not repoint catalog entries — FIXED (2026-07-07).**
  The control-plane-owned GitHub source-sync path completed the loop it started:
  after a successful async `EDD_BUILD_TARGET=golden` CodeBuild observation, the
  image-source service rolled each configured `<app>/golden/<variant>` catalog entry
  to the exact 12-character source tag through `CatalogService.rollImageTag` and the
  existing catalog CAS write. Missing/multiple catalog matches and other rollout
  failures marked the source trigger `failed` with a visible reason instead of
  reporting a successful build that the catalog did not use. This fixed the live
  class where new immutable ECR tags existed but the catalog kept launching the old
  `omnibus:db75d1f` row. Existing workspaces still correctly woke on the image they
  were created with; fresh workspaces picked up the repointed catalog entry.

- **Snapshot cadence and retention mismatch — FIXED (2026-07-07).** Scheduled
  snapshots defaulted to 5 minutes, the interval was configurable and persisted per
  workspace, and the reconciler honored that per-workspace value. GC retained only
  referenced snapshots after the one-hour grace, so when a workspace stopped and its
  shutdown snapshot succeeded, the older 5-minute scheduled snapshots aged out and
  two hours later only the shutdown snapshot remained for that workspace.

- **Branch e2e failures after instant-create were real async-provisioning test
  mismatches, then fixed (2026-07-07).** The PR #193 `e2e` check had been red. Local
  reproduction showed the first failures were not the golden-image build flake that
  initially looked likely: several tests still assumed `POST /api/workspaces` returned
  `running`, but instant create correctly returns `provisioning` and launches detached.
  Updated the e2e fixtures/specs to accept `provisioning` and wait for `running`
  before stop/connect assertions. The remaining SSH wake-chain failure was a harness
  issue: the custom server sweep and compiled Next route handlers have separate
  in-memory fake-storage instances, so a stop converger cannot snapshot a route-created
  fake volume. The test now seeds a resume snapshot through the public `snapshot` API
  before stopping, keeping the test focused on the gateway → control-plane wake
  contract. Verified with `pnpm test:e2e:local` (20/20 Turbo tasks; `@edd/e2e`
  46 passed, 5 image-variant skips).

- **The control-plane and reconciler task roles could read/write DynamoDB items but
  couldn't decrypt them (2026-07-06, found by a real user hitting `/workspaces` right
  after the DescribeTable/AUTH_URL fixes went live).** The single table is encrypted
  with the module's own customer-managed KMS key; the ONLY existing `kms:Decrypt`
  grant was on the task-EXECUTION role (`DecryptForInjection`, for the ECS agent to
  decrypt Secrets Manager values at container launch) — the task ROLE the running
  app actually uses for its own DynamoDB calls had no KMS grant at all. Unlike
  CloudWatch Logs (a genuine service-principal grant on the key policy), DynamoDB
  with a customer-managed CMK requires the CALLING PRINCIPAL to hold direct
  `kms:Decrypt`/`kms:GenerateDataKey`/`kms:DescribeKey` on the key — confirmed via
  the exact error: `AccessDeniedException ... is not authorized to perform:
kms:Decrypt on resource: arn:aws:kms:...` thrown from `ElectroError` in
  `workspace-service.ts`'s `list()`. Added a `DecryptSingleTable` statement granting
  those three actions on `aws_kms_key.this.arn` to both `control_plane` and
  `reconciler` task-role policy documents, and the matching entries to both
  components' `IAM_REQUIREMENTS` manifest entries in `packages/core`. The
  `iam-policy-drift` test (terraform grants ⊇ manifest) passes; `terraform fmt`/
  `validate` clean.

- **The `codebuild` build-mode CodeBuild project's default image couldn't run the
  golden-image build's Node.js step (2026-07-05, same deploy).** The golden image
  build stages `@edd/editor-monaco` (`tsc`/`vite`/`esbuild`) directly on the CodeBuild
  host, not inside a container. `aws/codebuild/amazonlinux2-x86_64-standard:5.0`
  defaults to Node 18.20.8, and Vite 8 requires 20.19+/22.12+ — failed with
  `ReferenceError: CustomEvent is not defined`. Worse, Amazon Linux 2's glibc (2.26) is
  too old to run official Node.js 20+/22+ binaries **at all**, so no version-manager
  trick on that base image would have fixed it. Fixed by switching the CodeBuild
  project's image to `aws/codebuild/standard:7.0` (Ubuntu, modern glibc) and
  explicitly selecting Node 22 in the buildspec (`n 22`) before `corepack`/`pnpm`.
  `terraform fmt`/`validate` clean; confirmed working on the next live CodeBuild run
  (control-plane, ssh-gateway, and the omnibus golden image all built and pushed
  successfully under Node 22).

- **`publish-images.sh`'s ssh-gateway build passed the wrong Docker build context
  (2026-07-05, same deploy).** `build_push_arch ssh-gateway "$repo/services/ssh-gateway/Dockerfile.proxy"
"$repo/services/ssh-gateway"` used the `services/ssh-gateway/` subdirectory itself as
  context, but `Dockerfile.proxy`'s `COPY` paths are repo-root-relative
  (`services/ssh-gateway/sshd_config.proxy`, etc. — the same convention as the
  control-plane Dockerfile), so every `COPY` failed with `"...": not found`. This build
  path had never been exercised: local `image_build_mode` never got past the
  control-plane image (see above), and this was the first time `codebuild` mode ever
  reached the ssh-gateway step. Fixed by passing the repo root as context, matching
  the control-plane `build_push_arch` call. Also declared `seed_default_catalog` as a
  proper passthrough variable in `examples/complete` (Terraform warned "does not
  declare a variable named seed_default_catalog" — `main.tf` hardcoded it instead of
  taking a variable, the same undeclared-passthrough pattern PR #191 already fixed for
  `nat_mode`/`image_build_mode`/`golden_image_repos`); cross-checked every other key
  `install.sh` writes into `install.tfvars` against `examples/complete`'s declared
  variables and found no further gaps. Verified: `shellcheck`, `terraform fmt`/
  `validate`, and a direct local `docker buildx build` of the ssh-gateway image with
  the corrected context (all `COPY` steps succeed).

- **`apps/web/Dockerfile` had never actually been built until this exact real deploy
  (2026-07-05) — only `scripts/release.yml` (gated dormant until now) ever invokes
  it, via `scripts/publish-images.sh`.** The image build failed during
  `pnpm install --frozen-lockfile`: `node-gyp` couldn't compile
  `services/editor-monaco`'s `node-pty` native binding — `gyp ERR! Could not find any
Python installation to use`. The workspace-wide install pulls in every package's
  deps (including `editor-monaco`'s, even though `apps/web`'s runtime doesn't use it),
  and the `node:22-bookworm-slim` base image has no Python or C/C++ toolchain by
  default. Fixed by installing `python3 make g++` in the builder stage before
  `pnpm install`. Verified with a direct local
  `docker buildx build --platform linux/arm64 -f apps/web/Dockerfile .` — full build
  (install, `@edd/web` build, `@edd/reconciler` build, runner stage) now completes
  clean.

- **Two more real Terraform-module bugs found once `terraform apply` was actually
  running against real AWS (2026-07-05, same first-ever real deploy) — never
  exercisable against the sockerless sim:**
  1. **`aws_kms_key.this` (`data.tf`) had no explicit key policy**, so AWS applied the
     default root-only policy. DynamoDB/EBS/Secrets Manager encryption with this key
     works fine under the default policy (each service authorizes via the CALLING
     principal's own IAM permissions and a dynamically-created KMS grant), but
     CloudWatch Logs log-group encryption calls KMS as the
     `logs.<region>.amazonaws.com` SERVICE principal, which the default policy doesn't
     cover — all four log groups (`control-plane`/`reconciler`/`workspaces`/
     `ssh-gateway`) failed with `AccessDeniedException: The specified KMS key does not
exist or is not allowed to be used`. Fixed by giving the key an explicit policy:
     the standard "Enable IAM User Permissions" root statement plus a service-principal
     grant for `logs.<region>.amazonaws.com` (Encrypt/Decrypt/ReEncrypt/
     GenerateDataKey/Describe, scoped via an `ArnLike` condition on
     `kms:EncryptionContext:aws:logs:arn`). (The sim doesn't enforce KMS key-policy
     access control at all per sockerless#732, so this was structurally
     unexercisable before a real account existed.)
  2. **The SSH-gateway security group's `description` contained a non-ASCII em-dash**
     (`ssh-ingress.tf`), and `CreateSecurityGroup`'s `GroupDescription` is
     ASCII-only on real AWS — real AWS rejected it with
     `InvalidParameterValue: ... Character sets beyond ASCII are not supported`
     (the other three security groups in the module don't use non-ASCII characters
     in their descriptions, so this was isolated). Fixed by replacing the em-dash
     with a plain hyphen.
     Both verified via `terraform fmt`/`validate`; the KMS fix's actual effect (log
     groups creating successfully) was confirmed on the next live re-run.

- **fck-nat's default NAT instance type isn't viable on a fresh/Free-Tier-restricted
  AWS account (2026-07-05, same deploy).** `RunInstances` for the `t4g.nano` fck-nat
  instance failed with `InvalidParameterCombination: The specified instance type is
not eligible for Free Tier` — this AWS account hadn't yet graduated past AWS's
  Free-Tier EC2 instance-type restriction (the same class of account-level
  restriction that blocks Route53 Domains registration; see `DO_NEXT.md`). Not a code
  bug, but the module offered no way to override the instance type through the
  standard install path. Added `nat_instance_type` as a passthrough variable
  (`examples/complete`, default `t4g.nano` — unchanged for graduated accounts) and
  `EDD_NAT_INSTANCE_TYPE` to `install.sh` (default `t4g.nano`); this deploy uses
  `t4g.micro`, confirmed free-tier-eligible via
  `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true`
  and same Graviton family as the default, so no architecture change.

- **`scripts/install.sh`/`bootstrap-secrets.sh` had four real bugs, all found on the
  first-ever real execution of the install path (2026-07-05, right after the AWS
  account/domain decisions unblocked it).** The script had only ever been
  shellchecked/statically validated before, never actually run against real inputs, so
  all four went undetected until this exact first live run:
  1. **`install.sh`'s `missing()` helper had inverted logic.** `[ -n "$1" ] || return 0`
     returned SUCCESS when the parameter was empty (silently passing an actually-missing
     required var) and FAILURE when the parameter WAS set (aborting with
     `edd: missing required parameter edd-prod` — printing the VALUE, not even the
     name, since the value was all it was ever passed) — the exact opposite of the
     intended check. Fixed by taking `<name> <value>`, testing `[ -n "$2" ] && return 0`,
     and passing the variable name at every call site so the error message is useful.
  2. **`bootstrap-secrets.sh`'s `put_secret` raced Secrets Manager's own eventual
     consistency.** It created a secret, then immediately ran a SEPARATE
     `describe-secret --query ARN` to fetch its ARN; that follow-up call intermittently
     404'd right after a genuine successful create (reproduced live: `AUTH_SECRET`/
     `EDD_TOKEN_ENC_KEY`/`EDD_GATEWAY_SECRET` created fine, then `EDD_AGENT_SECRET`'s
     immediate re-describe 404'd — confirmed via direct `describe-secret` calls both
     immediately and well after: it never existed at that point, so the create's result
     hadn't propagated to the follow-up read yet). Fixed by removing the redundant call
     entirely — `create-secret`'s own response already includes the ARN
     (`--query ARN --output text` works on it directly), so there's no follow-up call
     left to race. Also routed the "already exists"/"created" status lines to stderr
     (they were being silently captured into the ARN variable via command substitution
     and never shown live — how the race went unnoticed for a moment).
  3. **A skipped IdP prompt could abort the whole script under `set -eu`
     (deployment-blocking for this exact GitHub-only deploy).** `read -r entra_id` with
     no env var set and no interactive TTY hits EOF, returns non-zero, and — unguarded —
     aborted the script even though the docs say "blank = skip". Separately, the final
     ARN-summary loop's last statement was `[ -n "$val" ] && printf ...`; when the LAST
     item in that fixed list (`AUTH_MICROSOFT_ENTRA_ID_SECRET`) is blank — our own exact
     case, GitHub-only, no Entra — that failing test became the whole script's exit
     status, regardless of whether everything actually succeeded. Fixed both: `read ...
|| var=""` treats EOF the same as a blank line (skip), and the summary loop uses a
     proper `if` block (which returns 0 on a false condition with no `else`) instead of
     `&&`, so the exit code no longer depends on which optional field happened to be
     listed last.
  4. **`install.sh`'s `EDD_AZS` → HCL-list `sed` pipeline always emitted an unclosed
     list.** `sed 's/,*$/,/; s/,/","/g; s/^/["/; s/,$/"]/'` first force-appends a
     trailing comma (even when one already wasn't there), then globally quotes every
     comma including that one (turning it into `","`, not a bare `,` anymore) — so the
     final `s/,$/"]/ ` has no bare trailing comma left to convert, permanently leaving
     e.g. `["eu-west-1a","eu-west-1b","` unclosed. This reached `terraform apply` as a
     literal syntax error (`Invalid multi-line string`) that cascaded into a parse
     failure on every subsequent line of the generated `install.tfvars`. Fixed with the
     simpler, correct `sed 's/,/","/g; s/^/["/; s/$/"]/'`. Verified:
     `["eu-west-1a","eu-west-1b"]`.
     All four verified live against the real AWS account (eu-west-1) mid-deploy:
     `shellcheck` clean on both scripts, a direct functional re-run of
     `bootstrap-secrets.sh` with closed stdin and no IdP env vars completes with exit 0
     and correctly reports every already-created secret's ARN, and the corrected
     `azs_list` sed pipeline produces valid HCL.

- **`pages` deploy workflow could never recover from a transient `deploy-pages`
  failure without a fresh run (2026-07-05).** The `pages` workflow's push-to-`main`
  run for PR #190 (run `28723669008`) failed with GitHub's generic
  `Deployment failed, try again later.` (no further detail; confirmed no
  githubstatus.com incident for Pages/Actions around that time, no environment/branch
  policy issue, `concurrency: {group: pages, cancel-in-progress: false}` already
  correct) — looked like a genuine one-off on GitHub's side. Re-running the failed
  `build + deploy` job to confirm surfaced a **separate, 100%-reproducible bug**:
  `actions/upload-pages-artifact@v3` has no `overwrite` input (hardcodes
  `overwrite: false` on the `actions/upload-artifact@v4` call it wraps), and GitHub
  keeps every attempt's artifact under the same run id — so the retry's fresh upload
  didn't replace attempt 1's `github-pages` artifact, it added a second one, and
  `deploy-pages@v4` then refused to pick one (`Multiple artifacts named "github-pages"
were unexpectedly found for this workflow run. Artifact count is 2.`). Confirmed via
  the Artifacts API: two non-expired `github-pages` artifacts existed under run
  `28723669008` (attempt 1's from the original failure, attempt 2's from the rerun).
  Net effect: **any** retry of this job — manual or from a future transient hiccup —
  was guaranteed to fail this way from the second attempt onward. Fixed by adding a
  step before `upload-pages-artifact` that deletes any `github-pages` artifact already
  attached to the current run id via the Artifacts REST API (`actions: write` added to
  the job's permissions). `actionlint` clean. The original attempt-1 failure's root
  cause stays an unresolved one-off (no further evidence available on our side beyond
  GitHub's own message), but the workflow no longer compounds it into a second,
  different, permanent failure on retry.

- **`examples/complete` silently dropped 6 Terraform variables the install flow depends
  on (2026-07-05).** Found while verifying `docs/install.md`/`docs/deploying.md` against
  current code ahead of a real deploy. `scripts/install.sh` writes `image_build_mode`
  into the generated `install.tfvars`, but `examples/complete/variables.tf` never
  declared that variable — `main.tf` hardcoded it to `"local"` instead, so
  `EDD_IMAGE_BUILD_MODE=codebuild|pre-published` was silently ignored (Terraform accepts
  an unused `-var-file` key with a warning, not an error). Same silent-drop for
  `golden_image_repos` (hardcoded `["omnibus", "typescript"]`, ignoring `EDD_GOLDEN`) and
  `codebuild_source_repo`/`monthly_budget_usd`/`alarm_sns_topic_arns` (not declared at
  all — `deploying.md` documents tuning the latter two, but they weren't reachable
  through the standard install path). Separately, `nat_mode`/`single_nat_gateway` were
  derived from `var.environment == "prod"` — a real footgun: naming a stack `edd-prod`
  (a perfectly normal `EDD_NAME`) would silently switch from cheap fck-nat to the AWS
  NAT Gateway. Fixed by declaring all six as first-class passthrough variables on the
  example (`nat_mode`/`single_nat_gateway` default to today's non-prod behavior —
  `instance`/`true` — with no name-based derivation; `image_build_mode` defaults
  `"local"`; `golden_image_repos` defaults `["omnibus"]`, matching `EDD_GOLDEN`'s own
  documented default; `codebuild_source_repo`/`monthly_budget_usd`/
  `alarm_sns_topic_arns` default to the module's own disabled defaults), and threading
  `scripts/install.sh` (`EDD_NAT_MODE`, validated `instance|gateway`) + updating
  `terraform.tfvars.example`/`docs/install.md` to match. `examples/complete` is only
  `terraform validate`d in CI (`terraform-sim` applies a separate fixture,
  `modules/ecs-dev-desktop/tests/sim`, not this example) — `fmt`/`validate` pass;
  real end-to-end coverage comes from actually deploying through it.

- **VS Code workspace proof (`vscode-workspace.pwvscode.ts`) keyboard-focus flake — hardened (2026-06-22).**
  The container-mode e2e tier's keyboard-driven OpenVSCode terminal proof failed once in CI ("keyboard-driven
  VS Code terminal never produced the build artifact" — the `mkdir ~/proof` keystrokes never landed across all
  retries; confirmed a non-deterministic flake: a re-run of the identical commit passed). Root cause: the test
  clicked the xterm screen ONCE before the 4-attempt retry loop, so if terminal focus drifted to another
  workbench part (the bundled chat panel / a webview) the keystrokes landed nowhere and EVERY retry was a
  silent no-op. Fixed by re-establishing terminal focus (re-clicking the xterm screen) at the start of each
  attempt and bumping the retries 4→6. Unrelated to the #150 changes; folded in per the standing
  fix-flakiness-in-the-open-PR rule. (CI-only validatable — the proof needs the golden image + browser.)

- **Third bug / spec-fidelity / fuzz sweep (2026-06-22) — parallel audit of the newest surfaces, all
  confirmed findings fixed.** Alongside the IAM-enforcement + cost-visualization threads:
  - **H1 (HIGH) — false `METRIC_RECONCILER_CONVERGE_FAILED` alarm.** `recoverErrors`/`finishDeletions` counted
    a benign version-conflict race (a non-ok `Result`) as `failed`, unlike every other sweep (which counts a
    non-ok Result as `skipped`, only a thrown error as `failed`). Gave `RecoveryResult` a `skipped` field,
    bucketed races there, routed it to `METRIC_RECONCILER_SKIPPED`. (`services/reconciler/src/index.ts`.)
  - **M1 — `storageDrift.skipped` dropped from the SKIPPED roll-up** (while `storageDrift.failed` was counted).
    Extracted both roll-ups (`run.ts`) into single source-of-truth consts so the metric + log can't diverge
    again (that divergence WAS M1), and added the missing terms incl. `deletions.failed` → CONVERGE_FAILED
    (which finishDeletions' own comments promised was alarmed but wasn't).
  - **M2 — security `privilege_attempt` metric double-counted with no audit ledger.** The retry-dedup lived
    inside the audit block but the metric ran unconditionally after. Now the metric fires only when a NEW audit
    row is created; an absent ledger fails loud (`unavailableError`) — the method can't honor its
    idempotent+auditable contract without one (production always wires it). (`workspace-service.ts`.)
  - **M3 — timeline activity-dedup used a string compare while the sort used instant compare**, fabricating a
    spurious duplicate "activity" event when `createdAt`/`lastActivity` are the same instant in different
    CloudTrail surface forms. Now dedups by parsed instant. (`observability/timeline.ts`.)
  - **L1** `tuningCount` parser for `EDD_CONVERGE_BUDGET` (a count, was parsed as ms). **L3** corrected the
    `createDynamoClient` doc (`DYNAMODB_ENDPOINT` is the only coordinate; it must NOT default to the sim when
    unset). **L4** fail-loud/early-return hardening: EMF sink throws on an unparseable clock timestamp (else
    `Timestamp: null` is silently dropped); CloudTrail `recent(≤0)` returns `[]` not an invalid `MaxResults: 0`.
  - **6 new property/fuzz files** (now 20): `iam-requirements` (fail-closed: a missing decision is a deny),
    `base-image-catalog`, `config-sync`, `health`, `stats` (conservation), `topology` (unmatched node →
    `unknown`, never fabricated `ok`).
  - **NOT a bug — M4 false positive:** the scheduler-recurrence test's `ActionAfterCompletion: "DELETE"` is
    correct/intentional — `DELETE` reaps a schedule only after it _completes_, and a recurring `rate()` with no
    end date never completes, so real AWS keeps it (the test proves the recurring schedule survives the
    more-aggressive setting). Left unchanged.

- **Second bug / spec-fidelity / fuzz sweep (2026-06-21) — 5-agent audit of the under-covered + newest
  surfaces, all fixed.** A read-only multi-agent audit (editor-proxy/custom-server, pure-core fuzz gaps,
  AWS-spec fidelity, IAM-preflight/reconciler, contracts/client/routes); fixes applied serially to avoid
  the parallel-edit stash races the first sweep hit. Every fix has a test; +3 `*.fuzz.test.ts`. Highlights:
  - **`verifyWorkspaceToken` threw instead of failing closed (HIGH).** A string-length (UTF-16 code-unit)
    guard before `timingSafeEqual` (which needs equal BYTE length) let an attacker-controlled candidate of
    the same code-unit but different byte length (a multi-byte char) make it THROW — breaking the "never
    throws → callers fail closed" contract on every machine-token trust boundary. Now compares on bytes.
  - **Reconciler convergence sweep aborted on one transient per-item error (HIGH).** The per-item loops
    (drift/storage-drift/provisioning/finish-delete/error-recover/idle/snapshot) handled a version-conflict
    Result but assumed the service never THREW; a single transient compute/DynamoDB error escaped the loop
    and skipped every later sweep step for the tick. Each loop now isolates a throw (counts `failed`, logs,
    retries next sweep); new `reconciler.converge.failed` metric.
  - **Editor proxy forwarded the Auth.js session JWT into the workspace container (MED).** The full cookie
    jar — including the portal session credential that authorizes the control-plane/admin API — was
    forwarded to the user-code-running editor upstream; `stripSessionCookie` now removes it (keeps
    `vscode-tkn`). Also: the WS-upgrade connect-timeout stayed armed post-upgrade (idle editor tunnels were
    killed) — cleared on upgrade; `getToken` `secureCookie` inferred from `AUTH_URL` scheme broke behind a
    TLS-terminating LB (login loop) — now read from the actual cookie; token redirect sets
    `Referrer-Policy: no-referrer`.
  - **`git-credential` minted a token for a `deleting` tombstone (MED).** The one secret-emitting route had
    no lifecycle gate (a lingering container mid-delete kept pulling tokens); now refuses
    `deleting`/`terminated`.
  - **AWS-spec fidelity (real-Fargate).** `runTask` ignored RunTask `failures[]` (capacity/ENI placement
    failure surfaced as a misleading "missing taskArn") — now surfaces the reason; `taskState` ignored
    DescribeTasks `failures[]` (a non-MISSING cluster/permission failure silently mapped to "stopped" and
    could tear down a live workspace) — MISSING → stopped, any other failure fails loud; `deleteVolume`/
    `deleteSnapshot` weren't idempotent (a benign already-gone delete false-alarmed `gc.failed`) — now
    swallow `Invalid{Volume,Snapshot}.NotFound`; `cost-service.replaceAll` discarded `BatchWriteItem`
    `unprocessed` (silent partial cost-row write under throttle) — now fails loud; `ssh-key-service.list`
    bare `.go()` → `pages:"all"`.
  - **Other fail-loud / fail-closed / fidelity.** `fingerprintPublicKey` accepted non-canonical base64
    (distinct strings could collide on a fingerprint) — round-trip check; timeline/audit/earliest sorted ISO
    by string (CloudTrail offset forms mis-order) — sort by instant; `parseLevel` mis-classified any line
    mentioning "error"/"warn" — anchored to a level marker token; iam-preflight read a `MissingContextValues`
    provisional allow as definitive — now fail-closed; `connect-info` parses its body through `sshConnectInfo`;
    `sessionCost.state` tightened to `workspaceState | "unknown"`.

  One item recorded as a **known limitation** (not fixed; under _Open_): `callerToPrincipalArn` can't recover
  an IAM path from an STS assumed-role ARN (degrades safely). Verified at close: `pnpm build`/`test`/`lint`
  green; control-plane + web integ green against DynamoDB Local (figure-equivalence preserved).

- **Bug / spec-fidelity / fuzz-testing sweep (2026-06-21) — property-based tests + a batch of traced
  fixes.** Added a **property-based / fuzz testing** capability (`fast-check`, 11 `*.fuzz.test.ts`) over the
  pure functions, pinning the safety-critical invariants — most importantly the **cost figure-equivalence**
  metamorphic invariant (checkpoint+resume == full-ledger derivation for any split) and **GC selection
  safety** (the orphan/snapshot selectors NEVER reap a referenced resource; monotonic in grace; never reap
  a `retained` snapshot; fail-safe on a malformed timestamp) — plus the state machine
  (transition⟺can-transition, `terminated` absorbing, every UI action → a legal transition, `planConnect`
  totality) and the security-relevant parsers (`email`/`workspaceIdFromPath`/`decideWorkspaceAccessBySubject`/
  `withinWorkspaceQuota` fail-closed + never-throw; compute-ecs, cloudwatch-logs, apps/web, auth, config
  parsers). The bugs fixed this sweep, each traced to the code, grouped:
  - **compute-ecs (data-safety / GC).** `listWorkspaceTasks` ignored `DescribeTasks` `failures[]` → a failed
    batch silently dropped tasks from the reaper's "existing" set (a true orphan could leak a Fargate task +
    EBS volume); now throws on any failure. `stopTask` wasn't idempotent → now swallows
    `ResourceNotFound`/`InvalidParameter` (task already gone), mirroring `deleteAgentSecret`.
    `taskDefinitionFamily("")` produced a degenerate `edd-ws-` colliding all empty/all-special images → now
    fails loud (surfaced by a fuzz test).
  - **cloudwatch-logs.** `read()` issued a single-page `FilterLogEvents` and dropped `nextToken` (admin log
    view silently truncated) → now paginates to a line budget (mirrors `CloudTrailAuditSource`).
  - **core (cost / fail-loud).** `relativeWindow` on negative/NaN `days` → inverted/empty window that
    silently zeroed the cost report; now fails loud. `deriveFleetAudit` with a negative `limit` sliced from
    the end (wrong feed); now fails loud. `deriveBillingIntervals`/`walkBilling` sorted timestamps by STRING
    compare (mixed ISO formats could mis-order and clamp an interval to zero, losing billable time); now
    sorts by parsed instant. The `email` smart constructor accepted C0 control chars / DEL (NUL isn't `\s`),
    branding garbage as an `Email`; now rejects control characters. The base-image catalog stored `name`
    un-trimmed; now trimmed (consistent with tags/tools).
  - **ssh-gateway (shell).** `wake-and-forward.sh` polled the full 60s deadline on a terminal wake state;
    now breaks early on error/terminated/deleting. `authorized-keys.sh` trusted the response body without
    checking HTTP status; now requires 200 (fail-closed hardening).
  - **apps/web (contract / authz / API-first).** The api-client offered `connectInfo(id, "http")` but the
    SSH-only route ignores `protocol` (would silently return sshd port 22); removed the `protocol` param
    from the client. `session.user.role` was a non-optional `Role` set only conditionally; the callback now
    always sets it (default `viewer`, least-privilege) so the type is honest. The git-credential route
    emitted an unvalidated body; added a `gitCredentialResponse` Zod contract + parse. The admin workspace
    list was un-enriched vs the enriched member list; now runs through the same `enrichWorkspace`.

  One item is **deferred** (recorded under _Open_, not fixed): the cost-model teardown-volume over-bill for
  a stopped-then-deleted workspace. Verified at close: `pnpm build`/`test`/`lint`, `check-deps`, and
  `shellcheck` all green.

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

**IAM call-time enforcement — #657 FIXED (sockerless #659) + PROVEN downstream (2026-06-22).** The sim used
to authorize every API call regardless of the caller's policy (the evaluator was wired only into the
`SimulatePrincipalPolicy` diagnostic endpoint). #659 added the IAM user/access-key/inline+managed-policy
surface (`iam_users.go`) and a request-time authorization gate (`iam_enforcement.go`) that resolves the SigV4
access-key id → registered IAM user → effective policy → evaluator, returning the per-service deny shape (EC2
`UnauthorizedOperation`, awsJson `AccessDeniedException`, other query `AccessDenied`). Backward-compatible by
design: enforcement applies ONLY to access keys that resolve to a registered IAM user, so existing tests'
dummy creds stay permissive (re-pinned to `1dc18896`; full integ tier 25/25, unchanged). We now PROVE
least-privilege denial at the sim tier — `packages/storage-ec2/src/iam-enforcement.integ.ts` self-provisions a
restricted principal via standard IAM APIs (`CreateUser`→`PutUserPolicy`→`CreateAccessKey`) and asserts the
gate is SELECTIVE: `DescribeVolumes` allowed (positive control), `CreateVolume` denied with
`UnauthorizedOperation` (negative control), then tears the principal down. Standard IAM+EC2 APIs only, no skip,
no sim branch — the same test certifies real AWS in `e2e-aws`. **Extended for condition keys via sockerless
#660** (the full real-AWS condition-operator evaluator + STS `AssumeRole`/`GetCallerIdentity`; re-pinned
`1dc18896` → `9a1d4e92`, full integ 25/25 unchanged): the test now also proves CONDITION-level enforcement —
a region-locked policy (`ec2:CreateVolume` with `Condition StringEquals aws:RequestedRegion`) allows the SAME
action in-region and denies it cross-region. Resource-scoped condition keys (`aws:ResourceTag/*`,
`ecs:cluster` — our exact design) are not yet populated by the gate; filed **#661** (see _External blockers_).

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
