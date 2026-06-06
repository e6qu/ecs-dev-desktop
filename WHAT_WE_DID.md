# WHAT_WE_DID.md — ecs-dev-desktop

> Durable decisions/lessons + a compressed milestone timeline. For the sockerless
> issue saga see `BUGS.md`. Append new entries at the bottom (past tense).

---

## Key decisions & lessons (durable)

- **Architecture (locked, `AGENTS.md` §1):** ECS Fargate; DynamoDB single-table +
  ElectroDB (over Aurora); Teleport SSH; identity-aware proxy + wildcard DNS (over the
  ~100-rule ALB cap); EBS-snapshot-as-persistence + scale-to-zero; Auth.js + CASL.
  Workspace runtime = **ECS-managed EBS** (compute creates/releases the task's volume;
  storage owns snapshot/restore/GC).
- **Engineering charter (`AGENTS.md` §6, CI-enforced):** strong typing + branded types;
  functional core / imperative shell; typed `@edd/config` (no magic values); fail-loudly;
  explicit named exports; SAST + Trivy; pre-commit; deps = latest ≥1-day-old.
- **Endpoint-only / swappability (HARD RULE §6.8):** the whole project — product code
  _and_ tests/fixtures — differs from real cloud by **endpoint/base-domain only**. Sim =
  sockerless from source (pinned submodule); file gaps upstream + halt, never work around.
  **Observability** follows this too: no custom audit store — derive from current state
  now, from CloudTrail/CloudWatch on AWS.
- **GC safety:** `Ec2StorageProvider` tags everything `edd:managed` and scopes enumeration
  to it — GC can never delete unmanaged EBS.
- **Lessons:** git push over HTTPS+`gh` (SSH key authed as wrong user) · TS6/pnpm needs
  explicit `@types/node` · Auth.js breaks under vitest → lazy `import("../auth")` ·
  `export *` collisions → explicit exports · ElectroDB scans need `{pages:"all"}` at 200+ ·
  Trivy secret-scans token-shaped literals → build dummies piecewise / construct in CI ·
  a sim that _accepts_ a call can still be non-conformant — audit vs the real API ·
  **browser e2e finds client/runtime bugs Node tiers can't** (unbound `fetch`, missing
  `transpilePackages`, `vitest` leaking through a public index).

## Milestone timeline (compressed)

- **2026-06-01** — Scaffold: public repo (protected `main`), `@edd/*` Turborepo, core
  state machine + ports/fakes, DynamoDB-Local harness + ElectroDB, CI + charter. Control
  plane (lifecycle API + CASL over `WorkspaceService`), Auth.js (GitHub+Entra), portal,
  reconciler idle pass.
- **2026-06-02** — **Consume sockerless from source** (submodule). Real endpoint-only
  `@edd/storage-ec2` + `@edd/compute-ecs`; evolved to the managed-EBS model; GC wired with
  managed-resource tagging. **Mock-free workspace e2e** (container-mode sim): data fidelity
  (write→snapshot→restore) + the full `WorkspaceService` lifecycle on real Fargate+EBS.
  Orphan GC + scheduled snapshots. Audited/filed the sockerless gaps (all later fixed).
- **2026-06-03** — **Mock-free auth, swappability charter.** GitHub (bleephub) + Entra
  (azure sim, standard Graph + ROPC) logins → real `normalizeClaims`+role mapping. Sharpened
  §6.8 to cover test fixtures; reworked both auth e2es to be swappable, filing/halting on
  every sim divergence (bleephub OAuth conformance, Entra provisioning, admin endpoints —
  all fixed upstream same-day). **SSH via Teleport** (real cluster, connect-as-principal +
  authz deny). **Pomerium** identity-aware wildcard routing (real proxy, OIDC = azure sim).
  **Wake-on-connect** control-plane half (`planConnect` + `connect()`, idempotent, on the sim).
- **2026-06-03/04** — **Portal features.** Base-image catalog: API (`CatalogService` CRUD +
  CASL + create-enforcement) and UI (admin page + create-from-catalog picker). **Playwright
  portal e2e** (built app, cookie dev-auth shim) — caught + fixed three browser-only bugs.
  **Activity heartbeat** (`markActivity` + `WorkspaceService.heartbeat`) completes the
  scale-to-zero input side. Designed **Phase 8 — admin console & observability**
  (`docs/admin-ui-design.md`).
