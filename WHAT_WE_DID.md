# WHAT_WE_DID.md — ecs-dev-desktop

> Durable decisions/lessons + a compressed milestone timeline. For the sockerless
> issue saga see `BUGS.md`. Append new entries at the bottom (past tense).

---

## Key decisions & lessons (durable)

- **Architecture (locked, `AGENTS.md` §1):** ECS Fargate; DynamoDB single-table +
  ElectroDB (over Aurora); OpenSSH registered-key auth (no CA — dual-trust via
  `ssh-authorize`); identity-aware proxy + wildcard DNS (over the
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

- **2026-06-13 — Core user loop (sessions = control plane + users + admins +
  multiple sessions, one repo per session).** On `feat/vscode-workspace-proof`
  (PR #69). Repo-per-session: clone on first boot (public proven). Private
  clone+push via AES-256-GCM token-crypto + per-owner gitCredential store +
  GitHub token captured at sign-in + an agent-only broker
  (`/api/workspaces/:id/git-credential`) + an in-image git credential helper —
  token never on the EBS volume, in task metadata, or the browser. Wake-on-connect
  gate: resolves each workspace's live ENI via `connect-info?protocol=http`
  (gateway HMAC), wakes scaled-to-zero sessions, proxies HTTP+WS; one gate fronts
  all workspaces (Pomerium static upstream); OpenVSCode `--without-connection-token`
  for the gated deployment. GitHub launcher: GitProvider (repos / namespaces with
  permission flags / create) + `/api/github/*` routes + the `/sessions/new` UI
  (search → start; create repo default-private, grayed out with the reason when
  not permitted; blank session). Decisions: OAuth-token clone behind a GitProvider
  abstraction (GitHub App later); gate-is-the-auth. Lessons: Semgrep flags
  hex-literal test secrets (use randomBytes) and GCM without authTagLength; see
  [[sast-and-precommit-gotchas]]. Increment-2 deployment wiring (Pomerium→gate +
  browser e2e) and audit-log + cost-viz tracks remain.

- **2026-06-13 — First-class audit log (PR #70, merged).** Append-only,
  actor-attributed `auditEvent` entity + `StoredAuditSource`; the admin feed
  merged the stored log with the derived fleet feed, each source degrading to `[]`
  on error (logged) so one failing source never blanks the feed.

- **2026-06-13 — Cost visualization** (on `feat/cost-visualization`). The
  remaining item of "admins + costs + audit". Decisions (asked): run-time is
  **derived from the audit ledger** (over an accumulator); pricing defaults to
  **us-east-1 on-demand, env-overridable**. Because an audit-derived cost model
  needs a _complete_ ledger, lifecycle audit was **centralized in
  `WorkspaceService`** — it now records `session.create/start/stop/delete` on the
  _actual_ state transition (so gate-wakes via `connect()` and reconciler-driven
  scale-to-zero/drift stops are captured exactly once, with no flood on idempotent
  reconnects); the route-level emits were removed and the actor threaded through
  (`system` for machine/reconciler). The audit sink was wired into both
  composition roots (web `getControlPlane` + reconciler `run.ts`). Cost is a pure
  `@edd/core` model (`deriveBillingIntervals` → `priceIntervals` →
  `computeFleetCost`): compute = Fargate vCPU+memory while running; volume = live
  EBS gp3 while running; snapshot = EBS snapshot while scaled-to-zero (730-h
  month). Rates/sizing live in `@edd/config` (`workspacePricing`/`workspaceSizing`,
  the latter tracking the same `ECS_*` provisioning env). `CostService` joins the
  ledger with current records (owner from the `session.create` actor, so deleted
  workspaces still price), behind `/api/admin/costs` + an `/admin/costs` page
  (fleet tiles + per-user + per-session). Lesson: the gate calls `POST /connect`
  per request, so emitting on transitions (not per-call) is what avoids a flood.
  **Accuracy + live (user follow-up: "must be accurate, not an MVP compromise;
  visible asap, near real time").** Emission was made **atomic** with the
  transition — each lifecycle event is written in the SAME DynamoDB transaction
  as its state change (`@edd/db` `writeTransaction` → ElectroDB
  `createWriteTransaction`; a canceled transaction maps to the existing
  version-conflict handling), so a billable event can never be dropped or
  double-written (proven by `cost-ledger-atomicity.integ.ts`); deleted workspaces
  still price because the ledger is append-only. **Live**: a running session's
  open interval is priced to `now` on each fetch and the page auto-refreshes
  (`LiveRefresh`, 15 s). Remaining (perf only, not accuracy): the report scans the
  whole ledger per request — a `byTime`-windowed query + rollups would flatten
  latency at large scale (`BUGS.md` → Open).

- **2026-06-13 — GitHub App provider + the "Coordinates, not targets" principle**
  (on `feat/github-app-provider`). Introduced a `GitProvider` seam: the existing
  user-OAuth GitHub functions became `UserOAuthGitProvider`; added
  `InstallationGitProvider` (RS256 app-JWT via `jose` → installation token → REST,
  token cached to expiry). `getGitProvider` selects by config; the repos/namespaces
  routes + the clone/push broker use it (broker scopes the installation token by
  the repo's owner). The credential is wire-identical (`x-access-token`), so the
  in-image helper is unchanged. **New HARD RULE §6.9 "Coordinates, not targets — the
  simulators do not exist"** (`AGENTS.md`): to the app + tests there is no
  sim-vs-real branch anywhere; only coordinates (endpoints, credentials, resource
  ids) point at a target, reached through standard APIs only (never a sim's
  `/internal`). The App e2e (`github-app.e2e.ts`) is purely coordinate-driven — it
  reads the App id + key + org/repo + base URL from env and **skips** when absent;
  it has no notion of bleephub. Lesson (the user drove this hard): my first cut
  embedded bleephub's `/internal/apps` setup IN the test — that broke real-GitHub
  targeting AND made the test sim-aware. The fix was NOT "move the `/internal` setup
  to a harness" (still sim-internal) but to drop sim-internal use entirely: take
  coordinates from env, skip without them, and **file the sim gap upstream** —
  bleephub can't seed a pre-registered App with a caller-supplied key via standard
  config (**sockerless#559**), so CI can't supply sim App coordinates yet; the e2e
  runs against real GitHub when secrets are provided, unit tests cover the rest.

- **2026-06-13 — Coordinate purity: the simulators are nameless** (on
  `feat/coordinate-purity`, stacked on the App PR). Enforcing §6.9 repo-wide: the
  sim-named coordinate constants in `@edd/config` were renamed to generic role
  coordinates — `awsSim→aws`, `bleephub→github`, `entraSim→entra`,
  `dynamodbLocal→dynamodb`, `ENTRA_SIM_TENANT→ENTRA_TENANT` (pure rename; values +
  shapes unchanged, defaults still the local harness, overridable by the standard
  env coordinate). The interactive-login harness `test-support/bleephub-oauth.ts`
  → `github-oauth.ts` with its `bleephub*`/`Bleephub*` helpers → `github*`/`Github*`.
  ~44 files migrated; a pure symbol rename, so `tsc` build + type-aware lint across
  the monorepo validate every reference (16/16 build, 17/17 lint, 29/29 unit, knip
  clean, jscpd 0.96%). Result: no app or test symbol is named after a sim — only
  coordinates remain. Audit confirmed product logic was already branch-free; the
  only residue was these names. Minor follow-ups (harness-only, noted in DO_NEXT):
  the `EDD_SIM_SCHEME` env knob and a couple of harness file names
  (`packages/e2e/src/aws-sim.ts`, compose service names) still say "sim" — infra,
  not app/test logic.

- **2026-06-13 — Sim-probe coverage + a §6.9 workaround removed** (on
  `feat/sim-probe-coverage`). (1) `Ec2StorageProvider` dropped its client-side
  `isManaged` re-filter — a target-specific workaround ("the sim ignores Filters")
  that violated §6.8/§6.9; enumeration now relies solely on the server-side `tag:`
  Filters, which real AWS honours and the sim honours too (verified in the sim
  source: `ec2VolumeMatchesFilters`/`ec2SnapshotMatchesFilters` → `ec2TagFilterMatch`,
  the #507 fix). (2) `observability-live.integ.ts` now exercises the real EBS
  adapter (`createVolume`+`createSnapshot`, coordinate-only) and asserts the
  CloudTrail-backed feed captures those actual `CreateVolume`/`CreateSnapshot` ops —
  previously only a bare `CreateCluster` was asserted. If CI shows the sim doesn't
  record a standard op, that's a coordinate-level divergence to file upstream
  (e6qu/sockerless), not work around. Remaining Track C probes (ECS Exec real
  session, EBS snapshot-chain edge cases) + Track A (live Pomerium→gate→ECS) remain.

- **2026-06-14 — Local dev/test made simple + self-reaping; docs cross-linked.**
  A developer can now `pnpm dev` (one command: reap prior state → DynamoDB Local →
  idempotent table/catalog bootstrap → `next dev` with dev-auth, on :3000). Tiers
  via `docker-compose.dev.yml` profiles + coordinate env: local fakes / `+github`
  (bleephub OAuth) / `+aws` (sockerless AWS adapters) / `+entra`. Every local
  command **reaps prior harness state first** (`scripts/reap-local.sh` →
  `docker compose down --remove-orphans -v` across the project), so a stale or
  half-created run never blocks the next: `pnpm dev`, `pnpm test:integ:local`,
  `pnpm test:e2e:local`, `pnpm reap`. New `docs/running-locally.md` (tier matrix,
  dev-auth, deployment pointer) + README **Running locally** + **Deploying**
  sections, all cross-linked (README ↔ running-locally ↔ TESTING ↔ terraform).
  Fixed `.gitignore`: `next-env.d.ts` is generated (and differs between
  `dev`/`build`, so a committed copy churns) and isn't needed for lint/tsc —
  untracked + ignored per Next convention.

- **2026-06-14 — Live per-workspace authz: browser → Pomerium → gate (PEP) → PDP
  (increment-2 / DO_NEXT #5).** Proved the proxy-authz decision _where it ships_,
  not just in-process. Added a control-plane Docker image (`apps/web/Dockerfile`,
  `next start` on :3700) so the PDP runs in-network, and `docker-compose.gate.yml`:
  Pomerium routes the wildcard `*.devbox.localhost` through the **workspace-gate
  container** (`infra/proxy/pomerium-gate.yaml`, `preserve_host_header`) → the PDP
  container (assertion vs Pomerium's JWKS, fetched via a `health.devbox.localhost`
  network alias over trusted-CA TLS + ownership from the DynamoDB record) → an echo
  upstream. A real-browser suite (`workspace-gate.pwgate.ts`, `test:pw:gate`, CI
  `e2e-gate`) asserts owner→200 (assertion injected) and same-user-non-owner→403.
  Lessons: (1) a real PDP bug — the proxy preserves the original `Host` (the
  harness's `:8443`; any non-443 proxy port in prod) but Pomerium binds the
  assertion `aud`/`iss` to the bare hostname, so the PDP must authorize on the
  port-stripped hostname (regression test added). (2) the gate `Dockerfile` never
  copied `@edd/core` (imported by the dynamic upstream resolver) — undetected
  because the gate image had never been built in CI; now built by `e2e-gate`.
  Standardized the local app port off the crowded 3000 → 3700 (image + `pnpm dev`
  - docs). Built per the user's fat-PR directive (one PR, held until CI green).

- **2026-06-14 — Sim-probe coverage: multi-generation EBS snapshot chain.** Added a
  probe (`packages/storage-ec2/src/ec2-storage.integ.ts`) for the repeated
  scale-to-zero persistence loop: snapshot a volume that was itself hydrated from the
  previous generation's snapshot, twice, asserting per-generation snapshot→source
  lineage (not collapsing to the original) and restore-from-a-restored-snapshot. The
  sim handles it correctly (green) → no upstream gap to file. Confirmed the §6.9
  storage-filter comment is current (the stale client-side-refilter workaround was
  already removed in #74), so nothing stale to fix. Decision-free ECS hardening
  (runTask readiness gating; agent secret → ECS `secrets`; real `health()`) remains
  in `BUGS.md` → Open as the next follow-ups — deliberately not bundled here (a
  behavior change, not a probe).

- **2026-06-14 — ECS `runTask` readiness gating.** Closed the impactful reliability
  gap from the 2026-06-13 audit: `EcsComputeProvider.runTask` now returns only once
  the task is READY — a pure `taskReady(task)` predicate (`lastStatus` RUNNING +
  managed-EBS volume attached + ENI private IP assigned) — instead of returning at
  PROVISIONING/PENDING as soon as the volume id appeared. `WorkspaceService` thus no
  longer reports `running` / hands out `sshHost`+connect-info for a task that can't
  yet accept connections (the race callers used to absorb with retries). Verified the
  sim's transition from source (PROVISIONING→PENDING→RUNNING with attachments
  ATTACHED) before gating on RUNNING so the heavy container-mode e2e wouldn't hang;
  unit-tested the predicate; timeout raised to 180s for real Fargate cold start.
  Endpoint-only. Remaining ECS follow-ups (agent secret → ECS `secrets`; real
  `health()`) stay in `BUGS.md` → Open.

- **2026-06-14 — ECS hardening sweep (health, exec, agent-token secrets).** Cleared
  the remaining Open compute items from the 2026-06-13 audit:
  - **Agent token → Secrets Manager (security).** `runTask` now stores the
    per-workspace HMAC agent token in a Secrets Manager secret and references it
    from a per-workspace task def's container `secrets`, instead of plaintext
    `environment` (visible in DescribeTasks/CloudTrail). ECS resolves it into the
    container env at launch — transparent to the in-workspace agent. Active when an
    agent secret + Secrets Manager client are configured (`fromEnv` wires both);
    plaintext path kept only for local/fakes. Proven against the container-mode sim
    (`agent-secret.e2e.ts`) + the user-journey heartbeat (functional).
  - **Real `EcsComputeProvider.health()`** via DescribeClusters (process-mode integ).
  - **ECS Exec on the launch path** (`enableExecuteCommand: true`).
  - Found + filed **sockerless#569**: process-mode RunTask with managed EBS panics
    the sim (nil Docker client) — so the runTask/secret path is validated in
    container mode, not the process-mode `integration` job.
    Deferred: cost-report rollups (explicitly perf-only, must not change figures — a
    sizable subsystem left as a follow-up) and `CONNECTION_TOKEN` injection (lands
    with the future DYNAMIC wake-on-connect gate it's tied to).

- **2026-06-14 — Cost report O(history) → O(recent) via figure-exact rollups.**
  The admin Costs report priced the whole audit ledger each request. Added pure
  checkpoint primitives (`deriveBillingState`/`resumeBilling`): price a workspace by
  resuming a persisted billing checkpoint and replaying only the events since it.
  Their combination equals the full `deriveBillingIntervals` for ANY checkpoint (46
  equivalence cases); `priceIntervals`→`priceDurations` and a shared canonical-order
  `aggregateFleetCost` make the full-scan and rollup paths sum to identical floats.
  Plumbing: a `costRollup` entity (reuses GSI1 — no table change) +
  `StoredCostRollupStore`; `CostService.rollup()` regenerates checkpoints (admin
  trigger `POST /api/admin/costs/rollup`); `report()` uses them when present, else
  the exact full scan; `StoredAuditSource.since()` is the byTime tail. Proven
  byte-identical to the full scan against DynamoDB Local
  (`cost-rollup-equivalence.integ.ts`) across a checkpoint mid-open-interval, a
  terminate after it, a terminate before it, and a workspace born after it.
  Pricing remains the AWS on-demand model (us-east-1 rates, env-overridable); live
  Price List API rate sourcing (real-AWS-only to validate) is the next follow-up.

- **2026-06-14 — AWS pricing model: live region-accurate rates (Price List API).**
  Accurate costing now sources rates directly from AWS's published prices:
  `apps/web/lib/aws-pricing.ts` queries the AWS Price List API
  (`pricing:GetProducts`) for the deployment's region (Fargate vCPU/GB-hr, EBS gp3
  GB-mo, snapshot GB-mo), classifying rows by `usagetype`. Opt-in (`EDD_AWS_PRICING=1`)
  and best-effort: each rate falls back per-rate to the configured `@edd/config`
  value (us-east-1 default, `EDD_PRICE_*`-overridable), so a missing/denied API or
  unexpected product shape never mis-prices — it degrades to the documented rate.
  The pure parser (`parseOnDemandUsd`/`parseUsageType`) is unit-tested against a
  recorded GetProducts shape; the live fetch has no simulator (no Pricing API), so
  it is validated against real AWS (`e2e-aws`) while CI uses the safe fallback. The
  pricing formula is unchanged.

- **2026-06-14 — ECS Exec data-channel command proof.** Upgraded the container-mode
  ECS Exec e2e from a response-shape smoke test to an executed-command proof. The
  test opened the `ExecuteCommand` session's SSM WebSocket, sent the standard
  token-bearing `OpenDataChannel` handshake, and asserted a unique marker command's
  output arrived in the streamed AgentMessage frames. The test consumed only AWS
  response coordinates and standard wire behavior, so it remained target-agnostic;
  the simulator matched the real client path and no upstream gap was found.

- **2026-06-14 — AWS SDK retry hardening (concurrent wake-on-connect).** The
  `concurrent-connect` e2e issues N simultaneous `/connect`s, each waking via
  `RunTask`, so several concurrent `RunTask`s hit the platform at once. The
  control-plane AWS clients ran on the SDK default retry (`standard`, 3 attempts),
  so a transient `RunTask` 5xx/throttle under that burst could exhaust retries and
  surface as an uncaught 500 — failing the strict idempotent-200 assertion. Since
  `RunTask` throttles in real AWS too, the fix is real-cloud-correct rather than a
  sim workaround (§6.8): ECS, Secrets Manager, and EC2 clients now use
  `retryMode: "adaptive"` + `maxAttempts: 6` (named in `@edd/config`). The race
  test stays strict — no assertion was weakened.

- **2026-06-14 — Docs review + launch-readiness audit.** Reviewed every doc for
  accuracy and cross-linking via a parallel audit (local-run, deployment,
  observability, cross-links). Made the docs navigable and correct: surfaced the
  orphaned `admin-ui-design` / `infra/images` / `infra/proxy` /
  `services/ssh-gateway` READMEs in the README index; wrote a full AWS deployment
  runbook (`docs/deploying.md`) correcting the prior gaps (the two real images —
  control-plane app image + golden, not a phantom reconciler/ssh-proxy image; every
  operator-supplied secret incl. the missing `EDD_SSH_CA_KEY_PATH` and the
  `EDD_ADMIN_GROUPS` admin-bootstrap footgun; remote state, ECR login, two-phase
  apply, base-image seeding, Pomerium/gate); and made the `running-locally` tier
  commands actually runnable (`+ AWS` requires `ECS_SUBNETS`/`ECS_EBS_ROLE_ARN`;
  OIDC tiers require the Auth.js secrets). Inventoried the
  logs/health/status/metrics/testing gaps in `docs/observability-gaps.md`
  (top: real `/api/healthz` readiness, structured logging, a metrics layer,
  CloudTrail pagination). Fixed one gap inline: added a live
  `Ec2StorageProvider.health()` (`DescribeAvailabilityZones`), verified against the
  sim — storage previously reported `unknown` on the Health board even on AWS (the
  same inverted contract just closed for compute).

- **2026-06-14 — Observability layer (readiness, logging, metrics, alarms,
  audit pagination).** Acting on the gap audit (and the user's "go big" choice),
  closed the headline launch-readiness gaps in one pass: (1) `/api/readyz`, a real
  DynamoDB-backed readiness probe wired to the ALB target group, split from
  `/api/healthz` liveness (the ECS container restart probe) — an unhealthy task is
  pulled from the LB rather than killed; (2) a structured JSON logger in `@edd/core`
  (`createLogger`/`formatLogLine`, writer injected so the core stays pure) used by
  the control plane (replacing ad-hoc `console.*`) and the reconciler (per-sweep +
  error lines); (3) a metrics port `MetricSink` (+ `NoopMetricSink`/
  `InMemoryMetricSink`) with a CloudWatch EMF-over-stdout adapter
  (`@edd/cloudwatch-metrics`), emitting wake-on-connect cold-start latency
  (`WorkspaceService.start`) and reconciler action/failure counts, plus CloudWatch
  alarms (`alarms.tf`, gated `enable_metric_alarms` — off for the sim, which has no
  metrics endpoint); (4) CloudTrail audit pagination (`NextToken` to the limit, was
  first-page-only). Everything is coordinate-driven (EMF/alarms on real AWS, no-op
  locally — §6.8) and unit/integ-tested; remaining gaps tracked in
  `docs/observability-gaps.md`.

- **2026-06-14 — Observability completion (the rest of the gaps, one PR).** Closed
  every actionable item left in `docs/observability-gaps.md`: (1) **API request
  metrics + access logging** — a `withObservability` HOF (latency/status/error +
  structured access log via the `MetricSink` + logger; injectable deps, unit-tested)
  wrapped across all ~22 business API routes (probes/auth excluded); (2) **fleet +
  cost gauges** — the reconciler emits `fleet.workspaces.{total,running,stopped,
active}` (via `tallyWorkspaceStates` over the full list) and a priced
  `fleet.cost.usd` (a config-rate `CostService`) each sweep, best-effort;
  (3) **reconciler health** — a `makeReconcilerHeartbeatEntity` singleton the
  reconciler stamps per sweep, read by `HealthService` via the pure
  `reconcilerHealthFromHeartbeat` (stale > `DEFAULT_RECONCILER_STALE_MS` → degraded;
  no record → unknown), replacing the hardcoded `unknown`; (4) **per-workspace log
  view** — `LogSource.read(stream, {taskId})` threads through the CloudWatch adapter
  (narrows the shared workspaces group to `workspace/<container>/<taskId>`), the
  admin Logs route + UI (`?workspaceId=`), and the api-client; the awslogs
  stream-prefix is now a named `@edd/config` constant shared with the compute
  provider; (5) **SSH CA key material** — `caKeyPath()` accepts `EDD_SSH_CA_KEY`
  (materialized to a 0600 temp file) as well as `EDD_SSH_CA_KEY_PATH`, so the CA
  private key is delivered via Secrets Manager (the secure default, never in
  Terraform state); `docs/deploying.md` Step 4 updated. The only substantial item
  left is `e2e-aws` — external, blocked on the AWS-account decision.

- **2026-06-14 — Local dev login UI (seeded users, config-driven) + `edd.localhost`.**
  Replaced the hand-edit-cookies dev-auth flow with a real `/login` form (gated on
  `EDD_DEV_AUTH=1`): pick a seeded account + password, a server action sets host-only
  `edd-dev-*` cookies + redirects (admin → /admin/overview, else /workspaces), and a
  dev-aware sign-out clears them (Auth.js `signOut` would not). The accounts are
  **configuration, not app code**: `@edd/config` `devUsers()` parses `EDD_DEV_USERS`
  (JSON, zod-validated) with a built-in default set, and `devPassword()`
  (`EDD_DEV_PASSWORD`, default `dev`; per-account `password` overrides). Served via
  `edd.localhost:3700` (browsers resolve `*.localhost` → 127.0.0.1) with host-only
  cookies so other localhost apps are unaffected. Playwright `e2e/login.pw.ts` signs
  in via the form as admin/member/viewer and asserts role-appropriate access,
  wrong-password rejection, and sign-out. Fixed `pnpm reap` (it left profile-scoped
  sim containers running — `down` without `--profile`); added a reusable
  `pnpm --filter @edd/web screenshot` dev aid. Verified live against the sockerless
  `+AWS` tier (login form → admin console; storage/compute/reconciler health real;
  structured access logs streaming).

- **2026-06-15 — Wake-on-connect: claim-before-launch (kills the thundering herd).**
  Root-cause fix for the recurring `concurrent-connect` e2e flake (surfaced again on
  this PR's CI). The wake path now persists the `stopped → provisioning` claim with
  the optimistic-version CAS BEFORE launching, so a burst of connects starts exactly
  ONE task (the claim winner); losers `awaitWoken` until it reaches running.
  Two-phase domain core: `markWaking` (stopped→provisioning) + `markProvisioned`
  (provisioning→running), replacing the single `markStarted`; a new
  `provisioning → stopped` transition lets a failed launch roll the claim back
  (workspace stays wake-able). `start()` stays a strict transition (start-while-
  running is still a conflict); `connect()` owns the idempotent race handling
  (re-dispatch + wait-out in-flight provisioning). Crash-consistency reworked: a
  write failure on the claim leaks nothing (no task yet); a failure on the
  post-launch commit stops the task and rolls back. Deterministically proven in the
  integ tier (N concurrent wakes → one launch, all running — 10/10) plus the
  rewritten crash + state-machine/domain unit tests; the container `concurrent-connect`
  e2e exercises it for real in CI.

- **2026-06-15 — Docs accuracy pass (run-everywhere: local options + cloud module).**
  A read-only audit (local-run + Terraform-deploy) drove targeted fixes so the docs
  show how to run the app across the spectrum: README now has a run-options table
  (local fakes → local sims → cloud Terraform) and uses `edd.localhost`;
  `running-locally.md` gained the missing `+ Entra` command + its HTTPS-callback
  caveat; `deploying.md` split the env into `secret_environment` (auth/crypto/SSH-CA)
  vs `extra_environment` (RBAC groups, AUTH_TRUST_HOST, base domain, JWKS), corrected
  the FARGATE-Spot wording and `golden_repository_urls` output name, and kept the
  `EDD_SSH_CA_KEY` material default; the module README inputs/outputs tables gained
  the three alarm vars + five missing outputs; `variables.tf`'s `secret_environment`
  description now lists the full secret set; and `examples/complete` now wires
  `extra_environment` (so `EDD_ADMIN_GROUPS` — required for any admin — is settable)
  with a fuller `terraform.tfvars.example`. `terraform fmt`/`validate` clean.

- **2026-06-15 — Provisioning failure is a handled 503, not an on-purpose 500.**
  A workspace create against a backend with no ECS cluster threw "Cluster not found"
  → framework 500 (empty body) → browser "Unexpected end of JSON input". Reframed as
  a handled condition end-to-end: a new `unavailable` domain error (→ 503) + a typed
  `ComputeUnavailableError` thrown by `WorkspaceService.create()` (route maps to 503);
  `start()` returns `unavailable` and rolls the wake claim back; `withObservability`
  observes-and-re-raises so only genuinely-unexpected errors are 500s; the api-client
  tolerates an empty/non-JSON error body. `dev-bootstrap` seeds the full golden
  catalog. Principle recorded: **a handled error is by definition not a 500.** (Full
  create against the process-mode sim still blocks on sockerless#569 — managed-EBS;
  the `+AWS` dev tier is for adapter call-shapes, not end-to-end create.)

- **2026-06-15 — Admin Infrastructure view (cluster + status + metrics + topology).**
  New `/admin/infrastructure` aggregating, in one round trip: dependency status
  checks (reusing the Health board), the live ECS cluster (new `ClusterInfo` port
  method — `EcsComputeProvider.clusterInfo()` over DescribeClusters; the fake reports
  its in-memory equivalent, no fabricated cloud metrics), fleet metrics, and the
  **component/network topology**. The topology is the locked architecture as a pure
  node/edge graph in `@edd/core` (`SYSTEM_TOPOLOGY` + `overlayTopologyHealth`): a
  static deployment fact with live health overlaid on each node — boundary/dynamic
  nodes report `unknown`, never a fabricated `ok`. Shell = `InfrastructureService`;
  contracts + `adminInfrastructure()` client method; route, page, nav entry, testids.
  Refactored the live-view polling into a shared `usePoll` hook + `HealthRows`/
  `HealthHead` components (DRY — kept jscpd under threshold). Tested at every layer:
  core topology + fake-cluster unit tests, `InfrastructureService` unit tests,
  contracts parse test, compute-ecs `clusterInfo` integ vs the live sockerless sim,
  and Playwright (admin sees cluster + topology with live status; non-admin denied).

- **2026-06-15 — End-to-end live IDE flow proven + tested in CI on Linux and macOS.**
  Stood up the full stack on the container-mode sim with a real ECS cluster and
  proved "create a workspace and open its IDE": the control plane runs a real ECS
  task (managed EBS + awsvpc ENI; container mode is unaffected by sockerless#569),
  and the **actual OpenVSCode workbench** is reachable in a browser through a new
  IDE bridge (`packages/e2e/src/ide-bridge.ts`). The sim isolates each task's awsvpc
  netns (not attached to any host-reachable Docker network — peer tasks reach it
  in-network), so the bridge tunnels host → `docker exec` → the task netns →
  `127.0.0.1:3000` and extracts the per-boot `--connection-token`; it is the
  local/sim realisation of the production identity-aware-proxy reach (the
  CONNECTION_TOKEN handoff remains the future product extension). New
  `live-ide-flow.e2e.ts` asserts the whole path (create → 403 token gate → 200
  workbench with `vscode-workbench-web-configuration` + the bridge as
  `remoteAuthority`); `live-sim-run.ts` became a one-command interactive harness
  (auto-create + bridge, prints web + IDE URLs). CI: the e2e runs every PR in the
  Linux `e2e` job; a gated **`e2e-flow-macos`** job (macos-14 + colima Docker;
  `workflow_dispatch` or the `ci:macos` PR label, to bound expensive macOS minutes)
  runs the identical flow on macOS. Lessons: (1) the harness and the web app must
  share ONE DynamoDB endpoint — `configureAwsSimEnv` sets `AWS_ENDPOINT_URL` (the
  sim's own DynamoDB) but not `DYNAMODB_ENDPOINT`, so a harness that doesn't pin
  `DYNAMODB_ENDPOINT` writes the table to the sim while the app reads DynamoDB-Local
  (empty → 503); (2) sim task containers are reaped after a few idle minutes —
  irrelevant to the fast e2e, flagged for the focused sim-fidelity pass.

- **2026-06-15 — Golden-image workspace UX: user-installable CLIs + Dark mode (#90/#91/#94).**
  Hands-on workspace testing surfaced that a fresh workspace was hard to use from the
  in-browser terminal. Fixed in `infra/images/workspace`: (1) npm's global prefix now
  points at a HOME dir (`NPM_CONFIG_PREFIX=/home/workspace/.npm-global`, set after the
  system `npm i -g`s so yarn/pnpm/playwright stay in `/usr/local`), so the non-root
  `workspace` user can `npm install -g` without the old `/usr/local` EACCES (#90);
  (2) the user-CLI bin dirs (`~/.npm-global/bin`, `~/.local/bin`) are on PATH across
  the whole shell matrix — image `ENV` (non-login `bash -c` / agent subprocesses),
  `/etc/profile.d` (login terminal), and sshd `SetEnv PATH` (the `ssh host '<cmd>'`
  exec channel that sources no profile) (#91); (3) the editor defaults to Dark mode,
  seeded write-if-absent **in the entrypoint on first boot** — build-time seeding is
  shadowed because the EBS home volume mounts over `/home/workspace` (#94). Key nuance
  recorded: anything under `$HOME` baked at image build is shadowed by the volume mount,
  so home-resident defaults must be seeded at first boot (entrypoint) or live in a
  system path. New `workspace-toolchain.e2e.ts` assertions (npm prefix writable; PATH on
  login + non-login + sshd config; dark settings) — 10/10 green; workbench still serves.
  Decided the **golden-image collection** direction (base/omnibus + per-language slims);
  these fixes move into the shared `base` in the follow-up split (see `DO_NEXT.md`).

- **2026-06-15 — Golden-image collection: base/omnibus split (PR B).** Refactored the
  single workspace image into a shared `infra/images/base` (OpenVSCode Server, sshd +
  SSH CA, idle-agent, entrypoint, git-credential broker, `workspace` user, Node 22,
  and the #90/#91/#94 user-CLI + dark-mode fixes — deliberately NO compilers/language
  toolchains) plus `infra/images/omnibus` (`FROM base` + the full polyglot toolchain),
  which reproduces the previous image and stays tagged `edd-workspace:e2e` so every
  suite keeps working. Variants build `FROM base` via a `BASE` build-arg. PATH is made
  composable through per-image drop-ins each variant overwrites: `/etc/profile.d/edd-path.sh`
  (login shells) and an sshd `SetEnv` drop-in under `/etc/ssh/sshd_config.d/` (the
  ssh-exec channel; base sshd_config now `Include`s the dir). Lesson: the base sets a
  HOME npm prefix via `NPM_CONFIG_PREFIX`, which omnibus INHERITS — so build-time system
  `npm install -g` (yarn/pnpm/playwright, incl. `npx`) must `export NPM_CONFIG_PREFIX=/usr/local`
  for those steps, or they install under `$HOME` (and a home-cleanup step then deletes
  them). Updated the build everywhere (CI `e2e` + `macos-images` jobs, `scripts/test-e2e.sh`,
  `TESTING.md`), the Trivy DS-0002 paths, and `infra/images/README.md` (collection doc).
  Verified: base + omnibus build; `workspace-toolchain.e2e.ts` 10/10; live-IDE-flow e2e
  green against the split. Per-language slim variants (typescript/python/go/java/rust)
  and layered #93/#95 tooling are the follow-ups (`DO_NEXT.md`).

- **2026-06-15 — Golden-image collection: slim per-language variants (PR C).** Added five
  lean variants `FROM base` — `infra/images/{typescript,python,go,java,rust}` — each with
  only its toolchain (build-essential only where needed: ts native addons, python wheels,
  go cgo, rust linker). Sizes ~0.95–1.4 GB vs omnibus 3.04 GB (base 605 MB). Each variant
  overwrites the PATH drop-ins (`/etc/profile.d/edd-path.sh` + the sshd `SetEnv` drop-in)
  ONLY when its tools land off the base PATH (go → /usr/local/go + GOPATH/bin; java →
  /opt/gradle; rust → /opt/rust/cargo) — typescript/python tools live in /usr/local/bin
  or /usr/bin, already on the base PATH. `dev-bootstrap` now seeds the whole collection
  (omnibus + 5 variants) into the catalog. New `packages/e2e/src/image-variants.e2e.ts`
  (parametrised over the variants) proves each: its toolchain present, the shared base
  behaviour intact (#90 npm prefix writable, #91 user-CLI PATH, #94 dark mode, Node), and
  it is **slim** (the other languages are absent) — 5/5 green. A path-gated
  `.github/workflows/golden-images.yml` (triggers only on `infra/images/**` /
  the variant test) builds base + all variants and runs the smoke test, so the heavy
  variant builds don't burden the always-on `e2e` job. Gotcha: in zsh the brace-less
  `"edd-ws-$v:e2e"` tag mangled to `edd-ws-2e` — use `${v}`. Follow-up: PR D layers the
  agent extensions (#93) into base + curated tooling (#95) per image.

- **2026-06-16 — Golden-image collection: AI agents + curated dev tooling (PR D; #93 + #95; merged #103).**
  Completed the collection. `base` now bakes the AI coding agents (Claude Code + Codex
  VS Code extensions + the `claude` CLI) and the cross-cutting JS/TS tooling matching CI
  (prettier/eslint/knip/jscpd + the prettier/eslint/GitHub extensions). Each variant adds
  its language tooling + extensions — python (ruff/ty/vulture/bandit/semgrep + Python/Ruff/
  ty/basedpyright/Semgrep exts), go (golangci-lint + golang.go), java (redhat.java), rust
  (clippy/rustfmt + rust-analyzer); omnibus carries all. Mechanism: VS Code extensions
  can't be baked into the EBS-shadowed home extensions dir, so they're installed into
  OpenVSCode's **built-in** extensions dir (`/opt/openvscode-server/extensions`) at build —
  loaded read-only with **no runtime copy** and surviving the mount; users still install
  their own into the volume dir. (First tried a first-boot copy from a system cache, but
  copying ~1 GB of agent extensions slowed task startup and caused live-sim timing failures
  in `live-ide-flow` (token race) + `user-journey` (concurrent-update races) — the built-in
  dir avoids the copy entirely; the IDE bridge also now retries token extraction since a
  task is ECS-RUNNING before OpenVSCode execs.) Dev-tool CLIs install to system paths (`uv`
  UV_TOOL_BIN_DIR=/usr/local/bin; `go install` GOBIN=/usr/local/bin) so they survive the
  mount; the go module/build cache is cleaned to avoid ~2 GB bloat.
  Lessons: (1) OpenVSCode Server defaults to **Open VSX** — `--install-extension <id>` works
  with no gallery config (the README's claim was true only by luck; now relied on). (2) The
  base sets a home `NPM_CONFIG_PREFIX`, so base's OWN system `npm i -g` must run BEFORE that
  ENV (lands in /usr/local). (3) `semgrep --version` SIGILLs (exit 132) on some arm64 hosts
  but runs on amd64 — build + tests verify semgrep via `command -v` (no native run). Verified:
  all 7 images build; `image-variants.e2e.ts` 5/5, `workspace-toolchain.e2e.ts` 12/12. Size
  cost: the baked agents (~1 GB native) live in base → every variant carries them (ts ~2 GB
  … omnibus ~5.7 GB) — flagged for a possible opt-in/omnibus-only move. Closes the
  golden-image collection plan (PRs A–D).
- **2026-06-16 — Golden-image fuller per-language dev tooling (#95 follow-ons; merged #104).** Rounded
  out the curated dev-tooling set so a workspace matches CI out of the box. Added: the
  cross-cutting **Trivy** security scanner to **base** (the repo's own CI gate tool, so a
  workspace scans its deps/IaC/secrets exactly as CI does — single static binary to
  /usr/local/bin, vuln DB fetched lazily at first scan; language-agnostic → base, every
  variant inherits it); the Go dead-code/CPD/static-analysis set \*\*staticcheck + deadcode
  - dupl** alongside golangci-lint in **go**+**omnibus** (`go install` → GOBIN=/usr/local/bin,
    one cache clean after); and **cargo-audit** (Rust SCA against the RustSec advisory DB)
    in **rust**+**omnibus** (`cargo install --locked`, registry dropped after). Tests:
    `image-variants.e2e.ts` (go asserts staticcheck/deadcode/dupl via `command -v` for the
    ones with no `--version`; rust asserts cargo-audit; the shared base-behaviour block
    asserts trivy on every variant) + `workspace-toolchain.e2e.ts` (omnibus asserts all).
    Lessons: `deadcode`/`dupl` have no `--version` (no-arg form exits non-zero) → verify with
    `command -v`; `cargo audit --version` prints `cargo-audit-audit <ver>` → match `/audit \d/`.
    Remaining gap flagged: **Java** still has no standalone formatter/linter CLI (JDK/Maven/
    Gradle + redhat.java only) — a follow-up (e.g. google-java-format). Also **re-pinned the
    sockerless submodule\*\* `1ca1f71 → c69cd27`, picking up #569 (process-mode managed-EBS
    RunTask panic fix) + later Azure/GCP/GitLab cells (no AWS-surface impact).
- **2026-06-16 — Golden-image follow-ups: Java formatter + agents omnibus-only (merged #105).** Closed the
  two follow-ups flagged after #104. (1) **Java formatter** — added `google-java-format` (the
  de-facto Java formatter) to **java**+**omnibus** as a JAR under `/opt` + a `/usr/local/bin`
  wrapper (`java -jar`), so every language variant now ships a format CLI. Version resolved via
  the github.com `releases/latest` **redirect** (the release-page URL carries the tag), NOT
  api.github.com — the JSON API's low unauthenticated rate limit 403'd mid-build (flaky in CI
  too). (2) **Agents omnibus-only** — moved the AI agents (Claude Code + Codex extensions + the
  `claude` CLI, ~1 GB native binaries) OUT of **base** into **omnibus only**. Slim variants now
  drop ~1 GB each (base ~1.8→0.9 GB, typescript →1.3, go →1.5, java →1.7, rust →1.8, python
  →2.7); a slim-variant user who wants the agents installs them at runtime via the user-CLI
  path (#90/#91 — npm global prefix in HOME + PATH). Tests: `image-variants.e2e.ts` now asserts
  agents are ABSENT from every slim variant (omnibus-only) + java carries google-java-format;
  `workspace-toolchain.e2e.ts` keeps the omnibus agent assertions (now genuinely omnibus-sourced)
  - adds google-java-format. Lesson reaffirmed: the local podman legacy-build cache reuses layers
    built on a prior base even after the base changes — variants must be rebuilt `--no-cache` when
    the base content changes (CI is unaffected: fresh runner, base built once, variants layer on it).
    Verified locally: base agentless (0.89 GB, no `claude`); all 5 variants 5/5 (agents absent,
    java google-java-format 1.35.0).
- **2026-06-16 — Catalog metadata picker + admin UX cleanup landed.** Base-image catalog
  entries now carry structured `tags` + `tools` metadata end to end (core domain, API
  contracts, Dynamo entity/service, admin form, dev-bootstrap defaults), and the
  new-session launcher now renders a card-based environment picker that surfaces the
  metadata instead of a bare select. The same pass also cleaned up the broader portal IA:
  catalog management moved under the admin shell at **`/admin/catalog`** and `/base-images`
  now redirects there; top-level navigation gained active-state location awareness; the
  competing inline workspace creator was removed from `/workspaces` so session creation is
  unified around `/sessions/new`; workspace/admin lists and inspect views now show catalog
  display names + richer environment context instead of mostly opaque ids/image refs; the
  catalog-management form was labeled/grouped like an operator surface; and responsive CSS
  improved the admin shell, timeline, audit feed, and data-row behavior on narrower widths.
  Two unrelated but live defects were fixed proactively in the same change set: (1)
  `apps/web` no longer depends on `next/font/google`, so `pnpm --filter @edd/web build`
  succeeds without outbound network access and now uses local/fallback font-family CSS
  variables; (2) `waitForDynamo()` now fails before Vitest's hook timeout with an explicit
  endpoint-bearing error, so an absent local DynamoDB no longer surfaces as opaque
  `Hook timed out in 30000ms` noise. Verification: `@edd/core` catalog unit tests green;
  `@edd/{api-contracts,db,core,control-plane}` builds green;
  `@edd/{db,core,control-plane,web}` lint green; `@edd/web` type-check and production build
  green; targeted `@edd/web` base-image integ green against real local DynamoDB; targeted
  control-plane integ green; full portal Playwright suite green **13/13** (including the
  admin-catalog route and legacy redirect). Notes: Playwright still emitted external
  Node/tooling warnings about `module.register()` deprecation and `NO_COLOR` vs
  `FORCE_COLOR`; they were traced to the toolchain, not repo code.
- **2026-06-16 — Dependency freshness follow-up after the UX pass.** The PR's `check-deps`
  job later failed because the repo's age-gated freshness policy had moved underneath the
  branch: `vitest` was one patch behind (`4.1.8 → 4.1.9`) and `@playwright/test` was one
  minor behind (`1.60.0 → 1.61.0`). Refreshed both manifests and `pnpm-lock.yaml`, then
  re-ran `pnpm check-deps` successfully. Verification on the updated dependency set:
  representative Vitest target green (`packages/core` catalog tests) and the full portal
  Playwright suite green **13/13** after installing the matching Chromium `v1228` browser
  payload locally. The recurring `NO_COLOR` vs `FORCE_COLOR` warnings still came from the
  Node/Playwright launcher stack rather than repo code.
- **2026-06-16 — Live portal Playwright spec updated for the merged session launcher.**
  The container-mode CI e2e `apps/web/e2e/portal-live.pwlive.ts` was still automating the
  removed `/workspaces` inline creator (`select.select` + `+ new workspace`), so the job
  timed out waiting for a control that no longer existed after the catalog/admin UX merge.
  Updated the spec to use the current `/sessions/new` flow: pick the catalog card by
  `TESTID.catalogPickerOption`, launch via `blank session`, then assert the redirect back
  to `/workspaces` before continuing the real ECS stop/wake/delete lifecycle checks.
  Local verification: `pnpm --filter @edd/web exec tsc -p tsconfig.json --noEmit` green and
  the standard portal Playwright suite green **13/13**. The full live harness remained
  CI-only in this shell, but the failure mode was a stale selector, not a compute-path bug.
- **2026-06-16 — sockerless#569 confirmed fixed downstream; the integration-tier
  follow-up was retired as misframed.** The `BUGS.md` follow-up asked to "re-enable a
  process-mode managed-EBS `RunTask` in the lightweight `integration` job" to confirm the
  #569 panic fix. Brought up the re-pinned process-mode sim (`docker-compose.tier2.yml`,
  `c69cd278`) and drove a managed-EBS `EcsComputeProvider.runTask` at it: the call
  returned a real task ARN and the sim stayed healthy through the async EBS transition —
  exactly the path that used to **panic** the sim before #569. So #569 is confirmed fixed.
  But the task then **stopped at container start** (`docker client not initialized`):
  the `integration` tier is the **API-surface** process-mode sim with no container runtime
  (CLAUDE.md §5), so a workspace `RunTask` can never reach RUNNING there. A test that
  asserted RUNNING in process mode would behave differently by target — forbidden by §6.9 —
  and container execution is, by design, the **`e2e`** tier's job (where this path is
  already covered by `agent-secret.e2e.ts`, workspace-lifecycle, and the user-journey/golden
  e2e). Reverted the exploratory process-mode test + its `@aws-sdk/client-ec2` dev-dep
  (no viable, rule-compliant cheap variant exists) and instead updated `BUGS.md`: marked
  #569 confirmed, corrected the line-104 note that had attributed the "can't complete in
  process mode" property to #569 (it is the runtime-less tier, independent of the now-fixed
  panic), and closed the follow-up. Net: no code change; a misleading follow-up retired and
  an upstream fix verified, with the reasoning recorded so it isn't re-chased.
- **2026-06-16 — SSH CA provisioning confirmed not-a-gap; added a plan-time half-config
  guard.** Chased the DO_NEXT "remaining deploy wiring gap: `EDD_SSH_CA_KEY_PATH` not
  provisioned by the Terraform module." Traced the SSH-cert path (`apps/web/lib/ssh-cert.ts`)
  and the module: the CA **private** key is already provisioned the recommended way —
  `EDD_SSH_CA_KEY` material via `secret_environment`, which the control-plane task def wires
  as ECS `secrets` (`ecs.tf:82`) with execution-role `GetSecretValue` over those ARNs
  (`iam.tf`), and the key never enters TF state; deploying.md Step 4 documents it end to end.
  The on-disk `_PATH` variant is intentionally dev-only (provisioning it would mean a key on
  disk / in state). So the note was stale. Found and hardened a genuine footgun instead:
  `ssh_ca_public_key` (workspace sshd trust) and `EDD_SSH_CA_KEY` (control-plane signing) must
  be set together; setting only the public key advertises SSH that can never issue a cert, and
  it previously failed only at runtime. Added a `lifecycle.precondition` on
  `aws_ecs_task_definition.control_plane` that fails the plan in that case (one-directional:
  the reverse just leaves SSH disabled, which is benign). Verified `terraform fmt`/`validate`
  green and the condition's three cases via `terraform console` (footgun→false/blocked;
  both-set→true; public-empty→true). The condition uses only plan-time-known values (map keys
  - an input string) on an always-created resource, so it always evaluates; the sim fixture and
    `examples/complete` set neither var and stay unaffected. A full misconfigured-plan repro
    against the sim was not run (disproportionate setup); the logic + safety were proven as above.
- **2026-06-16 — User-registered SSH keys + per-workspace subdomain: Slice 1 foundation.**
  Began the feature where a user inputs their SSH key once and SSHes into each running
  workspace at its own subdomain. Investigated the existing SSH design first (cert-principal
  routing via the gateway; CA-signed short-lived certs; `*.devbox` is HTTP-only; SSH has no
  SNI) and surfaced the design tradeoffs to the user. **Confirmed decision** (refines
  AGENTS.md §1's "short-lived user certs"): authenticate the human→gateway hop by the
  **registered public key** (Codespaces/Coder-style) + authorize the workspace by **ownership
  at connect time**, keep the **CA for the internal gateway↔workspace hop**, and route via
  wildcard DNS → one public gateway (stock OpenSSH; workspace id rides in the
  subdomain/username). Landed Slice 1 (foundation, no AWS): `@edd/core` branded
  `SshKeyId`/`SshPublicKey`/`SshKeyFingerprint` + pure `fingerprintPublicKey` (verified to
  match `ssh-keygen -lf` SHA256), `sshKeyType`, `workspaceSshHost(id, baseDomain)`;
  `@edd/api-contracts` register/list/delete schemas reusing the existing public-key boundary
  validation (extracted a shared `sshPublicKeyField`); `@edd/db` `makeSshKeyEntity`
  (PK=ownerId/SK=keyId + `byFingerprint` GSI1 over the already-provisioned GSI1 — no new
  physical index) for the gateway lookup and global key uniqueness; `@edd/control-plane`
  `SshKeyService` (register with fingerprint dedup + typed `SshKeyConflictError`, list
  newest-first, ownership-scoped delete, `ownerForKey` gateway lookup). Verified: core +
  contracts unit green (173 total), `SshKeyService`+entity integ green on DynamoDB Local
  (8/8 — register, default/explicit label, dedup same-owner + cross-owner uniqueness,
  ownerForKey, ownership-scoped delete, fingerprint freed after delete), all four packages
  typecheck + eslint clean. Slices 2 (`/api/ssh-keys` routes + Settings page + gateway
  `AuthorizedKeysCommand` + ownership authz + subdomain resolution) and 3 (public SSH NLB +
  Route53 `*.ssh`, AWS-gated by decision #1) are queued in `PLAN.md` §4b.
- **2026-06-16 — User-registered SSH keys: Slice 2 (API + portal + authorize seam).**
  Built the API and UX on the Slice-1 foundation. Routes: `/api/ssh-keys` GET (list) +
  POST (register, 409 on conflict) and `/api/ssh-keys/[id]` DELETE (ownership-scoped, 404
  otherwise); plus `POST /api/workspaces/[id]/ssh-authorize` — the gateway's connect-time
  decision (gateway machine-auth only; authorize iff the presented key is registered to the
  workspace owner; returns the workspace principal) — the seam the gateway will consume.
  Added `sshAuthorizeRequest/Response` contracts, api-client `register/list/deleteSshKey`,
  the `getSshKeyService()` web accessor, the Settings → SSH keys page + `SshKeys` client
  component (register/list/remove, surfaces the real server error), the per-workspace `ssh`
  command on the workspace card (shown when `EDD_SSH_BASE_DOMAIN` is set), the `SSH_BASE_DOMAIN`
  config, and `isWorkspaceLabel` in core (dedupes the label regex). Verified: route integ
  green on DynamoDB Local — ssh-keys CRUD/conflict/per-user-isolation (7) and ssh-authorize
  owner/mismatch/unregistered/no-token (4); web typecheck + eslint + offline build green;
  core 173 green. **Found while wiring:** the SSH proxy is a transparent `nc`/`-W` tunnel, so
  the user's SSH authenticates **end-to-end with the workspace node** (both hops check the CA
  cert today) — so registered-key auth at the gateway also needs the workspace node to trust
  the key. Reclassified the gateway sshd wiring as **Slice 2c** with an explicit sub-decision
  (dual-trust both sshds [recommended] vs a terminating bastion) rather than rushing a
  security-sensitive proxy-auth change into this PR; it also needs the golden-image rebuild +
  `docker-compose.ssh.yml` e2e. Captured in `PLAN.md` §4b.
- **2026-06-16 — SSH Slice 2c: dual-trust chosen; ssh-authorize + gateway done.** The user
  initially leaned terminating bastion to "minimize public-internet surface." Surfaced that
  public surface is **identical** in both models (only the bastion is internet-facing;
  workspaces stay private VPC-internal) — the real difference is internal trust. A terminating
  bastion in stock OpenSSH is shell-only (breaks VS Code Remote-SSH / scp / port-forwarding,
  which matter for a VS Code platform); full transparency would mean adopting/​building
  Teleport. The user ruled out Teleport and took the recommendation: **dual-trust** — both the
  gateway and the workspace sshd authorize the same registered key via `ssh-authorize`
  (per-connection, revocable; the workspace never stand-trusts a user key). Landed on
  `feat/ssh-dual-trust`: (1) `ssh-authorize` now accepts the **workspace agent token** in
  addition to the gateway token, so the inner-hop `AuthorizedKeysCommand` can call the same
  decision (route integ 5 green, incl. the agent-token case); (2) the **gateway** sshd swapped
  from CA/principal auth to `AuthorizedKeysCommand` (`services/ssh-gateway/authorized-keys.sh`,
  gateway token), the transparent `nc` forward unchanged so the session stays end-to-end to the
  workspace sshd (shellcheck-clean). **Mid-flight — not yet wired end-to-end:** the golden
  image (`infra/images/base`) sshd still uses CA auth, and the `docker-compose.ssh.yml` e2e
  still signs certs. Next: swap the golden image to `AuthorizedKeysCommand` (agent token) +
  entrypoint env-persist + Dockerfile (prod-image rebuild), rewrite the e2e to register a key
  against a stub control plane, and validate the full key→shell path.
- **2026-06-17 — SSH Slice 2c completed + docker-e2e validated.** Finished dual-trust:
  the **golden image** got `AuthorizedKeysCommand` (agent token, root, root-only
  `/run/edd-ssh-env`) **alongside** the retained CA cert path — additive on purpose, since
  many e2e suites (golden-workspace-ssh, user-journey, ssh-wake-chain, image-variants,
  workspace-toolchain) SSH into the golden image via certs and would otherwise break; sshd
  supports both paths at once, and `EDD_SSH_CA_PUBLIC_KEY` became optional (empty CA file →
  only registered-key active; verified sshd accepts an empty `TrustedUserCAKeys`). Rewrote
  `ssh-proxy.e2e.ts` as a **self-contained** harness (no compose): the stub control plane
  runs in a **worker thread** so it keeps serving while the main thread blocks on synchronous
  `spawnSync(ssh/docker)` — the gateway and node call `ssh-authorize` _during_ the blocking
  connection, which a main-loop server would deadlock (that was the bug behind a long
  banner-exchange timeout; a separate-process stub worked, an in-process one didn't). The
  test docker-runs its own node + proxy on a fresh network with a resilient host-alias probe
  - named-container teardown; **2/2 green** — a registered key is authorized at both hops and
    lands on the node (`whoami=workspace`), an unregistered key is denied. Deleted the obsolete
    cert-based `ssh-connect.e2e.ts` and `docker-compose.ssh.yml`; CI + `scripts/test-e2e.sh`
    now build `edd-workspace-node:e2e` and pass `NODE_IMAGE` instead of bringing up the compose
    harness (whose node entrypoint now requires runtime env compose didn't set); dropped the
    deleted ssh-connect CI step; `gen-ssh-ca` stays for the golden-image cert path. Updated
    TESTING.md, the ssh-gateway README, the coverage doc. **Net: dual-trust SSH (Slices 1–2c)
    is done and locally e2e-validated; only Slice 3 (public NLB + Route53, AWS-gated) remains.**
    On `feat/ssh-dual-trust` / draft PR #110.
- **2026-06-17 — Fix: SSH infra made additive after `ssh-wake-chain` CI failure.** PR #110
  CI surfaced that the cert-based wake-chain e2e (`packages/e2e/src/ssh-wake-chain.e2e.ts`)
  shares the gateway proxy image **and** the `docker-compose.ssh.yml` node — both of which the
  Slice-2c changes had made registered-key-only (and the compose harness had been removed),
  so the wake-chain broke (`No such container: edd-workspace-node`; the proxy no longer trusted
  its cert; `AllowUsers workspace` rejected its `dev-<id>` login). Fixed by making the shared
  SSH infra **additive** (CA cert + registered key), mirroring the golden image: the gateway
  `sshd_config.proxy` and the e2e node `sshd_config` re-trust the CA alongside
  `AuthorizedKeysCommand`; the proxy/node entrypoints ensure `workspace-ca.pub` exists (empty
  when unmounted) and the node entrypoint makes `EDD_*` optional (CA-only when unset);
  `AllowUsers workspace dev-*` on the node. Restored `docker-compose.ssh.yml` + the CI/test-e2e
  bring-up. The self-contained `ssh-proxy.e2e.ts` now names its node `edd-dualtrust-node` to
  avoid colliding with the compose node's global container name. Verified locally: dual-trust
  e2e 2/2 green **and** the additive node accepts a CA cert as a `dev-<id>` principal
  (`whoami=dev-test`). Lesson: changing shared SSH infra has a wide blast radius — additive
  (both auth paths) is the safe migration; full CA removal is a later, deliberate step.
- **2026-06-17 — SSH Slice 2d: clean-break removal of the SSH-CA path (registered-key only).**
  With dual-trust proven (#110 merged), took the deliberate full-removal step the prior entry
  flagged. The user confirmed we carry **no legacy** (mid-development), so this is a clean
  break, not an additive shim. On `feat/ssh-registered-key-only`, deleted the entire
  certificate path: the `POST /api/workspaces/:id/ssh-cert` route (+ integ) and
  `apps/web/lib/ssh-cert.ts` (+ test); the `sshCertRequest/Response` contracts and the
  api-client `sshCert` method; `scripts/gen-ssh-ca.sh`; `docker-compose.ssh.yml`; the
  `EDD_SSH_CA_*` config, the `EcsComputeProvider` `sshCaPublicKey` config + `EDD_SSH_CA_PUBLIC_KEY`
  env injection (+ `fromEnv`); the Terraform `ssh_ca_public_key` var **and** the #108
  half-config `precondition` (the guard for a now-nonexistent var); and all CA wiring from the
  golden/gateway/e2e-node sshd configs + entrypoints (no `TrustedUserCAKeys`,
  `AuthorizedPrincipalsCommand`, or `workspace-ca.pub` ensure). The shared infra the #110 fix
  had made additive is back to registered-key only; `ssh-proxy.e2e.ts` keeps its
  `edd-dualtrust-node` name (the compose node it avoided is gone).
  **Migrated the cert-based e2e suites to registered keys** (per the user's "migrate all
  properly"): `golden-workspace-ssh` + `data-durability` now use an in-process
  `startSshAuthorizeStub` control plane (the golden image's `AuthorizedKeysCommand` hits it;
  no full CP needed for these low-level image tests); `user-journey` registers an account key
  via `/api/ssh-keys` and asserts the DTO + listing (it only ever _issued_ a cert, no SSH
  connection); `ssh-wake-chain` registers a key and proves the gateway wakes a STOPPED
  workspace through the **real** control plane via `ssh-authorize` + `ForceCommand` (no node —
  landing-on-node is covered by `ssh-proxy`). `image-variants` + `workspace-toolchain` only
  needed the dead `EDD_SSH_CA_PUBLIC_KEY` env dropped (they use `docker exec`, not SSH). Also
  dropped the throwaway-CA plumbing from the live harnesses (`live-ecs-app` + callers,
  Playwright live/vscode setup) and made the e2e key-scratch dir self-create (the deleted
  `gen-ssh-ca.sh` used to make it). Swept all docs/comments to the registered-key story
  (runbook Step 4, READMEs, coverage/observability docs, the AGENTS.md §1 architecture table,
  core `ssh.ts` + topology descriptions). Verified: `@edd/e2e`/`@edd/core`/`@edd/ssh-gateway`
  typecheck + eslint + knip clean; core unit 173 green. Lesson: once a parallel path is
  proven, removing the old one _entirely_ (config, infra, images, tests, docs in one sweep)
  is cleaner than leaving a dual-trust-plus-CA surface that every future change must reason about.
- **2026-06-17 — Cost report time-windowing** (`feat/cost-time-windowing`). Added the
  deferred follow-up to the cost visualization: the admin `/admin/costs` page and
  `GET /api/admin/costs` now take `?window=all|1d|7d|30d` to scope spend to the last N
  days. Cost is linear in running/stopped duration, so windowing is just **clipping** the
  lifetime billing intervals to `[now - days, now)` before pricing — implemented as pure
  `clipIntervals` + `relativeWindow` in `@edd/core`, threaded through an optional `window`
  on `computeFleetCost` and `CostService.report(windowDays?)`. The earlier worry (STATUS
  framed it as needing a "sizable bucketed-rollup subsystem that must not change figures")
  was unfounded: on-the-fly clipping is exact and the **lifetime path stays byte-identical**,
  so the O(history)→O(recent) cost-rollup figure-equivalence invariant is untouched (windowed
  requests simply full-scan — a single checkpoint→now rollup can't serve an arbitrary window).
  Sessions with no run-time inside the window are dropped from the list. UI: a `.tabs`
  segmented selector (reusing the existing component) in the page header, link-driven so the
  page stays a server component; `LiveRefresh` preserves the selected window across refreshes.
  Contracts: `costWindow` enum + `COST_WINDOW_DAYS` map + `costReportQuery` (`.catch("all")`
  so a garbage/absent `?window=` falls back, never 400s). TDD throughout: core windowing unit
  (clip / relativeWindow / windowed `computeFleetCost`), a windowed `CostService.report` unit,
  a route integ (`?window=1d` scopes; garbage → all-time), a contract test, and a Playwright
  assertion that the selector defaults to "All time" and switching to "24h" navigates + keeps a
  just-run session visible. Verified: contracts 10 / core 178 / control-plane 23 unit green,
  cost route integ 5 green, rollup-equivalence integ green, the costs pw test green;
  eslint + knip clean.
- **2026-06-17 — Fixed two SSH e2e regressions from #111 (surfaced on the cost PR's CI).**
  #111 merged red: `golden-workspace-ssh.e2e.ts` and `ssh-wake-chain.e2e.ts` failed
  deterministically in the container-mode `e2e` job (which runs on every PR, so the cost PR
  inherited them). Diagnosed iteratively from the CI logs (each fix sharpened the next
  failure), never sim-special-casing — the fixes are all standard cloud-API/coordinate work.
  **(1) golden-workspace-ssh — root cause: the workspace subnet had no egress.** #111 switched
  the golden image from CA-cert auth (validated locally by sshd, no network) to **registered-key
  auth**, where the workspace calls the control plane (`AuthorizedKeysCommand → ssh-authorize`)
  to authorize each key. But this test created a plain VPC/subnet with **no route out**, so the
  authorize curl couldn't reach the control plane and every key was denied — exactly what real
  AWS would do for a task with no IGW/NAT route (so it's faithful cloud behaviour, not a sim
  bug). The original symptom was a hang (the authorize curl had no timeout, blocking sshd
  pre-auth); two intermediate fixes made it legible — a curl `--connect-timeout`/`--max-time`
  on the authorizers (`infra/images/base/authorized-keys.sh`,
  `services/ssh-gateway/authorized-keys.sh`, `wake-and-forward.sh`: a slow/unreachable control
  plane must never hang an SSH login, a real DoS) turned the hang into a clean
  `Permission denied (publickey)`, and decoupling the client loop's two checks (SSH-authorize,
  then poll OpenVSCode :3000) gave distinct error messages. The real fix has two parts, both
  matching the passing `data-durability` e2e (same stub+authorize path): the workspace task
  needs a **public IP** (`assignPublicIp: true` — golden had it hardcoded `false`; the provider
  default and `data-durability` are ENABLED) **and** its subnet needs **egress**
  (`createVpcWithEgress`: IGW + route). i.e. a public-subnet task that can reach the control
  plane — exactly what real AWS requires. (Egress alone wasn't enough — a public-IP-less task
  still can't route out; that intermediate run still got `Permission denied`.) **(2) ssh-wake-chain — root cause: a synchronous
  ssh froze the event loop.** `EDD_FAKE_SSH_HOST` is an unrouteable TEST-NET address, so the
  gateway's post-wake `nc` hangs and the ssh session never returns. The first fix bounded it with
  `spawnSync(..., {timeout})`, but that **blocks Node's event loop** for the whole timeout, during
  which our own keep-alive socket to the control plane went idle and the server closed it → the
  next `fetch` failed with `other side closed`. Final fix: run ssh **async** (`spawn`, killed once
  the wake is observed) so the loop stays free to poll. Local repro couldn't reproduce the CI
  condition (this host runs Podman — the workspace task won't start ready — vs CI's dockerd), so
  each iteration leaned on the CI-log evidence + the `data-durability` control; CI verifies.
  Lessons: don't merge a red e2e job; a no-network failure can masquerade as a timeout; and never
  block the event loop in an async test.
- **2026-06-17 — Focused sockerless fidelity conformance pass (EBS/ECS/SecretsManager/CloudWatch).**
  Ran the long-queued adversarial conformance sweep: drove the AWS call shapes we depend on against
  the process-mode sim (`SIM_RUNTIME=process`, pin `c69cd278`) with unexpected/edge inputs and
  diffed each against documented AWS behaviour (scratch probes in gitignored `temp/probes/`, not CI
  tests). **Conformant:** EBS not-found error codes + server-side `Filter`s; ECS `MISSING`
  task/cluster failures + `InvalidParameterException` for an unknown task; Secrets Manager
  `ResourceNotFoundException`/`ResourceExistsException`; CloudWatch Logs
  `ResourceNotFoundException`/`ResourceAlreadyExistsException` (all exact, 400). **Filed upstream
  (genuine cloud-spec gaps):** #590 — EC2 `DescribeSnapshots` ignores `MaxResults`/`NextToken`
  (pagination unimplemented; our SDK paginators still terminate correctly at small scale); #591 —
  EC2 `CreateVolume` accepts a missing required `AvailabilityZone` (silently defaults); #592 — ECS
  cluster-scoped ops (`DescribeTasks`/`ListTasks`/`StopTask`) never raise `ClusterNotFoundException`
  for an unknown cluster (medium impact: code distinguishing cluster-gone from task-gone would
  misclassify). **Discarded two would-be findings as probe errors, not sim bugs** — `CreateSnapshot`
  has no `ClientToken` idempotency in AWS (the SDK type wouldn't compile it), and `DescribeSnapshots
MaxResults` has an AWS minimum of 5 — reinforcing the rule to validate every probe against the AWS
  spec before claiming a divergence. Recorded in `BUGS.md` → External blockers (all low/medium
  impact, none block us). Next fidelity slice if revisited: ECS `RunTask`/task-def validation,
  IAM/STS, and pagination on the other list APIs.
- **2026-06-17 — Confirmed #590/#591/#592 fixed; re-pinned sockerless `c69cd278` → `fcb58281`.**
  Upstream **#593** (a fail-loud / no-fallback audit) fixed all three gaps the fidelity pass filed.
  Re-pinned the submodule to the #593 merge (`fcb58281`), rebuilt the process-mode sim, and re-ran
  the probes: **#590** `DescribeSnapshots(MaxResults=5)` now returns 5 + a `NextToken`; **#591**
  `CreateVolume` with no `AvailabilityZone` now returns `MissingParameter`; **#592**
  `DescribeTasks`/`ListTasks`/`StopTask` against an unknown cluster now all throw
  `ClusterNotFoundException`. Sanity-checked the broad bump locally — `@edd/storage-ec2` (4/4) and
  `@edd/compute-ecs` (4/4) integ green against the new sim — with full integ/e2e validation on CI.
- **2026-06-17 — Observability `Low` triage: `parseLevel` reads structured levels; rest deferred
  with rationale.** Picked up the deferred observability follow-ups. **Done:** `parseLevel`
  (`@edd/cloudwatch-logs`) now reads the explicit `level` of a structured log line (our
  `formatLogLine` JSON) instead of substring-matching the raw message — so an `info` line whose
  text happens to contain "error" is no longer mis-levelled; the brittle heuristic remains only
  for raw unstructured container stdout (idle-agent / workspace processes). Added a `structuredLevel`
  parser + `isLogLevel` type guard; unit tests cover structured-wins-over-heuristic and the
  non-JSON/level-less fallbacks. **Triaged + deferred** (recorded in `docs/observability-gaps.md`):
  **cached fleet status** (_Medium_, the one with real value) needs a caching-strategy decision
  (short-TTL memo vs reconciler-persisted aggregate vs `unstable_cache`) — an architecture call,
  not a mechanical fix; **per-user quota gauges** (_Low_) are an awkward fit (the reconciler has
  `ownerId` but not the owner's role, and the limit is `workspaceLimit(role)`); **control-plane
  self-health** (_Low_) is deliberately hardcoded `ok` (by construction it answers its own request).
  This closes the cleanly-fixable observability `Low` items; what's left is the AWS-gated `e2e-aws`
  tier plus the one Medium item that's a deliberate design decision.
- **2026-06-17 — Cached fleet status (the Medium observability item) + 53 GB local cleanup.**
  Picked the short-TTL strategy (user's call): the admin Overview now reads `getFleetStatus()` —
  the fleet aggregate (state tallies + distinct owners) behind a generic **single-flight `ttlCache`**
  (`apps/web/lib/ttl-cache.ts`, 10s TTL) — instead of a full `cp.list()` scan per page load, so
  bursts (multiple admins / live refresh) collapse to one scan at 200+ workspaces. Chose short-TTL
  over a reconciler-persisted aggregate (whose staleness would be the ~5-min sweep). `ttlCache`
  takes `nowMs` for deterministic tests (§6.10): caches within TTL, reloads after, shares an
  in-flight load across concurrent callers, and does **not** cache a rejection (4 unit tests).
  Also did a **local disk cleanup** at the user's request (disk was 90% full): cleared the 53 GB
  Turborepo cache (`.turbo/cache`), ~6 GB of orphaned `<none>` Docker build layers from the e2e/sim
  image builds, `apps/web/.next`, per-package `dist/`, and scratch `temp/`, and downed the project
  compose stacks — ~59 GB reclaimed (40 GB → 93 GB free), all regenerable.
- **2026-06-17 — Built out the `e2e-aws` workflow (first slice: real EBS snapshot round-trip).**
  Turned the `e2e-aws.yml` skeleton (echoed TODOs) into a working manual real-AWS tier, chosen by
  the user with the explicit "untestable until the account lands" caveat. Kept it **self-contained
  and safe** rather than refactoring the sim-defaulting coordinate plumbing blind (which would risk
  breaking green CI): `packages/e2e/src/aws-ebs-smoke.ts` builds the EC2 client from real
  coordinates only (`AWS_REGION` + OIDC creds, **no** endpoint override — it refuses to run if
  `AWS_ENDPOINT_URL` is set, since a set endpoint means a sim) and does create gp3 volume → snapshot
  → wait-completed (logging the **real** completion latency a sim can't model) → restore a new
  volume from the snapshot → assert lineage; it deletes its own resources in `finally`. The workflow
  adds OIDC role assumption (role/region from repo `vars`, no static keys), a `confirm=RUN` dispatch
  gate, a 30-min timeout (cost cap), and a belt-and-suspenders `always()` step that sweeps everything
  tagged `edd-e2eaws-run=<run-id>` so a hard crash can't leak resources. Validated what's testable:
  `@edd/e2e` tsc + eslint clean, knip entry registered, **actionlint clean** (incl. shellcheck on the
  teardown bash). The real run + teardown are validated only once an account is supplied (DO_NEXT #1);
  documented in TESTING.md (set `E2E_AWS_ROLE_ARN`, dispatch with `confirm=RUN`). Fuller suites the
  sim can't cover (Fargate cold-start, federation, IAM enforcement, 200+ load, wake-on-connect) are
  added as further jobs once this first slice is validated.
- **2026-06-17 — Per-user quota-utilization metric (the last observability `Low` item).** Closed
  the deferred quota gauge via the event-driven approach the earlier triage foresaw: it's emitted
  from the **create route** (which knows both the owner's current count and their role-derived
  `workspaceLimit(role)`), not the reconciler (which has `ownerId` but not the role). A pure,
  testable `recordQuotaUsage(metrics, {owned, limit, role, allowed})` (`apps/web/lib/quota-metrics.ts`)
  emits `quota.utilization` (gauge = `owned/limit`, 0 when unlimited) and `quota.denied` (count on
  rejection), dimensioned by role only (bounded cardinality). Added the metric-name constants to
  `@edd/core` and a memoized `getMetrics()` app sink accessor. 3 unit tests (allowed / unlimited /
  denied). This closes the `observability-gaps.md` `Low` list entirely — the only thing left there
  is the AWS-gated `e2e-aws` tier.
- **2026-06-17 — Made the e2e-aws EBS smoke coordinate-driven + sim-validated (it wasn't really
  "untested until AWS").** The user pushed back on the e2e-aws caveat — and rightly: the smoke I'd
  shipped in #115 _refused to run if `AWS_ENDPOINT_URL` was set_, which is an **anti-§6.9 special-case
  against the sim** and the very reason it looked untestable. Fixed it the §6.9 way: extracted the
  round-trip into `runEbsSmoke(ec2, prefix)` in `@edd/storage-ec2` (where the EBS context + integ
  tier already live), made `packages/e2e/src/aws-ebs-smoke.ts` a thin coordinate-driven wrapper
  (honours `AWS_ENDPOINT_URL` if set), and added `ebs-smoke.integ.ts` that runs the SAME `runEbsSmoke`
  **against the sockerless sim** — asserting the round-trip + lineage AND that the `finally` teardown
  deleted the volume (`InvalidVolume.NotFound`). So it now runs both ways by coordinates alone: the
  `integration` job validates the logic + teardown against the sim (no ci.yml change — storage-ec2's
  `test:integ` already runs there), and `e2e-aws` runs the identical logic against real AWS for the
  latency/durability fidelity a sim genuinely can't model. Validated locally against the running
  process-mode sim (round-trip + teardown green); tsc + eslint + knip clean. Lesson: don't bake a
  "real-only" guard that special-cases the sim — coordinate-drive it and the sim validates the logic
  for free; only the real-world _fidelity_ is AWS-gated.
- **2026-06-18 — Closed the idle-agent heartbeat RESUMPTION testing gap (the last non-AWS Medium).**
  The user-journey e2e already proves the in-workspace agent beats and advances `lastActivity`
  (liveness/tolerance in-container); what was untested was that it TOLERATES the control plane going
  away and RESUMES once it returns — behaviour that lives entirely in `idle-agent.sh`'s loop (a
  guarded `curl` that logs-but-doesn't-exit on failure). Rather than a flaky container restart, added
  `packages/e2e/src/idle-agent-resume.integ.ts`: it drives the REAL `infra/images/base/idle-agent.sh`
  (sh + curl, the exact `--retry`/`--max-time` flags) against a stub control plane (a Node http
  server) toggled down → up, asserting (a) no acks land and the process does not exit while the CP
  503s, then (b) a fresh beat lands after the CP returns. Deterministic — 1s interval + relative
  polling, no wall-clock assertions (§6.10); 3/3 stable at ~7.3s. Established a new lightweight
  `@edd/e2e` `test:integ` tier (`vitest.integ.config.ts`, no container/sim) so it runs in the
  existing `integration` CI job (`pnpm test:integ` is turbo-wired); first test of an `infra/images`
  shell script. tsc + eslint + knip + shellcheck clean.
- **2026-06-18 — Hardened reconciler GC to be best-effort per resource (highest-blast-radius path).**
  A robustness audit of the reconciler found the one real gap: `collectGarbage` deleted orphan
  volumes/snapshots in a bare `for … await storage.deleteVolume(id)` loop — so a SINGLE delete that
  throws (very plausible on real AWS: a volume transiently in-use/detaching → `VolumeInUse`,
  throttling, or an already-deleted volume → `InvalidVolume.NotFound`) aborted the rest of GC AND
  propagated out of `runMaintenance`, failing the whole sweep (counted as `reconciler.sweep.failed`)
  and stranding the remaining orphans (cost accruing). This contradicted the reconciler's own design
  — the idle/snapshot/drift sweeps already skip-and-continue ("one racy workspace must not abort the
  sweep"). Made GC match: each delete is now try/caught, **counted and logged (not swallowed)**, and
  the sweep continues. `GcResult` gained `volumesFailed`/`snapshotsFailed`; a new
  `reconciler.gc.failed` metric (`@edd/core`) is emitted and the per-resource error is logged via an
  optional `ReconcilerLogger` on the deps (the run entrypoint passes its structured logger). Added a
  unit test (one stuck delete → the other orphan still reaped, failure counted + logged, no throw) and
  updated the exact-match GC assertions. reconciler unit 9 + integ 7 (vs sim/DynamoDB Local) + core
  178 green; tsc + eslint + knip clean.
- **2026-06-18 — Stop the launched task when a workspace launch fails to become ready (compute-leak
  fix).** Continuing the destructive-path hardening into the compute provider: `EcsComputeProvider.
runTask` calls `RunTaskCommand` (a real Fargate task is now launched) and then `awaitTaskReady`,
  which **throws** if the task stops mid-boot or the readiness poll times out. On that throw the ARN
  never escaped `runTask`, so the caller (`WorkspaceService.create`/wake — which only compensates
  with `stopTask(task.id)` once it HAS the id) could not clean it up: a failed/timed-out launch
  **leaked a running Fargate task + its managed EBS volume**, unreferenced (the storage GC reaps
  volumes, but nothing reaps a task with no record). Fixed in `runTask`: wrap `awaitTaskReady`, and on
  failure best-effort `stopTask(arn)` before rethrowing — stopping the task reaps the managed volume
  via `deleteOnTermination`. If the cleanup stop ALSO fails it is **not swallowed** (§6.5): a combined
  error is thrown with the original `cause` so a genuinely-leaked task is visible. Added a unit test
  (mock ECS client whose task STOPS before ready → `runTask` rejects AND issues exactly one StopTask
  for the launched ARN). compute-ecs unit 17 green; tsc + eslint + knip clean.
- **2026-06-18 — Storage provider: delete a volume/snapshot whose post-create settle fails (audit
  cont.).** Completing the provider-pair hardening (compute was the prior fix): `Ec2StorageProvider.
createVolume`/`createSnapshot` create the resource then `waitUntilVolumeAvailable`/
  `waitUntilSnapshotCompleted`, which **throw** on timeout or a terminal `error`/`deleted` state — and
  the just-created id never escaped, so a failed settle left the resource behind. Lower severity than
  the compute leak (these resources are tagged, so the reconciler GC reaps them past the 1h grace),
  so this is defense-in-depth: immediate cleanup avoids the cost-accrual window and a retry storm
  piling up orphans faster than GC reaps. Added a shared `deleteOrSurfaceLeak` (best-effort delete →
  rethrow original; a failed cleanup is surfaced with `cause`, not swallowed, §6.5) used by both
  methods. Unit tests drive the real SDK waiters to a fast terminal-state failure (mock EC2 client,
  `deleted`/`error` acceptors) and assert the cleanup delete fires; storage-ec2 unit 3 green
  (~0.3s); tsc + eslint + knip clean.
- **2026-06-18 — Self-healing: reconciler reaps orphaned workspace TASKS (the compute analogue of
  storage GC).** The user asked for self-healing when services are down/fail. Assessment found the
  platform already self-heals a lot (ECS service auto-restart + circuit breaker + `/api/healthz`
  liveness + `/api/readyz` readiness, the scheduled reconciler, drift detection, idle-agent tolerance
  #118, leak cleanup #120/#121), but had **one real gap**: the reconciler reaped orphan volumes/
  snapshots yet **never orphaned ECS tasks** — a RUNNING workspace task with no control-plane record
  (a crash between RunTask and persist, a partial wake, an out-of-band launch) leaked the most
  expensive resource forever, since nothing reaped a task with no record. Built the reaper as a clean
  mirror of the storage GC: workspace tasks are now **tagged** (`edd:workspace-id`) at launch so the
  reaper enumerates only workspace tasks (never the control-plane/reconciler tasks sharing the
  cluster); a `listWorkspaceTasks` compute port (ListTasks + DescribeTasks/TAGS), a
  `listReferencedTasks` keep-set on the control plane, a pure `selectOrphanTasks` (same grace window as
  volume GC, so a just-launched-but-not-yet-recorded task is spared), and `Reconciler.reapOrphanTasks`
  that stops orphans **best-effort** (counted + logged, never aborts the sweep — runs before GC so a
  reaped task's volume becomes GC-able). New `reconciler.tasks.reaped`/`reap_failed` metrics. Touches
  core/compute-ecs/control-plane/reconciler; the local fake path no-ops (the port is optional). Tests:
  `selectOrphanTasks` (4), `reapOrphanTasks` incl. stop-failure + no-compute no-op (3), real
  `listWorkspaceTasks` tag-filtering (mock ECS client). core 182 + reconciler 12 + compute-ecs 18 +
  reconciler integ 7 green; tsc + eslint + knip clean.
- **2026-06-18 — Self-healing alerting: control-plane down/degraded alarms.** ECS already self-heals
  the control plane (service auto-restart + deployment circuit breaker + `/api/healthz` liveness +
  `/api/readyz` readiness), but nothing **alerted** when it was down — only `reconciler.sweep.failed`
  and wake-latency were alarmed. Added two CloudWatch alarms (`alarms.tf`) on **AWS-managed ALB
  metrics** (so they fire even when the control plane can't emit its own EMF): `control-plane-unhealthy`
  (HealthyHostCount `< 1` for ~3 min behind the ALB — the CP is down / crash-looping / a stuck
  dependency) and `control-plane-5xx` (target `HTTPCode_Target_5XX_Count` over a tunable threshold —
  up but erroring). Same `enable_metric_alarms` gate + `alarm_sns_topic_arns` actions as the existing
  alarms (off for the sim, which has no metrics endpoint); new `control_plane_5xx_threshold` var.
  `terraform fmt` + `validate` clean. The real firing is `e2e-aws`-validated (ALB metrics are
  real-AWS-only). This + the orphan-task reaper are the "both, reaper first" self-healing items.
- **2026-06-18 — workspace-gate proxy: fix a per-connection socket leak on a non-upgrade upstream
  (audit cont.).** Auditing the gate (it fronts every workspace connection), `proxyUpgrade` only
  handled the `upgrade` + `error` events: if the upstream answered a WebSocket upgrade with a **normal
  HTTP response** instead of switching protocols — e.g. a just-woken workspace whose editor isn't
  serving WebSocket yet returns 502/503 — the `response` event was unhandled, so the **client socket
  was never written to or destroyed and hung open** until the client timed out (a socket leak per such
  connection, and these cluster during cold-start wakes). Added a `response` handler that relays the
  status line and closes the client socket. Also hardened `proxyHttp`: abort the upstream request when
  the client disconnects mid-exchange (`res` close → `proxyReq.destroy()`), so the upstream socket
  doesn't linger. Test: an upstream that answers the upgrade with a raw 503 → the gate relays 503 and
  closes (without the fix the client hangs to timeout). workspace-gate unit 13 green; tsc/eslint/knip
  clean.
- **2026-06-18 — Hardened the flaky `pw:vscode` browser proof (terminal keystroke retry).** The
  "VS Code workspace browser proof" flaked in CI (`EDD-VSCODE-BUILD-OK` not found). Root cause: the
  build was driven by a SINGLE keystroke burst into the integrated terminal, but xterm can drop the
  leading keystrokes before it's attached to the pty — so the build command never ran and the 60s
  artifact poll waited for a binary that never came. The verification (a container-filesystem probe
  of the compiled `~/proof/hello` ELF) was already robust; the flake was upstream. Fix: **re-issue
  the build command** (up to 4 rounds, polling the filesystem ~20s each) so a dropped burst is
  retried, while still proving the keyboard-driven terminal works (the artifact only appears if the
  keystrokes landed and the build ran in the terminal). Relative-time poll loops only (§6.10). eslint
  - tsc clean; the real proof is the e2e job.
- **2026-06-18 — Audit pass (adapters): retry policy + transaction-cancellation classification.**
  Two findings from a focused partial-failure audit of the db/adapter layers (cost model, CloudWatch/
  CloudTrail/Secrets all came back clean). (1) **DynamoDB + CloudTrail clients ignored the configured
  retry policy** — every other AWS client passes `AWS_SDK_MAX_ATTEMPTS=6`/`retryMode=adaptive`, but
  `createDynamoClient` (the highest-traffic, most-contended client — every CAS write + `writeTransaction`
  at 200+ scale) and `CloudTrailAuditSource.fromEnv` (LookupEvents is throttled ~1-2 TPS) were on the
  SDK defaults (3/standard); added the config. (2) **`writeTransaction` cancellations were all
  misclassified as benign version conflicts** — the code threw a synthetic `ConditionalCheckFailedException`
  for ANY `result.canceled`, discarding ElectroDB's per-item `code`. So a permanent `ValidationError`/
  `ItemCollectionSizeLimitExceeded` was silently swallowed as a "lost race" (§6.5). Added
  `fatalTransactionCode` (pure, unit-tested): a permanent data-error code surfaces loudly (500); the
  contention codes (`ConditionalCheckFailed`/`TransactionConflict`/throttling) keep the conflict/retry
  path. control-plane unit 28; db/cloudtrail build clean.
- **2026-06-18 — Self-healing: recover workspaces STUCK in `provisioning` (crashed wake).** The main
  gap from the self-healing audit: `start()` is claim-before-launch — it CAS-commits `stopped →
provisioning` (no taskId), launches, then CAS-commits `→ running`. If the driving process dies
  between, the record is stranded in `provisioning` FOREVER — `listActive` only queries running/idle,
  so no sweep (drift/idle/snapshot/GC) ever sees it; the workspace can't connect, wake, or scale-to-zero
  (only `remove` works). Added a reconciler recovery step (runs FIRST, before drift): `WorkspaceService.
listStuckProvisioning` + `recoverStuckProvisioning` revert provisioning→stopped via `markStopped`
  (the snapshot is carried forward — a wake always has one — so it's wake-able again; the in-process
  `rollbackWake` does the same), best-effort with a lost-CAS-race skip (a slow wake that finally
  committed). Timeout `DEFAULT_PROVISIONING_TIMEOUT_MS` = 10 min (well above the ~180s legit cold-start
  window so an in-flight wake is never reverted), env-overridable (`EDD_PROVISIONING_TIMEOUT_MS`). New
  `reconciler.provisioning.recovered` metric. The orphan task (if its launch outran the crash) is
  already handled by the reaper. Tests: reconciler unit `recoverProvisioning` (revert-vs-spare-fresh,
  lost-race skip) + a crash-consistency integ that strands a record in provisioning (commit + rollback
  both fail) and recovers it back to wake-able (DynamoDB Local). core 182 + reconciler 14 + control-plane
  28 unit + 7+41 integ green; tsc/eslint/knip clean.
- **2026-06-18 — Security breadth audit (clean) + cleared the remaining deferred fixes.** A focused
  security/authz/input-validation audit of the whole request surface — all 28 API routes (auth +
  CASL + ownership/IDOR + body/param validation + error leakage), machine-auth/HMAC, the Pomerium PDP
  (JWKS + aud/iss/exp binding, host-spoof resistance), and the IdP claim→role mapping — found **no real
  defects** (the surface is consistently guarded via the shared `lib/api` guards). It surfaced two
  low hardening nits, both fixed: `admin/costs` used `.parse` (a bad `?window=` → 500) → now `safeParse`
  → 400; `ssh-keys` POST echoed the internal error message in its 500 body → now re-throws so
  `withObservability` logs it and returns a bodiless 500. Also cleared the actionable **deferred** items
  flagged across recent audits: (a) the CloudWatch Logs + Pricing clients now use the configured
  6/adaptive retry policy (completing the DynamoDB+CloudTrail pass); (b) `StoredCostRollupStore.replaceAll`
  is now a TRUE replace (deletes checkpoints absent from the new generation before upserting, so a
  stale rollup can't be double-counted — was an upsert safe only by the append-only invariant); (c) the
  admin audit route emits `audit.source.degraded` when a source errors and is degraded to an empty feed.
  Left deferred-by-design (documented, not actionable now): control-plane self-health hardcoded `ok` (by
  construction), `CONNECTION_TOKEN` injection (the future wake-on-connect gate), the upstream sockerless
  blockers, and the recorded DynamoDB-Local delete-vs-wake flake. core 182 + cloudwatch-logs 21 +
  control-plane 28 + web 63 unit + cost integ green; tsc/eslint/knip clean.
- **2026-06-18 — Operational monitoring cluster (the buildable ops-readiness gaps).** From an
  ops-readiness gap analysis of the ECS Fargate deployment, built the buildable-now cluster. CloudWatch
  alarms (`alarms.tf`): **`reconciler-not-running`** — the key blind spot: `reconciler-failed` only fires
  when a sweep RUNS and throws, so a scheduled task that never launches left the whole self-healing
  engine silently dead; this alarms on a `reconciler.sweep.count` Sum `< 1` over the window with
  `treat_missing_data = breaching`. Plus `reconciler-gc-failed`/`reconciler-reap-failed` (a stuck,
  cost-leaking orphan), a metric-math `dynamodb-throttle` alarm, and a `reconciler-dlq` alarm. Added an
  SQS **dead-letter queue** on the EventBridge→reconciler target (`dead_letter_config` + the scheduler
  IAM `sqs:SendMessage`) so a dropped sweep is visible; an `…-ops` **CloudWatch dashboard** (`monitoring.tf`,
  jsonencode: fleet/cost, wake p50/p99, CP healthy-hosts + 5xx, reconciler actions + failures, DynamoDB
  throttles); and an optional monthly **AWS Budgets** cost guardrail (`monthly_budget_usd`, 80%/100% SNS).
  Observability: a per-request **correlation id** in `withObservability` — threaded into the access +
  thrown-error logs and stamped on every response as `x-edd-request-id` (injectable for tests). Wrote the
  incident **runbook** (`docs/runbook.md`): each alarm → diagnosis → remediation, the first-stops (ops
  dashboard / Health board / per-workspace logs / audit / correlation id / ECS Exec), and reliability
  notes (NAT `instance` is a single-AZ SPOF → use `gateway` for prod; DynamoDB PITR + deletion protection
  on). `terraform fmt`+`validate` clean; web unit 64; tsc/eslint/knip clean. **Deferred (AWS-gated /
  larger):** full X-Ray/OTel distributed tracing, a synthetic create→wake→connect canary, EBS AZ/region
  DR, and real-time per-workspace status — all want the account to build+validate against real AWS.
- **2026-06-19 — Sockerless fidelity pass on the "AWS-gated" ops/DR surfaces; filed 3 upstream gaps.**
  Probed how much of the AWS-gated work (alarms, EMF metrics, EBS DR) could run on sockerless instead
  of needing the account. Rigorously (probe + sim-source verified, catching two of my own CLI
  false-positives) found: the sim DOES implement CloudWatch metrics (`PutMetricData`/`GetMetricStatistics`/
  `GetMetricData`/`ListMetrics`) and the full EBS create/snapshot/restore lifecycle, and the
  create→wake→connect journey already runs (the `user-journey` e2e) — but three genuine gaps remain,
  each filed upstream with a reproduction + AWS-spec reference: **sockerless#602** (EC2 `CopySnapshot`
  unimplemented → blocks cross-region EBS DR), **#603** (CloudWatch alarm API unimplemented — metrics
  but no `PutMetricAlarm`/`DescribeAlarms` → why `enable_metric_alarms=false` for the sim), **#604**
  (CloudWatch Logs doesn't extract EMF → our EMF-over-logs metrics path can't be sim-validated).
  Recorded in `BUGS.md` → External blockers; cross-referenced from `observability-gaps.md`. Once these
  land upstream (cf. the #593/#590-#592 cycle), our alarms, EMF metrics, and EBS DR become
  sim-CI-validatable rather than real-AWS-only.
- **2026-06-19 — Deeper call-shape fidelity pass; filed 2 more sockerless gaps (#605/#606).** Followed
  the first pass by inventorying every AWS API _call shape_ our code issues (EC2 paginators/waiters/tag
  filters, ECS `RunTask`+tags/`ListTasks`/`DescribeTasks include:TAGS`, Secrets Manager idempotent
  upsert, CloudWatch Logs `FilterLogEvents`, CloudTrail `LookupEvents` pagination, DynamoDB
  transactions) and probed each against the process-mode sim, cross-checking the Go source (and
  correcting one false-positive — a process-mode task stopping immediately, not a `ListTasks` filter
  bug). Most surfaces were faithful; two genuine gaps, both hitting our code, were filed upstream with
  deterministic reproductions: **sockerless#605** (`FilterLogEvents` ignores `logStreamNamePrefix` →
  our per-workspace log view leaks every workspace's container events) and **sockerless#606**
  (CloudTrail `LookupEvents` absolute-offset `NextToken` over a newest-first list → overlapping/
  duplicate pages; our audit-source pagination loop collects duplicates and misses entries). Recorded
  in `BUGS.md` → External blockers.
- **2026-06-19 — Adopted sockerless #607 (re-pin); confirmed all 5 fixes downstream; surfaced + filed
  2 more (#608/#609).** Upstream #607 (merge `74c0a3d2`) fixed all five gaps from the two fidelity
  passes (#602 CopySnapshot, #603 alarm API, #604 EMF extraction, #605 `FilterLogEvents` prefix, #606
  CloudTrail cursor). Re-pinned the `third_party/sockerless` submodule `fcb58281 → 74c0a3d2`, rebuilt
  the process-mode sim, and **confirmed each fix downstream** by re-probing (copy-snapshot returns a
  new id; alarm CRUD + live `ALARM` state; an EMF log doc round-trips through `get-metric-statistics`;
  `FilterLogEvents` honours `logStreamNamePrefix` + mutual-exclusion; CloudTrail pages no longer
  overlap on a growing trail). Then exercised the module's alarm/dashboard resources against the sim
  via `terraform apply` on `tests/sim`, which surfaced two residual gaps, both filed upstream with
  reproductions: **#608** (`PutDashboard` unimplemented → 404) and **#609** (alarms drop a percentile
  `ExtendedStatistic`, so the wake-latency p99 alarm shows a perpetual `plan` diff / fails the
  idempotency gate). Split the CloudWatch dashboard onto its own `enable_cloudwatch_dashboard` toggle
  (decoupled from `enable_metric_alarms`) so each can be enabled the moment its upstream gap closes;
  both stay `false` for the sim fixture until #608/#609 land. `terraform fmt`/`validate` clean; the
  sim apply (alarms+dashboard off) is idempotent (`plan -detailed-exitcode` = 0). Tracked in `BUGS.md`
  → External blockers (#602–#606 moved to fixed-confirmed; #608/#609 added as open).
- **2026-06-19 — Adopted sockerless #611 (re-pin); confirmed #608/#609 fixed; enabled the sim's
  alarm + dashboard validation. No open sockerless blockers remain.** Upstream #611 (merge `322d16ad`)
  implemented the CloudWatch dashboard API (#608, new `cloudwatch_dashboards.go`) and the alarm
  percentile `ExtendedStatistic` round-trip (#609). Verified first at the source level (the handlers
  / struct field now exist at the tip), then **confirmed downstream**: re-pinned `third_party/sockerless`
  `74c0a3d2 → 322d16ad`, rebuilt the process-mode sim, and probed — dashboard CRUD round-trips
  (put→`[]`, get echoes body, list→`["ops"]`, delete clears) and a `p99` alarm round-trips
  `ExtendedStatistic=p99`/`Statistic=null`. Flipped **both** sim-fixture gates on
  (`enable_metric_alarms=true`, `enable_cloudwatch_dashboard=true`): `terraform apply` lands all 9
  alarms + the ops dashboard and `plan -detailed-exitcode` = 0 (idempotent), clean destroy of 66
  resources; `fmt` clean. Earlier (before the fix landed) I also posted source-level "still
  reproduces" evidence comments on #608/#609. Net: the full EMF→metrics→alarms→dashboard observability
  path is now sim-CI-validatable, and **no sockerless gap blocks us** — `BUGS.md` → External blockers
  has #602–#606 and #608/#609 all fixed-confirmed.
- **2026-06-19 — Phase 9: codex code-review remediation (12 findings + DR), one PR (#129).** A deep
  `codex` review produced 12 findings; all were fixed with tests, none deferred. **Critical:** prod
  fake-provider guard (fail-loud `control-plane.ts`); terraform IAM for the per-workspace agent-secret
  create/inject path + a workspace task role + passed `ECS_EXECUTION_ROLE_ARN`/`ECS_TASK_ROLE_ARN`;
  transactional SSH-key fingerprint uniqueness (sentinel + `writeTransaction`). **High:** shorter
  early-session snapshot cadence (no fresh-workspace data loss); fail-loud repo-clone/git-credential
  surfacing (stderr→portal log view + IDE marker); orphan agent-secret GC (tag-on-create + reconciler
  `reapOrphanSecrets`). **Medium/Low:** task-def revision GC (reconciler prune, keep newest N per
  family); owner-identity required at create (no unopenable workspaces); cost `?window=` rejects
  invalid; topology CA-cert text. **Deferred→done:** cross-region EBS snapshot DR
  (`StorageProvider.copySnapshot` + sim integ, via sockerless#602). **Coupled, not built:**
  `CONNECTION_TOKEN` — correctly stays with the future DYNAMIC gate (tokenless-behind-gate today;
  building it now = dead code §6.5). Each finding sim/integ/unit-validated; the two terraform criticals
  proven against the `terraform-sim` IAM apply. Two self-introduced CI failures (gate fakes opt-in +
  a cost integ assertion) were diagnosed from the logs and fixed.
- **2026-06-19 — Self-recovery + monitoring (4 themes, one PR; codex-advised).** Asked codex for
  self-recovery recommendations, synthesised with our own analysis, confirmed 4 design decisions with
  the user (one bundled PR; desired-state + tombstone async delete; Middle data-safety; live config
  self-check now), then built all four on `feat/self-recovery-and-monitoring`:
  - **Self-recovery / convergence.** Durable intent (`desiredState` present/deleted) + a `deleting`
    tombstone so an interrupted delete is resumable; `markRecovered` (error→stopped when a snapshot
    exists) + `markSnapshotLost` (reverse drift: a referenced snapshot deleted out-of-band → honest
    unrecoverable error). `WorkspaceService.remove` now CAS-marks the tombstone (DELETE → **202**,
    idempotent); reconciler `recoverErrors` + `finishDeletions` + `detectStorageDrift` sweeps converge
    each cycle, budget-bounded (`DEFAULT_CONVERGE_BUDGET`), Middle data-safety (final snapshot before
    teardown). Metrics `reconciler.recovered/deletions.{finished,failed}/drift.snapshot_lost` + gauges
    `workspaces.error/.deleting`; alarms `workspaces-stuck-error` (needs a human) +
    `reconciler-deletions-failed`. Propagated the async-delete semantics through every affected
    integ/e2e suite.
  - **Privilege/security warnings.** In-image privilege guard (`edd-privilege-guard.sh`) shims
    docker/sudo/mount/… on PATH: blocks (exit 126) + warns the user + ships a structured line to
    CloudWatch + reports to the control plane. `POST /api/workspaces/:id/security-event` (agent auth) →
    a first-class audit event + `security.privilege_attempt` metric; alarm `security-privilege-attempts`.
  - **Config-sync self-check (UI/API/SDK/CLI).** Pure `evaluateConfigSync` (real providers + ECS/EBS +
    observability coordinates + DynamoDB/cluster reachability → ok/drift/unknown). `GET
/api/admin/config-sync`, `api-client.adminConfigSync`, a Configuration-sync card on the admin
    Infrastructure page, and a **new thin `@edd/cli` `edd` CLI** over the SDK (`edd config-sync/doctor`
    exits 1 on drift; `health`/`status`/`workspaces`). Terraform-plan infra drift is left as a separate
    deploy-time gate (noted in DO_NEXT).
  - **Functional usability checks.** The idle-agent probes whether the desktop is actually usable (IDE
    on :3000 reachable + workspace writable) and folds it into the heartbeat; the control plane stores
    it (surfaced as a `usable` row in admin Inspect). The create→clone→build→run→delete journey
    (user-journey + workspace-toolchain e2e) is the synthetic canary. Each theme unit/integ-tested;
    full build + lint + tf validate clean.

- **2026-06-19 — Sockerless fidelity slice 2 (ECS/Scheduler request-validation); filed #618/#619.**
  A second focused, adversarial conformance sweep of the AWS surfaces our code drives but the first
  slice (#590/#591/#592) hadn't reached — ECS `RegisterTaskDefinition`/`RunTask`/`DescribeTasks`
  request-validation, EventBridge Scheduler `CreateSchedule`, CloudWatch Logs pagination, and Secrets
  Manager error shapes — probed endpoint-only against the process-mode sim (`322d16ad`) with the
  standard AWS SDK v3 and judged against the documented AWS spec (each behaviour confirmed via the AWS
  API reference before filing; one Fargate finding carries a control case to isolate the cause). Found
  **two genuine under-validation gaps** and filed them upstream:
  - **sockerless#618 (ECS)** — a Fargate task def with no task-level `cpu`/`memory` is accepted (AWS:
    `ClientException`); `RunTask count:11` starts 11 (AWS caps `count` at 10); `DescribeTasks` with an
    empty `tasks:[]` returns 200 (AWS: `InvalidParameterException`).
  - **sockerless#619 (Scheduler)** — `CreateSchedule` stores an invalid `ScheduleExpression` (non
    `at()`/`rate()`/`cron()`) without error (AWS: `ValidationException`); distinct from the closed cron
    _evaluation_ gaps #489/#493.
    Both are **non-blocking** — the sim is more lenient than AWS, so our flows (which never send these
    malformed requests) are unaffected, but each lets a downstream regression slip past sim-backed CI.
    Many behaviours were **confirmed conformant** and recorded as locked-in (ECS unknown-taskdef →
    `ClientException` + `ListTasks` pagination; Scheduler `GetSchedule` unknown → `ResourceNotFoundException`;
    CWL `GetLogEvents` pagination + unknown-group → `ResourceNotFoundException`; SM unknown → RNF +
    duplicate-create → `ResourceExistsException`). Recorded in `BUGS.md` → External blockers; adopt on the
    next re-pin once fixed upstream. **Boy-scout:** also reconciled `BUGS.md` — the codex Phase-9 findings
    (merged #129) were still listed as Open "being remediated"; re-verified all 12 against the merged code
    and moved them to Resolved (repo).

- **2026-06-20 — Adopted sockerless #621 (re-pin `322d16ad` → `47b6a2a`); #618/#619 fixed, confirmed
  downstream.** Upstream #621 landed validation for both gaps from fidelity slice 2. Re-pinned the
  submodule to the #621 merge, rebuilt the process-mode sim from source, and re-probed all four cases —
  each now rejects with the AWS-spec error (`RegisterTaskDefinition` Fargate-without-cpu/mem →
  `ClientException`; `RunTask count:11` → `InvalidParameterException` "count cannot be greater than 10";
  empty `DescribeTasks` → `InvalidParameterException` "Tasks cannot be empty."; Scheduler bad
  `ScheduleExpression` → `ValidationException`), while the valid-form control cases (a cpu+mem Fargate td
  and a `rate(5 minutes)` schedule) still pass. The re-pin also picks up #612–#620 (CloudWatch Logs
  Insights, Docker-faithfulness + concurrency fixes, a cross-cloud behavioural audit) — consumed
  endpoint-only; the integration + e2e CI tiers rebuild the sim from this pin and validate the rest.
  Closed #618 (auto) and #619 (manually, with a confirmed-downstream note). `BUGS.md` → External
  blockers updated to fixed-confirmed; **no open sockerless blockers remain** (aside from the deliberate
  #583 memory-sizing gate).

- **2026-06-20 — IAM permission self-check + identity surfacing (config-sync extension).** The app now
  understands the IAM actions each runtime component needs and checks it actually holds them, per the
  user's request (hybrid verification + a CI drift gate, both confirmed). New pure core
  (`@edd/core` `iam-requirements.ts`): `IAM_REQUIREMENTS` — the per-component (control-plane, reconciler)
  required-action manifest, the single source of truth derived from `iam.tf`, with the condition context
  scoped grants need (`ecs:cluster`, `aws:ResourceTag/edd:managed`, `iam:PassedToService`); plus pure
  `evaluateIamPermissions` (fold a live simulate signal → ok/drift/unknown). Shell adapter
  (`apps/web/lib/iam-preflight.ts`): `sts:GetCallerIdentity` + `iam:SimulatePrincipalPolicy` over the
  control plane's OWN identity, resolving representative resource ARNs from coordinates + the caller
  account; endpoint-only (§6.9), fail-fast (`maxAttempts:2`), degrades to `unknown` (never a false
  drift) off real AWS / when simulate isn't permitted. Folded into the config-sync report as an
  `iam-permissions:control-plane` check. **Identity surfacing:** the resolved caller identity
  (account + principal/caller ARN) rides the same report → admin Infrastructure card, the
  `/api/admin/config-sync` contract, the api-client, and the `edd config-sync`/`doctor` CLI.
  **CI drift gate:** a static test (`iam-policy-drift.test.ts`) asserts the terraform policy grants ⊇ the
  manifest per role (manifest is SSOT, so IaC and the app can't silently diverge), and the terraform-sim
  job gained a live `iam:SimulatePrincipalPolicy` self-check assertion. Terraform: the control-plane role
  gained read-only `iam:SimulatePrincipalPolicy` + `sts:GetCallerIdentity` (introspection only). Tests:
  core 14 (manifest + eval + config-sync passthrough), web 16 (preflight helpers + drift gate +
  config-sync route integ); full lint/build/typecheck green. Reconciler runtime preflight (it has no
  UI/API) left as a noted follow-up — its grants are covered by the manifest + CI drift gate.

- **2026-06-20 — Broad code-quality sweep (6-agent audit) + batch-1 remediation.** Ran a six-dimension
  adversarial audit (API-first/thin-UI, fake telemetry/monitoring, weak types, fake/anemic tests,
  idempotency/self-heal/fail-loud, correctness/UX), each finding traced to the code. The codebase scored
  high (no fabricated metrics, no `any`/`@ts-ignore` in src, strong authz/cost coverage, honest
  degrade-to-`unknown` telemetry). **Batch 1 — correctness + fail-loud + telemetry honesty — fixed and
  tested** on `fix/sweep-correctness-failloud`: `toWorkspaceDto` repoUrl round-trip (A1), heartbeat
  functional self-report on the session path (A2), snapshot lifecycle guard against snapshotting a
  `deleting` tombstone (A3), `/api/admin/logs` unknown-workspaceId no longer leaks the unfiltered stream
  (A4), `create()` compensation no longer masks the original error / leaks on cleanup failure (H2),
  reconciler heartbeat written before the flaky cost/gauge step so a healthy reconciler can't look
  `degraded` (MED-1), and `pruneTaskDefinitions` surfaces a `failed` count + new `reconciler.taskdefs.*`
  metrics instead of a silent success-shaped zero (L1). The remaining findings (weak-type branding,
  AWS-adapter request-shape test fidelity + port contracts, the API-first thin-UI refactor, the quota
  TOCTOU atomic counter, and the UX confirmations/stale-state handling) are recorded in `BUGS.md` →
  Open (Code-quality sweep) for follow-up batches.

- **2026-06-20 — Sweep batch 2: test fidelity (AWS-adapter request shapes + anemic-test fixes).** The
  real EBS/Fargate adapters' tests switched on `command instanceof` but never inspected `command.input`,
  so the security-critical request fields were unverified. Added request-shape assertions: EC2
  (`ec2-storage-provider.test.ts`) — every created volume/snapshot carries the `edd:managed=true` tag
  (the tag that scopes ALL GC), the fresh-vs-hydrate `Size`↔`SnapshotId` branch, list enumeration's
  server-side `tag:` filters + `OwnerIds:self`, and `copySnapshot` issuing against the destination
  region; ECS (`ecs-compute-provider.test.ts`) — `RunTask` carries the `edd:workspace-id` tag (the
  orphan-task reaper reads it back), `launchType:FARGATE`, and the managed-EBS volume's
  `deleteOnTermination` + the snapshot-hydration branch. Also fixed anemic/tautological tests: the role
  mapper (`role-mapping.test.ts`) now covers the `member` branch + admin-beats-member precedence (was
  admin-only); `pricing.test.ts` pins the actual rate literals instead of `=== DEFAULT_*`; the cost
  window→days test derives from the enum (exhaustive) instead of restating the impl literal. Remaining
  test-fidelity follow-up (noted): wire `storageProviderContract` into the storage-ec2 integ tier + add
  a `computeProviderContract` (fake `taskState`/snapshot-hydration parity).

- **2026-06-20 — Sweep batch 3: atomic per-user quota (closes the TOCTOU race).** The create path read
  the owner's count, checked `count < limit`, then created — so concurrent creates (double-click / retry
  storm) all passed the read and all created, bypassing the cap → unbounded Fargate launches. Replaced
  with a true atomic guard (user chose this over a reconciler backstop): a new per-owner
  `ownerWorkspaceCount` entity (`@edd/db`); `WorkspaceService.create` takes a `quotaLimit` and, in the
  SAME `writeTransaction` as the workspace insert + audit event, conditionally increments the counter
  (`ADD count 1` guarded by `attribute_not_exists(count) OR count < limit`) — the (limit+1)th concurrent
  create's transaction cancels and throws the new `QuotaExceededError` (route → 409). `finishDeleting`
  decrements the counter (UNCONDITIONALLY, in the same transaction as the hard-delete, so a counter drift
  can never block a delete). Wired `ownerCounts` into BOTH the web app AND the reconciler's
  `WorkspaceService` (the reconciler is what hard-deletes, so it must decrement — else the counter only
  ever grows). The route's read-check stays as a fast UX gate; the counter is the authoritative
  enforcement. Tests: control-plane integ proves exactly-`limit` sequential creates + a concurrent burst
  that can NEVER exceed the cap + decrement-frees-a-slot; all 46 cp integ + 30 unit green. Follow-up
  noted: a counter-vs-actual drift-reconciliation sweep.

- **2026-06-20 — Big combined PR: API-first thin-UI + weak-type branding + UX + idempotency follow-ups.**
  One large PR completing the bulk of the code-quality sweep's remaining workstreams (built incrementally
  on `feat/sweep-ux-apifirst-types`). **API-first (the reskinnability goal):** the workspace DTO is now
  self-rendering — `availableActions` (moved to `@edd/core` `workspaceActions`, deleting the client-side
  state-machine mirror), the catalog `imageName`/description/tags/tools join, and the `sshCommand` are all
  server-computed and ride the contract (`toWorkspaceDto` + a shared `enrichWorkspace` shell helper, used
  by the route AND the pages); `WorkspaceCard` is a pure renderer; `lib/catalog-details.ts` deleted. The
  two admin views that had no API now do: `quotaReport` + `overviewReport` contracts, `GET
/api/admin/quotas` + `/api/admin/overview` routes, `adminQuotas()`/`adminOverview()` client methods +
  shared builders; Costs got an `adminCosts()` client + the route's `costReportQuery` validation (silent
  `.catch` gone). **Weak-types:** `Principal.id` → `OwnerId` (branded at the identity edge, re-brands
  removed; authz now depends on `@edd/core`); `ownerEmail` → `z.email()`; a typed `AuditAction` union
  (protects the cost ledger's exact-string filter). **UX:** two-step workspace-delete confirm
  (data-loss guard) + auto-refresh-on-409; keep-stale-data Health/Infra boards; repo-load spinner
  resolves; degraded indicator on the owner card; `aria-pressed` picker. **Idempotency:**
  `recordSecurityEvent` is idempotent (deterministic id per workspace/tool/bucket dedupes guard retries).
  Each chunk green through full pre-commit (tsc, turbo test, knip, lint) + targeted integ tests.
  Deliberately deferred (involved / needs a product call, tracked in `BUGS.md`): `SshKeyService`/
  `GitCredentialService` signature branding; billing-at-teardown (rewires the cost model); the
  `finishDeleting` snapshot-retention mechanism; storage/compute port contracts.

- **Deferred-cleanup PR (2026-06-20, `feat/deferred-cleanup-fat-pr`) — closed the last deferred sweep
  items in one PR.** **Weak-type service signatures:** `SshKeyService`/`GitCredentialService` public
  methods take branded ids (`OwnerId`/`SshKeyId`/`SshPublicKey`); `ownerForKey` returns branded ids; a
  closed `GitProviderId` union replaces the bare credential-provider string (named `GitProviderId` to
  avoid the unrelated `GitProvider` app interface). **Port contracts:** `storageProviderContract` gained a
  `{dataIo}` gate so its control-plane subset (volume/snapshot lifecycle + snapshot-hydration lineage +
  retain) runs against the REAL `Ec2StorageProvider` in the integ tier (`dataIo:false`; EBS file bytes
  stay §6.8 — fake/real-AWS only); a new `computeProviderContract` runs against the fake (tier-1) AND the
  real `EcsComputeProvider` in container-mode e2e (the only tier where `runTask` reaches RUNNING), proving
  task-lifecycle + snapshot-hydration parity. **Snapshot retention (Middle policy):** the data-safety
  snapshot taken at teardown is RETAINED via an `edd:retain` tag through the storage port
  (`createSnapshot({retain})` + `tagSnapshotRetained`, read back on `SnapshotRef.retained`) and a GC
  keep-set (`selectOrphanSnapshots` never reaps a retained snapshot); `finishDeleting` takes a fresh
  retained snapshot of a live volume, else tags the existing latest snapshot retained. **Quota-drift
  self-heal:** `WorkspaceService.reconcileOwnerCounts()` recomputes each owner's true live count and
  corrects a drifted per-owner quota counter (the unconditional teardown decrement can drift it), each
  correction conditioned on the observed value so a racing create/delete is never clobbered; wired as a
  reconciler sweep step emitting `reconciler.quota.drift_corrected`. **Billing-to-teardown** (user chose
  "bill until teardown completes"): the cost model gained a fourth **teardown** phase — `session.delete`
  is the delete REQUEST that opens it (compute stops; volume + snapshot keep billing), a new
  `session.terminated` (emitted by `finishDeleting` atomically with the hard-delete + quota decrement)
  closes it and ends billing; threaded through `BillingIntervals`/`BillingState`/`CostBreakdown`, both
  walkers, the cost-rollup record + `costRollup` DB entity + `costBreakdown` contract. The figure-
  equivalence invariant (rollup == full-scan) is preserved (same walker both paths) and extended with
  teardown/terminate checkpoint cases. Green through build + all unit suites + lint; integ/e2e in CI. One
  item still deferred (in `BUGS.md`): a UI Open/Connect affordance (gated on the proxy-domain config).

- **Resiliency + correctness sweep (2026-06-20, `feat/sweep-resiliency-correctness`) — 5-agent audit, all
  fixed, no deferrals.** Parallel agents audited resiliency/concurrency, correctness/cost-model,
  types/fail-loud/telemetry, test-fidelity, and security/data-safety; they confirmed the codebase is
  high-quality and converged on a tight set of genuine bugs, all remediated + tested. **(1)** `finishDeleting`
  data-loss: `snapshotStale` checked only snapshot _absence_, so deleting a `running` workspace with a
  stale prior snapshot retained the OLD snapshot and let the live volume (newer work) be destroyed by
  `deleteOnTermination`; made age-aware (`>= DEFAULT_SNAPSHOT_INTERVAL_MS`) so a live volume with a stale
  snapshot gets a FRESH retained snapshot. **(2)** retained-snapshot leak: `finishDeleting` created a fresh
  retained snapshot but never recorded it, so a delete-transaction cancel (e.g. `TransactionConflict` on the
  owner-count item from a concurrent same-owner create) re-created one each retry, and retained snapshots
  are never GC'd; now records the snapshot id on the tombstone (version-conditioned — the tombstone version
  is stable, so no spurious conflict), so a re-run re-tags it instead (idempotent). **(3)** git credential
  over-scoping: GitHub-App `gitCredential` silently fell back to `installs[0]` when the repo owner had no
  matching App installation, minting a write-capable token for an UNRELATED org; now fails closed (→ 404),
  fall-back only for the no-repo (blank session) case → null. **(4)** retain-tag eventual-consistency window:
  `tagSnapshotRetained` now confirms the tag is durably visible via a strongly-consistent by-id
  `DescribeSnapshots` before `finishDeleting` unreferences the snapshot, closing the window where orphan-GC
  could reap a just-tagged data-safety snapshot (fail-loud → safe retry; the `createSnapshot({retain})` path
  already had no window — the tag rides `TagSpecifications` at creation). Tests added for every fix +
  adjacent gaps (stale-snapshot data-loss, stopped-delete tag branch, idempotent re-run, GC keep-set spares
  retained, start-during-teardown, terminate-without-delete, teardown-nonzero sentinel, credential
  fail-closed). The audit verified clean: the two cost walkers' figure-equivalence (brute-forced to length-4
  event sequences across checkpoints, incl. inside-teardown), the lifecycle state machine + `workspaceActions`,
  DTO faithfulness, authz/secret-handling (branding is a compile-time phantom — no runtime comparison
  weakened), and telemetry honesty (every metric/gauge/health value traces to a real measurement). This PR
  also folds in the sockerless #629/#630 fidelity record + the submodule re-pin to `693b39a7` (#631 fix +
  #632 sweep; confirmed downstream — integ tiers green).

- **Breadth sweep (2026-06-20, `feat/sweep-breadth-resiliency`) — 5-agent audit of the under-covered
  surface, all fixed, no deferrals.** Prior sweeps went deep on control-plane/cost/reconciler/storage; this
  one targeted the gateway/proxy/auth chain, the DB + cloud-adapter layer, the HTTP route surface, and
  shell/IaC/config. No critical bypass (the auth chain fails closed). Genuine MEDIUM/LOW bugs fixed: auth
  group matching was case-SENSITIVE (a GitHub-slug casing mismatch silently downgraded the role) → now
  case-insensitive; `github-teams` fetched only page 1 of `/user/teams` (a later-page admin team dropped) →
  now follows all pages + fails loud past a cap; `base-images` POST mapped EVERY error to 409 + leaked the
  raw message (no conflict condition — removed the catch); `github/repos` POST surfaced a 422 name-collision
  as a bodiless 500 → typed `GitHubApiError` mapped to 409; `connect-info` validated before authenticating
  (pre-auth status leak) and 404'd an unbound-host running workspace → auth-first + retry-able 409;
  `pomerium-assertion` didn't require `exp` (non-expiring token) → `requiredClaims:['exp']` + clockTolerance;
  `toLogLine` coerced a missing timestamp to epoch → throws; the EMF sink now throws on a
  dimension/metric-name collision; `db.ensureTable` waits for ACTIVE (real-AWS CreateTable returns CREATING);
  `api-client.connectInfo` gained the `protocol` arg; `cli status` gates its exit code on cluster health;
  `withObservability` guards the request-id header set; both `authorized-keys.sh` hops gained a fail-closed
  charset guard on sshd-supplied key fields before JSON interpolation. (A `/run/edd-env` group-restriction
  was attempted but reverted after the ssh-wake-chain e2e failed — its two readers, `nobody` and the dev-\*
  login, are distinct users and sshd command sessions don't reliably carry a shared supplementary group, so
  restricting the file broke the wake; it stays world-readable in this single-purpose proxy.) Tests:
  case-insensitive role mapping,
  teams pagination, EMF collision throw, toLogLine throw. Verified clean: machine-auth, token-crypto, the
  PDP/gate fail-closed paths, IAM least-privilege, config validation, golden-image entrypoint, time handling
  (§6.10). Dismissed after verification: `nc -q0` is fine (Debian netcat-openbsd supports `-q`).
