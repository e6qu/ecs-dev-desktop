# WHAT_WE_DID.md — ecs-dev-desktop

> Durable decisions/lessons + a compressed milestone timeline. For the sockerless
> issue saga see `BUGS.md`. Append new entries at the bottom (past tense).

---

## Key decisions & lessons (durable)

- **Architecture (locked, `AGENTS.md` §1):** ECS Fargate; DynamoDB single-table +
  ElectroDB (over Aurora); OpenSSH + our SSH CA; identity-aware proxy + wildcard DNS (over the
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
  all fixed upstream same-day). **SSH** (standard sshd + ephemeral CA, connect-as-principal +
  authz-deny). **Pomerium** identity-aware wildcard routing (real proxy, OIDC = azure sim).
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
  verification, not a skip. SSH connect + authz-deny runs against the real OpenSSH workspace
  node. Lesson: bleephub's TLS lives in its `Server.ListenAndServe` (env
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

- **2026-06-07** — **ssh-connect.e2e.ts test 1: `-t` → `-tt`; sockerless → `9f89ae36` (PR #511 / BUG-1564).** Two fixes in one commit: (1) `ssh-connect.e2e.ts` test 1 now uses `-tt` instead of `-t` — `-t` is a soft PTY request (refused when stdin is not a terminal, as with `spawnSync` in CI); `-tt` forces PTY allocation regardless, which is the correct way to test that the workspace node accepts interactive sessions (VS Code Server terminals require PTY). This is purely standard OpenSSH sshd + our CA cert auth. (2) Submodule → `9f89ae36`: PR #511 fixes BUG-1564 (ELBv2 TG `Matcher` hardcoded to `"200"`, `ProtocolVersion`/`IpAddressType` not round-tripped, `SetIpAddressType` unregistered, LB `EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic`/`CustomerOwnedIpv4Pool` dropped). No CI assertion changes: our TG uses `matcher = "200"` (already asserted and still correct); fresh-apply idempotency clean because the sim sets the same defaults on create and read-back.

- **2026-06-07** — **Sockerless submodule → `7c812094` (PR #510); sockerless#508 closed; zero open upstream blockers; CI 14/14.** PR #510 fixed #508 (azure-sim v2.0 `userinfo_endpoint` missing — exposed by #504's issuer fix letting Pomerium reach `provider.UserInfo()`). Fix: `userinfo_endpoint` advertised in v2.0 discovery; `GET /{tenant}/v2.0/userinfo` endpoint added per OIDC Core §5.3 — RS256 bearer-token verification against the sim's signing key, 401 + `WWW-Authenticate` on missing/invalid token (no fallback identity). Tested with the real `coreos/go-oidc` `provider.UserInfo()` call — the exact Pomerium codepath. Unblocks `pomerium-authed.e2e.ts` test 1 ("completes the OIDC auth flow and proxies with X-Pomerium-Jwt-Assertion header") → `e2e` and `e2e-https` CI jobs expected fully green. PR #54 ready to merge.

- **2026-06-06** — **All 10 open sim blockers resolved upstream (PRs #463 + #466); submodule → `1859adf`; all CI assertions + idempotency checks un-gated.** Upstream merged two PRs: **PR #463** fixed #453 (DynamoDB `SSEDescription` null), #454 (ECS `deploymentConfiguration` null), #455 (EC2 `ModifySecurityGroupRules` unimplemented) + a repo-wide PM-artifact sweep. **PR #466** fixed all 7 idempotency read-back fidelity gaps: #457 (SG egress `from_port`/`to_port`=0 for ip_protocol=-1), #458 (SG ingress `referenced_security_group_id` account-prefix), #459 (NAT gateway `connectivity_type` not persisted → forced replacement), #460 (ECS task-def `healthCheck`/`secrets` dropped → forced replacement cascade), #461 (ALB `minimum_load_balancer_capacity` spurious capacity_units=0), #462 (tags not returned by `ListTagsForResource` family), #464 (ELBv2 `DescribeListeners` `Certificates` absent for HTTPS listeners). CI: restored all three idempotency checks to direct fail-fast; un-gated DynamoDB SSE (status/type/key) and ECS `deploymentCircuitBreaker` assertions; restored `CERT_ARN` via `describe-listeners`. Zero open upstream blockers.
- **2026-06-06** — **#467 filed: ECS task-def tags still empty after PR #466; idempotency re-gated.** With most drift fixed by #463+#466, the remaining `Plan: 0 to add, 3 to change, 0 to destroy` turned out to be ECS task-definition tags not returned by `DescribeTaskDefinition --include TAGS` (the TF-provider read path) even though other services from #462 are now fixed. Both task-defs show tag additions on every plan; this cascades to a spurious `aws_iam_role_policy.scheduler` re-read. Filed **#467** upstream. All three idempotency checks re-gated on #467 (exit 1 still fails; exit 2 gated). The `ECS deploymentCircuitBreaker enabled` assertion boolean case corrected to `True` (AWS CLI text-mode Python booleans).
- **2026-06-06** — **#467+#465 resolved upstream (PR #468); submodule → `3db617e`; default + DNS/TLS idempotency un-gated; 3 new fck-nat sim gaps filed (#470–#472); fck-nat idempotency re-gated.** PR #468 fixed two issues: **#467** (`DescribeTaskDefinition --include TAGS` path not implemented — tags leaked inside the `taskDefinition` object which the SDK model drops, while the TF provider reads the top-level `tags` field emitted only when `include` has `TAGS`) and **#465** (OCI `/v2/` responses missing `Docker-Distribution-Api-Version` header on non-ping routes; strict clients or proxies could reject non-tagged responses). Fix: `ECSTaskDefinition.Tags` marked `json:"-"` (internal); top-level `tags` emitted from `RegisterTaskDefinition` (always) and `DescribeTaskDefinition` (when `include=TAGS`, absent otherwise — matching real AWS). Default idempotency restored to direct fail-fast. Three new fck-nat sim bugs exposed and filed: **#470** `RunInstances` not stamping `aws:ec2launchtemplate:*` system tags (TF provider reads these to reconstruct `launch_template` block; absence → ForceNew replacement), **#471** `DescribeRouteTables` routes missing `NetworkInterfaceId`, **#472** `DescribeSecurityGroups` egress rules missing `Ipv6Ranges`. DNS/TLS exposed **#473** (`DescribeListeners` missing `SslPolicy`). Fck-nat + DNS/TLS idempotency re-gated on respective issues. **PR #475 (merged 2026-06-06) resolved all five (#469–#473); submodule → `3d457dd`. All idempotency checks un-gated and fail-fast across all three configurations; zero open upstream blockers.**
- **2026-06-06** — **VS Code distro resolved → OpenVSCode Server (MIT, Gitpod); golden image + idle-agent + real adapter wiring (PR #52).** `infra/images/workspace/`: Dockerfile (node:20-bookworm-slim + OpenVSCode Server v1.109.5, tini, workspace user, port 3000), `entrypoint.sh` (starts idle-agent background → exec openvscode-server), `idle-agent.sh` (POSTs `/heartbeat` every 120s with HMAC machine-auth token). `EcsComputeProvider.runTask` now injects `EDD_WORKSPACE_ID`, `EDD_CONTROL_PLANE_URL`, and `EDD_AGENT_TOKEN` = HMAC-SHA256(`agentSecret`, workspaceId) into every launched task via container overrides. Heartbeat route acquires a second auth path (agent bearer token) before session auth; `checkAgentAuth` uses `timingSafeEqual`; 4 new integ tests. `apps/web/lib/control-plane.ts`: `COMPUTE_PROVIDER=ecs` switches from in-process fakes to `EcsComputeProvider.fromEnv()` + `Ec2StorageProvider.fromEnv()`; fakes remain default (dev/integ). Terraform module injects `COMPUTE_PROVIDER`, `CONTROL_PLANE_URL`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `ECS_EBS_ROLE_ARN` from existing resources; `EDD_AGENT_SECRET` via `secret_environment`. `DEFAULT_WORKSPACE_MOUNT_PATH` corrected to `/home/workspace`.

- **2026-06-06** — **Phase 8C: CloudTrail audit + CloudWatch Logs adapters (PR #53).** Two new endpoint-only packages: `@edd/cloudtrail-audit` (`CloudTrailAuditSource implements AuditSource` — calls `LookupEvents`, maps to `AuditEvent` shape; integration tests in `test/`) and `@edd/cloudwatch-logs` (`CloudWatchLogSource implements LogSource` — `FilterLogEvents` on `/${appName}/{control-plane,reconciler,workspaces}`; returns `available:false` with a note when a log group is absent; exhaustive `logGroup()` switch guarded by `assertNever`; integration tests in `test/` including log-level parsing and the missing-group path). `apps/web/lib/control-plane.ts` now selects real adapters via `AUDIT_PROVIDER=cloudtrail` / `LOG_PROVIDER=cloudwatch`; `EDD_APP_NAME` required for CloudWatch. Terraform `base_environment` injects all three env vars. Both packages build and lint clean against the sim. Integration test layout follows the AWS CDK / SST / ElectroDB convention: `src/` = production code, `test/` = integration tests (not colocated). Phases 8A+8B+8C complete; Phase 8 fully closed on the sim.

- **2026-06-07** — **Sockerless submodule → `def45a1` (#495); zero open upstream blockers.** PR #495 fixed both gaps filed after the PR #491/#492 audit: **#493** cron `L`/`W`/`#` qualifiers now fully implemented (`L` last-day/Saturday, `nL` last-weekday-n, `W`/`LW` nearest-weekday, `d#n` nth-weekday) with `ValidationException` for malformed expressions instead of silent no-fire; **#494** bleephub `POST /login/oauth/access_token` now returns `application/x-www-form-urlencoded` by default (matching real GitHub) and JSON only with `Accept: application/json`. PR also swept CloudTrail eventSource mappings (all service prefixes now emit canonical `<service>.amazonaws.com`; unmapped slices log-and-skip instead of fabricating values) — no change needed in `@edd/cloudtrail-audit` since `LookupEventsCommand` is called without an EventSource filter.

- **2026-06-07** — **Sockerless submodule → `0b9af6e` (#491+#492); cron + bleephub OIDC discovery fixed.** PRs #491+#492 fixed: (1) `cron(...)` expressions never evaluated (BUG-1531) — full 6-field AWS cron in `scheduler_cron.go`; (2) `cron(N/step)` mis-parsed (#489) — `N/step` now means "N to field-max every step"; (3) bleephub `/.well-known/openid-configuration` missing `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint` (#490) — added all three plus `response_modes_supported`, `grant_types_supported`. Zero open upstream blockers.

- **2026-06-07** — **Phases 3/4/5 (sim-testable): reconciler container, authenticated proxy-pass (PR #55).** Three sim-provable capabilities added in one bundle:
  - **Phase 5 — Reconciler container:** `services/reconciler/src/run.ts` (CLI entrypoint — reads env vars, wires `EcsComputeProvider` + `Ec2StorageProvider` + `WorkspaceService`, calls `runMaintenance()`, emits JSON to stdout). `services/reconciler/Dockerfile` (multi-stage: esbuild bundles all workspace packages into a single 4.8 MB ESM `dist/run.js`; runtime image copies only `node_modules/` + the bundle). `packages/e2e/src/reconciler-container.e2e.ts`: EventBridge Scheduler `at(<now+3s>)` → ECS RunTask → reconciler container sweeps an empty DynamoDB table → stops → CloudWatch Logs contain `{"idle":{"scanned":0,...},"snapshots":...,"gc":...}`. esbuild v0.25.5 added as reconciler devDep; `onlyBuiltDependencies: [esbuild]` in `pnpm-workspace.yaml`. `packages/e2e` gained `@aws-sdk/client-scheduler` + `@aws-sdk/client-cloudwatch-logs`. CI `e2e` job builds `edd-reconciler:e2e` before harness start; passes `RECONCILER_IMAGE` env.
  - **Phase 3 — Pomerium authenticated proxy-pass:** `packages/e2e/src/pomerium-authed.e2e.ts` — HTTP client with cookie jar follows the full OIDC redirect chain (azure-sim immediately issues a code without a login form; test rewrites `azure-sim:4568` → `127.0.0.1:4568`). After authentication Pomerium proxies the workspace request with `X-Pomerium-Jwt-Assertion`; traefik/whoami echoes it back. Two assertions: (1) 200 + header present, (2) `_pomerium` session cookie set.
  - `knip.json` updated with `src/run.ts` as reconciler entry.

- **2026-06-06** — **PR #51: ~175-assertion sim probe; all assertions active.** Comprehensive CI assertion expansion (~75 new checks) covering ECS container details (essential/port/log-driver/healthCheck/env vars), ECS cluster strategy (weight/base/FARGATE_SPOT), ECS service LB binding + network, EventBridge Scheduler EcsParameters (timezone/FlexibleTimeWindow/TaskCount/network), ALB TG health-check thresholds, KMS metadata (usage/origin), CloudWatch log group names, DynamoDB GSI key schemas + projections, IAM trust policies for all 5 roles, 5 new reconciler IAM sim checks, SG rule details (source match, egress rules, VPC match), and DNS/TLS (SslPolicy, forward action, port-443 rule, ACM domain, Route53 CNAME). One false alarm: **#477** (filed then closed) — CI used `AwsvpcConfiguration` (capital A) but the wire key is `awsvpcConfiguration` (lowercase); JMESPath is case-sensitive and real AWS returns the same `None`. Not a sim bug; queries corrected; all 3 assertions now pass.

- **2026-06-07** — **Sockerless submodule → `fc03b15` (PR #500); #496/#497/#498 all fixed; zero open upstream blockers.** Three CloudTrail fidelity bugs found by reading source (all three filed with file+line evidence from `cloudtrail.go`, `scheduler_firing.go`, `main.go`), fixed upstream same day: **#496** `cloudTrailEventMatches` now handles all 8 `LookupAttribute` keys (`EventId`/`ResourceType`/`ResourceName`/`AccessKeyId`/`ReadOnly` added; unknown key raises `InvalidLookupAttributesException`; `ReadOnly` from operation verb, `AccessKeyId` from SigV4 credential, per-operation `resources[]` in new `cloudtrail_resources.go`); **#498** Scheduler API calls now recorded — each route wrapped with `schedulerRecorded`, recording against `scheduler.amazonaws.com`; **#497** Scheduler-fired `RunTask`/`SendMessage`/`Publish`/`Invoke` now recorded with `userIdentity.invokedBy = scheduler.amazonaws.com`. Un-gated: reconciler-container e2e test 3 (`it.skip` removed) + `assert_cloudtrail "Scheduler CreateSchedule"` in terraform-sim CI step.

- **2026-06-07** — **CloudTrail-based resource and functional tests; post-Terraform probes.** Extended test coverage to exercise the sockerless sim's full CloudTrail and functional layers:
  - **`@edd/cloudtrail-audit` integration tests** (new `describe` block): seeds an ECS `CreateCluster` event, then asserts `recent()` surfaces it with a non-empty target, events are ordered newest-first, and `LookupEvents` with `LookupAttributes=[{EventName=CreateCluster}]` returns only matching events (tests server-side filter path). Added `@aws-sdk/client-ecs` devDep.
  - **Workspace lifecycle → CloudTrail correlation** (new `it()` in `workspace-lifecycle.e2e.ts`): after `WorkspaceService.create()` polls CloudTrail for `RunTask`; after `service.stop()` polls for `StopTask` and `CreateSnapshot`; then verifies `CloudTrailAuditSource.recent()` surfaces all three — proving the full `WorkspaceService → ECS/EC2 → CloudTrail → AuditSource` stack end-to-end. Added `@aws-sdk/client-cloudtrail` + `@edd/cloudtrail-audit` to `@edd/e2e` deps.
  - **Reconciler → CloudTrail** (test 3 in `reconciler-container.e2e.ts`): after scheduler fires the reconciler task and it completes, polls CloudTrail for a `RunTask` event whose `Resources` include the reconciler cluster — tests whether the scheduler's internal `RunTask` call (in-process in the sim) appears in CloudTrail.
  - **terraform-sim default-stack step** gains two new sections between IAM simulation and idempotency: (1) **CloudTrail provisioning-event audit** — `assert_cloudtrail` helper queries `lookup-events --max-results 100` and filters with JMESPath; asserts `CreateTable`, `CreateCluster`, `RegisterTaskDefinition`, `CreateKey`, `CreateLogGroup`, `CreateRepository`, `CreateRole`, and `CreateSchedule` all appear post-apply; (2) **functional probes** — DynamoDB write/read/delete of a probe item against the provisioned table, CloudWatch Logs create-stream/put-event/get-event against the provisioned log group, and ECS `register-task-definition` against the provisioned cluster. If any CloudTrail or functional assertion fails it is a sim gap; will file upstream per §6.8.

- **2026-06-07** — **CI failures on PR #54 diagnosed and fixed (2 issues).** Two CI failures diagnosed and fixed before merging to `main`:
  - **vuln-scan (CRITICAL):** Trivy flagged `BLEEPHUB_ADMIN_TOKEN = "ghp_00...00"` in `ssh-connect.e2e.ts:46` as a real GitHub PAT. This token is bleephub's hardcoded simulator admin token (`store.go:580`) — not a real credential. Inline `trivy:ignore` annotations suppress misconfig findings, not secrets; correct suppression is `skip-files` on the containing file in the trivy-action config. Fixed by adding `skip-files: services/ssh-gateway/src/ssh-connect.e2e.ts` to the vuln-scan step. Filed upstream as **e6qu/sockerless#501** (non-configurable admin credentials; value matches real credential pattern); suppressed via `.trivyignore.yaml` targeted entry.
  - **terraform-sim (CreateTable not in CloudTrail):** `cloudTrailLookupEvents()` in `cloudtrail.go:280-282` hard-caps `MaxResults` at 50 (matching real AWS). Our `assert_cloudtrail` was requesting `--max-results 100` (silently capped) and filtering client-side with JMESPath. With ~80 verification API calls generating events before the assertion, `CreateTable` was pushed past position 50. Fixed by switching to server-side `--lookup-attributes AttributeKey=EventName,AttributeValue=<name> --max-results 1`, which is reliable at any event volume and valid since sockerless fc03b15 (PR #500 fixed EventName LookupAttributes support).

- **2026-06-07** — **Pomerium `pass_identity_headers: true` added to wildcard route.** Required for `X-Pomerium-Jwt-Assertion` injection (Pomerium default is false); the wildcard workspace route was missing it. Second test in `pomerium-authed.e2e.ts` passed because it only checks the auth redirect completes; the first test checks the proxied upstream body and failed without the header.

- **2026-06-07** — **azure-sim OIDC v2.0 issuer mismatch filed upstream (sockerless#504).** `simulators/azure/auth.go:147` hardcoded `issuer: "https://sts.windows.net/<tenantId>/"` for all discovery paths; the v2.0 path requires the issuer to equal the discovery URL (`<baseURL>/<tenantId>/v2.0`). Pomerium's `coreos/go-oidc` enforces this, returning HTTP 500. Filed as **e6qu/sockerless#504**. Blocked `pomerium-authed.e2e.ts` JWT assertion test until fixed upstream.

- **2026-06-07** — **SSH gateway: standard sshd + ephemeral CA; sockerless submodule → `0a383db` (PR#506).** `services/ssh-gateway`: standard `sshd` in Docker with certificate auth — `scripts/gen-ssh-ca.sh` generates an ephemeral CA; the CA pub key is mounted as `TrustedUserCAKeys`; `AuthorizedPrincipalsFile` enforces RBAC; the test signs a short-lived user cert with `ssh-keygen -s`. `ssh-connect.e2e.ts`: 2 tests — connect-as-principal + authz-deny. `Dockerfile.node`: debian+openssh-server. Also fixed upstream in PR#506: sockerless#504 (azure OIDC v2.0 discovery issuer now version-aware) and sockerless#501 (bleephub admin token now required via env var, no default).

- **2026-06-07** — **Sockerless submodule → `a00c7e07` (PRs #509 + #507); BUG-1560/BUG-1561/BUG-1562 resolved.** Two EC2/EBS fidelity PRs landed on `main` (both included at HEAD `a00c7e07`): **PR #509** (BUG-1560) — key pairs (`CreateKeyPair`/`ImportKeyPair`/`DescribeKeyPairs` with MD5 fingerprint + filters); `ModifyInstanceMetadataOptions`; LT `CreditSpecification` + `InstanceMarketOptions` (spot); `DescribeImages` filter support (synthesized deterministic image matching query attributes). **PR #507** (BUG-1561 + BUG-1562) — gp3/gp2/io1/io2 volume performance fields (IOPS/throughput/KmsKeyId/MultiAttachEnabled) now parse, store, and round-trip (`aws_ebs_volume` no longer drifts every plan); snapshot `Encrypted`/`KmsKeyId` inherited from source; `DescribeVolumes`/`DescribeSnapshots` full filter matchers (`volume-type`/`status`/`tag:`/etc.); `DescribeVolumesModifications` registered and backed by `ModifyVolume` records. No CI assertion changes needed — these fix sim fidelity without changing our assertion values. The fck-nat `data "aws_ami"` lookup and its gp3 EBS `block_device_mapping` are both now more faithful; existing assertions remain correct. Only sockerless#508 (azure-sim v2.0 `userinfo_endpoint` missing) still blocks `e2e`/`e2e-https`.

- **2026-06-08** — **Sockerless submodule → `4b8bcd9` (PR #515); reconciler-container e2e fully unblocked.** PR #515 fixed sockerless#514 and added ECS service/cluster fidelity (BUG-1567). Root cause of #514: `callJSONHandler` discarded the handler's response body+status, and `fireECSTarget` recorded CloudTrail success unconditionally — so when RunTask correctly rejected a request (e.g. an SG that didn't exist) the error vanished and the task was never launched. Fix: `callJSONHandler` returns `(status, body)`; a shared `recordSchedulerFireResult` records failures honestly with `errorCode`/`errorMessage`; valid-config happy path unchanged. Also fixed: ECS service `CreateService`/`UpdateService` now round-trip all fields (`enable_ecs_managed_tags`, `placement_constraints`, `service_connect_configuration`, etc.); `UpdateCluster`/`UpdateClusterSettings` registered. Our test was using placeholder `"subnet-placeholder"` / `"sg-placeholder"` which the sim now correctly rejects — updated `reconciler-container.e2e.ts` to create a real VPC/subnet/SG in `beforeAll` and pass those IDs. Also committed the staged reconciler esbuild ESM fix (`createRequire` banner — BUG-reconciler-build). Zero open upstream blockers.

- **2026-06-07** — **CI failures on PR #54 — round 4 (SSH CA path, terraform-sim route table count, Trivy DS-0002, knip 6.16.1, sockerless#508 filed).** Four CI failures fixed; one new external blocker found:
  - **SSH CA path mismatch (e2e + e2e-https):** `gen-ssh-ca.sh` defaulted to `temp/ssh-ca/` (repo root), but `ssh-connect.e2e.ts` resolves the CA from `process.cwd()` = `services/ssh-gateway/`, so it looked for `services/ssh-gateway/temp/ssh-ca/ca`. Fixed by changing the script default to `services/ssh-gateway/temp/ssh-ca` and updating the `docker-compose.ssh.yml` volume mount accordingly.
  - **terraform-sim route table count (default stack):** `DescribeRouteTables --filters vpc-id` returned 4 (1 VPC main/default + 1 public + 2 private) instead of 3. The sim (0a383db) now correctly models the VPC's auto-created main route table, which real AWS also includes in this query. Assertion updated from 3 to 4.
  - **Trivy DS-0002 (vuln-scan):** `Dockerfile.node` has no `USER` instruction — correct architecture: `sshd` must run as root for PAM authentication and per-session privilege separation. Added suppression to `.trivyignore.yaml` (`misconfigs: DS002, path: services/ssh-gateway/Dockerfile.node`).
  - **check-deps (knip 6.16.0 → 6.16.1):** `pnpm update --latest -r`.
  - **sockerless#508 (azure-sim v2.0 userinfo_endpoint missing — new blocker):** After the token exchange in the OAuth callback, Pomerium's go-oidc calls `provider.UserInfo()`. The v2.0 discovery document (newly correct issuer from #504 fix) is missing `userinfo_endpoint`; go-oidc returns "user info endpoint is not supported" → Pomerium returns HTTP 500. Real Azure AD v2.0 includes this endpoint. The #504 fix in PR#506 likely dropped the field when refactoring the v2.0 discovery handler. Filed upstream as **e6qu/sockerless#508**. Blocks `pomerium-authed.e2e.ts` test 1 → `e2e` and `e2e-https` jobs remain partially failing until fixed.

- **2026-06-08** — **Sockerless submodule → `cf7df7c` (PR #519); #516 follow-up VPC fidelity fixed.** Upstream merged the netns VPC fabric follow-up to PR #518. PR #518 made ECS task ENI IPs real and routable with Docker bridge networks, but Docker cannot host two bridge networks with overlapping CIDRs even though AWS allows overlapping CIDRs across isolated VPCs. PR #519 added a Linux network-namespace-per-VPC fabric (`VPC = netns`, `subnet = bridge`) for capable hosts, attaches ECS awsvpc tasks through a pause-container netns, preserves the real ENI IP with no remap, and cleans up backing fabric on `DeleteVpc`. The Docker-network tier remains for distinct CIDRs when netns capabilities are unavailable and fails loudly on overlap. Corresponding local changes were made: the container-mode sim image gained `ip`/`nft`/`nsenter`/`sysctl`, `docker-compose.e2e.yml` runs it with `pid: host`, and `packages/e2e/src/ecs-overlapping-vpc.e2e.ts` now proves overlapping-CIDR VPC isolation, same-VPC reachability, real CIDR ENI addresses, and post-`DeleteVpc` CIDR reuse through standard AWS APIs. Focused lint/type checks and the new e2e passed locally. No open sockerless blockers remained.

- **2026-06-08** — **PR #57 was opened for the sockerless #519 unblock work.** Branch `feat/sockerless-519-overlap-vpc-e2e` was pushed and PR #57 was opened against `main` with the #519 submodule pin, the container-mode netns harness changes, the overlapping-CIDR awsvpc e2e, stale-comment cleanup, and synced continuity files.

- **2026-06-08** — **PR #57 CI failures diagnosed; sockerless #521/#522 filed; upstream PR #523 opened and pinned.** CI exposed two follow-up issues after #519: netns ECS tasks could reach the simulator container but not `host.docker.internal`/DynamoDB Local endpoints, so the reconciler-container e2e failed inside the task; cleanup also sometimes returned 503 when deleting an already-absent backing route. Filed **sockerless#521** and **sockerless#522**, then opened **sockerless PR #523** (`94cd773`) with host-side nft masquerade for realexec subnet egress, `host.docker.internal` env rewriting for pause-netns ECS tasks, and tolerant route cleanup. PR #57 now pins that pushed commit. Repo CI fixes added: Trivy DS-0002 suppression for the privileged simulator image, serialized container-mode e2e files, and a same-VPC client retry loop for service readiness. Local verification passed: `@edd/e2e` lint, `@edd/e2e` typecheck, sockerless AWS/realexec Go package tests, and targeted container-mode e2e (`ecs-overlapping-vpc.e2e.ts` + `reconciler-container.e2e.ts`) with 2 files / 4 tests passing.

- **2026-06-08** — **Sockerless PR #520 merged and superseded #523; PR #57 moved to `85a62bc`.** Verified PR #520 (`aws ECS: netns metadata and route-table egress`) merged at `85a62bc` and contained the #523 host-egress/env/cleanup changes, then closed #523 as superseded and closed #521/#522 as resolved. #520 also models real route-table egress, so the reconciler-container e2e fixture was updated to provision a standard IGW + `0.0.0.0/0` main-route-table route and run the scheduled Fargate task with `AssignPublicIp=ENABLED` before it reaches simulator-adjacent endpoints. Verification against `85a62bc`: `@edd/e2e` lint, `@edd/e2e` typecheck, sockerless AWS/realexec Go package tests, and targeted container-mode e2e (`ecs-overlapping-vpc.e2e.ts` + `reconciler-container.e2e.ts`) all passed.

- **2026-06-08** — **PR #57 docs/live-simulator coverage refresh.** Reviewed stale project docs and updated them in the same PR: README status, TESTING tiers, Terraform sim apply docs, admin observability design, proxy docs, golden image docs, SSH CA path docs, and the OpenVSCode Server wording in the roadmap. Added `docs/simulator-live-coverage.md`, which records current live coverage against sockerless AWS/Azure/bleephub and the next live app-test candidates (admin routes with CloudTrail/CloudWatch adapters, portal lifecycle against container-mode ECS, browser Pomerium login, full user journey without fake compute, and Auth.js callback route coverage). Removed obsolete references to old active blockers where they no longer described current behavior. No new repo or upstream bugs were found.

- **2026-06-08** — **PR #57 e2e CI failure fixed: data-fidelity snapshot race.** CI e2e failed in `workspace-data-fidelity.e2e.ts` because the verifier task exited `2` (`grep` could not find the restored marker file). The writer task had reached `RUNNING`, then the test slept for a fixed 3 seconds before snapshotting a still-running task's retained EBS volume. Fixed the race by making the writer write + `sync` + exit cleanly, waiting for `STOPPED`, asserting exit `0`, then snapshotting the retained managed-EBS volume. Local verification against the container-mode sim passed: `pnpm --filter @edd/e2e lint` and `pnpm --filter @edd/e2e exec vitest run --config vitest.e2e.config.ts src/workspace-data-fidelity.e2e.ts src/reconciler-container.e2e.ts` (2 files / 4 tests).

- **2026-06-08** — **PR #56 and PR #57 merged; post-merge docs/live-simulator audit started locally.** Verified PR #56 merged at `2026-06-08T07:59:52Z` and PR #57 merged at `2026-06-08T17:40:55Z` (`e6af04b`). Fast-forwarded local `main` to the merge commit. Updated continuity away from "PR open" state, reviewed the docs/test surface again, and found one repo gap: the golden workspace image does not yet include `sshd`/CA principal wiring even though production SSH requires it. Recorded that as `BUG-golden-image-sshd`; no new sockerless blocker was found. No PR was opened.

- **2026-06-08** — **sockerless PR #524 merged upstream; noted as optional ECS Exec test capability.** Verified `e6qu/sockerless#524` merged at `2026-06-08T19:06:04Z` with merge commit `39a4291`. It aligns the AWS ECS simulator's `ExecuteCommand` handler with the ECS API/SDK response shape and validation. ecs-dev-desktop has no current `ExecuteCommand`/ECS Exec call sites and remains pinned to sockerless `85a62bc`, so this did not unblock an active blocker; it was recorded as a future live-test option for ECS Exec diagnostics/in-workspace probes. No PR was opened.

- **2026-06-08** — **Golden workspace SSH + live simulator follow-up prepared.** The follow-up branch pinned sockerless to PR #524 merge commit `39a4291` and added a live ECS Exec smoke test. The golden workspace image now installs OpenSSH Server, supports multi-arch OpenVSCode assets, writes the injected SSH CA and `dev-<workspaceId>` principal at startup, starts `sshd`, and runs idle-agent/OpenVSCode as `workspace`; `EcsComputeProvider` injects `EDD_SSH_CA_PUBLIC_KEY` and tests the task environment. Added live admin observability route coverage against sockerless CloudTrail/CloudWatch, made Entra e2e users/groups unique per run, made reconciler e2e resources unique per run, fixed the SSH CA generator overwrite prompt, fixed Podman-compatible host alias probing in SSH proxy e2e, built the workspace image in CI before e2e, scoped the reconciler Docker install, quieted esbuild output to real warnings, and fixed Turbo build outputs for type-check-only packages. Filed upstream **sockerless#525** (duplicate Entra UPN), **#526** (managed-EBS awsvpc task private IP unreachable from same-VPC task), and **#527** (Fargate sandbox lacks `SYS_CHROOT`, breaking OpenSSH preauth). Full e2e passed with 20 running tests and one skipped golden-image OpenSSH awsvpc assertion pending #527.

- **2026-06-08** — **PR #58 opened for the combined golden SSH/live-simulator follow-up.** Opened one PR only: <https://github.com/e6qu/ecs-dev-desktop/pull/58>.

- **2026-06-09** — **sockerless PR #529 consumed in PR #58.** Upstream merged
  `e6qu/sockerless#529` at merge commit `39d15b5`, fixing all three downstream
  blockers: #525 (duplicate Entra UPN + deterministic ROPC resolver), #526
  (managed-EBS awsvpc same-VPC private-IP reachability), and #527 (Fargate sandbox
  `SYS_CHROOT` for OpenSSH preauth chroot). The follow-up branch tested the
  submodule at `39d15b5`, moved #525/#526/#527 to resolved, and restored the golden
  workspace SSH e2e locally as an active managed-EBS `EcsComputeProvider` test instead
  of a skipped direct ECS task assertion. That immediately exposed a new simulator
  fidelity blocker, **sockerless#530**: container-mode ECS does not apply
  `RunTask.overrides.containerOverrides[].environment`, so the golden image exits
  with `EDD_WORKSPACE_ID is required`. Filed upstream and halted without a downstream
  workaround.

- **2026-06-09** — **sockerless PR #531 consumed in PR #58.** Upstream merged
  `e6qu/sockerless#531` at merge commit `dade6ca`, fixing #530 by applying standard
  ECS `RunTask` task/container overrides to runtime containers. The follow-up branch
  pinned the submodule to `dade6ca`; the restored managed-EBS golden workspace SSH e2e
  now passes locally through `EcsComputeProvider` → Fargate managed EBS → golden image
  OpenSSH → same-VPC SSH client task. No additional sockerless fidelity bug was found
  in that path.

- **2026-06-09** — **PR #58 local gates were brought back to green after #531.**
  `jscpd` aged into the dependency freshness gate, so it was updated to `5.0.4`.
  Its stricter detector pushed duplication above the 1% threshold; the e2e AWS sim
  env/client/`required`/sleep setup was extracted into `packages/e2e/src/aws-sim.ts`.
  Verification passed: `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm cpd`,
  `pnpm check-deps`, process-mode `pnpm test:integ`, and full container-mode
  `pnpm test:e2e` (including managed-EBS golden workspace SSH and ECS Exec).

- **2026-06-09** — **sockerless PR #532 was reviewed for downstream impact.**
  Upstream merged `e6qu/sockerless#532` at merge commit `638f65a`. It includes the
  prior #531 fix and adds broad simulator coverage: Azure Logic Apps/ACI, GCP
  Spanner/Dataflow/Bigtable, and AWS SDK audit-test cleanup for SSM, Glue,
  CodeBuild, Step Functions, CloudWatch Logs, SQS, and ElastiCache. The
  ecs-dev-desktop follow-up branch moved from the #531 pin to `638f65a`; no new
  app-specific simulator blocker was identified from the PR surface. Local
  verification passed against #532: `pnpm lint`, `pnpm test`, `pnpm build`,
  `pnpm cpd`, `pnpm check-deps`, `pnpm test:integ`, and full container-mode
  `pnpm test:e2e`.

- **2026-06-12** — **Test-gap closure: every seam from the coverage review got a
  real test, and the tests exposed one real product bug.** The SSH gateway's
  `wake-and-forward.sh` authenticated with a bearer token (`EDD_GATEWAY_TOKEN`)
  no control-plane code path accepted — every real gateway call would have
  401'd; the stub control plane in the proxy e2e had masked it. Fixed with
  per-workspace HMAC machine-auth (`EDD_GATEWAY_SECRET`, same scheme as the
  idle-agent), accepted by the wake routes via `loadConnectableWorkspace`
  (destructive routes stay session-only). New coverage, all green locally:
  route-level integ tests for stop/start/snapshot/connect + healthz + admin
  data routes + gateway auth; a wake-on-connect chain e2e against the REAL
  production-built control plane; the user journey rewritten to drive the real
  HTTP API with `COMPUTE_PROVIDER=ecs` on the container-mode sim (the
  in-workspace idle-agent's real heartbeats advance `lastActivity`); the
  reconciler container e2e seeding a stale real-task workspace that the sweep
  must snapshot + stop; and an Auth.js callback-route e2e driving the real
  NextAuth handlers against bleephub (team→admin) and the Azure sim (TLS leg
  in `e2e-https`). Product knobs added along the way: `ECS_ASSIGN_PUBLIC_IP`,
  `EDD_HEARTBEAT_INTERVAL_S` injection, reconciler `EDD_IDLE_THRESHOLD_MS`/
  `EDD_SNAPSHOT_INTERVAL_MS`/`EDD_GC_GRACE_MS`, `AUTH_GITHUB_URL` (GHES
  `enterprise.baseUrl`), Entra `client_secret_post` + no stock photo fetch.
  Upstream: filed sockerless#547 (azure-sim authorize not user-bound) and
  sockerless#548 (token endpoint rejects `client_secret_basic`) — fidelity
  gaps, neither blocking. Lesson: a stub of OUR OWN service in an e2e can hide
  a broken cross-service contract — point chain tests at the real component
  and keep stubs only for component isolation.

- **2026-06-12** — **sockerless PR #549 consumed (pin `777ffd3`): both same-day
  issues fixed upstream.** #547: `/authorize` honours `login_hint`, binds the
  resolved user into the auth code, and unknown hints redirect with
  `error=login_required`; #548: the token endpoint accepts
  `client_secret_basic` (we keep `client_secret_post`, MSAL's convention). The
  Auth.js callback-route e2e gained the previously-gated assertion: a
  Graph-provisioned user in a security group drives the full interactive flow
  via standard `login_hint` and lands a session with the admin role, plus the
  unknown-hint negative path. Graph provisioning was extracted to
  `apps/web/lib/test-support/entra-graph.ts` (shared with `entra-auth.e2e.ts`).

- **2026-06-12** — **LIVE portal browser e2e: the UI tier moved onto the
  container-mode path.** New `playwright.live.config.ts` + `portal-live.pwlive.ts`
  run the production build with `COMPUTE_PROVIDER=ecs`: browser
  create/stop/start/delete clicks act on real golden-image ECS tasks, and the
  admin Inspect API confirms a real task ARN, managed volume, and live-subnet
  ENI — with the wake binding a NEW task ARN and the stop snapshot recorded.
  Because Playwright launches the webServer BEFORE globalSetup (verified
  empirically), cloud provisioning lives in the webServer command:
  `start-live-app.sh` → tsx `live-cloud-setup.ts` → `temp/live-pw.env` →
  `next start`. Two stale assumptions corrected along the way (both probed,
  not assumed): current Playwright DOES transpile workspace TS imports (the
  old global-setup comment predates this), and the webServer/globalSetup
  ordering above. Shared spec helpers extracted to `apps/web/e2e/support.ts`;
  `@edd/e2e` grew `exports` for its `aws-sim`/`docker-host` harness modules.
  CI: the `e2e` job runs `test:pw:live` after the package e2e suites.

- **2026-06-12** — **Browser OIDC login through Pomerium — the last live-coverage
  candidate — landed, and the Pomerium harness moved to real TLS.** Root cause
  for why plain HTTP could never work in a browser, verified in the Pomerium
  v0.32.2 source: `urlutil.GetAbsoluteURL` unconditionally sets
  `u.Scheme = "https"`, so every sign-in/post-auth redirect is https even with
  `insecure_server` (an http authenticate URL attempt also broke the signed
  sign-in URLs — reverted). The harness now serves the gen-sim-tls-cert.sh
  cert (SANs extended with `devbox.localhost` + `*.devbox.localhost`),
  published at 8443:443; both Node suites moved to HTTPS with the CA trusted
  explicitly (shared `packages/e2e/src/pomerium-proxy.ts` transport). The new
  Chromium spec (`test:pw:pomerium`) completes gate → IdP → callback →
  workspace in one navigation, asserts the identity header at the upstream,
  the stored Secure session cookie, and session reuse with no second
  authenticate round trip. Chromium trusts the harness key via
  `--ignore-certificate-errors-spki-list` (SPKI pin of OUR CA/leaf only — any
  other untrusted cert still fails; Chromium reads no NODE_EXTRA_CA_CERTS and
  OS trust stores aren't automatable cross-platform). CI: cert generation
  moved before harness bring-up; `test:pw:pomerium` runs in the e2e job. No
  new sockerless issue: the azure-sim behaved per spec throughout. Local
  footnote: a stray pre-session `bleephub-server --addr :8443` (expired 1-day
  cert) squatted the port and was killed.

- **2026-06-12** — **Correctness-hardening pass (unhappy paths): two real bugs
  fixed, drift detection added.** A coverage review of failure modes the
  happy-path tests never reached turned up two genuine product bugs, both now
  fixed and locked with tests. (1) **Concurrent-wake task leak:**
  `WorkspaceService.persist` was an unconditional PutItem, so two simultaneous
  `connect`/`start` calls on a stopped workspace each launched a real ECS task
  and the last write won — the losers' tasks leaked (GC reaps storage, not
  tasks), and the gateway's per-connection wake plus a portal Start click make
  concurrent connects normal. Fixed with an optimistic-concurrency `version`
  field + conditional `persistTransition`; the wake loser stops its own task
  and returns the winner's state (idempotent). (2) **Quota bypass at scale:**
  `list()` read a single ≤1 MB DynamoDB page, so past that the per-owner quota
  count undercounted (bypass) and the admin list truncated — fixed with
  `pages:"all"`. Also added **drift detection** (a new feature): the reconciler
  sweeps first for tasks that died out-of-band (new `ComputeProvider.taskState`)
  and reconciles the record to `stopped`/`error` so connect-info never serves a
  dead ENI and the idle sweep never snapshots a released volume; plus
  crash-consistency compensation (stop a launched task if persist fails),
  adversarial auth tests (Pomerium forged cookie; Auth.js PKCE/replay — PKCE is
  the GitHub provider's active check, verified in @auth/core, not state;
  wrong-CA/expired SSH certs), a 64 MiB checksummed data-fidelity case, and the
  EBS adapter over the TLS aws-sim. `/security-review` on the diff: no
  HIGH/MEDIUM findings. Lesson: a stub of our OWN persistence (unconditional
  put) hid a cross-request race that only a real concurrent test surfaces — and
  pagination defaults are a silent correctness AND authz risk, not just a perf
  one. Sockerless pin bumped to #550 (`9d43f3d`); no downstream impact (bleephub
  = OAuth only), auth e2e green on it.

- **2026-06-12** — **Depth-hardening pass (authz matrices, concurrency pairs,
  GC TOCTOU, ssh-cert input): one more real bug fixed.** Following the
  races/drift pass, a review of the remaining unhappy paths surfaced a
  **delete-vs-wake task leak**: `WorkspaceService.remove()` used an
  unconditional ElectroDB `.delete()`, so a delete racing a `start`/`connect`
  could remove the record while the wake launched a task — orphaning it (the
  same class as the connect-race, but on the delete path). Fixed by making
  `remove()` version-conditioned (claim the deletion via a conditional write
  before any teardown) and deferring snapshot reaping to GC (the single storage
  reaper with a grace window), which also eliminated a snapshot-vs-wake ENOENT
  race the test first exposed. Plus: an exhaustive CASL ability matrix (every
  role × action × subject) and a route-level authorization matrix (viewer
  denied on every workspace verb, member can't mutate the catalog, unauth →
  401); concurrency-pair integ tests (stop/snapshot, stop/heartbeat, two
  snapshots, delete/wake → exactly one winner + one clean conflict, never a
  500); a GC TOCTOU test (a brand-new unreferenced volume within grace is never
  reaped); and ssh-cert input hardening (the public-key Zod contract rejects
  malformed/oversized/multi-line/unknown-type keys with 400 instead of a 500
  from ssh-keygen — no shell injection since the key is written to a file). The
  one genuine gap NOT fixed here is per-workspace proxy authorization
  (`allow_any_authenticated_user` on the wildcard route) — it needs a design
  decision (DO_NEXT #5; tracked as a known limitation in BUGS.md) because
  Pomerium can't map subdomain→owner without the control plane. Lesson: the
  version-CAS added in the prior pass made connect/start safe but the audit
  proved you must apply it to EVERY mutating path — delete had been missed.

- **2026-06-12** — \*\*End-to-end coverage pass: data durability across scale-to-zero
  - the reconciler container's drift sweep.** Two gaps the unit/component tiers
    didn't reach. (1) **Data durability through the real lifecycle**
    (`data-durability.e2e.ts`): the prior data-fidelity test proved EBS
    snapshot/restore preserves bytes using bare tasks; this proves it through
    `WorkspaceService` — SSH writes a marker+checksum into a workspace's managed
    mount, `stop()` snapshots, `connect()` wakes a NEW task hydrated from that
    snapshot, and SSH into the woken task confirms the file byte-for-byte
    (`sha256sum -c`). The headline "your work survives scale-to-zero" promise,
    observed the way a user reaches it. (2) **Containerized drift sweep\**:
    `reconciler-container.e2e.ts` now seeds a second workspace whose task is killed
    out-of-band, so the scheduler-fired reconciler *container's\* `runMaintenance`
    drift pass (not just the in-process reconciler) reconciles it to stopped.
    Shared golden-image SSH plumbing (cert signing, in-subnet client task,
    task-status polling) extracted to `golden-ssh-helpers.ts`. No product bugs
    found and no sockerless issues: the sim faithfully handled EBS snapshot/restore
    data persistence, DescribeTasks status for the killed task, and awsvpc SSH.
    (One local-only snag: a stale `edd-reconciler:e2e` image predating `detectDrift`
    made the container test fail until rebuilt — verified by rebuild; CI builds the
    image fresh each run.)

- **2026-06-12 — Per-workspace proxy authorization (decision #5; closes the last
  open `BUGS`/`DO_NEXT` item).** The Pomerium wildcard route was
  `allow_any_authenticated_user`, enforcing no per-workspace ownership. Verified
  from Pomerium v0.32.2 source that Pomerium OSS cannot call an external authz
  endpoint per request (forward-auth is deprecated; PPL/rego see only token
  claims), and that the assertion JWT sets `aud`/`iss` = the route hostname and
  carries `email`/`groups`/`sub` (`authorize/evaluator/headers_evaluator_evaluation.go`).
  Chose external-authz → control plane, realized as a PEP/PDP split: a thin
  **workspace gate** (`services/workspace-gate`) verifies nothing itself but
  forwards the assertion + host to a control-plane **PDP** (`/api/internal/authz`),
  which verifies the assertion against Pomerium's JWKS (jose; `aud`/`iss` bound to
  the host ⇒ no cross-workspace replay) and allows only the owner or an admin.
  Match key is **email** — the Auth.js portal IdP (`sub`/`oid`) and the Pomerium
  proxy IdP mint different subjects, but share email — so workspaces now record
  `ownerEmail` (`@edd/core` + `@edd/db` + create flow + `Principal.email`).
  Lesson: the literal "Pomerium calls our endpoint" isn't an OSS feature; the
  faithful realization is downstream JWT verification at a gate. Proven by core
  unit tests, the gate component test (HTTP + WS), the PDP integration test, and
  an e2e against a REAL Pomerium assertion + real JWKS. No sockerless bugs.

- **2026-06-13 — Polyglot golden image + real VS Code proof + ECS hardening.**
  Deep-audited the ECS compute service and proved the headline product works.
  ECS gaps fixed: the task definition now declares `portMappings` (OpenVSCode
  :3000 + sshd :22), supports `executionRoleArn`/`taskRoleArn` (required on real
  Fargate for private-ECR pull + awslogs), and `fromEnv` reads task sizing +
  roles (cpu/memory/volume were hardcoded to defaults in production); plus
  `awslogs-region` via `DEFAULT_AWS_REGION` and a `stopTask` reason. Remaining
  follow-ups (readiness gating, ECS `secrets` for `EDD_AGENT_TOKEN`/
  `CONNECTION_TOKEN`, real `health()`) recorded in `BUGS.md`. The golden image
  became a polyglot dev workspace out of the box — Node 22 (npm/yarn/pnpm/bun),
  C/C++, Go, Java+Maven+Gradle, Rust, Python+uv, Playwright+headless-Chromium —
  proven by a toolchain smoke test that compiles+runs each language. A Playwright
  test (`test:pw:vscode`) drives the REAL OpenVSCode workbench in a browser:
  loads it, types code in the integrated terminal, compiles, and verifies the
  ELF artifact on disk (with screenshots). Lessons: (1) corepack shims defer
  yarn/pnpm downloads to first use (break no-egress workspaces) and cache
  per-user — install real global binaries instead; (2) pnpm latest needs Node 22
  (`node:sqlite`); (3) login shells reset PATH via /etc/profile, so toolchain
  PATH needs an /etc/profile.d entry, not just ENV; (4) keep the image lean
  (headless-shell, not full Chromium) and prune the podman VM aggressively — the
  build OOM'd on a full disk from ~800 stale sim images. Image ~3 GB.