- **2026-06-04** — **Phase 8 admin console (8A + 8B), mock-free.** 8A: the admin-only
  `/admin` sidebar shell, the live **Health board** (`HealthService` + real DynamoDB
  ping; providers/reconciler `unknown` until AWS), the all-workspaces table, and
  per-workspace **Inspect** (detail + bindings + snapshots + pure-derived lifecycle
  timeline). 8B: the **Overview** dashboard (`tallyWorkspaceStates`), **quotas** (per-role
  `EDD_QUOTA_<ROLE>`, pure `withinWorkspaceQuota`, create-time 409 enforcement), and the
  **Logs/Audit** screen — pure `deriveFleetAudit`/`auditToLogLines`, the
  `AuditSource`/`LogSource` ports with `DerivedAuditSource`/`DerivedLogSource` local
  adapters (audit derived from state; control-plane log stream live, reconciler/container
  streams **explicitly unavailable** until CloudWatch — no silent empties). All
  Playwright-covered. Observability stayed endpoint-only: no custom audit store; 8C swaps
  in CloudTrail/CloudWatch adapters behind the same ports.

- **2026-06-04** — **Robustness hardening pass** (no new features; AWS still gated). A
  coverage/robustness audit found one real bug: `DELETE /api/workspaces/:id` called
  `cp.remove` bare, so a concurrent double-delete (re-fetch in `remove` →
  `WorkspaceNotFoundError`) or a non-terminable state escaped as a **500**, unlike the
  sibling lifecycle routes. Fixed: the handler now maps domain errors like its siblings
  (`WorkspaceNotFoundError` → 404, others → 409). Added the missing **admin RBAC
  negative-path tests** (member/viewer → 403, unauth → 401 for all five `/api/admin/*`
  GETs), a `DELETE` route integ (owned → 204, repeat → 404, other-owner → 403), a
  control-plane assertion that `remove()` of an absent workspace rejects with
  `WorkspaceNotFoundError`, and core edge cases (orphan/snapshot selectors: empty inputs +
  the exact `>=` grace boundary; audit feed: empty input + zero limit).

- **2026-06-04** — **Hardening round 2.** Auditing whether the round-1 `DELETE` 500 was a
  one-off found the **same bug class** in the catalog: `CatalogService.update`/`remove`
  throw `BaseImageNotFoundError`, but `PATCH`/`DELETE /api/base-images/:id` mapped every
  error to 409, so editing/deleting a missing entry returned **409 instead of 404** (and,
  unlike the workspace `DELETE`, with no pre-guard it was directly reachable). Fixed both
  to map `BaseImageNotFoundError` → 404. Confirmed by audit that the remaining mutation
  routes (`connect`/`start`/`snapshot`/`stop`/`heartbeat`, base-images `POST`) already map
  domain errors uniformly. Added tests: catalog missing-entry `PATCH`/`DELETE` → 404,
  empty-body `PATCH` → 400, an exhaustive state-machine transition-matrix test (pins all
  15 permitted pairs, rejects the rest), and timeline same-timestamp / out-of-order
  sorting. core 60, web integ 24, all green.

- **2026-06-04** — **Typed error channel (Result + DomainError), part 1.** The two
  not-found mis-mapping bugs (#33, #34) shared a root cause: domain failures were thrown
  and hand-mapped to HTTP status per route via `instanceof` ladders, so a forgotten case
  was a runtime mistake. Fix is to offload it to the type system: `@edd/core` now has a
  `Result<T, E>` (errors as data, never thrown) and a `DomainError` discriminated union
  (`not_found`/`conflict`/`invalid`); the web shell has **one** exhaustive
  `Record<DomainError["kind"], number>` mapper (`domainErrorResponse`), so adding a kind
  without a status is a compile error and routes never hand-map. **Part 1** converted
  `CatalogService` (`update`/`remove`/`assertEnabled` → `Result`, dropped the
  `BaseImageNotFoundError` class) and the base-image + workspace-create routes; behaviour
  preserved (same statuses, incl. the #34 404s). Part 2 converts the workspace lifecycle
  core + `WorkspaceService` + routes + reconciler.

- **2026-06-04** — **Typed error channel, part 2 (the workspace vertical).** Completed the
  Result refactor across the lifecycle core: the state machine's `transition` and the
  workspace domain fns (`markStopped`/`markStarted`/`markActivity`/`assertTerminable`) now
  return `Result<_, DomainError>`; `WorkspaceService` (`stop`/`start`/`connect`/`heartbeat`/
  `snapshot`/`remove` + `require`) threads them and returns Result; the five workspace
  routes unwrap via the central `domainErrorResponse` mapper. Deleted the
  `InvalidTransitionError` and `WorkspaceNotFoundError` classes and every bare
  `throw new Error` in the domain/shell — domain failures are values now, so the compiler
  forces handling at each call site. The **reconciler** was the subtle bit: with `stop`/
  `snapshot` no longer throwing, a lost state race would have been silently swallowed, so
  it now **skips and counts** (`{scanned, stopped|snapshotted, skipped}`) rather than
  aborting the sweep (and one racy workspace no longer crashes maintenance). Behaviour-
  preserving (all HTTP statuses unchanged). core 68, control-plane integ 15, web integ 24,
  reconciler 7+5, Playwright 8; build + lint green.

- **2026-06-04** — **Type system does more heavy lifting (round 1): exhaustiveness +
  alignment.** Made the compiler enforce what tests were checking by string. Added
  `assertNever` (core) for `switch` exhaustiveness (`planConnect`, service `connect`).
  Replaced `tallyWorkspaceStates`'s hand-maintained `ALL_STATES` array + `as` cast with a
  `Record<WorkspaceState, number>` literal, so adding a state is a compile error (no silent
  miscount). Made `Role` a single source in `@edd/authz` (a `ROLES` tuple → derived union)
  and typed `DEFAULT_WORKSPACE_QUOTAS` as `Record<Role, number | null>` (was
  `Record<string, …>`) and `QUOTA_ROLES = ROLES` — a new/typo'd role is now a compile
  error wherever roles are enumerated. Added `expectTypeOf` contract↔domain alignment
  tests (control-plane) pinning the independently-defined Zod enums to the core unions
  (`WorkspaceState`/`HealthStatus`/`LogStream`/`LogLevel`) — type-checked by `tsc`, so they
  can't flake. (Note: kept `assertNever` out of the web client path — importing it into
  `availableActions` pulled `@edd/core` into the Turbopack client bundle; the non-`undefined`
  return type already makes that switch exhaustive.)

- **2026-06-04** — **Type system does more heavy lifting (round 2): typed test-id
  registry.** Killed the Playwright suite's flaky, copy-dependent selectors
  (`getByText("running")`, `.filter({ hasText: "control-plane" })`). Added one shared typed
  const `apps/web/lib/testids.ts` (`TESTID` + `TestId`); components render `data-testid`
  plus typed `data-*` attributes (state/status/enabled/available/event/action/stat/role),
  and the tests **locate by id, assert on the attribute** — never on rendered text. Because
  both component and test import the one const, renaming/removing an id is a compile error
  on both sides. Annotated WorkspaceCard, the catalog cards, HealthBoard, the admin
  workspaces table, Overview tiles, Inspect timeline, Logs audit/stream panels, Quotas, and
  the admin-denied gate. All 8 browser tests pass on the new selectors; build + lint green.

- **2026-06-04** — **Harness determinism (round 3): the integ suite stops racing.** The
  CI `integration` job's `dynamodb-local` service container had no health check, so
  `pnpm test:integ` could start before DynamoDB Local accepted connections — the first-run
  race that occasionally skipped/failed the suite. Added `waitForDynamo` (`@edd/db`): polls
  `ListTables` to readiness with a timeout, called at the top of `ensureTable`/`dropTable`,
  so every integ bootstrap (every package) is deterministic and a fast no-op once DynamoDB
  is up. Portable — no container health-check tooling required, same locally and in CI.
  Also added retry/backoff to the integration job's sim bring-up (registry rate-limit
  parity with the e2e/ssh jobs). Tests: `waitForDynamo` resolves against the live DB and
  throws deterministically (timeout) against a dead endpoint. db integ 5; build + lint green.

- **2026-06-04** — **Error channel reaches the UI.** The typed-error work stopped at the
  wire: the server returns `{ error: <message> }` with the right status, but `@edd/api-client`
  threw `Error("POST … failed: 409")` and discarded the body, so the portal showed a bare
  status. Added `errorResponse` (`@edd/api-contracts`) and an `ApiError` (carries the parsed
  server message + `status`); `send()` now surfaces the real reason (e.g. "workspace quota
  reached (5)") by parsing the `{ error }` body **strictly — no fallback**, so a
  contract-violating response fails loudly (§6.5). No UI change needed — `ApiError extends
Error`, so the portal's existing `e.message` shows it. api-client 4 tests; build + lint green.

- **2026-06-04** — **Dead-code + copy-paste detection (CI + pre-commit), and a dedup pass.**
  Added **knip** (unused files/exports/deps) and **jscpd** (duplication) as a `code-health`
  CI job and pre-commit hooks (`pnpm dead-code` / `pnpm cpd`; configs in `knip.json` /
  `.jscpd.json`, jscpd gated at a 1% threshold). knip found 7 dead exports — removed/unexported
  (`unauthorized`, `ownsOrAdmin`, `OwnedWorkspace`, `CatalogOption`, `FetchTeamsDeps`,
  `StatusMeta`, web `HealthStatus`). jscpd found 10 clones (1.02%); deduped to 5 (0.5%, all
  test-setup boilerplate) by: a shared `unwrap()` in `@edd/core` replacing a `val` Result-helper
  copied across 3 test files; the workspace `GET`/`DELETE` routes reusing `loadOwnedWorkspace`;
  `WorkspaceService.persist` reusing `toWorkspaceDetail` (one mapping, not two); and the
  data-fidelity e2e reusing `EcsComputeProvider.client()` instead of reimplementing it. Also
  gitignored `temp/` (local scratch, e.g. manual screenshots). All tiers green.

- **2026-06-04** — **Terraform platform module (deploy IaC) + sim-tested.** Wrote a
  reusable, parametric `infra/terraform/modules/ecs-dev-desktop` (Terraform/Terragrunt,
  no `provider` block): VPC/subnets/NAT/SGs, the DynamoDB single-table (matching
  `@edd/db`), KMS, ECR (control-plane + golden), IAM (execution, control-plane,
  reconciler, the ECS managed-EBS infrastructure role, scheduler), the ECS cluster +
  control-plane service + autoscaling, ALB + ACM/Route53 (optional), the EventBridge
  Scheduler reconciler cron, and CloudWatch logs. Plus `examples/complete`,
  `examples/terragrunt`, a full module README, and a sim-backed apply fixture
  (`tests/sim`). CI `terraform` job now `fmt -check -recursive` + validates the module and
  the complete example. **Tested against the sockerless AWS sim** (provider `endpoints` →
  sim, endpoint-only per §6.8): STS/IAM/KMS-create/EC2/DynamoDB/ECR/ELBv2/ACM/Route53/Logs/
  Secrets/ECS all apply; three operations are unimplemented and block a full apply —
  **filed `e6qu/sockerless#411`** (KMS `EnableKeyRotation`, Application Auto Scaling
  `RegisterScalableTarget`, EventBridge Scheduler `CreateSchedule`). Per §6.8 we did **not**
  branch the module around them; the full sim apply-test (a `terraform-sim` CI job) lands
  once #411 is fixed.

- **2026-06-05** — **Full non-mocked Terraform apply+destroy against the sim, in CI.** The
  `terraform-sim` job now provisions the **entire** platform stack against the from-source
  sockerless sim every PR and tears it down — `Apply complete! 55 added` → `Destroy
complete! 55 destroyed`, endpoint-only (§6.8), no module branches. Getting there was a
  four-PR onion-peel: each precise upstream filing (repro + source pointer) was fixed within
  a day and let the apply reach the next real gap — **#411→#410** (KMS rotation, App Auto
  Scaling, EventBridge Scheduler), **#413/#414→#415** (KMS tagging 10-min hang; NAT Gateway
  hang — both modeled in API-only mode), **#416/#417→#418** (DynamoDB dropped GSIs; ECS
  Service family + capacity providers unimplemented). Submodule `fed6600`→`aa33123`. Also
  added a portable `scripts/check-branch-current.sh` (branch must fast-forward into its base;
  pre-commit + CI), the optional **fck-nat** NAT-instance mode (`nat_mode`, cheap alternative
  to a managed NAT Gateway), and Trivy IaC suppressions/`TRIVY_TF_EXCLUDE_DOWNLOADED_MODULES`.
  Lesson: a TF provider lock generated by `terraform init` records only the **current
  platform's** `h1:` hash — CI on linux re-adds its hash and dirties the lock; regenerate with
  `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64
-platform=darwin_arm64` so the committed lock is complete everywhere. **All sockerless gaps
  filed are now fixed** (`BUGS.md` external blockers: none).

- **2026-06-05** — **Route-level heartbeat-on-stopped → 409 coverage.** Added
  `apps/web/app/api/workspaces/[id]/heartbeat/route.integ.ts` (DynamoDB Local): a heartbeat
  on a `running` workspace is 200, on a `stopped` one is **409** (the `markActivity` conflict
  mapped by the central `kind→status` table — never a 500), and a cross-owner heartbeat is 403. Closes the last open decision-free coverage item in `DO_NEXT`.

- **2026-06-05** — **ACM/TLS path sim-tested (round 4 of the Terraform saga).** Drove the
  module's `dns.tf` (ACM cert for `app.<domain>` + the `*.devbox.<domain>` wildcard,
  DNS-validated, fronting an HTTPS ALB listener) through the sim via a new `enable_dns`
  toggle in `tests/sim` (creates a Route53 zone + sets `domain_name`; default off so the
  always-run apply stays 55 resources). It surfaced two ACM gaps — **#421** (wildcard-SAN
  validation record name carried a literal `*` → `aws_acm_certificate_validation` rejected
  it) and **#420** (DNS-validated cert never transitioned `PENDING_VALIDATION → ISSUED` →
  the validation wait hung) — filed per §6.8 and fixed upstream by **#424**. Submodule
  `aa33123`→`e3567c7`; un-gated the DNS step so `terraform-sim` now runs **both** the default
  (`55 added → 55 destroyed`) and the DNS/TLS (`64 added → 64 destroyed`) apply+destroy every
  PR. Lesson: a wildcard SAN is the case that exposes ACM validation-record fidelity; a
  non-wildcard cert would only have hit the issuance gap.

- **2026-06-05** — **Simulators over HTTPS (TLS) — mock-free Entra auth + SSH smoke.** Added
  an `e2e-https` CI job that runs the auth + SSH paths the way real cloud does: over TLS with
  **real certificate trust** (no `--insecure`). `scripts/gen-sim-tls-cert.sh` (portable,
  shellcheck-clean) mints a self-signed CA + server cert into `temp/sim-tls` (gitignored, no
  committed key); `docker-compose.https.yml` serves all three sockerless sims over TLS —
  azure-sim + aws-sim via `SIM_TLS_CERT`/`SIM_TLS_KEY`, bleephub via `BPH_TLS_CERT`/
  `BPH_TLS_KEY` (all config-only — no upstream gaps; the Azure OIDC discovery auto-advertises
  `https://`). `@edd/config` gained an `EDD_SIM_SCHEME` switch (default `http`; `https` flips
  every sim base URL — endpoint-only, §6.8/§6.2); the client trusts the CA via
  `NODE_EXTRA_CA_CERTS`. The Entra login→group→role smoke (Graph + ROPC) passes over HTTPS and
  **fails without the CA** (`unable to verify the first certificate`) — proving real TLS
  verification, not a skip. SSH connect + authz-deny runs against the real Teleport cluster
  (already TLS). Lesson: bleephub's TLS lives in its `Server.ListenAndServe` (env
  `BPH_TLS_*`), distinct from the `simulators/*` `SIM_TLS_*` path — both reachable via env.

- **2026-06-05** — **IAM policy simulation + fck-nat ENI ops now sim-proven; submodule →
  `9e2640a`.** Three more upstream fixes landed: **#431** (closes #427) added a full IAM
  policy-evaluation engine to the sim (`SimulateCustomPolicy`/`SimulatePrincipalPolicy` —
  explicit-deny-wins, wildcard actions/resources, `StringEquals`/`ArnLike`/`Bool`/`IfExists`
  conditions, `NotAction`/`NotResource`, `MissingContextValues`); **#430** (closes #428)
  implemented standalone EC2 ENI ops (`CreateNetworkInterface`, Attach/Detach/Modify/Delete)
  which the fck-nat module needs; and **#429** fixed BUG-1470 (EC2 position-dependent filters
  — `DescribeNatGateways`/`DescribeSubnets`/`DescribeRouteTables` silently dropped any filter
  at position > 1). The `terraform-sim` CI job grew from two to **four** configurations every
  PR: (1) default stack with inline **IAM least-privilege assertions** (`simulate-principal-policy`
  between apply+destroy: `dynamodb:PutItem` allowed, `s3:GetObject` implicitly denied,
  `ec2:DeleteVolume` without `edd:managed=true` tag implicitly denied, with the tag allowed);
  (2) **fck-nat NAT instance** (`nat_mode=instance`); (3) DNS/TLS path. The module gained a
  `reconciler_task_role_arn` output. Lesson: the `aws:ResourceTag/edd:managed` condition test
  is the key least-privilege assertion for GC safety — the sim evaluator's `MissingContextValues`
  semantics (missing context → condition fails → implicit deny) match real AWS.

- **2026-06-05** — **Comprehensive sim gap audit → #434–#438 all fixed upstream in one PR
  (#440); submodule → `33b8e3d`.** Live-probed every AWS service the platform uses against the
  rebuilt sim (CloudTrail, CloudWatch Logs, SecretsManager, IAM, KMS, ECR, ECS, AppAutoScaling,
  ELBv2, EC2, SSM, STS, EventBridge Scheduler). Found five real gaps (no speculation — all
  verified with CLI repros): **#434** KMS grants + secondary crypto; **#435** ECR repository
  policy + image layer data plane (`InitiateLayerUpload`/`CompleteLayerUpload`/
  `GetDownloadUrlForLayer`, real content-addressed layer pipeline); **#436** ECS
  `DescribeCapacityProviders` + `ListTaskDefinitionFamilies`; **#437** EC2
  `DescribeInstanceTypeOfferings`; **#438** ELBv2 `CreateRule`/`DescribeRules`/`ModifyRule`/
  `DeleteRule`/`ModifyListener`. All five fixed in PR #440 (same day). The only remaining
  blocker was **#433** (EC2 LaunchTemplates — fck-nat CI step gated at the time). Lesson: a
  fresh cross-service audit finds gaps the apply-path tests miss (the apply succeeds even
  without `DescribeCapacityProviders` because Terraform's create path doesn't read back
  capacity providers; the read gap only surfaces on `plan` after `apply`).
- **2026-06-05** — **#433 (EC2 LaunchTemplates) fixed upstream by PR #439; fck-nat CI step
  un-gated.** `CreateLaunchTemplate`/`DescribeLaunchTemplates`/`DescribeLaunchTemplateVersions`/
  `DeleteLaunchTemplate` all implemented in `ec2_launch_template.go` (`registerEC2LaunchTemplates`
  wired into `registerEC2`). Live-probed all four ops — returned correct `lt-…` IDs and version
  numbers.
- **2026-06-05** — **Comprehensive sim probe → 7 new gaps filed (#441–#447); CI enhanced
  with 47-assertion post-apply verification suite.** Systematically probed all 12+ AWS
  services the platform uses against the live sim after a full `terraform apply`, checking
  every resource the module creates. Found and filed: **#441** IAM `ListPolicyVersions`
  unimplemented (blocks fck-nat `aws_iam_policy` destroy — re-gated CI step); **#442** EC2
  `DescribeVpcs` filtering completely broken (vpc-id, tag, and `--vpc-ids` all return wrong
  results; `CidrBlockAssociationSet` always null); **#443** EC2 `DescribeSecurityGroups`
  filters return ALL SGs regardless of value (group-name, vpc-id ignored); **#444** ECR
  `imageScanningConfiguration.scanOnPush` and `encryptionConfiguration` silently dropped on
  create; **#445** CloudWatch Logs `CreateLogGroup --kms-key-id` accepted but not persisted;
  **#446** ECS `DescribeClusters --include SETTINGS CONFIGURATIONS` returns null for both
  `containerInsights` and `executeCommandConfiguration`; **#447** IAM `ListRoles` returns
  `InvalidAction`. CI now runs a 47-check `assert_eq` suite (DynamoDB/KMS/ECR/ECS/
  AppAutoScaling/EventBridge/CloudWatch/ALB/IAM/networking) + 4 IAM simulation checks +
  idempotency (`terraform plan -detailed-exitcode` = 0) on the default stack, and HTTPS
  listener + ACM cert + idempotency on the DNS/TLS stack. Assertions for the 7 open gaps
  are gated with issue references. Module gains `alb_security_group_id` and
  `tasks_security_group_id` outputs; provider constraint updated to `~> 6.0`.

- **2026-06-06** — **All 7 sim gaps resolved upstream (PRs #448+#449); fck-nat step
  live again; 10 new assertions added; 4 active CI configurations.** Upstream merged
  **#448** (ECR `scanOnPush`/`encryptionConfiguration` — #444) and **#449** (IAM
  `ListPolicyVersions` — #441; EC2 `DescribeVpcs` multi-id + tag filters +
  `CidrBlockAssociationSet` — #442; EC2 `DescribeSecurityGroups` vpc-id/group-name/group-id
  filters — #443; CloudWatch Logs `kmsKeyId` persisted — #445; ECS `DescribeClusters
--include SETTINGS/CONFIGURATIONS` — #446; IAM `ListRoles` — #447). Submodule bumped
  `33b8e3d`→`b174425`. CI changes: (1) un-gated the **fck-nat** step (was gated on #441
  since prior session); (2) added 10 new `assert_eq` checks replacing the 7 gated comments
  — ECR scan-on-push + KMS encryption type, ECS containerInsights + executeCommand KMS key,
  CW Logs kmsKeyId, IAM `list-roles` count — bringing the default-stack verification to
  **57 assertions**; (3) `terraform-sim` now runs **four active** configurations every PR
  (default 57-check, fck-nat, DNS/TLS). No open upstream blockers remain.

- **2026-06-06** — **Second comprehensive sim probe → ~100-assertion CI verification suite;
  3 new gaps filed (#453–#455).** Live-probed every AWS service and every resource attribute
  the module creates (KMS alias; ECR imageTagMutability+kmsKey for all repos; ECS task-def
  cpu/memory/networkMode + service desiredCount+assignPublicIp; AppAutoScaling min/max+CPU
  target; Scheduler expression+retry; CW Logs retention+kmsKeyId for all 3 groups; ALB
  health-check path+matcher+drop-invalid-headers; IAM all managed+inline policies; VPC
  CIDR/DNS attrs; EIP; route table IGW+NAT routes; SG rules/ports/VPC; DynamoDB schema+GSIs+
  PITR; Route53 A records; ACM cert type+SANs+validation method) and all 11 IAM sim checks
  (ecs:RunTask cluster-scoped allow/deny, ecs:RegisterTaskDefinition with cluster context,
  logs:PutLogEvents owned/foreign, cloudtrail:LookupEvents, iam:PassRole to ecs-tasks).
  Found 3 new sim gaps: **#453** DynamoDB `SSEDescription` null (server_side_encryption not
  reflected in DescribeTable); **#454** ECS `deploymentConfiguration` null (deploymentCircuit-
  Breaker not stored in CreateService); **#455** EC2 `ModifySecurityGroupRules` unimplemented
  (in-place SG rule update path, called by TF provider v6). Two CI assertions gated on #453
  and #454; #455 does not block CI (fresh apply always uses Authorize/Revoke, not Modify).
  Default-stack suite: 57 → ~100 assertions. DNS/TLS step gains ACM type+SANs+method and
  Route53 A record existence checks.

- **2026-06-06** — **Sockerless submodule bumped to `8e866c3` (PR #456 — OCI `/v2/` data plane).** Upstream merged a shared OCI Distribution `/v2/` Docker Registry library wired into all three cloud sims (ECR #450, GCP Artifact Registry #451, Azure ACR #452). Fixes: `GET /v2/` base, chunked blob upload (POST → PATCH → PUT with sha256 verification), blob/manifest GET/HEAD/PUT/DELETE/tags, and `OnManifestPut` hook so a pushed image appears in the ECR control plane. Also bundled: delete-by-digest alias cleanup; a `requireNetworkHost` gate for Compute/Network tests off-Linux; EventGrid CLI test fixed (no longer skipped). No CI changes — these gaps were not in our tracked blockers and the sim-apply path doesn't push/pull images. Our three open blockers (#453 DynamoDB SSE, #454 ECS deploymentConfig, #455 ModifySecurityGroupRules) remain unchanged.

- **2026-06-06** — **Idempotency failures analysed → 6 new sim bugs filed (#457–#462); idempotency checks gated; Node deps updated.** The `terraform-sim` CI `terraform plan -detailed-exitcode` (idempotency check) returned exit 2 (Plan: 2 to add, 17 to change, 2 to destroy) on every PR due to six distinct sim root bugs: **#457** EC2 SG egress rules store `FromPort=0/ToPort=0` for `ip_protocol=-1` instead of null; **#458** SG ingress `ReferencedGroupInfo.GroupId` returned as `"accountId/sg-id"` instead of bare SG ID; **#459** `DescribeNatGateways` omits `ConnectivityType` → TF forces NAT gateway replacement every plan (cascading to private routes); **#460** `DescribeTaskDefinition` drops `healthCheck` and `secrets` from container definitions → forces new task-def revision every plan (cascading to ECS service and IAM inline policies); **#461** `DescribeLoadBalancerAttributes` returns `minimum_load_balancer_capacity.capacity_units=0` for ALBs without minimum capacity; **#462** `ListTagsForResource`/`ListTagsOfResource`/`ListTagsLogGroup` return empty for CloudWatch Logs, DynamoDB, ECR, and ECS task definitions (9 resources show spurious tag additions). All six filed upstream per §6.8. All three idempotency checks (default, fck-nat, DNS/TLS) now gate exit 2 (drift) while still failing on exit 1 (real errors). Also ran `pnpm update --latest -r` to fix the `check-deps` CI failure (stale Node/TS deps).

- **2026-06-06** — **DNS/TLS step exposes #464; cert ARN query rerouted via `list-certificates`.** With idempotency gated (prior commit), the DNS/TLS step ran for the first time and failed: `DescribeListeners` doesn't include `Certificates` for HTTPS listeners, so `CERT_ARN` resolved to `"None"` → ParamValidation. Filed **#464** upstream. The cert IS issued (apply completes via `aws_acm_certificate_validation`), so assertions about cert properties now obtain the ARN via `acm list-certificates` (standard API, not sim-specific). The listener-to-cert association check is gated (#464). Total open upstream blockers: 10 (#453–#455, #457–#462, #464).

<!-- Append new milestones below. -->

- **2026-06-06** — **All 10 open sim blockers resolved upstream (PRs #463 + #466); submodule → `1859adf`; all CI assertions + idempotency checks un-gated.** Upstream merged two PRs: **PR #463** fixed #453 (DynamoDB `SSEDescription` null), #454 (ECS `deploymentConfiguration` null), #455 (EC2 `ModifySecurityGroupRules` unimplemented) + a repo-wide PM-artifact sweep. **PR #466** fixed all 7 idempotency read-back fidelity gaps: #457 (SG egress `from_port`/`to_port`=0 for ip_protocol=-1), #458 (SG ingress `referenced_security_group_id` account-prefix), #459 (NAT gateway `connectivity_type` not persisted → forced replacement), #460 (ECS task-def `healthCheck`/`secrets` dropped → forced replacement cascade), #461 (ALB `minimum_load_balancer_capacity` spurious capacity_units=0), #462 (tags not returned by `ListTagsForResource` family), #464 (ELBv2 `DescribeListeners` `Certificates` absent for HTTPS listeners). CI: restored all three idempotency checks to direct fail-fast; un-gated DynamoDB SSE (status/type/key) and ECS `deploymentCircuitBreaker` assertions; restored `CERT_ARN` via `describe-listeners`. Zero open upstream blockers.
- **2026-06-06** — **#467 filed: ECS task-def tags still empty after PR #466; idempotency re-gated.** With most drift fixed by #463+#466, the remaining `Plan: 0 to add, 3 to change, 0 to destroy` turned out to be ECS task-definition tags not returned by `DescribeTaskDefinition --include TAGS` (the TF-provider read path) even though other services from #462 are now fixed. Both task-defs show tag additions on every plan; this cascades to a spurious `aws_iam_role_policy.scheduler` re-read. Filed **#467** upstream. All three idempotency checks re-gated on #467 (exit 1 still fails; exit 2 gated). The `ECS deploymentCircuitBreaker enabled` assertion boolean case corrected to `True` (AWS CLI text-mode Python booleans).
- **2026-06-06** — **#467+#465 resolved upstream (PR #468); submodule → `3db617e`; default + DNS/TLS idempotency un-gated; 3 new fck-nat sim gaps filed (#470–#472); fck-nat idempotency re-gated.** PR #468 fixed two issues: **#467** (`DescribeTaskDefinition --include TAGS` path not implemented — tags leaked inside the `taskDefinition` object which the SDK model drops, while the TF provider reads the top-level `tags` field emitted only when `include` has `TAGS`) and **#465** (OCI `/v2/` responses missing `Docker-Distribution-Api-Version` header on non-ping routes; strict clients or proxies could reject non-tagged responses). Fix: `ECSTaskDefinition.Tags` marked `json:"-"` (internal); top-level `tags` emitted from `RegisterTaskDefinition` (always) and `DescribeTaskDefinition` (when `include=TAGS`, absent otherwise — matching real AWS). Default idempotency restored to direct fail-fast. Three new fck-nat sim bugs exposed and filed: **#470** `DescribeInstances` missing `LaunchTemplateSpecification` (ForceNew replacement cascade), **#471** `DescribeRouteTables` route entries missing `NetworkInterfaceId`, **#472** `DescribeSecurityGroups` egress rules missing `Ipv6Ranges`. Fck-nat idempotency re-gated on #470–#472. DNS/TLS idempotency separately exposed **#473** (`DescribeListeners` missing `SslPolicy` for HTTPS listeners) and re-gated. Default idempotency unaffected by all four.
