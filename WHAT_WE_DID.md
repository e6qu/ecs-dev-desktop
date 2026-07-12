# WHAT_WE_DID.md — ecs-dev-desktop

> Durable decisions/lessons + a compressed milestone timeline. For the sockerless
> issue saga see `BUGS.md`. Append new entries at the bottom (past tense).

---

## Key decisions & lessons (durable)

- **Architecture (locked, `AGENTS.md` §1):** ECS Fargate; DynamoDB single-table +
  ElectroDB (over Aurora); OpenSSH registered-key auth (no CA — dual-trust via
  `ssh-authorize`); the browser→editor proxy is **in-process in the Next.js app** at a
  **path-based single domain** (`app.<domain>/w/<id>/`), authorized by the Auth.js session
  (uid-ownership/admin) — Pomerium + the standalone `workspace-gate` were removed 2026-06-20
  (no wildcard DNS/TLS); EBS-snapshot-as-persistence + scale-to-zero; Auth.js + CASL.
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
  negative-path tests** (developer/viewer → 403, unauth → 401 for all five `/api/admin/*`
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

- **2026-07-08** — **PR #206 deployed the workspace-open/vendor-harness fixes.** The
  merge commit `3561532b4ee5` rolled to production, `/api/healthz` reported that
  deploy SHA, `/api/readyz` was ready, `/workspaces` rendered HTTP 200 instead of
  the earlier Next.js digest, and post-deploy smoke passed. The golden-images
  workflow then pushed `edd-prod/golden/omnibus:3561532b4ee5` and the production
  catalog pointed at it. Existing Claude/Codex workspaces stayed errored because
  they were old records on the previous `f82e61db669c` image; fresh authenticated
  workspace creation/opening for all four interface modes still needed live
  browser verification.

- **2026-07-10** — **The Claude/Codex/opencode local-web assumptions were
  re-audited from evidence.** The project stopped treating OpenVSCode extension
  UIs, Monaco, Remote Control, Desktop, Platform, or hosted web products as
  acceptable substitutes for a selected "local web UI" workspace mode.
  `opencode web` was verified from official docs/source and a local Playwright
  screenshot at `/private/tmp/opencode-local-web.png`: it started a local
  browser UI protected by `OPENCODE_SERVER_PASSWORD`. Codex 0.144.0
  `app-server` was verified from official OpenAI source/manual, local startup,
  and `/private/tmp/codex-app-server-root.png` as a JSON-RPC/WebSocket protocol
  server with health probes, not an HTTP web UI. Claude Code 2.1.202 was checked
  through installed CLI help, `claude agents --json --all`, `claude daemon
status`, `claude web --help`, `claude serve --help`, the installed version
  tree, and official CLI/agent-view docs; no local browser UI command or static
  web bundle was found. `docs/workspace-agent-harnesses.md` was updated so
  Claude/Codex workspace modes stayed blocked/fail-loud until the exact
  first-party local browser command/client bundle was identified and
  screenshot-verified locally.

- **2026-07-10** — **PR #217 merged but release failed before deployment.** The
  merge commit `b95844c334e7453acb2f21b5e7f6ccb584420c8f` triggered `release`
  and `golden-images`, but `release` failed in `Build & push images` before ECS
  deployment. Production still reported `deploy.sha=3886482cd83f` and
  `/api/readyz` was ready. The release log showed the new direct BuildKit push
  mode had produced `edd-prod/control-plane:b95844c334e7-amd64` as a manifest
  list, then `docker manifest create` failed because it expected per-arch image
  manifests. The follow-up branch changed the direct-push manifest publication
  path to `docker buildx imagetools create` and kept the existing local-load
  manifest path unchanged. The branch also refreshed newly age-eligible
  `vite`/AWS SDK dependencies after `check-deps` caught them on PR #218.

- **2026-07-10** — **The live AWS account was audited and non-EDD leftovers were
  removed.** Cost Explorer was checked for both net unblended cost and usage-only
  gross spend, and live AWS resources were enumerated directly across enabled
  regions instead of trusting Terraform state. The audit found EDD's running
  control-plane, SSH gateway, NAT instance, load balancers, ECR repos, DynamoDB,
  SQS, WAF, Route53, KMS, Secrets Manager, CloudWatch, and retained snapshots,
  plus non-EDD sockerless leftovers. After the operator chose to keep only
  EDD-related resources, the sockerless S3 state buckets, `sockerless-volumes`
  EFS filesystem/access points, sockerless/skls CloudWatch log groups, old
  sockerless ECS task definitions, and the non-EDD ECR cache repository were
  deleted. Fresh checks showed only EDD ECR repositories, only the EDD Terraform
  S3 bucket, no EFS filesystems, and sockerless task definitions moving through
  AWS `DELETE_IN_PROGRESS`.

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

- **2026-07-07** — **Image-source reconcile and fail-loud cleanup branch.** After PR
  #197 was merged and deployed, production showed that successful golden CodeBuild
  runs only reconciled when `/admin/images` was read and that the Terraform-seeded
  catalog row lacked the required CAS `version`. The follow-up branch moved
  image-source reconciliation into the long-lived custom server startup/interval,
  made Terraform seed `version = 0`, and made `CatalogService` reject malformed
  catalog rows without compatibility fallback. Verification also removed hidden
  fallbacks: e2e production web harnesses supplied explicit image-source coordinates,
  dev-auth required per-account passwords, unknown editor values threw, and
  `claude`/`codex` workspace images exited loudly until the vendor local web UI
  harnesses were wired. A sockerless DynamoDB read/mutation panic was reported as
  `e6qu/sockerless#777`, fixed upstream by `e6qu/sockerless#778`, and pinned at
  `b5126463` by snapshotting stored items under lock; editor-monaco tests were
  tightened to loopback binds.
  `AGENTS.md` was clarified to allow only one active work branch and one active PR
  at a time, with no duplicate, parallel, or stacked PRs while that work was active.
  It also recorded the project norm that agents should resist tiny anemic PRs:
  related fixes, tests, docs, and cleanup belong in the active chunky PR until the
  human in command says to stop.
  After opening PR #198, CI exposed that the Playwright production custom-server
  harness still lacked the required image-source coordinates; the harness was
  fixed with explicit Playwright-only coordinates, and the observed
  `NO_COLOR`/`FORCE_COLOR` warning was removed at the Playwright process boundary.
  CI action warnings were cleaned by bumping age-eligible `actions/cache` and
  then replacing `pnpm/action-setup` with Corepack after its self-installer still
  emitted audit warnings. The `editor-token-handshake` test harness was hardened
  so loopback bind failures failed immediately and teardown stayed safe. The live
  Playwright e2e harness was then fixed with the same explicit image-source
  coordinates, and its browser lifecycle passed locally against the container-mode
  simulator. Circle-`i` help/details panels were moved to fixed overlays so they
  no longer altered page/card layout, and deleted-workspace snapshot behavior was
  pinned so terminated tombstones were neither explicit nor scheduled snapshot
  targets.

- **2026-07-10** — **Local Docker recovery unblocked simulator Playwright and
  dependency drift was reconciled.** After PR #216 merged, the local worktree was
  reset onto current `origin/main` on `chore/reconcile-local-docker-state` and
  stale pre-merge local edits were stashed. The host Docker-compatible runtime was
  repaired around Podman, Docker Compose 5.3.1 was installed, and the sockerless
  AWS simulator was built and started through `docker-compose.tier2.yml`.
  `pnpm --filter web test:pw` then passed 19/19 locally, replacing the earlier
  "simulator unavailable" non-result with a real browser assertion result.

  The same run found a packaging bug after `node_modules` was recreated:
  server-side Next.js code imported `@aws-sdk/client-sesv2` and other AWS runtime
  clients while those packages were declared only as dev dependencies. The branch
  moved the runtime AWS SDK clients into `apps/web` dependencies, refreshed
  age-eligible package drift, and kept TypeScript on `6.0.3` because
  `typescript-eslint@8.63.0` declared `typescript >=4.8.4 <6.1.0`. `check-deps`
  was made peer-aware for that single verified TypeScript case while continuing
  to fail loudly for any other stale JS dependency. Verification passed with the
  frozen install, dependency gate, shell checks, lint, build, unit tests,
  Playwright, and whitespace checks.

- **2026-07-07** — **GitHub Actions → AWS release bootstrap shipped.** After PR #200
  merged, the release workflow failed loudly at AWS authentication because no
  release OIDC role or GitHub coordinate variables existed. The follow-up branch
  documented and automated the AWS bootstrap step with
  `scripts/bootstrap-release-oidc.sh`: it created/updated the GitHub Actions OIDC
  provider, constrained the release role trust to this repository's `main` branch
  and `v*` tags, granted only the ECR push/read actions needed for the
  Terraform-created `control-plane` and `ssh-gateway` repositories, and wrote only
  non-secret GitHub repo variables. Static secrets were not stored in GitHub
  variables or secrets. The branch also made the release and `e2e-aws` workflows
  require explicit coordinates with no default region/account fallback and bumped
  action pins to age-eligible Node 24 releases. The real `main release` rerun for
  PR #200 merge commit `2c5fe20b99a675a19eb35ee937e4033f79942489` succeeded and
  ECR contained `edd-prod/control-plane:2c5fe20b99a6` and
  `edd-prod/ssh-gateway:2c5fe20b99a6`. During validation, `pnpm check-deps` found
  age-eligible drift in `@casl/ability` and `turbo`, so both were refreshed and
  the lockfile was committed. The same sweep fixed editor-monaco's loopback test
  harness so bind failures rejected immediately instead of timing out with
  unhandled `listen` errors.

- **2026-07-08** — **Golden images moved to async GitHub CI; catalog rollout race
  fixed.** After PR #202 merged, production verified the recovered release path:
  GitHub Actions run `28901563184` pushed control-plane and SSH images for
  `881c88c504e3`, registered task definitions `:27`, rolled the ECS services, and
  retargeted the reconciler schedule. The same inspection found the workspace
  golden image existed in ECR but the base-image catalog still pointed at
  `omnibus:89c3cdee68d1`; DynamoDB showed the latest trigger failed with
  `catalog rollout failed: rollout of edd-prod/golden/omnibus lost a concurrent update`.
  The branch traced that to EDD app code: multiple successful golden triggers
  reconciled concurrently and raced the catalog CAS. The fix made only the newest
  successful golden trigger roll catalog state, marked older successful tags as
  superseded, and retried catalog-rollout failures.

  The branch also moved workspace/golden image publishing out of the EDD app and
  into a separate `golden-images` workflow that runs on `main` and manual dispatch,
  non-blocking to the `release` workflow. The app no longer started CodeBuild for
  source observations; it queued expected tags, verified ECR image presence, and
  exposed source/image/trigger state in `/admin/images`. The admin UI removed the
  app-started rebuild control, while legacy CodeBuild history remained read-only
  for older rows/tooling. `scripts/bootstrap-release-oidc.sh` was extended with
  required `EDD_RELEASE_GOLDEN_VARIANTS`; the real `edd-prod` bootstrap was rerun
  with `omnibus`, updating the GitHub OIDC role for `edd-prod/golden/*` and writing
  only non-secret GitHub repo variables. Deploy speed/no-downtime settings were
  tightened by reducing ALB/NLB health checks to 10 seconds and setting explicit
  SSH service 100%/200% rolling deployment bounds. The dependency gate was hardened
  so Terraform init errors or missing Terraform failed loudly.

  Verification passed across the broad local gates: targeted image-source tests,
  `@edd/web` lint/build/test, repo `pnpm lint`, `pnpm build`, `pnpm test`,
  `pnpm test:integ`, `pnpm test:e2e:local`, `pnpm check-deps`, `pnpm dead-code`,
  `actionlint`, `shellcheck`, Terraform fmt, and Terraform validate with
  Terraform 1.15.7 and provider/network access. The container-mode e2e suite passed
  lifecycle, data fidelity, OpenVSCode, Monaco, SSH wake, ECS Exec, reconciler,
  and workspace-toolchain checks; the per-variant image e2e file skipped locally
  because the dedicated `golden-images` workflow built and tested those images.
  The first PR #203 CI run exposed one stale assertion in `terraform-sim`: the
  workflow still expected ALB target-group health checks every 30 seconds after
  the branch intentionally changed the module default to 10 seconds. The assertion
  and a stale adversarial-slice comment were corrected, and the rerun on head
  `1aa4a6c7c616195d1c797dfa3646e58b7fe7cb49` passed all PR checks; GitHub reported
  merge state `CLEAN`.

- **2026-07-08** — **Fixed post-#203 golden-image CI, per-workspace sizing, and
  faster release builds.** After PR #203 merged, GitHub release run
  `28907270779` for commit `b44acf698aaf68af3e4a9640e6eeb3ef025913fd`
  succeeded: ECR contained `edd-prod/control-plane:b44acf698aaf` and
  `edd-prod/ssh-gateway:b44acf698aaf`, ECS cluster `edd-prod-workspaces` ran
  control-plane desired/running `2/2` and SSH `1/1` on task definition revision
  `:28`, and `https://app.edd.e6qu.dev/api/healthz` plus `/api/readyz` returned
  healthy/ready. The separate `golden-images` workflow still failed. First,
  `edd-prod/edd-base` was missing; after the repo was created, the rerun failed
  because `scripts/publish-images.sh` had built the base image locally but never
  pushed `edd-base:<tag>-amd64` before variants used that ECR tag as `FROM`. The
  branch added a Terraform-managed `${name}/edd-base` repository with immutable
  tags, scan-on-push, KMS encryption, and lifecycle retention; expanded release
  OIDC bootstrap IAM to that exact repo; and pushed the per-arch base tag before
  variant builds. The live `edd-prod/edd-base` repo was reconciled into ignored
  local Terraform operator state via import of
  `module.ecs_dev_desktop.aws_ecr_repository.golden_base` and its lifecycle
  policy, then tagged to match the module.

  Workspace sizing moved from deployment-global config to per-workspace state.
  Creation accepted CPU, RAM, and disk choices with defaults of 0.5 vCPU, 2 GiB
  RAM, and 8 GiB disk and limits of 4 vCPU, 16 GiB RAM, and 64 GiB disk. Core
  validation enforced valid Fargate CPU/RAM combinations; API contracts, DB
  entities, DTOs, control-plane launch/start flows, ECS task-definition
  registration, managed-EBS volume creation, cards/details/monitoring UI, and cost
  reports all carried those resources. No compatibility fallback was added:
  persisted workspaces require `resources`, and cost reports fail loudly when a
  deleted workspace's old session cannot be priced from stored resource detail.

  The same branch made release/golden builds faster without adding a fallback
  path: release builds became AMD64-only and removed QEMU, both release and golden
  builds used Buildx GitHub cache, the web Dockerfile copied manifests before
  source for better layer reuse, and the ECS control-plane container health check
  interval/start period dropped to 10 seconds. Verification passed with
  `pnpm lint`, `pnpm build`, unsandboxed full `pnpm test`, focused unsandboxed
  `@edd/editor-monaco` loopback tests, `actionlint`, `shellcheck` on the changed
  scripts, Terraform fmt, and Terraform init/validate for the module and complete
  example with provider/network access.

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

- **2026-07-01 — Third adversarial spec-fidelity probe wave PR #179 green (sockerless #737).** Bumped the `third_party/sockerless` submodule to `38e311ac` (sockerless #737), which fixed **#731** (Route53 wildcard DNS) and **#732** (KMS real encryption + key-policy Deny enforcement). Added ten adversarial spec-fidelity probe slices in `infra/terraform/modules/ecs-dev-desktop/tests/sim/` — CloudWatch Alarm → SNS, Route53 DNS, ACM + ALB TLS, KMS encryption-in-use, EC2 SG network-layer enforcement, ECS rolling update + circuit breaker, S3 backend encryption/lifecycle, EBS cross-region snapshot copy, Budgets notification, and ECS reconciler heal — and wired them into the `terraform-sim` CI job via `run-adversarial-slices.sh`. Hardened `adversarial-slice-acm-tls.sh` to create an A-record → `127.0.0.1`, resolve through the sim's authoritative DNS server, and retry the TLS handshake; added `docker-compose.tier2.host.yml` so the Linux CI runner can reach the sockerless ALB/NLB TLS data plane bound to container loopback. Fixed a `shellcheck` SC2015 warning in `adversarial-slice-kms-encryption.sh` and refreshed Node dependencies with `pnpm update --latest -r` to clear the `check-deps` gate. Fixed a fuzz failure in `@edd/demo` (`format.ts:pct`) by guarding against non-finite `maxUsd`. Fixed the `e2e-https` CI job to bring up `docker-compose.https.yml` (azure-sim + aws-sim + bleephub) instead of only the plain AWS sim, so the Entra + Auth.js callback-route tests can reach their simulators. Full CI is now green. The only remaining upstream blocker is **e6qu/sockerless#734** (CloudWatch Alarm → SNS → SQS message delivery), so that probe skips SQS receipt verification but still proves alarm state transition and AlarmActions wiring.

- **2026-07-03 — sockerless #764 adds fan-out observability + OAuth team fidelity; submodule re-pinned to `6756ecfb`.** sockerless **#764** closes **e6qu/sockerless#762** by adding Info-level logging at every SNS→SQS fan-out decision point (subscription count, matching subscriptions, delivery attempts, policy-denied/missing-target skips, successful enqueue), and closes **e6qu/sockerless#763** by making bleephub emit `X-OAuth-Scopes` for web-flow tokens so `GET /user/teams` returns the user's team memberships. Re-pinned `third_party/sockerless` to `6756ecfb`. PR #180 is now running through CI for verification.

- **2026-07-03 — sockerless #761 logs dispatch but SQS still empty; bleephub teams now empty; filed #762 and #763.** CI re-run **28655396822** after the #761 bump showed progress: the simulator now logs `CloudWatch alarm dispatching actions` and `CloudWatch alarm transitioned` for `cli-alarm-sns-sqs-process-745`, but no `SNS.Publish` request is logged and the SQS queue stays empty. Filed **e6qu/sockerless#762** asking for logging of the SNS `Publish` outcome. The same CI run showed the bleephub `/user/teams` endpoint now returns an empty list after #756, so GitHub OAuth role mapping falls back to `viewer` instead of `admin`; filed **e6qu/sockerless#763**. Refreshed Node dependencies with `pnpm update --latest -r`; `pnpm check-deps` passes locally.

- **2026-07-03 — sockerless #759 only adds a regression test; no simulator fix; filed e6qu/sockerless#760.** Bumped `third_party/sockerless` to `2fde669` (#759), which added a dangling-alarm SDK regression test but no simulator code changes. Our integrated `terraform-sim` CloudWatch Alarm → SNS probe still fails with the same symptoms, so **e6qu/sockerless#760** was filed asking whether a follow-up fix is needed and how to instrument the simulator. The probe re-uses the fixed alarm name `cli-alarm-sns-sqs-process-745`, which may collide with leftovers from prior Terraform apply/destroy cycles.

- **2026-07-03 — sockerless #756 fixes both #753 and #754; submodule re-pinned to `a3448639`.** The integrated CloudWatch Alarm → SNS probe failure persisted after sockerless #751, so **e6qu/sockerless#753** was filed. sockerless **#756** resolved it by moving the evaluator's last-dispatched state onto each alarm's persisted state (so alarm replacement naturally resets it) and adding panic recovery in the evaluator loop. The same PR fixed the bleephub `/user/teams` 403 regression reported in **e6qu/sockerless#754** by removing the OAuth-scope gate. Re-pinned `third_party/sockerless` to `a3448639`. PR #180 is now running through CI for verification.

- **2026-07-02 — Strict CloudWatch Alarm → SNS probe: upstream fix landed, verifying in CI.** On PR #180, removed the SQS-receipt workaround in `adversarial-slice-cloudwatch-alarm-sns.sh` so the probe fails loudly. Bumped `third_party/sockerless` through `059dff89` (#739), `1896cb22` (#742), and `8bf4ed69` (#748). Rewrote the probe to match the upstream #748 regression test as closely as possible (removed `--treat-missing-data notBreaching`, `--alarm-description`, explicit timestamp, and diagnostic SNS publish; switched to `--metric-data` JSON array; used env vars `AWS_ENDPOINT_URL`/`AWS_DEFAULT_REGION`/`AWS_PAGER` instead of CLI flags; used exact upstream resource names). CI run **28573699565** still failed `terraform-sim`: the alarm transitioned to `ALARM`, but simulator request logs showed **no `SNS.Publish`** and the SQS queue stayed empty. sockerless #748's isolated CLI test passes; the integrated environment after Terraform apply/destroy cycles did not. Filed **e6qu/sockerless#749** with the failure evidence. sockerless **#751** fixed #749 by resetting the CloudWatch alarm evaluator state on `PutMetricAlarm`; re-pinned `third_party/sockerless` to `3d85b89`. PR #180 is now running through CI for verification.

- **2026-06-29** — **Sockerless submodule re-pinned to `35f0f087` (#715); Budgets Terraform lifecycle gap closed.** Adopted the upstream merge that fixes the follow-up Budgets issue #714. Re-pinned from `dd2eb3ab` to `35f0f087`, rebuilt the process-mode sim, and re-ran the new behavioral probe suite with `monthly_budget_usd=100`: the `aws_budgets_budget` resource now creates, refreshes, and destroys cleanly through the Terraform provider. All 13 probes pass. Updated continuity files to mark #714 resolved.

- **2026-06-29** — **Heavy container-mode e2e passes locally on Podman.** Tried to run `pnpm test:e2e:local`. It initially failed because `scripts/test-e2e.sh` was calling raw `docker build -t edd-base:e2e infra/images/base`, but the base Dockerfile `COPY`s the staged `@edd/editor-monaco` bundle that only `build.sh` produces. Fixed `scripts/test-e2e.sh` (and `TESTING.md` / `infra/images/README.md`) to use `infra/images/base/build.sh`. The dev workstation exposes Podman 5.4.2 through the Docker CLI, and Podman's default `docker buildx` builder is the `docker-container` driver, which does not load images into the local store for subsequent `docker build`/`docker buildx build` `FROM` resolution. Fixed `infra/images/base/build.sh` to auto-detect a Podman backend (`docker version | grep 'Podman Engine'`) and use `podman build` directly for non-buildx runs. Fixed `scripts/test-e2e.sh` to start a local insecure registry on `localhost:15000` (macOS AirPlay binds :5000), push the reconciler, proxy, base, workspace, and node images there, and set `WORKSPACE_IMAGE`, `RECONCILER_IMAGE`, `PROXY_IMAGE`, and `NODE_IMAGE` to the fully-qualified registry refs. Added those four vars to `turbo.json` `test:e2e` env pass-through so they reach the test processes. Re-ran the suite: **19/19 tasks**, `@edd/e2e` 46/46 tests passed, 5 skipped (variant images not built).

- **2026-06-29** — **Sockerless submodule re-pinned to `dd2eb3ab` (#713); module-wide fidelity audit validated through integration tier + new behavioral probe suite.** Adopted the upstream merge that closed all ten filed gaps (#703–#712). Validated downstream: `pnpm build`/`test` green; `pnpm test:integ` green across web (130/130), reconciler (9/9), storage-ec2 (15/15), and the lightweight e2e integ (1/1); `terraform-sim` default apply/destroy + idempotency re-plan pass. Added `infra/terraform/modules/ecs-dev-desktop/tests/sim/validate-sockerless-713.sh`, an endpoint-only behavioral probe suite that applies the module with `enable_dns=true` and validates all ten fixed surfaces end-to-end: ACM PEM (#708), Route53 DNS (#710), ELBv2 HTTPS cert attachment (#709), Budgets API (#703), SQS DLQ redrive (#704), CloudWatch alarm SNS actions (#705), CloudWatch Logs metric-filter→metrics (#706), AppAutoScaling target tracking (#707), ECS scheduler DesiredCount reconciliation (#711), and security-group ingress rules (#712). Exposed the sim's Route53 DNS port in `docker-compose.tier2.yml` (host port `15353` → container `5353`) so the probe can resolve records from the host. Fixed the `tests/sim` fixture to include the `budgets` provider endpoint and allow STS account-id resolution (`skip_requesting_account_id = false`). Surfaced one new focused upstream gap during probe development — sockerless **#714** (`aws_budgets_budget` Terraform lifecycle blocked by missing `ListTagsForResource` and implicit `AccountId` handling) — filed in `e6qu/sockerless`; the Budgets API itself is covered via CLI/SDK in the probe suite, and the sim fixture keeps `monthly_budget_usd` default `0` to avoid the bug. Updated `docs/simulator-live-coverage.md` with the new coverage and the #714 blocker.

- **2026-06-29** — **Adversarial spec-fidelity slice on ECR/CloudTrail/KMS passes; leftover probe resources cleaned up.** Ran `infra/terraform/modules/ecs-dev-desktop/tests/sim/adversarial-slice-probe.sh` against sockerless `35f0f087` and confirmed all probes pass: ECR repository creation with `IMMUTABLE` tag mutability, `scanOnPush`, KMS encryption, lifecycle policy, repository policy, and `GetAuthorizationToken` shape; `BatchGetImage` returns `ImageNotFound` failure entries for missing tags; CloudTrail `LookupEvents` paginates past 50 events, filters by `EventSource`, and respects `StartTime`/`EndTime`; KMS key creation, alias, rotation enablement, policy round-trip, and `GenerateDataKey` all conform. Cleaned up all probe-created resources (ECR repos, ECS clusters, KMS aliases) after the run.

- **2026-06-29** — **CloudWatch Logs adversarial spec-fidelity slice passes.** Added `infra/terraform/modules/ecs-dev-desktop/tests/sim/adversarial-slice-cloudwatch-logs.sh` (POSIX sh, shellcheck-clean, endpoint-only) and ran it against sockerless `35f0f087`. It validates `CreateLogGroup` with `kmsKeyId` persistence through `DescribeLogGroups`, `PutRetentionPolicy` round-trip, `CreateLogStream` + `PutLogEvents` + `GetLogEvents`, `FilterLogEvents` pattern matching, and clean `DeleteLogStream` + `DeleteLogGroup`. All probes pass; the script self-cleans the log group and stream it creates.

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
  denied on every workspace verb, developer can't mutate the catalog, unauth →
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
  in via the form as admin/developer/viewer and asserts role-appropriate access,
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
  mapper (`role-mapping.test.ts`) now covers the `developer` branch + admin-beats-developer precedence (was
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

- **UI/contract/perf/gate sweep (2026-06-20, `feat/sweep-ui-contracts-perf`) — 4-agent audit + type-safety
  hardening, all fixed.** Targeted the still-under-covered surface (UI/React, Zod contract tightness, 200+
  scale, gate/harness) plus the user's directive to make bug classes non-representable via types.
  **Type-safety:** `quotaReport.limit`→`int().nonnegative().nullable()`, `quotaReport.role`→a closed enum,
  `costBreakdown` USD/Ms→`nonnegative()`/`int()`, `sshConnectInfo.host`→`min(1)`; and `workspaceLimit` now
  THROWS on a negative/fractional/non-numeric `EDD_QUOTA_*` override (a negative would lock the role out of
  creating) instead of silently driving quota — so the stricter contract invariant holds at the source.
  **Gate (HIGH — one PEP fronts every workspace):** added a PDP-fetch timeout (fails closed 502), upstream
  HTTP + upgrade timeouts, and registered the upgrade-path client-close teardown BEFORE the upstream
  upgrades, closing socket/fd-leak vectors a slow PDP/upstream could exploit. **Scale:** the cost rollup was
  wired but NEVER regenerated (every cost read full-scanned the append-only ledger O(history)) — added
  `CostService.rollupIfStale(cadence)` called each reconciler sweep so `report()`, the fleet-cost gauge, and
  `/admin/costs` stay O(recent) with unchanged figures; the quota report now shares the short-TTL cached
  fleet scan. **Correctness:** `finishDeleting` now decides a fresh teardown snapshot from `deleteRequestedAt`
  (`needsFreshTeardownSnapshot`, replacing #139's age heuristic) so a stuck-teardown retry can never
  re-create the retained snapshot (the >6h leak window is gone) and it's more data-safe; `NewSession`
  surfaces a failed namespaces fetch (was a false "no permission"); `BaseImageActions` re-syncs on error;
  `usePoll` applies only the latest-started run. **Harness:** the `ssh-authorize` e2e stub verifies the
  per-workspace HMAC bearer (derived from the secret + the workspace id in the path). **API-first:** the
  off-contract `POST /admin/costs/rollup` gained a `costRollupResponse` contract + `adminCostsRollup()`.
  Tests added: quota fail-loud, `rollupIfStale` (empty/fresh/stale). Verified clean: machine-auth,
  token-crypto, the gate auth ordering, the cost walkers, DTO faithfulness. Recorded (in BUGS.md) as
  optimizations of correct code rather than bugs — the per-sweep reconciler table re-scans, the drift
  sweep's serial per-workspace `DescribeTasks`, and the single-partition `auditEvent.byTime` GSI (sharding
  would risk the figure-equivalence invariant; on-demand adaptive capacity covers the 200 target).

- **2026-06-20 — Removed Pomerium + the standalone workspace-gate; folded the editor proxy into the
  Next.js app (path-based, single-domain, single-auth).** Clean break — no production users, no legacy
  shim (`AGENTS.md` §0). The browser→VS Code editor reach moved out of the external identity-aware proxy
  (Pomerium) + the separate `workspace-gate` PEP/PDP chain and INTO the control-plane app itself. **Custom
  Next.js server** (`apps/web/server.ts`, run via `tsx` in dev AND prod — replaced `next start`) serves the
  portal/admin/API and proxies the per-user editor at `app.<domain>/w/<id>/` (HTTP + WebSocket upgrade), the
  proxy logic living in `apps/web/lib/workspace-proxy.ts`. **Path-based routing on a single domain**
  (`/w/<workspace-id>/`) replaced wildcard-subdomain routing for the browser/HTTP path — no wildcard DNS, no
  wildcard TLS cert, no cross-subdomain cookie (SSH keeps its own `<ws-id>.<ssh-base-domain>` zone,
  unchanged). **Single auth system:** the same Auth.js (NextAuth) session authorizes the proxy, with
  **uid-based ownership** (`session.uid === workspace.ownerId`) or admin checked **in-process** — no
  Pomerium JWT assertion, no PDP `/api/internal/authz` round-trip, no gate machine-auth token, no email
  bridge. The decision is a pure pair in `@edd/core` (`decideWorkspaceAccessBySubject` +
  `workspaceIdFromPath`); the old email-based `decideWorkspaceAccess`/`workspaceIdFromHost` were deleted. The
  golden workspace image now runs OpenVSCode with `--server-base-path /w/<id>/`; a path-based **Open editor**
  link was added to `WorkspaceCard` (shown for running/idle/stopped — stopped wakes on connect). `connect-info`
  was simplified to **SSH-only** (the in-app proxy resolves the editor upstream in-process; the SSH gateway
  remains its only caller). **Tests:** added `apps/web/lib/workspace-proxy.test.ts` (authz glue:
  unauthenticated→login, unknown-ws→forbidden, owner→allow, other→forbidden, admin→allow, no-subject→forbidden);
  the vscode browser e2e (`test:pw:vscode`) now drives the editor under the `/w/<id>/` base path. **Deleted:**
  `services/workspace-gate/` (whole), `infra/proxy/` (Pomerium yaml), `apps/web/app/api/internal/authz/`,
  `apps/web/lib/pomerium-assertion.*`, the `pomerium-*`/`workspace-gate.pwgate`/`gate-global-setup` e2e +
  playwright configs, `packages/e2e/src/pomerium-*` + `proxy-routing.e2e.ts`, `docker-compose.gate.yml`,
  `scripts/test-gate-e2e.sh`, the `e2e-gate` CI job, and the config constants
  `POMERIUM_*`/`WORKSPACE_HOST_HEADER`/`WORKSPACE_AUTHZ_PATH`/`GATE_PDP_TIMEOUT_MS`/`workspaceGate`/
  `WORKSPACE_BASE_DOMAIN` (`GATE_UPSTREAM_TIMEOUT_MS` was renamed `WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS`).
  **Kept** (NOT Pomerium): the SSH gateway (`services/ssh-gateway`), `scripts/gen-sim-tls-cert.sh` + the
  `e2e-https` CI job + `docker-compose.https.yml` (these serve the Entra/Azure auth-over-TLS + EBS-over-TLS
  e2e, not Pomerium — only the Pomerium-specific SANs were trimmed from the cert; the tier stays). Verified at
  close: `pnpm build`, `pnpm test`, `pnpm lint` all green; `actionlint` + `shellcheck` clean;
  `pnpm install --frozen-lockfile` passes.

- **2026-06-20 — Finished the editor-proxy story (end-to-end connection token, workspace-isolating SG) +
  lifted IAM preflight into a shared package with a reconciler startup self-check.** Two tracks landed in
  one PR (later than, and separate from, the Pomerium-removal entry above).
  - **Editor reach now authenticates end-to-end ("Open editor" → workbench).** The in-app path-based proxy
    (`app.<domain>/w/<id>/`) now hands the editor a **defence-in-depth connection token**. A shared
    per-workspace HMAC derivation was centralized in `@edd/core`
    (`deriveWorkspaceToken`/`verifyWorkspaceToken`, `packages/core/src/domain/machine-token.ts`); the
    previously-duplicated derivations in `@edd/compute-ecs` (`agentToken`) and `apps/web` (`machine-auth`)
    now call it. The compute provider (`@edd/compute-ecs`) injects each workspace task's OpenVSCode
    **connection token** = `HMAC(EDD_CONNECTION_SECRET, workspaceId)` via Secrets Manager (secret
    `edd/workspace/<wsId>/connection`), mirroring the existing agent-token path (plaintext-env fallback when
    no secrets client); new config `connectionSecret`, with `EcsComputeProvider.fromEnv(agentSecret,
connectionSecret)` reading `EDD_CONNECTION_SECRET`. The golden image already runs OpenVSCode under
    `--server-base-path /w/<id>/` and consumes `CONNECTION_TOKEN`. The proxy
    (`apps/web/lib/workspace-proxy.ts` `editorTokenRedirect` + `apps/web/server.ts`) hands the
    **already session-authorized** browser the token: on the initial document navigation lacking it, a 302 to
    `…?tkn=<token>` (derived from the same `EDD_CONNECTION_SECRET`); the user never sees or handles it (new
    env constant `EDD_CONNECTION_SECRET` / `CONNECTION_SECRET_ENV`). **Network hardening (terraform module):**
    workspace tasks moved to a dedicated `workspaces` security group whose editor port (`workspace_port`,
    default 3000) + sshd (22) are reachable ONLY from the control-plane security group — never
    workspace-to-workspace (defence-in-depth alongside the token); new `workspace_port` variable +
    `workspaces_security_group_id` output, with the control plane pointing workspace tasks at it via
    `ECS_SECURITY_GROUPS`, and `EDD_CONNECTION_SECRET` added to the deployer-supplied secrets list. **Tested:**
    core machine-token unit tests; compute-ecs connection-token env tests; proxy `editorTokenRedirect` unit
    tests (redirect on document nav, skip when token/cookie present, skip sub-resources/non-GET, no-secret =
    tokenless); `packages/e2e/src/agent-secret.e2e.ts` extended to assert the `CONNECTION_TOKEN`
    Secrets-Manager injection against the container-mode sim; `packages/e2e/src/live-ide-flow.e2e.ts` reaches
    the real OpenVSCode workbench through the IDE bridge and asserts the token the running editor uses (its
    `--connection-token`) equals the injected per-workspace `HMAC(EDD_CONNECTION_SECRET, id)` — the workbench
    serves only with it — proving the handoff against real sim compute; and the LIVE portal e2e
    (`apps/web/e2e/portal-live.pwlive.ts`) asserts the **Open editor** affordance. `apps/web/e2e/start-live-app.sh`
    was switched from `next start` to the production custom server (`tsx server.ts`), so the live browser job
    now exercises the real production entrypoint + the `/w/` proxy routing, which `next start` never did. (The
    host-process proxy → in-VPC workspace ENI hop itself is the e2e-aws tier: the sim runs each task in an
    awsvpc netns the host cannot route to — see `packages/e2e/src/ide-bridge.ts`.)
  - **IAM preflight lifted into a shared package + reconciler startup self-check.**
    `apps/web/lib/iam-preflight.ts` (+ test) moved to a new package `@edd/iam-preflight`
    (`packages/iam-preflight`); `apps/web` imports from it and dropped its now-unused
    `@aws-sdk/client-iam`/`@aws-sdk/client-sts` direct deps. `@edd/core` gained pure
    `summarizeIamPreflight(signal)` + `IamPreflightSummary` + metric `METRIC_IAM_PREFLIGHT_DENIED`. The
    reconciler (`services/reconciler`) now runs `iamPreflight(env, "reconciler")` at startup, emitting the
    denied-action-count metric + a structured log (non-fatal; degrades to unknown), factored into a
    unit-tested `reportIamPreflight`.

  Verified at close: `pnpm build`/`test`/`lint` green; `shellcheck` + `terraform fmt`/`validate` clean.

- **2026-06-21 — Bug / spec-fidelity / fuzz-testing sweep: property-based tests + a batch of traced fixes.**
  Building on the prior 6-agent sweep (2026-06-20), a focused sweep added a **new property-based / fuzz
  testing capability** and fixed a batch of genuine bugs, each traced to the code. Verified at close:
  `pnpm build`/`test`/`lint`, `check-deps`, and `shellcheck` all green.
  - **New capability — fast-check property/fuzz testing.** Added `fast-check` (devDep) and **11
    `*.fuzz.test.ts`** files exercising the project's pure functions over generated inputs, pinning the
    safety-critical invariants:
    - `@edd/core` — the **cost model** (the **figure-equivalence metamorphic invariant**:
      checkpoint+resume == full-ledger derivation for any split; billing-interval non-negativity +
      order-independence; window-clip idempotence/bounds; pricing linearity; `relativeWindow` guard); the
      **state machine** (transition⟺can-transition agreement, `terminated` absorbing, every UI action maps
      to a legal transition, `planConnect` totality); **GC selection safety** (NEVER reaps a referenced
      resource; monotonic in grace; `retained` snapshots never reaped; malformed-timestamp fail-safe;
      `selectDueForSnapshot`); and the **security-relevant parsers** (`email`, `workspaceIdFromPath`,
      `decideWorkspaceAccessBySubject`, `withinWorkspaceQuota` — fail-closed, never-throw).
    - `@edd/compute-ecs` — `taskDefinitionFamily`, `workspaceEnvironment`, `taskReady`/`taskPrivateIp`.
    - `@edd/cloudwatch-logs` — the level/stream parsers. `apps/web/lib` — `parseOnDemandUsd`/`parseUsageType`,
      `cookieValue`, `repoOwner`. `@edd/auth` — `mapClaimsToRole`. `@edd/config` — the numeric env parsers.
  - **Bugs fixed (each traced to code).**
    - **compute-ecs (data-safety / GC).** `listWorkspaceTasks` ignored `DescribeTasks` `failures[]`, so a
      failed batch silently dropped tasks from the reaper's "existing" set (a true orphan could leak a
      Fargate task + EBS volume) — now throws on any failure. `stopTask` wasn't idempotent — now swallows
      `ResourceNotFound`/`InvalidParameter` (task already gone), mirroring `deleteAgentSecret`.
      `taskDefinitionFamily("")` produced a degenerate `edd-ws-` colliding all empty/all-special images —
      now fails loud (surfaced by a fuzz test).
    - **cloudwatch-logs.** `read()` issued a single-page `FilterLogEvents` and dropped `nextToken` (the
      admin log view silently truncated) — now paginates to a line budget, mirroring `CloudTrailAuditSource`.
    - **core (cost / fail-loud).** `relativeWindow` on negative/NaN `days` produced an inverted/empty
      window that silently zeroed the cost report — now fails loud. `deriveFleetAudit` with a negative
      `limit` sliced from the end (the wrong feed) — now fails loud. `deriveBillingIntervals`/`walkBilling`
      sorted timestamps by STRING compare (mixed ISO formats could mis-order and clamp an interval to zero,
      losing billable time) — now sorts by parsed instant. The `email` smart constructor's regex accepted
      C0 control chars / DEL (NUL isn't `\s`), branding garbage as an `Email` — now rejects control
      characters. The base-image catalog stored `name` un-trimmed — now trimmed (consistent with
      tags/tools).
    - **ssh-gateway (shell).** `wake-and-forward.sh` polled the full 60s deadline on a terminal wake state —
      now breaks early on error/terminated/deleting. `authorized-keys.sh` trusted the response body without
      checking HTTP status — now requires 200 (fail-closed hardening).
    - **apps/web (contract / authz / API-first).** The api-client offered `connectInfo(id, "http")` but the
      SSH-only route ignores `protocol` (would silently return sshd port 22) — removed the `protocol` param
      from the client. `session.user.role` was a non-optional `Role` set only conditionally — the callback
      now always sets it (default `viewer`, least-privilege) so the type is honest. The git-credential route
      emitted an unvalidated body — added a `gitCredentialResponse` Zod contract + parse. The admin
      workspace list was un-enriched vs the enriched developer list — now runs through the same
      `enrichWorkspace`.
  - **Deferred — recorded as a known model approximation (NOT fixed; `BUGS.md` → Open).** The cost model
    over-bills the **live-volume** line during a _stopped_-workspace teardown: a stopped workspace has no
    live EBS volume at delete (it was released at stop), but the single `teardown` bucket bills volume for
    the whole teardown window. The magnitude is sub-cent (teardown is seconds-to-minutes); a precise fix
    requires splitting the teardown bucket by its prior phase through the **persisted** `BillingState`
    rollup schema (a `@edd/db` entity change) and re-proving the figure-equivalence invariant — judged not
    worth the persisted-schema churn + regression risk for the magnitude.

### 2026-06-21 — Second bug / spec-fidelity / fuzz sweep (one PR)

A second adversarial multi-agent sweep (5 read-only auditors: editor-proxy/server, pure-core fuzz gaps,
AWS-spec fidelity, IAM-preflight/reconciler, contracts/client/routes) over the surfaces the first sweep
under-covered — the newest code especially (the in-app editor proxy #142/#143, the `@edd/iam-preflight`
package). Fixes were applied serially (read-only auditors → central edits) to avoid the parallel-edit stash
races the prior sweep hit. All findings fixed; every fix has a test; three new `*.fuzz.test.ts` extend the
property-based tier. Verified at close: `pnpm build`/`test`/`lint` green; control-plane + web integ green
against DynamoDB Local (figure-equivalence preserved). Grouped:

- **core (security / fail-closed).** `verifyWorkspaceToken` compared candidate length by STRING (UTF-16
  code units) before `timingSafeEqual`, which needs equal BYTE length — an attacker-controlled candidate of
  the same code-unit but different byte length (a multi-byte char) made it THROW instead of returning
  `false`, breaking the documented "never throws → callers fail closed" contract on every machine-token
  trust boundary (heartbeat / gateway wake / editor token); now compares on bytes. `fingerprintPublicKey`
  used lenient `Buffer.from(_,"base64")` (skips invalid chars), so distinct submitted strings could decode
  to the same bytes and collide on the fingerprint a key is deduped/looked-up by; now rejects non-canonical
  base64 via a round-trip check. `deriveWorkspaceTimeline`/`deriveFleetAudit`/`earliestEventAt` sorted ISO
  timestamps by STRING compare (the same class cost.ts already guards) — a CloudTrail-sourced `+hh:mm`
  offset form could mis-order, listing a later event first / dropping the newest from the capped audit feed;
  now sort by parsed instant.
- **compute-ecs (real-Fargate fidelity).** `runTask` read `tasks[0].taskArn` without checking RunTask's
  `failures[]` — a recoverable placement failure (RESOURCE:MEMORY / ENI exhaustion) returns 200 with empty
  `tasks[]` + `failures[]`, so the operator saw a misleading "missing taskArn" instead of "no capacity";
  now surfaces the placement reason. `taskState` ignored DescribeTasks `failures[]` entirely — a
  non-MISSING failure (cluster/permission problem) silently mapped to "stopped" and could tear down a live
  workspace; now MISSING → stopped (genuine loss) but any other failure fails loud.
- **storage-ec2 (idempotent GC).** `deleteVolume`/`deleteSnapshot` didn't swallow `InvalidVolume.NotFound`/
  `InvalidSnapshot.NotFound`, so a benign double-delete (eventually-consistent EBS + GC re-enumeration, or
  managed-EBS `deleteOnTermination`) made the reconciler's `gc.failed` metric false-alarm on normal
  operation; now idempotent (mirrors `stopTask`), a real error still propagates.
- **reconciler (convergence resilience, HIGH).** The per-item convergence loops (drift, storage-drift,
  provisioning-recover, finish-delete, error-recover, idle-stop, snapshot) handled a benign version-conflict
  Result but assumed the service call never THREW — a single transient compute/DynamoDB error on one
  workspace escaped the loop and aborted the whole sweep, skipping every later sweep step for the tick (the
  GC/reap sweeps were already hardened; these were not). Each loop now isolates a throw per-item: counts a
  new `failed`, logs loudly, retries next sweep; new `reconciler.converge.failed` metric + sweep-log field.
- **cost-service (silent partial write).** `replaceAll`'s batch put/delete (DynamoDB `BatchWriteItem`)
  discarded ElectroDB's `unprocessed` array — under throttling some cost checkpoint rows would silently fail
  to write/delete (stale/double-counted report); now fails loud so the next reconciler sweep re-runs the
  idempotent rollup. `ssh-key-service.list` used a bare `.go()` (first 1 MB page only) — now `pages:"all"`.
- **cloudwatch-logs (log fidelity).** `parseLevel` classified any stdout line CONTAINING "error"/"warn" as
  that level ("0 errors", "no warnings", `error_handler.go`); now matches a standalone level MARKER token.
- **iam-preflight (fail-closed).** `decisionsFromEvaluationResults` read a SimulatePrincipalPolicy result
  with non-empty `MissingContextValues` as a definitive allow, but per the IAM API that decision is
  PROVISIONAL (a condition couldn't be evaluated) — a future un-populated context key would report green;
  now a provisional allow counts as not-allowed (surfaces the gap).
- **apps/web (proxy hardening + authz).** The editor proxy forwarded the FULL browser cookie jar — including
  the Auth.js session JWT that authorizes the control-plane/admin API — into the workspace container (which
  runs user code/extensions); `stripSessionCookie` now removes it (keeps `vscode-tkn`). The WS-upgrade
  connect-timeout stayed armed after upgrade, so an idle editor tunnel was `destroy()`ed at the first quiet
  stretch; now cleared on upgrade. `getToken`'s `secureCookie` was inferred from the `AUTH_URL` scheme,
  which breaks behind a TLS-terminating LB (login-redirect loop); now detected from the cookie the browser
  actually sent. The token redirect now sets `Referrer-Policy: no-referrer` so `?tkn=` can't leak via
  Referer. The `git-credential` broker minted a live token for any record `get` returns, including a
  `deleting` tombstone — now refuses `deleting`/`terminated` (the one secret-emitting route had no state
  gate). `connect-info` now parses its hand-built body through the `sshConnectInfo` contract; `sessionCost.state`
  tightened from a bare string to `workspaceState | "unknown"` (the sentinel the cost model emits).
- **Fuzz tier (+3 files).** `machine-token.fuzz` (verify is total/never-throws/exact, workspace-scoped),
  `ssh.fuzz` (fingerprint only accepts canonical base64 + never collides; label/principal/host helpers),
  `timeline.fuzz` (timeline + audit order by instant regardless of ISO surface form; limit fail-loud).
- **Known limitation recorded (not fixed; `BUGS.md` → Open).** `callerToPrincipalArn` can't recover an IAM
  **path** from an STS assumed-role ARN (AWS drops it), so preflight's IAM self-check silently never runs
  for a path-scoped control-plane/reconciler role — degrades safely (→ unknown, never a false drift).

### 2026-06-21 — Moved two e2e-aws-only proofs onto the sim (CloudWatch Metrics + recurring cron)

Acting on the reframe that a sim gap is a slice to file/implement (not a hard "real-AWS-only" wall), moved
two validations onto the sockerless sim. Both turned out to need NO upstream slice — the sim already had the
support (sockerless #604 EMF extraction; the scheduler firing loop re-arms `rate()`/`cron()`), so this was
wiring + tests, validated against the live sim with no AWS account.

- **CloudWatch Metrics EMF→metric extraction (Phase 8C "Metrics on real AWS" gate closed).** `@edd/cloudwatch-metrics`
  gained a `test:integ` script + `vitest.integ.config.ts` + `test/emf-metric-sink.integ.ts` (and `test` in
  its tsconfig include for type-aware lint). The integ drives a real EMF document through `EmfMetricSink`,
  ships it via CloudWatch Logs `PutLogEvents` exactly as the awslogs driver would, then reads it back through
  the CloudWatch **metric** APIs (`ListMetrics` + `GetMetricStatistics`) — proving our EMF document shape is
  genuinely extractable (not just well-formed JSON). devDeps: `@aws-sdk/client-cloudwatch` (new — not used
  anywhere before) + `@aws-sdk/client-cloudwatch-logs` + `@edd/config`. The `integration` CI job
  auto-discovers it via turbo `pnpm test:integ`.
- **Recurring `rate()` schedule firing (Phase 5 cron model).** New `services/reconciler/src/scheduler-recurrence.integ.ts`
  proves the PRODUCTION reconciler cron model: a `rate(1 minute)` EventBridge Scheduler schedule fires its
  ECS RunTask target **repeatedly** (≥2 fires observed via CloudTrail `LookupEvents`) and **re-arms** (still
  present after firing despite `ActionAfterCompletion: DELETE` — a one-shot `at()` would be consumed). This
  closes the gap between terraform-sim (proves the `rate(5 minutes)` schedule is _created_) and the container
  e2e (proves a one-shot `at()` drives the reconciler) — neither proved a _recurring_ schedule fires on
  cadence. Detection via CloudTrail (records the fire attempt even when the target RunTask fails on the fake
  subnet — we assert the FIRE, not a launched container). Verified in-source that the sim's
  `scheduler_firing.go` ticks every second and only deletes a one-shot `at()` on completion (recurring
  expressions re-arm), so no upstream slice was needed. devDeps: `@aws-sdk/client-{ecs,scheduler,cloudtrail}`.
  Cost note: ~2 min wall-clock (two fires at the 1-minute AWS-minimum rate on a real-clock sim) — logged so
  it isn't mistaken for a hang.

Verified at close: `pnpm build`/`test`/`lint` green; `knip` clean; `pnpm outdated` clean; both new integ
suites green against the live sockerless sim (process-mode, `:4566`).

**Flakiness sweep folded into the same PR (2026-06-21).** CI surfaced two seedless `@edd/core`
fuzz properties that over-claimed on a fresh random seed (latent on main too): `ssh.fuzz` asserted a
base64 round-trip on the RAW input rather than the token `fingerprintPublicKey` actually validates (it
trims+splits first); `cost.fuzz` claimed order-independence under input reversal, false when two events
share a millisecond (causally-meaningful order, stable sort). Fixed both (assert on the processed value;
`distinctStreamArb` with minGap ≥ 1). Then an audit of all 14 `*.fuzz.test.ts` + a 30–40× per-file loop
found one more (~1/1800 runs): the `parseLevel` heuristic-fallback test generated a `badLevel` filtered
only against `info/warn/error`, but the post-#145 heuristic also escalates on `err/fatal/warning` markers
embedded in the serialized line — tightened the generator to exclude marker tokens. Also hardened the new
cron integ: its CloudTrail fire-count is now scoped to the cluster's `ResourceName` (one LookupAttribute,
real-AWS-conformant) so concurrent integ suites hammering the shared sim can't bury the 2nd fire. Lesson
recorded: never seed-pin — fix the property/generator. Production code unchanged by any of these.

**sockerless DynamoDB conformance investigation + 4 upstream issues (2026-06-21).** Rather than work around
the rare `concurrency-pairs` DynamoDB-Local CAS-isolation flake, we tried to run the control-plane integ
tier against the SIM's own DynamoDB (endpoint-only, `:4566`) — its single global-mutex item store
serializes conditional writes correctly, and `concurrency-pairs` passes 20/20 there. But a full-tier run
surfaced four genuine sim DynamoDB conformance gaps (each confirmed with a minimal SDK repro vs DynamoDB
Local + the AWS spec + a `dynamodb*.go` code pointer), all filed on e6qu/sockerless: **#641** (CRITICAL —
`TransactWriteItems` silently ignores the `Update` action: no mutation, no condition eval, 200 OK — guts
transactional version-CAS/atomic-counter/audit-ledger writes), **#642** (`TransactionCanceledException`
omits the `CancellationReasons` array — conflict→domain-error mapping), **#643** (`SET if_not_exists(c,:0)

- :v`stores`null`), **#644** (`DeleteTable` doesn't purge items). Per §6.8 we WAIT on the upstream fixes

* re-pin, then migrate the tier and drop the `amazon/dynamodb-local` container — no workaround, no switch to
  a less-conformant substrate. The flake stays documented (rare + self-healed) and gated on #641–#644. No
  test/product code changed by this investigation.

### 2026-06-22 — Migrated the integration tier's DynamoDB from DynamoDB Local to the sockerless sim

Closed out the `concurrency-pairs` "delete vs wake" flake at its root. The flake was DynamoDB Local's
weaker conditional-write isolation (it can, rarely, let two `version == V` CAS writes both commit). The
fix — per the user's "use sockerless, don't work around" directive — was to run the integration tier
against the sim's own DynamoDB (a single global-mutex item store, so conditional writes are atomically
serialized), endpoint-only.

Getting there surfaced **seven sim conformance bugs**, each confirmed with a minimal AWS-CLI/SDK repro vs
DynamoDB Local + the AWS spec + a `simulators/aws/*.go` code pointer, all filed on e6qu/sockerless and
**all fixed upstream** (we did NOT work around any): #641 (TransactWriteItems dropped the `Update` action),
#642 (TransactionCanceledException omitted `CancellationReasons`), #643/#648 (SET RHS evaluator stored
`null` for a parenthesized `if_not_exists` arithmetic — the form ElectroDB emits), #644 (DeleteTable didn't
purge items), #650 (sim self-generated phantom `ListBuckets` CloudTrail events from a bare `GET /`
healthcheck), #651 (CloudTrail `LookupEvents` returned DynamoDB data-plane ops — AWS returns management
events only). Also filed an architecture issue (#652) on the recurring "silent incompleteness" failure
mode (succeed-with-wrong-result instead of compute-or-fail-loud).

The migration (this PR), re-pinned to `0e46585e`:

- **Integ tier → sim DynamoDB:** `DYNAMODB_ENDPOINT=http://127.0.0.1:4566` is set in the CI `integration`
  job + `scripts/test-integ.sh` (turbo already passes `DYNAMODB_ENDPOINT` through to `test:integ`); the
  `amazon/dynamodb-local` container/service was removed from `docker-compose.tier2.yml` and the CI job. The
  `@edd/config` `dynamodb.endpoint` default stays `:8000` (still used by dev + the e2e tier).
- **`observability-live` made isolation-robust:** it asserted specific platform events appear in the admin
  audit feed (a shared, capped, newest-first view of CloudTrail); with the integ tier now logging DynamoDB
  _management_ events (CreateTable/DeleteTable) to the shared sim CloudTrail, those legitimate sibling events
  could crowd out the test's events past the 100-cap. The test now verifies its ECS/EBS ops were recorded
  via a server-side `EventName`-scoped `LookupEvents` (narrowed to this run's resource where the sim records
  one), and separately asserts the route returns a well-formed non-empty feed. (`@aws-sdk/client-cloudtrail`
  added to `apps/web` devDeps.)
- **Validated:** the full integ tier passes against the new pin + sim DynamoDB — control-plane 52/52 (incl.
  `concurrency-pairs`, now deterministic), db 5/5, web 130/130, storage-ec2 9/9 (×3 stable), compute-ecs 4/4,
  cloudtrail-audit 7/7, cloudwatch-logs 4/4, cloudwatch-metrics 2/2.
- **e2e tier still on DynamoDB Local** (`docker-compose.e2e.yml`): the container-mode e2e hardcodes
  `host.docker.internal:8000` for in-container DynamoDB access, so its migration is a separate follow-up
  (recorded in `DO_NEXT.md`).

### 2026-06-22 — Retired DynamoDB Local from all CI + re-pinned the sim (#654/#655, closing arch issue #652)

Two things in one PR (user-requested "1 and 2"):

**(1) Re-pinned the sim `0e46585e → 5fb1341a`**, adopting sockerless **#654** (DynamoDB fail-loud expressions

- spec-derived required-field validation) and **#655** (differential testing vs DynamoDB Local + CloudWatch
  fail-loud). These were the last two levers of the architecture meta-issue **#652** (the "silent
  incompleteness" failure mode I filed) — so #655 **closed #652**: all five prevention levers (spec as source
  of truth, fail-loud-by-default, closed types + real parsers, modelled cross-cutting concerns, differential
  testing) are now in place upstream. Re-validated the full integ tier (25/25) against the new pin — the new
  fail-loud + required-field validation surfaced **no new gaps** in surfaces our code uses (clean adoption).

**(2) Retired DynamoDB Local from ALL of CI.** The integration tier was migrated last PR; this finishes the
job — **e2e** (the container-mode sim already serves DynamoDB) and **playwright** (which now builds + runs
the process-mode sim) both moved onto the sim. `@edd/config` `dynamodb.endpoint` now **defaults to the sim**
(`:4566`), so the per-tier `DYNAMODB_ENDPOINT` overrides (CI integration job, `test-integ.sh`) were removed
— one source of truth. The `amazon/dynamodb-local` container is gone from `docker-compose.tier2.yml` +
`docker-compose.e2e.yml` and the integration/e2e/playwright CI jobs. Container-side endpoints updated:
`reconciler-container.e2e.ts` and the playwright config/global-setup now point at the sim (`:4566` /
`host.docker.internal:4566`). The playwright job gained `submodules: recursive` + a sim build (it had no sim
before — the cost of fully retiring DynamoDB Local there, validated 18/18 locally).

**The one deliberate exception: the local `pnpm dev` loop keeps DynamoDB Local** (`docker-compose.dev.yml`

- `dev.sh` pin `:8000`). The CAS-isolation flake DynamoDB Local can hit only matters under CI concurrency,
  not a single-user dev loop, and forcing a sockerless sim build on every `pnpm dev` is a real inner-loop
  regression. It's overridable to the sim (`DYNAMODB_ENDPOINT=…:4566` + `EDD_DEV_PROFILES=aws`).

Verified: integ 25/25 (via config default, no env override), portal Playwright 18/18 vs the sim's DynamoDB
locally (incl. the live-DynamoDB health board), build / lint (19) / unit (33) / knip / shellcheck /
actionlint / `pnpm outdated` clean. The container-mode e2e + e2e-https tiers validate in CI.

### 2026-06-22 — Three-thread sweep: IAM-enforcement (sim-first), cost-spend visualization, bug/fuzz sweep

One PR, three user-requested threads.

**(1) IAM call-time enforcement (sim-first).** Goal: prove least-privilege IAM actually DENIES an
unauthorized call at runtime, not just that the policy text is shaped right (the `@edd/iam-preflight`
`SimulatePrincipalPolicy` self-check already covers the latter). Investigation found the sockerless sim does
NOT enforce IAM on service calls: `iamEvalDecision` is wired only into the `SimulatePrincipalPolicy`
diagnostic endpoint, never into any service handler, and `AuthPassthroughMiddleware` accepts every request
without validating credentials — so a zero-permission principal calling `ec2:CreateVolume` gets a 200. Per
§6.8/§6.9 (file the gap, never work around): filed **e6qu/sockerless#657** (request-time authorization
layer: credential→principal→policy binding + an authz gate running the existing evaluator on each mutating
call, returning `UnauthorizedOperation`/`AccessDeniedException`). Added a coordinate-gated, skipped
enforcement test (`packages/storage-ec2/src/iam-enforcement.integ.ts`): it asserts a restricted principal's
`CreateVolume` is rejected with `UnauthorizedOperation`, and SKIPS until the restricted-principal coordinates
can be supplied (i.e. once the sim enforces, or on real AWS in e2e-aws) — it never falls back to
unrestricted creds. TDD against the upstream fix.

**(2) Cost-spend visualization.** The costs page was tiles + text rows; added a no-dependency, stacked
proportional spend bar per user/session row (compute/volume/snapshot segments, width = row.totalUsd/maxUsd,
server-computed — pure div+CSS in the house style, no chart lib). Extended the portal Playwright test to
assert the bar renders and the top spender fills to 100%. `apps/web/app/admin/costs/page.tsx`,
`globals.css`, `lib/testids.ts` (`costBar`), `e2e/portal.pw.ts`.

**(3) Bug / spec-fidelity / fuzz sweep.** A parallel audit of the newest surfaces surfaced real findings;
fixed all the confirmed ones:

- **H1 (HIGH) — false converge-failed alarm.** `recoverErrors`/`finishDeletions` bucketed a benign
  version-conflict race (a non-ok `Result`) as `failed`, feeding `METRIC_RECONCILER_CONVERGE_FAILED` (a
  human-attention alarm). Every other sweep distinguishes a non-ok Result (skipped) from a thrown error
  (failed); these two didn't. Gave `RecoveryResult` a `skipped` field, bucketed races there, and routed it to
  `METRIC_RECONCILER_SKIPPED`. `services/reconciler/src/index.ts` + `run.ts`.
- **M1 — `storageDrift.skipped` was silently dropped** from the SKIPPED metric/log while `storageDrift.failed`
  was counted. Extracted the two roll-ups into single source-of-truth consts (so the metric + log can't
  diverge again — that divergence WAS M1) and added the missing terms, including `deletions.failed` to
  CONVERGE_FAILED (which the teardown path's own comments promised was alarm-surfaced but wasn't).
- **M2 — security privilege-attempt metric double-counted** when no audit ledger is wired (the idempotency
  dedup lived inside the audit block, the metric ran unconditionally after). Now the metric is counted only
  when a new audit row is created, and an absent ledger fails loud (the method can't honor its
  idempotent+auditable contract without one — production always wires it). `workspace-service.ts`.
- **M3 — timeline activity-dedup used a string compare while the sort used instant compare**, so the same
  instant in different surface forms (`Z` vs `+00:00`, from CloudTrail) fabricated a spurious duplicate
  "activity" event. Now dedups by parsed instant. `observability/timeline.ts`.
- **L1** `EDD_CONVERGE_BUDGET` (a count) was parsed by the milliseconds helper → added a `tuningCount`
  (positive-integer) parser. **L3** corrected the `createDynamoClient` doc to state `DYNAMODB_ENDPOINT` is the
  only coordinate (it deliberately must NOT default to the sim when unset — real cloud needs ambient
  resolution). **L4** fail-loud/early-return hardening: EMF sink throws on an unparseable clock timestamp
  (else `Timestamp: null` is silently dropped by CloudWatch); CloudTrail `recent(≤0)` returns `[]` instead of
  sending an invalid `MaxResults: 0`.
- **6 new property/fuzz files** over high-value pure functions (now 20 `*.fuzz.test.ts`): `iam-requirements`
  (fail-closed — a missing decision counts as denied), `base-image-catalog`, `config-sync`, `health`,
  `stats` (conservation), `topology` (unmatched node → `unknown`, never fabricated `ok`).

**Two findings NOT actioned, with reasons:** **M4 (scheduler test uses `ActionAfterCompletion: DELETE`) was
a FALSE POSITIVE** — `DELETE` deletes a schedule only after it _completes_; a recurring `rate()` with no end
date never completes, so real AWS keeps it, the sim agrees, and the test deliberately uses DELETE to prove
the recurring schedule survives the more-aggressive setting (verified against AWS semantics; left unchanged).
**L2 (catalog create/update last-write-wins, no optimistic concurrency)** is recorded as an accepted
limitation (admin-only, low-contention) with a follow-up rather than expanded into a db-schema/version-CAS
migration in this PR — see `BUGS.md` → Open + `DO_NEXT.md`.

### 2026-06-22 — IAM call-time enforcement PROVEN at the sim tier (#657 fixed by sockerless #659)

The day after we filed #657 (the sim authorized every call regardless of policy), sockerless **#659** landed
the request-time IAM authorization layer: an IAM user/access-key/inline+managed-policy surface
(`iam_users.go`) plus a gate (`iam_enforcement.go`) that resolves the SigV4 access-key id → registered IAM
user → effective policy → the existing `iamEvalDecision`, returning the per-service deny shape (EC2
`UnauthorizedOperation`, awsJson `AccessDeniedException`, other query `AccessDenied`).

Adopted it (re-pinned `5fb1341a → 1dc18896`):

- **Backward-compat verified first.** The gate enforces ONLY on access keys that resolve to a _registered_
  IAM user; an unregistered/dummy key (what every existing test uses) stays permissive. Confirmed by
  rebuilding the sim and running the full integ tier — **25/25, unchanged**.
- **The enforcement test now runs** (was a coordinate-gated skip). `packages/storage-ec2/src/iam-enforcement.integ.ts`
  self-provisions a restricted principal via standard IAM APIs — `CreateUser` → `PutUserPolicy` (an inline
  policy granting ONLY `ec2:DescribeVolumes`) → `CreateAccessKey` — and proves the gate is **selective**, not
  blanket: `DescribeVolumes` is allowed (positive control) while `CreateVolume`, which the policy omits, is
  denied with `UnauthorizedOperation` (negative control). `afterAll` tears the principal down. It uses only
  standard IAM + EC2 APIs and never branches on the target, so the same test certifies real AWS in `e2e-aws`.
  (`@aws-sdk/client-iam` added as a storage-ec2 devDep.)

Why self-provision rather than a config-supplied coordinate: an IAM user/key is a first-class IAM API
resource (unlike a GitHub App or hosted zone, which are out-of-band-only), so the test brings up its own
restricted principal through the same standard API a real deployment would — coordinate-pure, no skip, no env
plumbing. This closes the loop opened by the #657 filing: least-privilege **denial** is now proven at the sim
tier, not deferred to a real AWS account. Eight sockerless issues filed across this whole arc; all resolved.

### 2026-06-22 — IAM enforcement deepened to condition keys (adopted sockerless #660; filed #661)

The day after #659 (call-time enforcement) landed, sockerless **#660** shipped a 3-cloud IAM/identity
fidelity sweep — for AWS, the full real-AWS condition-operator set (`Numeric*`/`Date*`/`IpAddress`(CIDR)/
`Null`/`Arn*`/`ForAllValues:`/`ForAnyValue:`/policy-variable substitution/`Principal` matching; previously a
policy using an unsupported operator silently failed its Allow → behaved as a Deny) plus STS `AssumeRole`/
`AssumeRoleWithWebIdentity`/`GetSessionToken`/faithful `GetCallerIdentity`.

Adopted it (re-pinned `1dc18896 → 9a1d4e92`):

- **Backward-compat verified:** full integ tier 25/25, unchanged (the gate still enforces only on registered
  IAM users; dummy creds stay permissive).
- **Extended the enforcement proof from action-level to condition-level.** Refactored
  `packages/storage-ec2/src/iam-enforcement.integ.ts` behind a shared `provisionPrincipal(policyDocument)`
  helper (creates a restricted IAM user + inline policy + access key via standard APIs, returns a region-scoped
  EC2-client factory + teardown — also keeps jscpd happy). Two describes now: **action level** (a
  describe-only principal: `DescribeVolumes` allowed, `CreateVolume` denied) and **condition keys** (a
  region-locked principal: `ec2:CreateVolume` granted only when `aws:RequestedRegion` equals the region, so the
  SAME action is allowed in-region and denied cross-region with `UnauthorizedOperation`). This proves the gate
  evaluates a policy's `Condition` against request context — the #660 evaluator in action — not just the
  action verb.

**Why only a global-key condition (`aws:RequestedRegion`):** the gate (`iam_enforcement.go` `iamAuthorize`)
populates only GLOBAL condition keys (`aws:username`/`userid`/`SourceIp`/`RequestedRegion`). It does NOT
resolve RESOURCE-scoped keys (`aws:ResourceTag/<key>` from the target resource's tags) or service keys
(`ecs:cluster`). Our least-privilege design conditions the destructive EC2 grants on
`aws:ResourceTag/edd:managed=true` and the ECS task grants on `ecs:cluster`, so those exact grants can't be
proven at the sim tier yet (a tag-scoped Allow currently behaves as a blanket deny). Filed **sockerless #661**
to populate resource/service condition keys into the authz context (the operator support already landed in
#660). Until then, the tag/cluster-conditioned grants stay e2e-aws-only. Nine sockerless issues filed across
the whole arc; eight resolved, #661 open.

**2026-06-25 — Second opportunistic audit sweep (fuzz + prod UX + examples), one PR.** Property-based
hardening on previously-uncovered surfaces: `token-crypto` (AES-GCM round-trip, fresh-IV, fail-closed
on wrong-key/tamper, controlled-error on a malformed blob), the shared `sshPublicKeyField` (no-newline
/ second-key-smuggle rejection, accepted⇒well-formed, total/no-ReDoS), GC-safety for
`selectOrphanTasks`/`selectOrphanSecrets` + the reconciler's `selectIdle` (never reap a referenced/live
resource; NaN-timestamp fail-safe), and the terminal `parseMessage` protocol. Two robustness fixes the
fuzz surfaced: `decryptToken` now throws its controlled "malformed ciphertext" (not a raw crypto
`TypeError`) on a bad blob, and `parseMessage` rejects non-integer/≤0 PTY dimensions. Prod-app UX: the
NewSession session buttons show in-flight labels (and the create form no longer silently no-ops on an
incomplete form); the workspaces mine/all tabs got `aria-current`; `LiveRefresh` pauses while the tab
is hidden + catches up on re-show. Examples/quality: removed the dead `EDD_WORKSPACE_BASE_DOMAIN` from
the tfvars/variables examples (its config export was dropped in #142 — only `EDD_SSH_BASE_DOMAIN` is
live), added the deployment-secret block to `apps/web/.env.example`, made `workspace-proxy` fail loud
on a missing `AUTH_SECRET` (was `?? ""`), trimmed CreateBaseImage name/image, and stopped the
ssh-gateway e2e fake from swallowing a malformed authorize body.

**2026-06-25 — sockerless bump + IAM resource/service condition-key proofs (#661 closed), one PR.**
Re-pinned the `third_party/sockerless` submodule from `9a1d4e92` to `6918fb81` (18 commits: the
#663–#679 conformance ratchet drove ECS/S3/DynamoDB/EventBridge/SNS/CloudWatch/IAM + many query/REST
services to 100%, and **#662 populated RESOURCE/SERVICE-scoped IAM condition keys — resolving our
filed #661**). With #662, the two least-privilege grants that were e2e-aws-only are now proven at the
sim tier: `packages/storage-ec2/src/iam-enforcement.integ.ts` gained an `aws:ResourceTag/edd:managed`
block (`DeleteVolume` on a tagged resource allowed, untagged denied), and a new
`packages/compute-ecs/src/iam-enforcement.integ.ts` proves the `ecs:cluster` service key (`ListTasks`
on the granted cluster allowed, another denied). The shared IAM-principal provisioning (CreateUser →
PutUserPolicy → CreateAccessKey + teardown) was extracted into a new internal
`@edd/aws-itest-support` package (`provisionRestrictedCredentials`/`inlinePolicy`) so both suites
share it (no jscpd clone). Validated against the locally-rebuilt process-mode sim: storage-ec2 6/6,
compute-ecs 2/2, **full integ tier 26/26**. No sockerless bug found — the upstream fix works as
specified. Boy-scout: refreshed three stale "DynamoDB Local" integ comments/describe-names (the tier
migrated to the sim's DynamoDB — §6.9 target-agnostic wording), the stale "no IAM enforcement" comment
in `ecs-compute-provider.ts`, and the `docs/simulator-live-coverage.md` "real-AWS-only" IAM line.

**2026-06-25 — Journey + fuzz + contrast sweep (4 specialized audits), one PR.** Contrast: the status
tokens are used as badge **label text**, not just the dot, so `--st-stopped` (#7a877c) and
`--st-terminated` (#6f7a6e) failed AA 4.5:1 as text — lifted to #838f86 / #828d80; added a
`--border-control` token (≥3:1) for input/select boundaries (`--border-strong` was ~1.5:1) and the
editor's terminal-toggle button. Bugs (the fuzz surfaced two): `editorTokenRedirect` threw `TypeError`
on a crafted proxy target (e.g. `req.url="http://"`/`"//"`) — now fails safe (returns undefined);
`stripSessionCookie("")`/trailing-`; ` leaked a spurious empty Cookie pair — now drops empty pairs;
`usd(NaN)` rendered `$NaN` — now guards non-finite like `pct`. Fuzz added (looped 20×, no flakiness):
`usd`; `normalizeClaims` (the github/entra identity edge — complete-or-throw, never silent-map,
SECURITY); `recordQuotaUsage` (utilization always finite ≥0); `stripSessionCookie` (no session cookie
survives, non-session preserved, SECURITY) + `editorTokenRedirect` totality. Production journeys: the
`/workspaces` list now mounts `LiveRefresh` while any workspace is transitional (provisioning/deleting)
so a just-created workspace advances to running + shows "Open editor" without a manual reload; the
create-repo flow surfaces the API's specific error (e.g. "repository name unavailable") instead of an
opaque status code. A11y: `role="alert"` on the inline async-error spans (SshKeys/NewSession/
CreateBaseImage/WorkspaceActions) so screen readers announce them. Two demo-journey behavior changes
(viewer-role RBAC is cosmetic; instant-create skips the provisioning story) were deferred to `DO_NEXT`
as focused follow-ups.

**2026-06-25 — Demo RBAC + provisioning dwell + fuzz + a11y, one PR.** The two deferred demo-journey
items landed: (1) **Viewer RBAC** — `DemoControlPlane.canMutateWorkspaces()` uses the REAL `@edd/authz`
`defineAbilityFor`, and Workspaces/Catalog hide the create form + start/stop/delete for a viewer, so the
identity switcher tells a true CASL story (a viewer is read-only). (2) **Provisioning dwell** — `create`
lands in `provisioning` and advances to `running` after a 1.5s dwell via the real `markProvisioned`
transition (fire-and-forget timer, re-reads state + no-ops if deleted), so the scale-to-zero cold-start
(the `StateBadge` pulse → "Open IDE appears when ready") is visible instead of an instant jump. Boy-scout:
`persistence.loadState` now validates the top-level SHAPE (`isDemoState` guard — arrays/records/primitives),
not just the version number, so a torn/hand-edited blob is re-seeded rather than read into newer code
(§6.5a; replaces a bare `as DemoState`). Fuzz added (fast-check; looped 20×): `ttlCache` (load-once-per-
window + single-flight + reject-not-cached, time injected), `buildEmfDocument` (round-trip + the
name/`_aws` dimension-collision guard), `auditToLogLines` (order/length-preserving, fields verbatim).
A11y: `aria-label` on the three NewSession fields + `aria-busy` on its in-flight buttons; `role="alert"`
on the demo SSH-key error; `aria-hidden` on the decorative status dots (web + demo); `aria-expanded`/
`aria-controls` on the editor's terminal-toggle disclosure. Contrast: the audit found NO fresh failures —
the token system is now AA-clean.

**2026-06-25 — Examples + journey + fuzz + a contrast-regression fix, one PR.** Four audits on saturating
surfaces still found real items. **Contrast regression (mine):** the prior editor `--border-control`
(#565659) was 2.09:1 vs the panel — I'd measured it against `--border` (#333), the wrong reference; the
3:1 non-text floor is vs the adjacent surface. Lifted to #757578 (3.3:1 on panel). **Deploy-breaking doc
omission:** `EDD_CONNECTION_SECRET` (the per-workspace OpenVSCode connection-token HMAC, read by
`constants.ts`/`workspace-proxy`) was missing from all three copy-paste secret lists — added to
`apps/web/.env.example`, the tfvars `auth_secret_arns` example, and the README crypto list. **Production
journey:** `/sessions/new` now gates on `defineAbilityFor(principal).can("create","Workspace")` and shows
a read-only `StateBlock` for a viewer (was a guaranteed 403 dead-end after picking an image — the prod
analog of the demo viewer-RBAC). **Demo journey:** Catalog hides the editor/agent pickers + shows a
read-only note for a viewer (they only feed `create`). **Fuzz (looped 20×):** `checkMachineAuth` (the
agent-heartbeat/gateway-wake auth boundary — it had NO test of any kind: total, fail-closed, soundness,
scheme case-insensitivity, SECURITY) and `matchDevUser` (dev-auth credential match — first-match, exact
username, `password ?? fallback`). **Boy-scout:** `workspaceLimit` now strict-decimal-parses
`EDD_QUOTA_<ROLE>` (rejects `0x10`/`1e1`/`" 5 "`, which `Number()` silently accepted); refreshed the stale
`*.devbox.<domain>` wildcard-routing comment in the terraform example (path-based now), a TESTING.md
`--filter web`→`@edd/web` nit, and a `reset()` latent-state comment. The wildcard-resources infra question

- a demo-viewer SSH-keys note are recorded in `DO_NEXT`.

**2026-06-25 — Forward capability: wildcard-DNS cleanup + Quotas over-limit + SSH Slice 3 ingress, one
PR.** Three deferred items, all delivered. **(1) Wildcard cleanup:** the `*.devbox.<domain>` editor
wildcard was confirmed vestigial (the path-based proxy needs only the `app.<domain>` cert) and removed —
the wildcard Route53 record, the ACM wildcard SAN, `local.workspaces_fqdn`, `var.workspaces_subdomain`,
plus the example/README/sim-assert refreshes (ACM SAN 2→1; the workspace-wildcard Route53 assert
repurposed to the SSH wildcard). **(2) Quotas over-limit:** resolved the role-not-stored blocker by
persisting `ownerRole` on the workspace at create (the user's role is otherwise only known at sign-in),
threaded through `@edd/core` Workspace/`provision` → `@edd/db` entity → `@edd/control-plane` (record +
both DTO mappers) → the `workspace`/`workspaceDetail`/`quotaReport.usage` contracts → `fleet-status` →
`quota-report` → the page (`atOrOver` flag). Forward-only; legacy un-roled rows fall back to the
strictest POSITIVE per-role cap (viewer's 0 excluded so it doesn't trivially flag everyone), admins
(unlimited) never flagged — locked with `quota-report.test.ts`. **(3) SSH Slice 3 ingress:** the gated
public SSH front door in `ssh-ingress.tf` — a `network` NLB + raw TCP:22 listener + TCP target group +
SSH-gateway ECS service/task + ECR repo + public SG (+ the workspace-SG ingress from it) + a
`*.<ssh_base_domain>` Route53 wildcard. The ingress applies cleanly against the sim and every
resource-level assertion passes — but TWO sim fidelity gaps keep it OFF the terraform-sim run (the sim
test leaves `ssh_base_domain` empty; the SSH terraform is covered by `terraform validate`): **#685** —
the sim returns a HealthCheck `Matcher` for a TCP target group that real AWS doesn't, breaking the
idempotency re-plan; and **#683** — the sim's NLB data plane is HTTP-only, so the live ssh-through-NLB
byte-stream proof is **e2e-aws-only**. Both filed on `e6qu/sockerless` + tracked in `BUGS.md`; the
unconditional ssh-gateway ECR repo IS still sim-asserted. The gateway image must be a PINNED tag
(immutable repo, a task-def precondition, no `:latest`). Boy-scout: fixed the module README's wrong
"SSH gateway runs behind this ALB" (it's the dedicated NLB) and the stale sim "workspace-wildcard
routing" comment.

**2026-06-26 — sockerless #687 bump; #683 + #685-matcher fixed, residual #688 found.** Re-pinned the
submodule `6918fb81` → `f58007ba` (#687 + 5 service-fidelity commits: GCP op-coverage gate, IAM to
100%, EC2/SSM/RDS/CloudFront to 100%, event-stream ops). #687 landed our two filed SSH-ingress
blockers — **#683** (the NLB raw-TCP data plane, new `elbv2_nlb_proxy.go`) and **#685** (cleared the TCP
target group's `Matcher`). Re-validated the SSH ingress against the rebuilt sim: `terraform apply`
succeeds, but the **idempotency re-plan still fails** — the sim now returns `HealthCheckPath="/"` for
the TCP target group (real AWS omits path AND matcher for TCP), the same root cause #685's fix missed.
Confirmed via the SDK (`describe-target-groups` → `Matcher: null` ✅, `HCPath: "/"` ❌) and **filed
sockerless #688** (a focused follow-up to #685). So the SSH ingress stays gated off `tests/sim` until
#688 lands — but the bump is kept (integration tier 26/26 against #687, and it captures #683 + the
matcher fix + the service ratchets). Per §6.8: filed upstream + skip, no workaround.

**2026-06-26 — sockerless #690 bump; #688 fixed, but a #683-introduced regression #691 found.**
Re-pinned `f58007ba` → `fe3fce01` (#690 "omit HealthCheckPath for TCP target groups" (#688) + #689 GCP/
Azure ratchets). Re-validated the SSH ingress against the rebuilt sim: the TCP-target-group health-check
error is **gone** (apply + plan no longer error on `path`/`matcher`) — but the idempotency re-plan still
**drifts** (`1 to change`). Root cause: the NLB raw-TCP data plane added in #687/#683 made
`DescribeLoadBalancers` return the `network` LB's `DNSName` as the **proxy's `host:port`** (e.g.
`10.89.3.2:44425`) instead of the stable `*.elb.amazonaws.com` hostname `CreateLoadBalancer` returned, so
`aws_lb.dns_name` + the `*.ssh` Route53 alias never settle (and a `:` isn't valid in a DNS name).
Confirmed via the SDK and **filed sockerless #691**. So the SSH ingress stays gated off `tests/sim` until
#691 lands; the #690 bump is kept (integration tier 26/26). Third gap in the chain (#685→#688→#691); each
upstream fix surfaced the next. Per §6.8: filed upstream + skip, no workaround.

**2026-06-26 — sockerless #692 bump; the ELBv2/NLB chain is CLOSED, SSH ingress sim-exercised.**
Re-pinned `fe3fce01` → `08b7ee71` (#692 "NLB DescribeLoadBalancers returns a stable AWS-shaped DNSName"
(#691)). Re-validated the SSH ingress against the rebuilt sim and it is **finally clean**: `terraform
apply` (94 added) → idempotency `plan -detailed-exitcode` exit **0** (`No changes`) → `destroy` clean.
Every SSH CI assertion passes locally (NLB type=network, scheme internet-facing, TCP:22 listener, TCP/22/
ip target group, the `*.ssh` wildcard A record, the `eddsim-ssh-gateway` ECS service), and the NLB
`DNSName` is now a stable `eddsim-ssh-<hash>.elb.us-east-1.amazonaws.com`. So `tests/sim` sets
`ssh_base_domain` again and the SSH CI assertions are restored. This closes a **four-gap chain** —
#683/#685 (#687) → #688 (#690) → #691 (#692) — each surfaced one at a time on the idempotency re-plan as
the prior fix landed; every gap diagnosed from the SDK + filed upstream, never worked around (§6.8).
Integration tier 26/26 against #692. Opened as one combined PR (bump + SSH sim re-enable) per the held-PR
plan.

**2026-06-28 — Multi-arch image publishing convention + golden base node-pty per-target-arch build.**
Established the project's container-image naming convention: every published image is a multi-arch manifest at the unsuffixed tag (`:<tag>`) plus per-arch images with an architecture suffix (`:<tag>-amd64` and `:<tag>-arm64`). `scripts/publish-images.sh` builds each requested architecture, pushes the suffixed images, and creates/annotates/pushes the manifest. The golden base image was refactored so its only native dependency, `node-pty`, is compiled inside a Dockerfile `node-pty-builder` stage for the target architecture; this removes the previous limitation where a macOS/Apple-Silicon host staged a Darwin binary that the Linux image could not load. `infra/images/base/build.sh` now stages only the architecture-independent editor bundle plus a minimal `package.json`, and switches to `docker buildx build` when the caller passes buildx-specific flags (`--platform`, `--push`, `--load`, etc.). The `release` workflow gained QEMU + Docker Buildx setup and a `pnpm install` step so dual-arch publishes work on GitHub's x86_64 runners. The Terraform CodeBuild project pins `EDD_BUILD_ARCHS=amd64` (single-arch on the x86_64 CodeBuild image) and installs pnpm dependencies before invoking `publish-images.sh`. Docs (`docs/install.md`, `docs/deploying.md`, `README.md`, the module README) were updated to describe the manifest/suffix convention and the `local`/`codebuild`/`pre-published` self-bootstrap modes. `BUGS.md` was updated: the old "node-pty has no Linux prebuild / macOS host stages Darwin binary" entry was replaced with a note that cross-arch builds require QEMU/binfmt on the build host and that single-arch runners should limit `EDD_BUILD_ARCHS`. Verified with `shellcheck`, `terraform fmt/validate`, and the full pre-commit suite.

**2026-06-28 — AWS deploy-readiness: examples wired, bootstrap/publish/install scripts, release workflow, architecture.md, doc cross-link sweep.**
Closed every code/docs gap blocking a real AWS deploy that didn't need a user decision. (1) **Terraform examples** (`examples/complete` + `examples/terragrunt`) now wire the SSH-ingress vars (`ssh_base_domain`/`route53_ssh_zone_id`/`ssh_gateway_image`) that were absent, the complete example gained the SSH + golden repo outputs, and a stale "SSH CA" comment was fixed. (2) **Control-plane Dockerfile** now also builds the reconciler bundle — the module runs the reconciler as the control-plane image with a command override (`node services/reconciler/dist/run.js`), but the image never built that bundle, so the reconciler would have failed at runtime; now both bundles ship in one image (no separate reconciler image, matching `deploying.md` + the module). (3) **Bootstrap/publish/install/uninstall scripts** (POSIX sh, shellcheck + sh/zsh clean): `bootstrap-state.sh` (versioned/encrypted S3 + DynamoDB lock, idempotent), `bootstrap-secrets.sh` (generates the crypto secrets, env-or-prompt for IdP creds, headless-capable), `publish-images.sh` (build+push control-plane/golden/gateway to ECR), `install.sh` (one-command orchestrator — fail-fast, parametrized via env, computes the SSH-gateway image ref upfront so SSH-enabled one-shot installs work, `--verify` re-checks a stack read-only), and `uninstall.sh` (full teardown, partial-install-safe: terraform destroy with `deletion_protection=false`, force-delete secrets, sweep leaked runtime volumes/snapshots/tasks tagged `edd:managed`, optional state purge). (4) **`release` workflow** (`release.yml`, tag/manual, OIDC→role, gated on `RELEASE_AWS_*` vars so inert until the account decision). (5) **`docs/architecture.md`** — block diagram, component roles, persistence/auth models, the deployment sequence, and the browser-editor + SSH-registered-key connection sequences. (6) **Doc sweep** — fixed stale SSH-CA refs (`infra/images/README.md`), the stale "sim NLB is HTTP-only" note in the module README (the NLB raw-TCP chain is closed), stale items in `observability-gaps.md` (CONNECTION_TOKEN done, sockerless#569 fixed), completed the module README inputs/outputs tables, and cross-linked architecture/install across README/deploying/module README.

**2026-06-28 — Deploy-readiness follow-up: fixed golden-image ECR path mismatch, aligned examples with real variants, bumped workspace memory, cleared check-deps.**
A focused pass closed the remaining decision-free gaps found while preparing the deploy-readiness PR. The Terraform module creates golden ECR repos as `<name>/golden/<variant>`, but `scripts/publish-images.sh` and the catalog seed image ref were pointing at `<name>/<variant>` — fixed by pushing variants to `<prefix>/golden/<variant>` and seeding the catalog with the same path. Terraform examples (`examples/complete`, `examples/terragrunt`), the module README, the `golden_image_repos` variable description, the sim fixture, and the `terraform-sim` CI assertions were updated to use the real variant folder names (`omnibus`, `typescript`, `go`, `python`, `java`, `rust`) instead of non-existent placeholders like `node-20`. `DEFAULT_WORKSPACE_MEMORY` was raised from 1024 MiB to 2048 MiB so the default omnibus workspace does not OOM when Fargate enforces cgroup limits (sockerless#583); the cost-model pricing test and `BUGS.md` note were updated to match. `eslint`, `knip`, `@types/node`, and `turbo` were refreshed to clear the `check-deps` gate. Verified with `pnpm test`, `shellcheck`, `terraform fmt/validate`, and the full pre-commit suite.

**2026-06-29 — sockerless #713 merged; all 10 filed gaps fixed upstream, submodule re-pinned to `dd2eb3ab`.**
sockerless **#713** closed the entire module-wide fidelity audit in one upstream merge: Budgets service slice (#703), SQS DLQ auto-redrive on `maxReceiveCount` (#704), CloudWatch alarm actions publish canonical JSON to SNS (#705), CloudWatch Logs metric filters evaluate and publish real metrics (#706), Application Auto Scaling target tracking adjusts ECS `DesiredCount` (#707), ACM `AMAZON_ISSUED` certificates mint real RSA/X509 PEM (#708), ELBv2 HTTPS/TLS listeners terminate TLS with the ACM PEM (#709), Route53 serves hosted zones over real UDP+TCP DNS (#710), the ECS service scheduler reconciles `DesiredCount` against live tasks (#711), and EC2 security groups enforce ingress rules at the host nftables tier (#712). Re-pinned `third_party/sockerless` from `08b7ee71` to the merge commit `dd2eb3ab`. Updated `BUGS.md`, `DO_NEXT.md`, and `STATUS.md` to reflect the fixes and queued downstream validation + new sim-backed tests for the previously unexercisable surfaces.

**2026-06-29 — PR #175 merged; added diagnostics for a one-time `terraform-sim` CloudWatch Logs flake.**
PR #175 (`feat/adversarial-spec-probes`) added adversarial spec-fidelity probes for ECR/CloudTrail/KMS and CloudWatch Logs and merged to `main`. The first `terraform-sim` CI attempt flaked during `validate-sockerless-713.sh` apply with `ResourceAlreadyExistsException: /eddsim/control-plane`, immediately after the DNS/TLS step reported a successful destroy; a re-run passed. Local reproduction attempts were inconclusive. Rather than ignore the flake, added diagnostics: (1) the `terraform-sim` CI job now captures the sockerless container logs on failure, and (2) `validate-sockerless-713.sh` now dumps pre-existing `/eddsim*` log groups before apply so a leaked group is visible. The root cause remains under investigation; an upstream sockerless issue will be filed only once a reproduction or clear evidence is in hand.

**2026-06-29 — CI flake-resilience pass (boyscout rule): hardened `terraform-sim` CloudWatch Logs flake and added retries to heavy e2e tiers.**
Following the one-time `terraform-sim` `ResourceAlreadyExistsException: /eddsim/control-plane` flake on PR #175, applied a CI-wide flake-mitigation pass rather than relying on re-runs: (1) `validate-sockerless-713.sh` now lists pre-existing `/eddsim*` log groups and deletes the three module log groups via standard AWS APIs before apply (endpoint-only self-healing); (2) the `terraform-sim` CI job now waits for the sim AWS API to be reachable after bring-up and captures sockerless container logs on failure; (3) CI-only retries enabled on the heavy/slow e2e tiers — `apps/web/playwright.vscode.config.ts`, `apps/web/playwright.live.config.ts`, `packages/e2e/vitest.e2e.config.ts`, `apps/web/vitest.e2e.config.ts`, and `services/ssh-gateway/vitest.e2e.config.ts`. Updated `STATUS.md`, `BUGS.md`, and `DO_NEXT.md`. The root cause of the original sim consistency issue remains under investigation; an upstream sockerless issue will be filed only with a reproduction or clear evidence.

**2026-06-29 — Second adversarial spec-fidelity probe wave; two upstream sockerless gaps filed.**
Added probe slices for the AWS surfaces the module depends on that were not yet audited: SQS DLQ redrive on `maxReceiveCount`, Application Auto Scaling target tracking on ECS, ECS service scheduler `DesiredCount` reconciliation, EC2 security group ingress rules (CIDR and referenced-group sources plus revoke idempotency), and CloudWatch Logs metric filters. Created `run-adversarial-slices.sh` to run all slices and wired it into the `terraform-sim` CI job after `validate-sockerless-713.sh`. Hardened the existing ECR/CloudTrail/KMS slice by bounding CloudTrail pagination to a time window and a page cap, preventing an unbounded loop when the sim accumulates events from prior runs. All slices pass against sockerless `35f0f087`. Found two genuine spec gaps during probing and filed them upstream rather than working around them: **e6qu/sockerless#722** (`RevokeSecurityGroupIngress` succeeds for a non-existent rule; real AWS returns `InvalidPermission.NotFound`) and **e6qu/sockerless#723** (`PutMetricFilter` accepts an invalid filter pattern; real AWS returns `InvalidParameterException`). The probes skip the strict assertions and record the gaps. Also retained the earlier boyscout flake-hardening pass (CI retries on heavy e2e tiers, `terraform-sim` log-group cleanup / sim health wait / failure-time logs).

**2026-06-29 — Opened PR #177 with the probe wave + flake hardening.**
Prepared and pushed `feat/adversarial-spec-probes-wave2-clean`: the second adversarial spec-fidelity wave, the `terraform-sim` flake hardening, CI retries on heavy e2e tiers, and upstream gap records (#722/#723). All pre-commit checks and local slice runs pass.

**2026-06-30 — sockerless #725 bump; adversarial probes #722/#723 now strict.**
Upstream **e6qu/sockerless#725** merged at `eaf80dc`, fixing the two probe-wave gaps: **#722** (`RevokeSecurityGroupIngress` now returns `InvalidPermission.NotFound` for a non-existent rule) and **#723** (`PutMetricFilter` now rejects an invalid filter pattern with `InvalidParameterException`). Re-pinned the `third_party/sockerless` submodule from `35f0f087` to `eaf80dc`, rebuilt the process-mode sim, and removed the previous `SKIP` paths in `adversarial-slice-ec2-sg.sh` and `adversarial-slice-cloudwatch-metric-filter.sh` so each probe fails loud if the fixed behavior regresses. Ran the full `run-adversarial-slices.sh` orchestrator against the rebuilt sim: all slices pass, including the newly strict EC2 SG revoke-not-found and CloudWatch Logs metric-filter validation probes. Updated `BUGS.md`, `STATUS.md`, and `DO_NEXT.md` to mark #722/#723 fixed-confirmed and reflect the new pin.

**2026-06-30 — Opened PR #178; discovered + filed sockerless #727 regression in revoke-by-rule-id.**
Pushed `feat/bump-sockerless-725-strict-probes` as **PR #178** to land the sockerless #725 bump and strict adversarial probes. All CI jobs passed except `terraform-sim`, which failed during `terraform destroy` while deleting `aws_vpc_security_group_ingress_rule`/`aws_vpc_security_group_egress_rule` resources with `InvalidPermission.NotFound`. Reproduced locally against the rebuilt sim: after `authorize-security-group-ingress` returns a rule id and `describe-security-group-rules` confirms the rule exists, `revoke-security-group-ingress --security-group-rule-ids <id>` fails with `InvalidPermission.NotFound`. Revoking by spec still works, so **sockerless #725 fixed spec-based revoke-not-found (#722) but regressed rule-id-based revoke**. Filed the new upstream bug as **e6qu/sockerless#727** with a minimal AWS-CLI repro and updated `BUGS.md`, `STATUS.md`, and `DO_NEXT.md`. PR #178 remained open and red pending a fix.

**2026-06-30 — Verified sockerless #727 fixed upstream; re-pinned submodule to `e2fafce6` and closed #727.**
A later check of upstream `main` revealed the rule-id revoke fix was already present (the `ec2RevokeByRuleIDs` helper in `simulators/aws/ec2.go`). The upstream maintainer's comment on #727 cited a non-existent commit SHA, but the code existed. Re-pinned `third_party/sockerless` from `eaf80dc` to `e2fafce6`, rebuilt the process-mode sim, and ran the exact reproduction: `revoke-security-group-ingress --security-group-rule-ids <id>` now returns `{"Return":true}` for an existing rule and removes it. Commented on and closed **e6qu/sockerless#727**. Updated `BUGS.md`, `STATUS.md`, and `DO_NEXT.md` to reflect the fix and the new submodule pin. Pushed the changes; full CI on PR #178 passed, including the previously failing `terraform-sim` job. PR #178 is green and ready to merge.

**2026-06-30 — Wave-3 KMS adversarial probe blocked upstream; filed e6qu/sockerless#732.**
Attempted to create `infra/terraform/modules/ecs-dev-desktop/tests/sim/adversarial-slice-kms-encryption.sh` to prove KMS keys actually encrypt/decrypt data and that key-policy access control works for the module's CloudWatch Logs/Secrets Manager/EBS usage. Against sockerless `e2fafce6` (`SIM_RUNTIME=process`, endpoint http://127.0.0.1:4566, region us-east-1, creds test/test) the probe hit two spec violations: (1) `kms:Encrypt` returns a trivial `kms-sim:<key-id>:<base64-plaintext>` blob that leaks the key ID and plaintext instead of an opaque ciphertext; (2) `kms:Decrypt` succeeds even after the key policy is updated to explicitly `Deny` `kms:Decrypt` for the current principal. Per §6.8 we did not work around the gap; filed **e6qu/sockerless#732** with a minimal AWS-CLI reproduction and recorded the blocker in `BUGS.md`/`DO_NEXT.md`. The slice will be implemented once the upstream fix lands.

**2026-06-30 — Wave-3 Route53 DNS adversarial probe blocked upstream; filed e6qu/sockerless#731.**
Created `infra/terraform/modules/ecs-dev-desktop/tests/sim/adversarial-slice-route53-dns.sh` (POSIX sh, shellcheck-clean, endpoint-only) to prove that hosted zones and records created via the Route53 HTTP API are resolvable through the sim's authoritative DNS server, matching the `app.<domain>` A alias and `*.<ssh-base-domain>` wildcard the ecs-dev-desktop module creates. The script creates a public hosted zone, retrieves its NS records, creates an A record (`app -> 1.2.3.4`) and a wildcard CNAME (`* -> app`), queries the records with `dig`/`drill`/`nslookup`, asserts the responses, and cleans up. Against sockerless `e2fafce6` (`SIM_RUNTIME=process`, endpoint http://127.0.0.1:4566, DNS port 15353, region us-east-1, creds test/test) the A record and NS records resolve correctly, but the wildcard CNAME does not: `route53_dns.go:resolveRoute53` matches only exact names, so `*.example.test` answers only a literal query for `*.example.test`; `foo.example.test` returns NXDOMAIN/NODATA. Per §6.8 we did not weaken the assertion or work around the gap; filed **e6qu/sockerless#731** with a minimal AWS-CLI + `dig` reproduction and recorded the blocker in `BUGS.md`/`DO_NEXT.md`. The slice will be enabled once the upstream fix lands.

**2026-06-30 — Wave-3 EC2 security-group network-layer enforcement probe slice created.**
Added `infra/terraform/modules/ecs-dev-desktop/tests/sim/adversarial-slice-ec2-sg-network.sh` (POSIX sh, shellcheck-clean). The slice creates a VPC, public subnet, two security groups, and two Fargate awsvpc tasks (one in each SG), then authorizes ingress to SG-A from SG-B. It proves enforcement by inspecting the host nftables ruleset: it asserts that the source-SG reference on SG-A is expanded to task B's live ENI IP/32 and installed as a packet filter on task A's NIC, that the reverse direction (A → B) has no such allow rule, and that a CIDR-based ingress rule on SG-B is also materialized. The AWS API surface remains endpoint-only; only the host-packet-path verification requires a real-exec host (Linux + CAP_NET_ADMIN + iproute2 + nftables + container runtime). It did not pass locally because this macOS environment lacks `ip`/`nft` and cannot access the Docker/Podman socket, but the script is intended for the Linux CI real-exec harness. Not added to `run-adversarial-slices.sh` because that runner targets the process-mode `terraform-sim` job.

**2026-07-01 — Started third adversarial spec-fidelity probe wave; sockerless #737 fixed #731/#732.**
Began implementing ten new adversarial probe slices on `feat/adversarial-probes-wave3` to increase confidence in module-critical AWS surfaces: CloudWatch Alarm → SNS, Route53 DNS resolution, ACM + ALB TLS termination, KMS encryption-in-use, EC2 SG network-layer enforcement, ECS rolling update + circuit breaker, S3 backend encryption/lifecycle, EBS cross-region snapshot copy, Budgets notification wiring, and ECS reconciler heal. Upstream **e6qu/sockerless#737** fixed **#731** (Route53 wildcard DNS) and **#732** (KMS real encryption + key-policy Deny enforcement), so the Route53, ACM/TLS, and KMS probes are enabled and pass locally. Filed **e6qu/sockerless#734** for CloudWatch alarm SNS → SQS delivery being flaky/malformed; the alarm probe skips the SQS receipt assertion but still proves alarm state transition and AlarmActions wiring. The network-layer SG and ECS reconciler-heal probes require `SIM_RUNTIME=docker` and skip gracefully in process mode. Updated `BUGS.md`, `STATUS.md`, and `DO_NEXT.md` to reflect the new state.

**2026-07-03 — Re-pinned to sockerless #764; CloudWatch fan-out confirmed working but slow; filed bleephub follow-up #765.**
After sockerless **#764** (`6756ecfb`) added SNS→SQS fan-out observability logging and OAuth team fidelity, re-pinned the `third_party/sockerless` submodule and ran the integrated `terraform-sim` CI job. The CloudWatch alarm now produces a successful fan-out (`SNS to SQS delivery succeeded` in the sim logs), but in the integrated environment the delivery arrives ~20 seconds after the alarm reaches `ALARM` — the evaluator is busy processing Terraform-managed alarms. Increased the probe's ALARM settle wait from 0 to 3 seconds and the SQS `receive-message` polling timeout from 10 to 30 seconds (`infra/terraform/modules/ecs-dev-desktop/tests/sim/adversarial-slice-cloudwatch-alarm-sns.sh`). Shellcheck and sh/zsh parse checks pass. The bleephub `GET /user/teams` endpoint, however, still returns an empty list for the OAuth web-flow token used by our GitHub OAuth e2e, so Auth.js maps the test `admin` user to `viewer`; **sockerless #764 did not resolve our case**. Filed a focused upstream follow-up as **e6qu/sockerless#765** and updated `BUGS.md`, `STATUS.md`, and `DO_NEXT.md`.

**2026-07-03 — CI run on PR #180 after timeout bump: fan-out logs success but SQS ReceiveMessage returns empty; filed sockerless #766.**
Pushed the probe-timeout commit (a79c11b) and watched CI run **28663582552**. The `terraform-sim` job progressed further: the CloudWatch alarm transitioned to `ALARM`, SNS fan-out started, and sockerless logged `SNS to SQS delivery succeeded`. However, the probe's 30-second poll of `AmazonSQS.ReceiveMessage` returned an empty `Messages` array on every call, so the probe still failed. This indicates the #764 fan-out path reports success without persisting a receivable message in the integrated environment. Filed **e6qu/sockerless#766** with the CI logs and the exact queue/topic/alarm ARNs. The `e2e` and `e2e-https` jobs also failed because bleephub `GET /user/teams` still returns `[]`, mapping the test user to `viewer`. All other jobs (`build-test`, `integration`, `playwright`, `check-deps`, `sast`, `vuln-scan`, `terraform`, `shellcheck`, `code-health`, `branch-current`) passed. Updated `BUGS.md`, `STATUS.md`, and `DO_NEXT.md` to reflect the new blocker. PR #180 remains open, waiting on upstream fixes for **#766** and **#765**.

**2026-07-03 — Root cause found: probe `echo` bug, not sim; sockerless #767 re-pin; all probes pass locally.**
sockerless **#767** (`f0d96ec3`) landed with bleephub team creator auto-maintainer (#763/#765) and SQS receive diagnostics (#766). Re-pinned the submodule and built the sim locally. Running the CloudWatch alarm probe still failed — but with `SIM_LOG_LEVEL=debug`, the #767 diagnostics revealed `ReceiveMessage picked=1 totalMessages=1 visibleMessages=1` on the first poll: **the message was being received all along**. The real bug was in our probe: `echo "$raw"` pipes JSON to python, but POSIX `echo` interprets backslash sequences (`\\` → `\`), corrupting the deeply-nested SQS Body (the SNS notification wrapper containing a JSON-stringified CloudWatch alarm message). Python's `json.load` failed silently (`2>/dev/null || true`), so `message_body` was always empty. Fixed by replacing `echo "$raw"` with `printf '%s\n' "$raw"` and parsing the nested SNS→CloudWatch JSON structure with proper `json.loads(body["Message"])` instead of fragile `grep -qF`. Closed **e6qu/sockerless#766** (not a sim bug). All probe slices pass locally against sockerless #767.

**2026-07-05 — First-ever real execution of `scripts/install.sh` surfaced four latent bugs, all fixed live mid-deploy.** With the AWS account/domain decisions resolved (region `eu-west-1`; domain `edd.e6qu.dev` delegated from Namecheap-registered `e6qu.dev`; GitHub OAuth via org `e6qu-org`), ran the real production install for the first time ever against real AWS — the install/bootstrap scripts had only ever been shellchecked before, never actually executed. Four bugs surfaced in sequence, each fixed and the run retried: (1) `install.sh`'s `missing()` parameter-validation helper had inverted return logic, aborting whenever a required parameter WAS supplied and passing silently when one was actually missing; fixed by taking `<name> <value>` and correcting the test. (2) `bootstrap-secrets.sh`'s `put_secret` raced Secrets Manager's own eventual consistency — a `describe-secret` immediately after a `create-secret` 404'd on `EDD_AGENT_SECRET` even though the create had (presumably) succeeded; fixed by reading the ARN directly off whichever call actually ran instead of a redundant follow-up describe. (3) A skipped Entra prompt (`read` hitting EOF with no TTY) aborted the whole script under `set -eu` despite "blank = skip" being documented, and separately the final ARN-summary loop's exit status depended on whether the _last_-listed field (`AUTH_MICROSOFT_ENTRA_ID_SECRET`, always blank for this GitHub-only deploy) happened to be empty — both fixed. (4) `install.sh`'s `EDD_AZS` → HCL-list `sed` pipeline always emitted an unclosed list (`["eu-west-1a","eu-west-1b","`) because force-appending a trailing comma before globally quoting every comma left nothing for the final substitution to convert into `"]`; this reached `terraform apply` as a real HCL syntax error cascading into parse failures on every subsequent `install.tfvars` line. Fixed with a simpler, correct sed pipeline. A fifth bug was found once `terraform apply` was actually running: the module's `build-local.tf` local-exec provisioner combined a `${path.module}`-relative script path with a `working_dir` override, so once `working_dir` changed the shell's cwd the relative path no longer resolved and the image-build step failed with "No such file or directory"; fixed by making the script path `abspath()`-resolved so it's immune to `working_dir`. All fixes verified (shellcheck, `terraform fmt`/`validate`, and functional re-runs) and applied on `fix/install-missing-param-logic` before continuing the real deploy. See `BUGS.md` → Resolved (repo) for full detail on each.

**2026-07-05 — Two more real module bugs found once `terraform apply` actually started running.** Neither was ever exercisable against the sockerless sim: (1) `aws_kms_key.this` had no explicit key policy, so AWS applied its default root-only policy; DynamoDB/EBS/Secrets Manager encryption with the key worked fine (each authorizes via the calling principal's own IAM permissions), but CloudWatch Logs encrypts as the `logs.<region>.amazonaws.com` service principal, which the default policy doesn't cover — all four log groups failed with `AccessDeniedException`. Fixed by giving the key an explicit policy (root statement + a scoped CloudWatch Logs service-principal grant). (2) The SSH-gateway security group's description contained a non-ASCII em-dash, and `CreateSecurityGroup`'s `GroupDescription` is ASCII-only on real AWS (the sim doesn't enforce this); fixed by using a plain hyphen. Separately, the fck-nat NAT instance failed to launch: `RunInstances` rejected the default `t4g.nano` type with `InvalidParameterCombination: ... not eligible for Free Tier` — this AWS account hasn't graduated past AWS's Free-Tier EC2 instance-type restriction yet (same class of restriction that blocks Route53 Domains registration). Not a code bug, but the module had no override path through the standard install flow; added `nat_instance_type` as a passthrough variable (`examples/complete`) and `EDD_NAT_INSTANCE_TYPE` to `install.sh`, both defaulting to `t4g.nano` (unchanged for graduated accounts), and used `t4g.micro` (same Graviton family, confirmed free-tier-eligible) for this deploy. See `BUGS.md` → Resolved (repo).

**2026-07-05 — `apps/web/Dockerfile` failed to build on its first-ever real invocation.** Only `release.yml` (dormant/gated until now) ever runs `scripts/publish-images.sh`, which builds this Dockerfile — so it had never actually been built before. `pnpm install --frozen-lockfile` failed compiling `services/editor-monaco`'s `node-pty` native binding (`gyp ERR! Could not find any Python installation to use`): the workspace-wide install pulls in every package's dependencies regardless of what `apps/web` actually uses at runtime, and the `node:22-bookworm-slim` base image ships no Python/C++ toolchain. Fixed by installing `python3 make g++` in the builder stage. Verified with a direct local `docker buildx build --platform linux/arm64 -f apps/web/Dockerfile .` — clean full build. See `BUGS.md` → Resolved (repo).

**2026-07-05 — Local `image_build_mode` hit a QEMU segfault on the amd64 leg (host is arm64); switched this deploy to `codebuild` mode.** `next build`'s SWC compiler crashed under QEMU user-mode emulation (`qemu: uncaught target signal 11 (Segmentation fault)`) — a known class of issue with stale QEMU binfmt handlers emulating complex Rust-compiled native binaries. Declined to run the privileged host-level QEMU refresh (`docker run --privileged ... tonistiigi/binfmt`) autonomously — that's a host-wide, third-party, elevated-privilege action needing the user's own say-so — and asked the user, who chose `image_build_mode=codebuild` instead (builds natively on AWS CodeBuild's x86_64 runners, no local QEMU at all). Needed `codebuild_source_ref`, which `examples/complete` didn't expose either (module default: `main`); added it so CodeBuild could build from the not-yet-merged `fix/install-missing-param-logic` branch directly. CodeBuild then surfaced a genuine bug of its own: `publish-images.sh`'s `build_push_arch ssh-gateway` call passed `services/ssh-gateway/` itself as the Docker build context, but `Dockerfile.proxy`'s `COPY` paths are repo-root-relative (same convention as the control-plane Dockerfile) — every `COPY` failed with "not found". This path had never been exercised (local mode never got past the control-plane image; this was CodeBuild's first run reaching it). Fixed by using the repo root as context. Also fixed a `seed_default_catalog` undeclared-variable warning in `examples/complete` (same hardcoded-instead-of-passthrough pattern PR #191 already fixed elsewhere) and cross-checked every other `install.tfvars` key against declared variables — no further gaps. See `BUGS.md` → Resolved (repo).

**2026-07-05 — Diagnosed and fixed the `pages` deploy workflow's retry bug.** The push-to-`main` `pages` run for PR #190 failed with a generic, detail-free `Deployment failed, try again later.` — ruled out an environment/branch-policy misconfiguration, a concurrency race (the job's `concurrency: {group: pages, cancel-in-progress: false}` was already correct), and a GitHub-side incident (checked githubstatus.com's incident history and Pages/Actions component status around the failure time — nothing). Re-running the failed job to gather more evidence instead reproduced a distinct, 100%-reproducible bug: `actions/upload-pages-artifact@v3` never overwrites (no `overwrite` input), and GitHub retains every attempt's artifact under the same run id, so the rerun's upload left TWO `github-pages` artifacts on that run — confirmed via the Artifacts API — and `deploy-pages@v4` then refused to disambiguate, failing with `Multiple artifacts named "github-pages"...`. This means any retry after a first failure (manual or automatic) was doomed from attempt 2 onward. Fixed by deleting any same-run `github-pages` artifact before uploading a fresh one (new `actions: write` permission on the job); `actionlint` clean. The original attempt-1 failure's root cause remains an unresolved one-off (no further evidence found), but the workflow can no longer compound it into a permanent retry failure. See `BUGS.md` → Resolved (repo).

**2026-07-05 — AWS account/domain decisions resolved; started the real production deploy.** The user resolved `DO_NEXT.md` open decisions #1 (AWS account: credentials already configured, region `eu-west-1`) and #2 (domain: register `e6qu.dev`, with a dedicated delegated Route53 zone `edd.e6qu.dev` for this project — `app.edd.e6qu.dev` control plane, `ssh.edd.e6qu.dev` SSH front door, same zone). IdP: GitHub OAuth only, org `e6qu-org`, admin team `e6qu-org-admins`, developer team `e6qu-org-members`. Explicitly confirmed `nat_mode=instance` (fck-nat) over the AWS-managed NAT Gateway, and declined an AWS Budgets guardrail for this first deploy. Before the real `apply`, verified `docs/install.md`/`docs/deploying.md` against current code (an Explore pass) and found `examples/complete` silently dropped six Terraform variables the install flow needs (`nat_mode`/`single_nat_gateway` derived from `var.environment == "prod"` — a footgun given the stack is named `edd-prod`; `image_build_mode`/`golden_image_repos`/`codebuild_source_repo`/`monthly_budget_usd`/`alarm_sns_topic_arns` either hardcoded or entirely undeclared) — fixed on `feat/tf-example-nat-mode-fix` (see `BUGS.md` → Resolved (repo)) before proceeding to the real deploy.

**2026-07-06 — The real production deploy went live; a live IAM gap and a live OAuth redirect bug found and fixed post-deploy.** `terraform apply` succeeded (`edd-prod`, `eu-west-1`), and `scripts/install.sh --verify` was fully green. Verify itself needed a fix first — its required-parameter validation ran unconditionally for both install and `--verify`, contradicting the documented "just EDD_NAME/EDD_REGION" verify usage (never exercised before this session's first real `--verify` call) — and surfaced a real IAM gap once fixed: `/api/readyz` 503'd on `dynamodb:DescribeTable`, missing from both `iam.tf` and the `IAM_REQUIREMENTS` manifest. Fixed both. Separately, the user's first sign-in attempt hit `redirect_uri_mismatch` from GitHub — Auth.js built the OAuth callback URL from the container's internal ECS hostname instead of `app.edd.e6qu.dev` (confirmed via CloudWatch logs); `AUTH_TRUST_HOST=true` alone wasn't resolving it correctly through this app's custom server. Fixed by setting `AUTH_URL` explicitly. Applying both fixes required reverting an accidental `image_build_mode` switch to `pre-published` (which destroyed the CodeBuild project and task definitions mid-troubleshooting — the running services stayed healthy throughout on their old task-definition revision, but the fix required a full CodeBuild rebuild to reconcile state) and clearing several immutable-ECR-tag collisions from repeated retries (`ssh-gateway` and `golden/omnibus` are both immutable; expected from partial prior successes, not bugs). Once live again, a real user hitting `/workspaces` surfaced one more gap: the control-plane and reconciler task roles could read/write the DynamoDB table but not decrypt it — the only `kms:Decrypt` grant was on the task-execution role (for Secrets Manager injection at launch), not the task role the running app uses for its own DynamoDB calls (DynamoDB with a customer-managed KMS key needs the calling principal's own KMS grant, unlike CloudWatch Logs' service-principal model). Fixed with a `DecryptSingleTable` statement on both roles plus the matching `IAM_REQUIREMENTS` manifest entries; the `iam-policy-drift` test still passes. In total, 9 real bugs were found and fixed across this first-ever live deploy, all previously unexercised by the sockerless sim or static checks — full detail in `BUGS.md` → Resolved (repo).

\*_2026-07-06 — First real workspace-creation attempt found the `RunAndManageWorkspaceTasks` IAM statement wrongly gated `ecs:RegisterTaskDefinition`/`ecs:DescribeTaskDefinition` (and, in a follow-up sweep of `/admin/health`+`/admin/infrastructure`, three more IAM gaps) on an `ecs:cluster` condition that AWS's own IAM condition-key reference confirms neither action supports (task definitions are account/region-level, not cluster-scoped) — verified against AWS's Service Authorization Reference (not guessed) before fixing. Split into three statements: the cluster-conditioned actions unchanged, `RegisterTaskDefinition` scoped to the `edd-ws-_`family prefix (no condition),`DescribeTaskDefinition`unconditioned (wildcard-only, per its own documented lack of resource-level support). Also fixed:`logs:DescribeLogGroups`(account-wide, no resource type at all — couldn't share the log-group-scoped`Logs`statement), and previously-ungranted`ecs:DescribeClusters`/`ec2:DescribeAvailabilityZones`(the compute/storage health checks, found live via`/admin/health`reporting both DOWN with`AccessDeniedException`; the latter also explained an `/admin/infrastructure`500). Fixing the first RegisterTaskDefinition split introduced a second, subtler bug: the`IAM_REQUIREMENTS`manifest still marked it`resource: "any"`(simulated against literal`"*"`) while the real Terraform grant was scoped to a representative ARN, so the *live preflight self-check\* (not the real grant) started reporting a false "drift" — added a `workspace-task-definitions` resource scope resolved to a concrete probe ARN so the simulation matches the deployed policy. Separately, a fuzz test on this session's first real `pnpm test` run caught a pre-existing validation gap: `workspaceIdFromPath`'s label regex accepted a bare `"ws-"` with no suffix as a "valid" workspace id (an `install -d`-style leaf-only fix, tightened to require the prefix plus a non-empty suffix, capped at the original 39-char `ws-<uuid>` length) — this also broke an `ssh-gateway` unit test that had been using an unrealistic non-`ws-`-prefixed fixture, corrected rather than the regex loosened.

**2026-07-06 — Shipped an admin/developer "view as" persona switcher, a `/me` account page, and a collapsible/paginated repo browser.** Admins can now preview the app as developer/viewer and developers as viewer, via a topbar dropdown and `/me` — downgrade-only: `effectiveRole`/`personasFor` (`packages/authz`) clamp a requested persona to at most the caller's real role, and `setPersonaAction` always re-derives the real role server-side (never trusts a client-supplied one), so a crafted request can't escalate privilege. The override is a cookie-based `Principal.role` substitution with `Principal.realRole` preserved, applied once in `getPrincipal`/`getPagePrincipal` — every existing authz call site (`requireAdmin`, `defineAbilityFor`, the `/admin` layout gate) needed zero changes to respect it. Verified live: an admin who switches to viewer is immediately denied on `/admin`. Separately, "Start from a repository" was a single 100-repo fetch with only client-side search, always expanded — now collapsed behind a toggle (off by default) and paginated one GitHub page (30 repos) at a time via the `Link: rel="next"` response header, lazy-fetched only on first expand.

**2026-07-06 — Root-caused a live editor-breaking bug via CloudWatch logs (no exec needed); AI agent CLIs moved to every golden variant; Monaco terminal reworked; explicit zero-downtime deploy config.** A user hit "The editor could not be opened due to an unexpected error" — found via the workspace task's CloudWatch log stream (not exec — the SSM session-manager-plugin wasn't installed locally, and reading the log turned out to be sufficient) that OpenVSCode Server's very first startup action, `mkdir '/home/workspace/.openvscode-server/extensions'`, failed with `EACCES`, followed by the same failure on `data/logs`, `data/Machine`, and the user extensions dir — explaining both the editor failure and a separate "can't install extensions" report as the same root cause. Root cause: `install -d -o workspace -g workspace -m 0755 <nested/path>` (`infra/images/base/entrypoint.sh`) only chowns/chmods the _leaf_ of a given path — GNU coreutils creates missing intermediate components with the default mode, root-owned, since the entrypoint still runs as root at that point. Fixed by listing each directory level as its own `install -d` argument (self-healing: `install -d` re-chowns a target even if it already exists, so a workspace waking from a snapshot with the old broken ownership gets it corrected on next boot). Per request: the Claude Code + Codex (previously missing — added `@openai/codex`) agent CLIs/extensions moved from omnibus-only into the shared base image, so every variant carries both now; updated the `image-variants`/`workspace-toolchain` e2e suites (they'd asserted the opposite). Seeded two more first-boot defaults: `window.menuBarVisibility: classic` (the File menu wasn't shown) and a folder-open task that opens the terminal by default and prints a one-time tip that `claude`/`codex`'s OAuth browser redirect can't reach a remote workspace — both CLIs already support pasting the code shown in the browser instead, so this is pure user education, no new infrastructure (confirmed via research: no device-code flow exists upstream, and OpenVSCode Server itself has no built-in port-forwarding-to-browser capability to build on, unlike GitHub Codespaces' proprietary layer). Reworked the first-party Monaco editor's terminal to match: opens by default, multi-tab (the server already spawned one PTY per WebSocket connection — multi-tab was purely a client-side gap), `` Ctrl+`/Cmd+` `` shown as a hint and wired to toggle (+Shift for a new tab), and the same OAuth tip on every new terminal. Also made the control-plane's rolling deploy explicitly zero-downtime (`deployment_minimum_healthy_percent=100`/`maximum_percent=200`, previously relying on AWS's identical but undocumented default) and gave the ALB target group a longer drain window (`deregistration_delay` 300s → 900s) so an in-flight workspace proxy session survives a deploy's drain rather than being cut off — it also carries every workspace editor's proxied HTTP/WebSocket traffic, not just page requests. Along the way, hit and recorded a real deploy-tooling footgun (`BUGS.md`): re-running `install.sh` with the same `EDD_CODEBUILD_SOURCE_REF` branch name after pushing new commits silently no-ops (terraform's `triggers_replace` is keyed on the literal ref string, not the resolved commit) — `EDD_IMAGE_TAG` must be bumped to force a real rebuild.

**2026-07-06 — Post-launch feature wave shipped: idle semantics v2, per-workspace monitoring, agent-first editor modes, session resilience — plus a fuzz-found request-crash and a scheduler-DLQ gap fixed.** Idle detection was redefined per product decision: "idle" now means _not loaded by any user_ — an open editor tab (even a background tab with zero interaction) or an attached-but-quiet SSH session keeps the workspace running, capped by the authorizing auth session's validity, and once truly unloaded a **5-minute cooldown** snapshots + stops it. Implemented as a per-replica `PresenceRegistry` in the workspace proxy (every proxied editor WebSocket is tracked with the session's `exp` captured at upgrade; a 60s sweep sends `active` heartbeats for present workspaces) plus a `/proc/net/tcp` established-:22 signal in the idle-agent. The workspace card gained a size line (vCPU/mem/disk incl. live usage from a new `df` self-report on the heartbeat), a closeable ⓘ session-details overlay, and a **Monitoring** page (`/workspaces/[id]/monitoring`): uptime, cost-so-far with the **snapshot-storage line** broken out (the cost model already computed it; now owner-visible), and CPU/memory/EBS-IOPS sparklines via a new `CloudWatchMetricReader` (`GetMetricData`, endpoint-only; new `cloudwatch:GetMetricData` grant + manifest entry). Editor selection shipped at session creation — OpenVSCode / Monaco / **Claude Code** / **Codex** — after research confirmed neither vendor ships a self-hostable web UI (their "web apps" are hosted-only; Claude's Remote Control is outbound-only to claude.ai), so the agent modes run the Monaco server with every terminal booting straight into the CLI (`EDD_TERMINAL_COMMAND`). Sessions moved to 4-hour rolling JWTs (`maxAge`/`updateAge`), the persona cookie became schema-versioned (`<v>:<role>`, §6.5a, fail-soft on any other shape), and a "reset cookies" escape hatch landed in the topbar + `/me`. A pre-commit fuzz run caught a genuine crash — `cookieValue` threw `URIError` on a truncated percent-escape (`Cookie: edd-persona=%` → 500 on any request); fixed (return raw on decode failure) with the counterexample pinned. Two operational gaps were found live and fixed: every apply used to deregister the old reconciler task-definition revision before the EventBridge schedule repointed, silently DLQ-ing scheduled runs in the window (21 accumulated messages — `skip_destroy = true` added, backlog purged), and **golden-image updates never reach the catalog** (the seeded row is `ignore_changes` + ECR tags immutable — repointed manually per rebuild; recorded in `BUGS.md`, automation needs a product decision). The public-spectate request was NOT implemented: it is the largest new attack surface to date (unauthenticated live view incl. keystrokes), so a design proposal (`docs/design-public-spectate.md` — owner-published mirror stream, spectators never touch the workspace, Monaco-first) awaits user sign-off on scope/link semantics before any code.

**2026-07-06 — First real deletion exposed a total-deletion-stall IAM gap; 7-day undelete shipped.** Watching the user's first real workspace deletion converge revealed that it never could: every reconciler sweep logged `finishDeleting threw ... not authorized to perform: dynamodb:DeleteItem` — the reconciler's DynamoDB statement granted Get/Put/Update/Query/Scan but not DeleteItem (the record-removal op), so every deletion in production would have stalled in `deleting` forever; the same sweeps' cost-rollup checkpoint failed on the equally missing `dynamodb:BatchWriteItem`. Both granted (terraform + IAM manifest) and applied; the stuck deletion converged on the next sweep. The user then asked for **undelete**: deleted workspaces restorable for up to 7 days, snapshots fully removed after. Implemented as a semantic change to teardown — `finishDeleting` now keeps a `terminated` **tombstone** (terminatedAt stamped, runtime bindings cleared, the retained data-safety snapshot KEPT, quota still freed + `session.terminated` audited in the same transaction) instead of hard-deleting the record; the state machine gained `terminated --undelete--> stopped` (the only event out of terminated; the absorbing-state fuzz property was updated accordingly); `WorkspaceService.undelete()` enforces the retention window and re-admits quota through the same atomic counter condition as create; a new reconciler sweep step purges expired tombstones (snapshot reaped FIRST so a transient failure never leaks a record-less snapshot, then record removed + `session.purged` audited; `EDD_UNDELETE_RETENTION_MS`/`var.undelete_retention_ms`, default 7 days); `reconcileOwnerCounts` and the create route's quota read-check exclude tombstones. UI: an Undelete button on the card, a "Recently deleted" section with a restorable-days countdown, and delete-confirm copy updated (no longer "irreversible"). Proven in integ end-to-end (delete → tombstone → undelete → start → running; window refusal; target-scoped purge). Also fixed en route: the reconciler's IAM self-check false-denied the KMS trio because the manifest simulated a key-scoped grant against `"*"` — a new `kms-key` resource scope resolves the real `EDD_KMS_KEY_ARN` (preflight now reports 0 denials live). Known approximation recorded in `BUGS.md`: the cost model doesn't yet price the undelete window's retained-snapshot storage or post-undelete resumption. One legacy artifact: `snap-0c91fecd14c808ec3` (the user's pre-undelete deletion) is a record-less retained snapshot with no restore button — kept pending the user's keep/delete call.

**2026-07-06 — Spectate v1 shipped: owner-shared, read-only live mirror for signed-in viewers.** The last feature of the post-launch wave, implemented exactly to the signed-off design (`docs/design-public-spectate.md`): a workspace owner flips a default-off "Share view" toggle on the card (behind an explicit consequences confirmation) and any **signed-in EDD user with at least the `viewer` role** — no anonymous links, no share tokens; the Auth.js session + role + share flag is the whole gate — can watch `/workspaces/<id>/spectate`: the owner's open file with cursor-line highlight, selection, normalized mouse position, live terminal output (write-only xterm), and focus state, all behind a **full-viewport interaction-blocking overlay** with a persistent read-only banner. Architecture is mirror-stream: **spectators never connect to the workspace** — the owner's Monaco editor tab publishes its rendered view state over `/api/spectate/<id>/publish` (owner-only; an admin may not impersonate a share) and unbounded viewers subscribe on `/subscribe`, so the viewer path is read-only by construction rather than by protocol filtering. Late joiners get a cached snapshot replay (file/cursor/focus/tabs/mouse — deliberately never terminal scrollback, per the no-backfill decision); a reloaded owner tab replaces the publisher without dropping viewers; the flag is cleared automatically on stop/delete (sharing never outlives the session) and spectator sockets are excluded from presence/idle (a viewer can't keep a workspace billing). v1 simplifications recorded in `DO_NEXT.md`: the relay is per-replica (the viewer client retries its WebSocket until it lands on the publisher's replica — a cross-replica internal bridge is the follow-up) and OpenVSCode sessions don't mirror yet (needs `edd-workspace-ui` extension capture; the viewer shows an honest "not publishing" note). Deployed as `fe7cc2b` (all-green verify, no drift, catalog repointed); relay/authz/core-flag behavior unit-tested (fan-out, snapshot replay, publisher replacement, ended fan-out, admin-can't-publish, role floor, flag-off-forbids-all). Boy-scout: the three identical not-signed-in page gates collapsed into `SignedOutBlock`, and the logs/monitoring route prologue into `loadOwnedWorkspaceDetail`.

**2026-07-06 — Live 504 on workspace create root-caused (not a failure); instant create shipped.** A user hit a 504 clicking "create" — but the control-plane log showed `workspaces.create` returning `201` after `durationMs=123402`: the create had SUCCEEDED server-side. The browser's request simply outlived the ALB's 60s idle timeout while the first pull of the multi-GB golden image ran (~2min), so the ALB returned 504 to the browser over a request that was still completing. The "failed" workspace (`ws-17a65dff`) was in fact fully provisioned and healthy (later scaled to zero, `functional: ok`). Fixed structurally rather than by bumping the ALB timeout: `WorkspaceService.create()` was split into `reserveWorkspace()` (persist the record — id pre-generated, `provisioning`, quota still atomic — and return instantly) and `launchReserved()` (the runTask→markProvisioned bind), and the web route now returns after the reserve (<1s) and fires the launch DETACHED. `launchReserved` never rejects: a launch failure lands on the record as `error` + reason (`functionalDetail`), a delete-mid-launch stops the fresh task (crash consistency; reaper backstop), and the reconciler's provisioning-timeout recovery covers a process dying mid-launch. Crash-consistency inverted for the better — a persist outage now launches nothing (record-first ordering). New `retry` lifecycle action (error→provisioning) drives a status-page Retry button (relaunch fresh, or recover+start when a snapshot survives so data isn't discarded). Status-page UX per the user's design answers: the launcher navigates immediately to `/workspaces/<id>?autoopen=1`; the page shows the workspace's own copyable URL, a provisioning phase stepper (created → launching compute → starting editor → ready, elapsed time on the active phase, derived purely from state + the agent's functional report) above the live boot-log tail, and auto-opens the editor 3s after ready with a "stay here" cancel (launch-visit only). Contracts gained `lastActivity` (phase timer, now a deliberate public DTO field — shape + never-leak fuzz tests updated) and `functionalDetail` (failure reason) on the workspace DTO; `workspaceAction` gained `retry`. Boy-scout: the five one-verb lifecycle route shells (start/stop/snapshot/retry/undelete) collapsed into a `lifecyclePOST` factory. Deployed as `ef86f2c` on branch `feat/instant-create-provisioning-ux` (control-plane-only change; golden image unchanged, catalog left at `fe7cc2b`). 61 integ green (instant-visibility, launch idempotency, fail-once→retry→running); local Playwright 18/18.

## 2026-07-07 — Fast deploys, Images console, cancelable stop, and a rigorous debug run

- **Deploy decoupling** (`EDD_BUILD_TARGET=web|golden|all`): the single CodeBuild
  pipeline rebuilt both the small control-plane image and the ~3GB golden image every
  time (~22min). `web` builds control-plane only (~3min build / ~7min total, proven
  live). Catalog seed is create-only, so a web deploy never repoints at an unbuilt
  golden. Golden rebuilds are now an explicit action.
- **Images admin console** (`/admin/images`, Phases 2+3): `ImageOps` port + AWS adapter
  (ECR + CodeBuild + CloudWatch Logs) + fake; per-image compressed size + per-layer
  breakdown, trigger a build, last-20 history, live logs. Scoped IAM added.
- **Cancelable `stopping` lifecycle**: manual stop → `stopping` (snapshot + scale-to-zero
  after a grace) with cancel/resume; converged by an in-process server sweep (not a
  detached route promise, which Next doesn't reliably run) + a reconciler backstop.
- **Lesson — reproduce, don't guess:** the CI integration+playwright failures were
  chased to root cause by running the exact failing tests + the real `server.ts` against
  a local DynamoDB (podman), peeling one layer at a time: (1) the DB READ mapper dropped
  `stopRequestedBy` (a multi-line edit silently no-op'd) → stop audited to `system`;
  (2) playwright ran `next start`, not the custom `server.ts`, so the sweep never ran;
  (3) `finishStop` hung forever when its snapshot hit a gone volume (now best-effort);
  (4) the workspaces page's `TRANSITIONAL_STATES` omitted `stopping`, so the card froze.
  All four were real; #3/#4 are prod bugs. Added an end-to-end proxy⇄Monaco token
  handshake test (the "unauthorized" regression guard the flow never had).

**2026-07-07 — Agent web UI direction corrected: reuse vendor harnesses, no EDD
reimplementation.** The user rejected the build-our-own agent UI path. The intended four
workspace interfaces are OpenVSCode, Monaco, Claude Code, and Codex. For Claude Code,
Anthropic's current docs distinguish Claude Code on the web (cloud-hosted) from Remote
Control, where `claude.ai/code` drives a Claude Code process running locally with local
tools/project config available; that is the target for `claude` workspaces. For Codex,
OpenAI's current Codex manual documents `codex app-server` as the local protocol backend
for rich clients (authentication, conversation history, approvals, streamed events);
that is the target for `codex` workspaces. Updated code comments/UI labels and continuity
docs to stop saying the Monaco-terminal CLI fallback is the faithful final product; it is
now recorded as an implementation gap until runtime wiring replaces it.

**2026-07-07 — PR #193 e2e fixed locally; dependency gate refreshed.** Checked the open
PR (#193 on `feat/instant-create-provisioning-ux`) and reproduced its red `e2e` path
locally. The failures came from tests that still assumed workspace creation returned
`running`; instant create now correctly returns `provisioning` while launch happens
detached. Updated the e2e helpers/specs to wait for `running` before stop/connect
assertions. The last failure, SSH wake-chain, was a test-harness mismatch: the custom
server sweep and compiled Next route handlers have separate in-memory fake-storage
instances, so the stop sweep cannot snapshot a route-created fake volume. The test now
creates a resume snapshot through the public snapshot API before stopping, then proves
the registered-key SSH gateway wakes the stopped workspace through the real
control-plane `/connect` path. Also improved `wake-and-forward.sh` diagnostics to log
the `/connect` response body on non-200. `vitest` was bumped to the latest
age-eligible `4.1.10` and the lockfile refreshed. Verified: `pnpm test`,
`pnpm lint`, `pnpm test:integ:local`, `pnpm test:e2e:local`, `pnpm check-deps`,
`pnpm dead-code`, `pnpm cpd`, plus shellcheck/bash/zsh parse sweeps (the zsh
`nice(5)` warning on the base entrypoint is recorded in `BUGS.md`).

**2026-07-07 — Deployed PR #193 branch to the existing AWS environment.** Reused the
existing `edd-prod` coordinates (`eu-west-1`, `app.edd.e6qu.dev`,
`ssh.edd.e6qu.dev`, GitHub org groups) and ran a control-plane-only CodeBuild deploy
from branch `feat/instant-create-provisioning-ux` with image tag `eee7176` and
`EDD_BUILD_TARGET=web`. Baseline verify was green before the apply. CodeBuild
succeeded in 3m26s, Terraform registered task definition revision 25 for the
control-plane/reconciler/SSH gateway image set, and ECS rolled cleanly: control-plane
2/2 and SSH gateway 1/1 on revision 25. Final `scripts/install.sh --verify` was
green (ALB health 200, `/api/readyz` 200, reconciler schedule enabled, no drift), and
the deployed control-plane task definition points at
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/control-plane:eee7176`.
Recorded one deploy-tooling warning in `BUGS.md`: `terraform init` emits `Missing
backend configuration` because the complete example has no backend block while
`install.sh` passes `-backend-config`.

**2026-07-07 — PR #193 merged; clarified workspace-image state.** The user merged
PR #193 to `main` (`021ae3c`) after all checks passed, including `golden-images`.
That check proved the golden/workspace image build path in CI, but the live AWS
deploy was intentionally `EDD_BUILD_TARGET=web`, so production did not publish a
workspace image tagged `eee7176` and did not repoint the catalog. Verified in AWS:
`edd-prod/golden/omnibus` has newer pushed tags up to `458a744`, but no `eee7176`;
the live catalog entry currently launches
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:db75d1f`.
Recorded the distinction in `STATUS.md`, `BUGS.md`, and `DO_NEXT.md`.

**2026-07-07 — Added asynchronous post-merge workspace image builds, trackable from
the admin control plane.** Added `.github/workflows/post-merge-workspace-images.yml`:
on every push to `main` it assumes `PROD_IMAGE_BUILD_AWS_ROLE_ARN` and starts the
existing deployment CodeBuild project with `EDD_BUILD_TARGET=golden`, `TAG=<short
sha>`, `SOURCE_REF=main`, `SOURCE_VERSION=<exact merge sha>`, and
`EDD_TRIGGER=github-main-merge`; the workflow exits after `StartBuild` so the heavy
workspace image build remains asynchronous. Updated the Terraform CodeBuild buildspec
to honor `SOURCE_VERSION` by checking out the exact commit after cloning the branch.
Enhanced `/admin/images` build history to surface target, tag, trigger, and exact
source version, so auto-started builds are visible alongside admin-triggered builds
and their live logs. Docs now list the required workflow variables. Verified with
`pnpm lint`, `pnpm test`, `pnpm --filter @edd/web build`, `actionlint`, `terraform
fmt -check -recursive infra/terraform`, `pnpm check-deps`, `pnpm dead-code`, and
`pnpm cpd` (existing clone report / `.jscpd.json` `$schema` warning only).

**2026-07-07 — PR #194 merged; first post-merge image workflow skipped pending repo
configuration.** The user merged PR #194 to `main` at `bf6cd22`. The new
`post-merge-workspace-images` workflow triggered on that push, but GitHub marked the
`start golden image build` job as skipped because its guard
(`vars.PROD_IMAGE_BUILD_AWS_ROLE_ARN != ''`) was false. Confirmed against AWS: no
new `edd-prod-build-images` CodeBuild run started after the merge time, and
`edd-prod/golden/omnibus` still has `458a744` as its latest pushed tag while the live
catalog continues to launch `omnibus:db75d1f`. Next steps are configuration/deploy
rather than code: set the repo variable, apply the CodeBuild buildspec update, roll
the control plane, and rerun/wait for the next main push.

**2026-07-07 — Replaced GitHub Actions workspace-image automation with EDD-owned
source sync, without making EDD its own release dependency.** Removed the
`post-merge-workspace-images` workflow and moved deployed workspace/golden image
orchestration into the control plane: new DynamoDB `imageSource` /
`imageSourceTrigger` records, `/api/integrations/github/image-webhook` with GitHub
`X-Hub-Signature-256` HMAC verification, `/api/admin/image-source` for source state,
and `/admin/images` source-sync/trigger tables. The source flow is signed-webhook
only, with no polling fallback and no disabled/not-configured mode: missing
`EDD_IMAGE_SOURCE_REPO` or `EDD_IMAGE_SOURCE_WEBHOOK_SECRET` fails loudly in the API
and install script. It compares GitHub repo/branch observations, starts CodeBuild
asynchronously for exact SHAs when workspace-image inputs changed, and records
skipped triggers when they did not. `ImageOps.startBuild` now accepts
`SOURCE_VERSION` and trigger labels for both admin and source-triggered builds. CI
still owns control-plane release image builds, so EDD remains releasable without an
existing EDD deployment. Verified with targeted web tests and shellcheck/bash/zsh for
`scripts/install.sh`; then reran web lint/build, full repo lint/test (the test gate
needed an unsandboxed rerun because the web handshake test binds `127.0.0.1`), `pnpm
dead-code`, `pnpm cpd` (known below-threshold clone report), `pnpm check-deps`,
`actionlint`, and `terraform fmt -check -recursive infra/terraform`.

**2026-07-07 — Scoped the public GitHub image-webhook receiver.** After PR #195
merged to `main` at `eca7352`, PR #196 merged at `ff3c60d` and narrowed the only
unauthenticated integration route. The route rejected anything except a GitHub
`push` envelope with a UUID-shaped delivery id, `application/json`, a bounded body,
and a valid `X-Hub-Signature-256`; it verified HMAC before JSON parsing. Added
focused route/unit tests for malformed envelopes and invalid signatures. The
Terraform module attached a regional WAF web ACL to the control-plane ALB,
with rules scoped to `/api/integrations/github/image-webhook`: block non-`POST`,
block non-JSON `POST`, and rate-limit the path. The sim fixture gained the WAFv2
endpoint, so the same module path validates against real AWS or sockerless by
coordinates only.

**2026-07-07 — Re-checked the deployed app and workspace image builds.** Verified
the live `edd-prod` deployment after PR #196 had merged: `https://app.edd.e6qu.dev`
returned 200 from `/api/healthz` and `/api/readyz`; ECS control plane was 2/2 on
task definition `edd-prod-control-plane:25`; SSH gateway was 1/1 on
`edd-prod-ssh-gateway:25`; and the running control-plane image was
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/control-plane:eee7176`.
CodeBuild build #29 had succeeded, but it used `EDD_BUILD_TARGET=web` and the old
`SOURCE_REF=feat/instant-create-provisioning-ux`; current `main` was `ff3c60d`.
No regional WAF web ACL existed yet, and the live DynamoDB table contained no
`imageSource`/`imageSourceTrigger` records. The production catalog still launched
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:db75d1f`
from `PK=$edd#id_img-seed-omnibus`, `SK=$baseimage_1`; newer golden-target builds
existed in ECR, but the latest build was control-plane-only and no source webhook
had triggered a new tracked golden build.

**2026-07-07 — Fixed the post-merge workspace image/catalog flow, snapshot policy,
and valid open workspace UX issues in one follow-up branch.** The source-sync flow
was completed so a successful tracked `golden` build rolled matching catalog image
entries to the exact `<sha12>` tag through catalog CAS; rollout errors marked the
source trigger failed with an operator-visible reason. Snapshot defaults moved to
5 minutes, per-workspace snapshot intervals were persisted and editable from user
and admin UI, and GC behavior was pinned so successful shutdown snapshots became
the long-term keeper while older 5-minute scheduled snapshots expired after the
one-hour grace. Workspace cards/admin lists showed last snapshot state; admin views
surfaced disk usage and monitoring links. The new-session flow gained public GitHub
URL + optional ref support and a real Entra-primary "Connect GitHub" OAuth linking
flow using signed short-lived state and the existing encrypted credential store.
Open issues were triaged: #96/#98/#99/#100 were addressed by code, #93/#95 were
closed as already implemented in the image Dockerfiles, and #92 was moved upstream
to `e6qu/sockerless#776`. Verification passed: `pnpm lint`, `pnpm build`,
`pnpm test`, `pnpm test:integ`, `pnpm check-deps`, `pnpm dead-code`, and `pnpm cpd`
(`cpd` exited 0 with the known below-threshold clone report/config warning).

**2026-07-07 — Deployed PR #197 and fixed the live image-source rollout gap without
fallbacks.** PR #197 merged and deployed as control-plane tag `2d231f5`; production
verify was green. The GitHub push webhook was configured, and EDD accepted a signed
push observation that queued a tracked `golden` CodeBuild run for
`2d231f50fad8`. The corrected run succeeded and pushed
`edd-prod/golden/omnibus:2d231f50fad8`, but the first rollout exposed two real bugs:
image-source build reconciliation only ran when `/admin/images` read
`/api/admin/image-source`, and the Terraform-seeded catalog row had no CAS
`version`, so `CatalogService` attempted `NaN` and failed loudly. The live catalog
row was corrected to the required shape and rolled through `CatalogService` to
`omnibus:2d231f50fad8`. The follow-up branch fixed the code path with no fallback:
the server now reconciles image-source builds on startup and on a periodic sweep,
Terraform seeds `version = 0`, and malformed catalog rows are rejected with a clear
invariant error instead of being tolerated.

**2026-07-07 — Fixed the Tier-2 sockerless DynamoDB race found during follow-up
verification.** Full `pnpm test:integ:local` initially crashed the pinned
sockerless AWS simulator with `fatal error: concurrent map iteration and map write`
in `ddbItemSizeBytes` from the `GetItem` read path, then downstream tests failed
with `ECONNREFUSED` after the simulator exited. The underlying issue was reported
as `e6qu/sockerless#777`, fixed upstream by `e6qu/sockerless#778`, and pinned at
merged main commit `b5126463`. The fix cloned DynamoDB items under `ddbItemsMu`
before projection and consumed-capacity accounting, and added a concurrent mutation
regression test. Verification passed with
`env GOWORK=off go test -tags noui . -run
TestDDBItemSnapshotIsIndependentUnderConcurrentMutation -count=10` in the
sockerless AWS module and then full EDD `pnpm test:integ:local` (27/27 tasks).

**2026-07-07 — Removed hidden fallback paths found while finishing the follow-up.**
The production e2e harness supplied the same required image-source coordinates the
server now demanded in production, fixing the `pnpm test:e2e:local` startup failure
without making image-source config optional. Dev-auth stopped using a shared
`EDD_DEV_PASSWORD` path: every built-in or configured dev user carried an explicit
password, and invalid `EDD_DEV_USERS` entries failed schema parsing. Unknown editor
values stopped becoming OpenVSCode, and the base workspace image stopped routing
`EDD_EDITOR_MODE=claude|codex` through the Monaco terminal wrapper; those modes
exited loudly until the Anthropic/OpenAI local web UI harness launchers were wired.
Verification passed with focused config/core/web tests and full `pnpm test:e2e:local`
(46 passed, 5 skipped variant-image tests).

**2026-07-07 — Opened the post-#198 warning cleanup branch.** After PR #198
merged, the remaining CI/deploy warning sources were fixed instead of filtered:
Debian slim workspace and SSH images kept man1 pages so package-managed
`update-alternatives` slave links had real targets, apt package installs ran
noninteractively, the shell sweep parsed POSIX scripts with `zsh --emulate sh -n`,
and the complete Terraform example declared the S3 backend configured by the
install/uninstall scripts. Verification passed with disposable Debian/Node
package-install reproductions, a clean SSH proxy Docker build, actionlint,
Terraform fmt/init/validate, dependency/dead-code/CPD gates, the full shell sweep,
`pnpm lint`, `pnpm build`, and `pnpm test`.

**2026-07-07 — Checked the live production service and fixed the release/verify
fail-loud gaps found there.** `app.edd.e6qu.dev` was reachable and healthy:
`/api/healthz` and `/api/readyz` returned 200, the ALB and SSH NLB target groups
were healthy, wildcard SSH DNS accepted TCP on port 22, the login page rendered,
and the GitHub image webhook surface rejected non-POST/non-JSON traffic at WAF and
bad signatures in the app with 401. The service was not current: ECS still ran
control-plane/SSH tag `2d231f5` after PRs #198/#199 had merged, while the app-owned
golden image flow had built and pushed `omnibus:7fee654aaa67` and
`omnibus:89c3cdee68d1` but left both trigger rows `queued` and the catalog on
`omnibus:2d231f50fad8`. The release workflow had no GitHub release variables or
secrets configured and no post-merge control-plane image tags existed in ECR. The
Terraform state bucket existed but had no expected remote state object; the live
state was only in ignored local files. The follow-up branch made the release
workflow run on main pushes, publish only web/control-plane images with
`EDD_BUILD_TARGET=web`, and fail loudly when release variables were missing. It
also made `scripts/install.sh --verify` check the exact S3 state object and fail
loudly instead of verifying local state or prompting for a backend migration in
read-only mode. The dependency gate found age-eligible AWS SDK drift to
`3.1080.0`, so the branch refreshed the affected package manifests and lockfile
instead of carrying a stale dependency set.

**2026-07-07 — Connected release image publish to ECS rollout.** After PR #201
merged, the release inspection verified that build/publish paths were working but
production was still stale. GitHub Actions run `28898272647` pushed
`edd-prod/control-plane:992b22cc3349` and
`edd-prod/ssh-gateway:992b22cc3349`, and the EDD-owned CodeBuild run
`edd-prod-build-images:651e5bbf-2ba6-47d2-98f2-f01ab00af0a5` pushed
`edd-prod/golden/omnibus:992b22cc3349`; however, ECS still ran
`edd-prod-control-plane:26` and `edd-prod-ssh-gateway:26` on tag `2d231f5`.
The follow-up branch added `scripts/deploy-release-images.sh` and wired it into
`.github/workflows/release.yml`: after publishing, CI registered fresh
control-plane, reconciler, and SSH-gateway task definitions from the current AWS
definitions, changed only the image references, updated the control-plane and SSH
ECS services, retargeted the reconciler Scheduler schedule, and waited for service
stability. `scripts/bootstrap-release-oidc.sh` was expanded from ECR-only
publishing to the exact ECR/ECS/Scheduler/`iam:PassRole` release deploy surface,
still using GitHub OIDC with only non-secret repo variables. The inspection also
recorded that the expected remote Terraform state object was absent,
`edd-prod-reconciler-dlq` contained old inactive-task-definition Scheduler
failures, and one workspace remained in `state=error`.

**2026-07-08 — Fixed the production `/workspaces` digest and made release
verification skeptical.** After PR #204 merged, the release workflow succeeded
and production ECS services reached steady state, but the real page
`https://app.edd.e6qu.dev/workspaces` still rendered a Next.js error boundary
with digest `3655293926`. CloudWatch tied that digest to an opaque resource
destructuring crash in `WorkspaceService.list`; a DynamoDB scan showed nine
workspace records without the now-required `resources` map. Those invalid
workspace rows were deleted operationally because there was no legacy data to
preserve, and the app then rendered `/workspaces` as "Not signed in" for an
unauthenticated request while `/api/readyz` stayed ready and the next reconciler
sweep processed an empty fleet successfully.

The branch kept the fail-loud state model and improved diagnostics/test coverage:
missing persisted workspace resources now throw
`invalid persisted workspace <id>: missing resources`, invalid resource values
include the workspace id, and the control-plane integration suite removes
`resources` from a raw DynamoDB row to pin the failure. `/api/healthz` now reports
baked deploy metadata from `@edd/config`, `scripts/check-deployed-app.sh` verifies
health, readiness, and `/workspaces` rendering, and a new async
`post-deploy-smoke` GitHub Actions workflow runs after `release` to wait for the
public app to expose the expected short SHA and render a user-facing page. The
release job stopped waiting for ECS service stability inside the critical path;
ECS convergence remained guarded by circuit breakers/alarms, while public app
verification moved to the separate smoke workflow. The release bootstrap script
now requires `EDD_RELEASE_APP_URL` and writes non-secret `EDD_APP_URL`, so the
smoke target is explicit and missing coordinates fail loudly.

The live inspection also recorded remaining operational facts rather than
claiming full health: `edd-prod-workspaces-stuck-error` cleared after deleting the
malformed rows, `edd-prod-reconciler-dlq` still held five old inactive-taskdef
messages, `edd-prod-reconciler-failed` still reflected the recent failure window,
old audit events without resource details still made cost rollup fail loudly, and
live target groups still used 30-second health checks until Terraform is applied.
Verification passed locally with `pnpm lint`, `pnpm build`, full `pnpm test`,
`pnpm test:integ`, `pnpm test:e2e`, focused health/resource-regression tests,
`actionlint`, and `shellcheck`.

**2026-07-08 — Fixed production workspace-open and vendor harness failures.**
After PR #205 deployed, the public control plane was healthy (`/api/healthz`,
`/api/readyz`, ECS 2/2) and the manually rerun post-deploy smoke passed for
merge SHA `885c560ab006`, but live workspaces still exposed separate failures.
The OpenVSCode/Monaco proxy token handoff was widened to treat exact
`/w/<id>/` root opens as document navigations even when browser headers were
sparse, fixing the observed `Forbidden`/`unauthorized` opens without redirecting
subresource/API paths.

The branch kept the four workspace interface choices (OpenVSCode, Monaco, Claude
Local Web UI, Codex Local Web UI) and wired the vendor harness modes without
using Monaco as a fallback. Claude Code Remote Control ran under a
pseudo-terminal so the CLI stayed interactive, and Codex ran the vendor
`codex app-server` process with health probing. Docker evidence rejected the
`codex remote-control start` daemon path because it required a standalone
installer layout not present in the image. The snapshot policy was also pinned
for errored workspaces: scheduled snapshot candidates remained running/idle
only, and explicit snapshots of errored workspaces conflicted before storage
I/O. Local verification passed across focused web tests, control-plane/reconciler
integration tests, repo lint/build, full unit tests, shell syntax/lint, and the
base-image Docker smoke for Monaco, Claude, and Codex modes.

**2026-07-08 — Verified fresh production workspaces on the fixed image.** After
the user created new workspaces, DynamoDB showed one running workspace for each
interface mode on `omnibus:3561532b4ee5`, all with `functional=ok`. CloudWatch
workspace logs showed OpenVSCode, Monaco, Claude Local Web UI, and Codex Local
Web UI each starting the expected local server/harness. The old errored
Claude/Codex records were terminated/deleted and the stuck-workspaces alarm
returned to OK.

**2026-07-08 — Fixed editor token handoff, server-side auth sessions, and
workspace-open deployment smoke.** After PR #206 deployed and fresh workspaces
were running on `omnibus:3561532b4ee5`, manually opening all four editor modes
still produced `Forbidden`/`unauthorized` failures. The branch fixed the proxy
root causes rather than adding fallbacks: exact `/w/<id>` and `/w/<id>/` opens
are treated as document navigations, non-ready workspace roots redirect to the
workspace status page, and token-redirect suppression is keyed by editor mode
(`vscode-tkn` for OpenVSCode and, after the later wrapper removal, Claude/Codex;
`edd-editor-token` for Monaco). Stale cookies from one editor family no longer
suppress token injection for another.

Auth gained a server-side revocation handle. Login creates a versioned
`AUTH_SESSION` DynamoDB row and embeds `authSessionId` plus
`authSessionVersion=1` in the Auth.js JWT. Session/proxy validation requires an
active, unexpired, unrevoked current-version row; old-format cookies become
unauthenticated and force re-login. Logout revokes the row and explicitly clears
Auth.js cookie names/chunks.

The no-fallback image contract stayed intact. Monaco was only served for the
Monaco workspace type, and a later fix replaced the temporary Claude/Codex
wrapper with vendor OpenVSCode extension UIs. An unknown editor mode exited with
an error instead of falling back.

Post-deploy smoke was expanded to catch the exact production failure class. The
workflow now assumes the release AWS role with GitHub OIDC, reads the deployed
`AUTH_SECRET`, creates a current-format server-side smoke session, creates one
workspace for each editor mode, waits for `running`/`functional=ok`, and opens
each `/w/<id>/` through the public app with browser-like cookie path scoping.
Bootstrap writes the required smoke coordinates and grants only the needed
Secrets Manager/DynamoDB permissions.

Verification passed locally with `pnpm build`, full `pnpm test`,
`pnpm test:integ`, `pnpm test:e2e`, `pnpm lint`, `pnpm check-deps`,
`pnpm dead-code`, `pnpm actionlint`, shellcheck for touched shell scripts, and
focused workspace-proxy/editor-handshake/Auth.js callback tests. CI surfaced
one real HTTPS-only coordinate bug after the PR was rebased: the Auth.js callback
e2e still used the HTTP-only DynamoDB endpoint while the HTTPS harness served
the AWS API over TLS. The test was corrected to use the active `aws.endpoint`
coordinate and the exact failing HTTPS command passed locally.

**2026-07-08 — Verified PR #207 rollout and fixed the smoke/bootstrap gaps it
exposed.** PR #207 merged as `24fc78f7bb05` and production rolled ECS task
definition `:32` on cluster `edd-prod-workspaces`. `edd-prod-control-plane` was
ACTIVE at desired/running/pending `2/2/0`, `edd-prod-ssh-gateway` was ACTIVE at
`1/1/0`, and both services reported rollout `COMPLETED` with `100/200`
minimum/maximum healthy deployment settings. The public app reported
`deploy.sha=24fc78f7bb05`, `/api/readyz` was ready, and `/workspaces` rendered
HTTP 200.

The new post-deploy smoke failed loudly several times before it could verify
workspaces, and each failure was a real setup/code gap. The live release
bootstrap state lacked the new non-secret smoke variables, the release role did
not yet have `secretsmanager:GetSecretValue`, and DynamoDB's customer-managed
KMS key denied decrypt. The real bootstrap was rerun from repo source with
explicit production coordinates, and the branch made that source require
`EDD_RELEASE_DYNAMODB_KMS_KEY_ARN` plus grant only DynamoDB-scoped
`kms:Decrypt`/`kms:GenerateDataKey`. The smoke then reached the app and exposed
that its synthetic Auth.js session had no email; the app correctly rejected that
as an unopenable real workspace, so the smoke JWT now includes a deterministic
`@smoke.edd.local` email.

The fixed smoke was run manually against production and opened all four editor
types through the public app: OpenVSCode, Monaco, Claude Local Web UI, and Codex
Local Web UI. A new Playwright screenshot verifier then repeated the production
test in Chromium and saved screenshots for all four modes under
`/private/tmp/edd-workspace-screenshots/`, then again after the helper refactor
under `/private/tmp/edd-workspace-screenshots-rerun/`. Visual inspection
confirmed the actual rendered editor/harness pages: VS Code Web, Monaco with
terminal, Claude vendor harness `status: running`, and Codex vendor harness
`status: running`. The workflow was updated to run this screenshot verifier and
upload the screenshot artifact after every successful release.

The Codex screenshot also surfaced a real runtime warning about missing sandbox
prerequisites. The current OpenAI Codex sandbox docs say Linux/WSL should
install `bubblewrap`, so the base image now installs `bubblewrap` and the
base-image smoke asserts `bwrap` exists. Verification for the branch passed with
web eslint/lint/build/test, `pnpm dead-code`, `pnpm actionlint`, and shellcheck;
the web test suite needed local loopback access because the sandboxed run denied
`127.0.0.1` listener setup with `EPERM`.

**2026-07-08 — Verified PR #208 rollout and fixed the smoke cleanup gaps it
exposed.** PR #208 merged as `b48030c13956` and the release workflow succeeded:
control-plane and ssh-gateway images were published, ECS service deployment
completed on task definition `:33`, and the public app reported
`deploy.sha=b48030c13956` with `/api/healthz`, `/api/readyz`, and `/workspaces`
healthy. The asynchronous golden-images workflow pushed
`edd-prod/golden/omnibus:b48030c13956` (`sha256:070bd726...`) and the production
catalog row `img-seed-omnibus` pointed at that tag at version `8`.

The post-deploy smoke workflow failed before it could open workspaces because
the GitHub runner had no Playwright Chromium executable installed. The follow-up
branch installed Chromium explicitly before running the screenshot verifier. A
manual live screenshot smoke against the updated catalog created all four editor
types on `omnibus:b48030c13956` and captured screenshots under
`/private/tmp/edd-workspace-screenshots-b480/`. Visual inspection confirmed VS
Code Web, Monaco with terminal, Claude Local Web UI `status: running`, and Codex
Local Web UI `status: running`; the Codex missing-sandbox-helper warning was
absent on the new image.

The same verification found that the smoke helpers still reported success after
DELETE without proving cleanup convergence. Production eventually terminated the
smoke workspaces, but reconciler logs showed skipped `finishDeleting` attempts
from version races while the deployed control plane accepted `active:false`
functional heartbeats for `deleting` records. The follow-up branch made
heartbeats reject every non-`running`/non-`idle` workspace, added integration
coverage for stopped/deleting `active:false` reports, and made both deployed
smoke scripts wait for every created workspace to reach `terminated` after
DELETE.

**2026-07-08 — Removed the Claude/Codex wrapper and made Monaco prove real file
editing.** Production `omnibus:b48030c13956` still rendered EDD-authored
Claude/Codex wrapper pages on `/w/<id>/`: Claude showed raw terminal/ANSI output
from `claude --remote-control`, and Codex showed `codex app-server` protocol
status. Local inspection of the rebuilt workspace image showed the browser
vendor UIs actually available in the image were the OpenVSCode extensions
`anthropic.claude-code` and `openai.chatgpt`, while Codex `app-server` exposed a
WebSocket protocol rather than an HTML UI.

The branch deleted the EDD vendor wrapper from the base image. `claude` and
`codex` workspace modes now fail loudly unless the corresponding CLI and vendor
OpenVSCode extension are installed, then start OpenVSCode and auto-open
Anthropic's Claude Code webview or OpenAI's Codex sidebar. The proxy and smoke
helpers now expect the OpenVSCode `vscode-tkn` cookie for Claude/Codex because
those modes are served by OpenVSCode rather than by a separate wrapper.

Monaco was corrected to use the real workspace filesystem as the source of
truth in the UI. It gained a New File control backed by the existing confined
file API and refreshes the explorer every two seconds, so `touch hello.txt` from
the integrated terminal appears without a reload. The post-deploy screenshot
smoke now rejects the old wrapper text and Monaco read-only edit errors, and it
creates/opens/types into a Monaco file from inside the browser page.

Verification passed with repo-wide `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm dead-code`, `pnpm actionlint`, and `pnpm check-deps` with Terraform
registry access. The base-image Docker smoke passed for OpenVSCode, Monaco,
Claude, and Codex. Local Chromium screenshots from the rebuilt `edd-base:smoke`
image showed the OpenAI Codex sidebar UI and Anthropic Claude Code webview
inside OpenVSCode, not the removed wrapper.

**2026-07-08 — Post-deploy verification failed and the smoke methodology was
corrected.** After PR #209 merged, production rolled to `e6b87475c1df`, ECS
services were steady on task definition `:34`, and the golden omnibus image was
pushed. The deployment was still not verified: `post-deploy-smoke` run
`28950258091` failed after only one OpenVSCode screenshot, and the artifact
upload path was wrong. More importantly, the smoke had been testing an
implementation shortcut, not the user path: it pre-primed editor token cookies
through helper fetches before opening `/w/<id>/` in Chromium. That let
stale-token-cookie bugs survive production.

The proxy was changed to suppress `?tkn=` injection only when the current
query/cookie value matched the derived token for the exact workspace/editor
mode, and tests covered stale OpenVSCode and Monaco token cookies. The
screenshot smoke now opened `/w/<id>/` directly with only the EDD session cookie
and saved per-editor screenshot/text/HTML diagnostics on failure. The same
analysis found Monaco still raised `Cannot edit in read-only editor` after
opening a file, so Monaco stopped initializing the editor widget as read-only
while preserving save no-ops until a file was selected. The branch also fixed
the screenshot artifact path, bumped `actions/upload-artifact` to age-eligible
`v7.0.1`, narrowed env-reader helper types, and kept `primeEditorToken`
internal.

PR #210 CI then exposed that the shared Playwright install action was still
using `playwright install --with-deps chromium`. All product tests before the
browser proof passed, but the `e2e` job was canceled while apt slowly fetched
optional font packages from the Ubuntu mirror. The branch changed the shared
Playwright action plus direct post-deploy/pages installs to install Chromium
only, leaving missing runtime-library failures loud while avoiding repeated apt
dependency installs in browser smoke jobs. PR #210's follow-up CI rerun then
passed all checks: `build-test`, `playwright`, `integration`, `e2e-https`,
`e2e`, `terraform-sim`, security scans, shellcheck, dependency freshness, and
code-health were green.

**2026-07-08 — Production smoke hardening and Monaco terminal/UI freshness
follow-up.** After the post-PR #210 production smoke still exposed stale image
and Monaco editability issues, the golden-image workflow was changed to run on
every `main` push, and deployed workspace smoke required the expected release SHA
to appear as an enabled catalog image before creating workspaces. The workspace
list/detail polling was tightened so stop/delete changes became visible quickly
instead of leaving stale cards. Monaco terminal tabs were removed on disconnect,
the terminal control opened/created sessions, and the panel gained resize,
minimize, maximize, and close controls; PTY spawn failures closed the terminal
channel loudly without crashing the editor server. The admin base-image form was
corrected to expose all four editor kinds. Local vendor verification established
that Codex app-server was a protocol server and Claude Remote Control did not
expose a local HTTP UI in the tested CLI surface, so the branch recorded that
blocker rather than inventing an EDD Claude/Codex chat UI or calling Monaco/
OpenVSCode a fallback solution.

**2026-07-09 — Added opencode's local web client and removed the last random
editor-token fallback.** The branch added `opencode` as a first-class workspace
interface across the domain/API contracts, DynamoDB editor enums, workspace
launcher, admin base-image form, workspace badges, deployed smoke scripts,
screenshot smoke, dev bootstrap, and image/toolchain e2e assertions. The shared
golden base image installed `opencode-ai@1.17.15`, and
`EDD_EDITOR_MODE=opencode` launched the real `opencode web` server with
`OPENCODE_SERVER_USERNAME=opencode` and `OPENCODE_SERVER_PASSWORD` set to the
workspace connection token.

The entrypoint failed loudly if opencode was selected without the CLI or
`CONNECTION_TOKEN`, and refused `EDD_DISABLE_CONNECTION_TOKEN=1` for opencode.
While touching the same auth path, the old OpenVSCode random connection-token
generation was removed: tokened editor startup now required `CONNECTION_TOKEN`
unless tokenless mode was explicitly selected.

Local verification showed opencode's web server had no base-path flag and used
root-absolute assets/API base logic. The existing in-app `/w/<id>/` workspace
proxy therefore gained an opencode-only adapter: preserve current behavior for
OpenVSCode, Claude, Codex, and Monaco; strip `/w/<id>` before forwarding
opencode requests upstream; inject Basic auth derived from the workspace token;
and rewrite opencode HTML/JS/CSS references back under `/w/<id>/`. The verified
Claude/Codex/opencode harness facts and proxy contract were recorded in
`docs/workspace-agent-harnesses.md`.

**2026-07-09 — Fixed PR #212's e2e failure without restoring token
fallbacks.** The first PR #212 CI pass failed only in the `e2e` job. The failure
logs showed golden workspace tasks stopped before readiness with essential
containers exiting; downstream user-journey and durability steps then observed
workspaces stuck in `error` and 409s on snapshot/stop/connect. The root cause was
the branch's intentional OpenVSCode fail-loud change exposing stale e2e launch
configuration: several golden-image e2e providers and the shared live ECS app
harness still omitted the editor connection secret, so the entrypoint had no
`CONNECTION_TOKEN` and exited as designed.

The fix kept the no-fallback architecture. Direct golden-image e2e launches and
the shared live ECS harness now supplied explicit `connectionSecret` values, and
the real web provider path threw immediately if `COMPUTE_PROVIDER=ecs` lacked
`EDD_AGENT_SECRET` or `EDD_CONNECTION_SECRET`. The compute-provider comments and
tests were updated to describe the current contract rather than the removed
random-token behavior. `@types/node` was bumped to `26.1.1` because
`check-deps` found it age-eligible.

Verification passed with `pnpm build`, `pnpm lint`, `pnpm test` with loopback
access, `pnpm check-deps` with registry access, `pnpm --filter @edd/compute-ecs
test`, `pnpm --filter @edd/e2e lint`, the focused `apps/web` control-plane test,
and `git diff --check`. The Docker-backed local `pnpm test:e2e:local` run built
the fixed golden base image and verified `opencode`, `claude`, and `codex`
binaries were present, but the local machine had only 12 GiB free and Podman
failed committing the omnibus image layer with `no space left on device` before
the e2e tests started; CI remained the full container-mode verification path.

**2026-07-09 — Fixed the second PR #212 e2e failure in the legacy user-journey
harness.** The PR #212 rerun passed build-test, integration, e2e-https,
terraform-sim, golden image validation, and the security/static checks, but
`e2e` still failed in `src/user-journey.e2e.ts`: create returned 500, then the
shared `wsId` remained empty and follow-up snapshot/stop/connect/delete calls
hit 405 routes. The missing root cause was the same fail-loud contract in one
older harness: `user-journey.e2e.ts` started the production web app with
`COMPUTE_PROVIDER=ecs` and `EDD_AGENT_SECRET` but no required
`EDD_CONNECTION_SECRET`. The harness now supplied an explicit connection secret.
Its HTTP status helper also printed the response body and captured web-app
stdout/stderr on mismatches, so the next CI failure in that path would include
the server-side reason instead of only assertion summaries. Focused verification
passed with `pnpm --filter @edd/e2e lint` and `pnpm exec tsc -p
packages/e2e/tsconfig.json --noEmit`; the package had no `build` script.

**2026-07-09 — PR #212 deployed, but post-deploy smoke correctly blocked
acceptance.** The release workflow for merge commit `af69bd829e6d` succeeded,
production `/api/healthz` reported that SHA, ECS rolled the control plane and
SSH gateway to revision `:37`, and the golden-images workflow pushed
`omnibus:af69bd829e6d`. The authenticated deployed smoke then failed before
reaching opencode. Its artifacts showed a real methodology bug: Codex was
rendered through the OpenAI OpenVSCode extension webview, but the assertion
waited for case-sensitive body text; Claude had passed on welcome-page
walkthrough text rather than proving the Anthropic webview was open. The
follow-up branch opened Claude via Anthropic's verified
`claude-vscode.sidebar.open` command and made the smoke require the vendor
extension tab plus webview iframe for both Claude and Codex.

**2026-07-09 — PR #213 deployed, but opencode still rendered blank until the
proxy rewrite was fixed.** PR #213's release and golden-image workflows
succeeded for `d063fea1ec78`; production health/ready checks were green, and ECS
showed the control plane and SSH gateway steady on task definition revision
`:38`. The new deployed screenshot smoke correctly kept blocking acceptance: it
captured OpenVSCode, Monaco, Claude, and Codex screenshots, then timed out on
opencode with a blank OpenCode document shell.

The failure was traced to EDD's opencode proxy adaptation, not to ECS rollout or
workspace task health. The deployed opencode HTML and assets loaded through
`/w/<id>/`, but the `opencode-linux-x64@1.17.15` bundle used root-origin client
assumptions that the first rewrite missed: bare `location.origin` in a ternary
expression and root-absolute API paths such as `/global/health`. The branch
rewrote all root-absolute same-origin string paths and every `location.origin`
occurrence to the workspace base path, while preserving fail-loud rejection for
opencode proxy requests outside `/w/<id>/`. The deployed screenshot smoke also
began recording browser console, pageerror, and requestfailed lines in failure
artifacts.

**2026-07-09 — Added admin-managed auth, revocable sessions, and self-healing
image-source polling.** PR #214 deployed and built the expected golden image
`omnibus:7197f30de9d9`, but post-deploy smoke failed before editor screenshots
because the production base-image catalog still pointed at
`omnibus:d063fea1ec78`. Direct production inspection showed the matching ECR
image existed but no durable `imageSource`/`imageSourceTrigger` records existed,
so the control plane had not observed the merge. The branch fixed the
architecture gap by polling GitHub's standard commits API in the image-source
sweep before ECR reconciliation, recording a trigger when the configured branch
SHA changed, treating every `main` push as a golden-image build trigger, and
failing loudly/retrying if GitHub polling failed. The golden-images workflow also
verified the expected pushed ECR tags after publish.

The same branch added the requested production user-management flow. DynamoDB
gained local-account and invitation entities; passwords used versioned scrypt
hashes; admins could create admin/developer password accounts, create and
reissue developer invitation links with a 1-day default and 30-day maximum
expiry, and send invitation email through AWS SES. Invitation acceptance reused
the same owner id for reissued links so the invited developer kept access to the
same workspaces. Auth.js credentials login created server-side auth-session
rows, every JWT-backed request validated that session row, logout revoked and
cleared cookies, and admins could revoke one user's sessions or all sessions
from `/admin/users`. The role vocabulary was renamed from `member` to
`developer` throughout code, config, docs, tests, and quotas.

Cost and UI hardening shipped with the same change set. Live AWS pricing mode
required all Price List rates and threw on missing/denied data instead of
falling back to configured values. Terraform and IAM drift checks included
`pricing:GetProducts` and `ses:SendEmail`. The costs page rejected invalid
windows, circle-`i` help overlays and long image/host/id strings no longer broke
layout, and pnpm's build-script allowlist explicitly approved `sharp` so
`CI=true pnpm install --frozen-lockfile` completed without ignored-script
warnings. Verification passed with full repo lint/build/test, dependency
freshness, actionlint, frozen install, shellcheck, bash/zsh syntax checks, and
`git diff --check`.

**2026-07-09 — Fixed PR #215 follow-up failures before opening the next PR.**
After PR #215 deployed commit `3886482cd83f`, release health was green but the
release was not accepted: the asynchronous golden-images workflow failed on
GitHub runner disk while `docker buildx --load` imported the large omnibus image,
production invitation sending surfaced raw digest `ERROR 1978335914` because
`EDD_PUBLIC_APP_URL` was missing, and the admin costs page could render `$NaN`.
The follow-up branch made release and golden-image workflows publish with
BuildKit `--push` directly, kept invitation mail configuration mandatory while
preflighting it before token creation and showing explicit admin errors, and
added finite/positive validation in the cost core, control-plane resume path,
and admin cost presentation boundary.

The same branch finished the requested UI/RBAC hardening. Circle-`i` page help
and session-detail panels moved to a fixed, viewport-bounded modal surface with
long-value wrapping and one-active-modal coordination. Workspace cards stopped
rendering snapshot-interval editing for viewers, and the authz matrix covered
viewer denial on workspace `PATCH`.

Verification passed with full `pnpm test`, `pnpm lint`, and `pnpm build`, plus
focused web/core/control-plane test/lint/build commands, `shellcheck`, `sh -n`,
`bash -n`, `actionlint`, and `git diff --check`. Local Playwright verification
remained blocked before assertions because the required sockerless AWS simulator
was absent and a freshly recreated Podman vfkit VM never exposed SSH/API to
gvproxy (`no route to host`).

**2026-07-10 — Replaced Claude/Codex workspace types with a generic Terminal
workspace.** After rechecking the installed CLIs, official docs/source, and local
browser screenshots, the branch stopped modeling Claude Code and Codex as
separate workspace interface types because neither had a verified first-party
EDD-hostable local browser UI. The accepted workspace kinds became OpenVSCode,
Monaco, Terminal, and opencode. `claude` and `codex` editor values were removed
from the core/API/DynamoDB contracts, UI selectors, proxy token mapping, image
entrypoint, and deployed smoke scripts, so old values failed loudly instead of
routing to an OpenVSCode or Monaco substitute. The new Terminal workspace reused
the first-party multi-tab terminal server under `/w/<workspace-id>/`, added a
token-gated `api/config` mode flag, hid the Monaco file/editor chrome in that
mode, and required both `claude` and `codex` CLIs on PATH before startup.
Verification passed with full lint/build/test, focused editor-monaco
test/build/lint, shell syntax checks for the image entrypoint/smoke script, and
`git diff --check`; the full test suite required loopback access for the
editor-monaco HTTP/WebSocket server tests.

**2026-07-10 — Fixed image-source convergence and audited real AWS costs.**
After PR #218 deployed commit `5f052272c505`, the control plane and golden image
were live but `post-deploy-smoke` still failed because the enabled base-image
catalog stayed on `omnibus:d063fea1ec78`. Direct CloudWatch/DynamoDB/ECR
inspection showed the app had enough durable information to converge but the
sweep stopped early: missing stale ECR tags threw `ImageNotFoundException`, and
GitHub commit-poll `403`s prevented already-recorded queued triggers from being
reconciled from ECR. The branch made missing ECR images return `null` per the
image-ops port contract, kept non-missing AWS errors fail-loud, and split
GitHub polling from ECR build reconciliation so either path retried
independently. The deployed smoke began actively polling `/api/admin/image-source`
during catalog rollout, wrote the live image-source payload into
`catalog-rollout-failure.json` on failure, shortened the rollout deadline, and
purged smoke workspaces after termination.

The same branch replaced the partial workspace-only cost view with a full AWS
account cost section backed by Cost Explorer. The admin Costs page still showed
workspace lifecycle ledger accounting, but also displayed account month-to-date,
last-7-days, last-24h, and top service costs, with finite-number validation and
visible failure if Cost Explorer returned bad data. IAM requirements and
Terraform granted `ce:GetCostAndUsage`. The first PR #219 Playwright CI run then
found a test-only ambiguity introduced by that visible failure state:
`getByRole("heading", { name: "Costs" })` also matched
`AWS account costs unavailable`. The branch fixed the assertion to use the exact
page heading and re-ran local Playwright 19/19 against the sockerless simulator.

The live AWS audit intentionally looked beyond Terraform state. It found only
the expected two control-plane tasks and one SSH gateway task running, no
managed EDD EBS volumes, but 59 EDD-managed retained snapshots without
`edd:workspace-id`, many active workspace runtime secrets, five messages in the
reconciler DLQ, old ECR tagged images, two untagged associated Elastic IPs, the
ALB/NLB, DynamoDB tables, S3 buckets, Route53 zone, WAF ACL, CodeBuild project,
KMS keys, CloudWatch log groups, and a non-EDD `sockerless-volumes` EFS
filesystem. The branch tagged future snapshots with `edd:workspace-id`, changed
runtime-secret GC to keep only task-referenced runtime secrets, and applied the
shared ECR lifecycle policy to the SSH gateway repo. Existing retained snapshots
were deliberately not deleted by code because they were data-bearing retained
resources without attribution; cleanup required an explicit operator decision.

**2026-07-10 — Removed the remaining non-EDD AWS infrastructure after PR #219
merged.** The operator explicitly approved deleting anything not EDD-related.
The follow-up cleanup verified the account from AWS APIs rather than Terraform
state, then removed empty default VPCs, their default subnets, and their internet
gateways across enabled regions, including the old default VPC in `eu-west-1`.
The earlier sockerless cleanup was rechecked: ECR contained only EDD repos, S3
contained only `edd-tfstate-edd-prod`, EFS returned no filesystems or access
points, and there were no sockerless/skls IAM roles, IAM policies, CloudWatch log
groups, ECR repositories, or active/inactive ECS task definitions. Resource
Groups still listed stale sockerless EFS access-point ARNs, but explicit
`DeleteAccessPoint` calls against all 87 IDs returned `AccessPointNotFound`; the
remaining sockerless ECS task-definition ARNs were only AWS
`DELETE_IN_PROGRESS` metadata. Final production-region verification showed
`eu-west-1` had only the tagged `edd-prod-vpc` and its four tagged EDD subnets.

**2026-07-10 — Added and backfilled the `edd-alpha` AWS cost-scope tag.** The
branch introduced one shared cost-allocation key, `edd:cost-scope`, with default
value `edd-alpha`. Terraform propagated it through provider default tags, module
tags, ECS environment, and module variables. Runtime code tagged ECS workspace
task definitions, tasks, configured-at-launch managed EBS volumes, workspace
runtime secrets, EC2 volumes, snapshots, copied snapshots, and EBS smoke
resources. The admin AWS account Cost Explorer query filtered usage by
`edd:cost-scope=edd-alpha` and exposed the selected cost scope in the UI, with
no account-wide fallback.

The live AWS account was backfilled through AWS APIs. Verification showed no
Resource Groups resources with `edd:component=ecs-dev-desktop`, no
`edd:managed` workspace runtime secrets, no EDD IAM roles, and no EDD IAM
policies were missing `edd:cost-scope=edd-alpha`. The state bucket
`edd-tfstate-edd-prod`, DynamoDB lock table `edd-tfstate-locks`, Route53 hosted
zone `edd.e6qu.dev`, 59 EDD-managed snapshots, and the two associated ALB
Elastic IPs were tagged. AWS Cost Explorer/Billing had not yet discovered the
new tag key: `list-cost-allocation-tags` returned no `edd:cost-scope` entry and
activation failed with `ValidationException: Tag keys not found:
edd:cost-scope`, so cost-allocation activation remained a follow-up retry rather
than a completed billing state.

**2026-07-10 — Staged the workspace provisioning/startup performance plan.** The
local roadmap stopped treating faster workspace startup as a single vague task.
The plan first measured create/wake phase timings, then expanded the admin
metrics UI to show p50/p90/p99 provisioning and wake latency, latest slow starts
with phase breakdowns, failure counts by phase, and links to workspace/session
logs. It then sequenced optimizations by evidence: image-pull reduction through
workspace-interface-specific golden images, launch-path API reduction through
stable task definitions and pre-created secrets if those phases proved material,
stopped-workspace wake tuning based on snapshot-hydration timing, and explicit
editor-readiness checks. Cost-bearing warm-idle/warm-pool behavior remained a
policy decision to make from production latency data, not a silent fallback.

**2026-07-10 — Made browser user-flow verification part of the SOP and tightened
workspace editor escape hatches.** `AGENTS.md` and `TESTING.md` were updated so
UI/workspace/editor changes required real browser workflow verification rather
than API checks, health endpoints, ECS deployment completion, or shallow
screenshots. The SOP explicitly required every workspace surface to provide and
verify a visible top-level route back to `/workspaces`, required OpenVSCode tests
to click the actual File menu, and required Terminal workspace checks to prove
default tab, command execution, new tab, tab switching, tab close, and closed-tab
cleanup.

The initial implementation attempted to force OpenVSCode's
`window.menuBarVisibility` to `classic` in remote workspace settings, injected a fixed top-level `EDD home` link into
OpenVSCode and opencode HTML through the in-app proxy, kept Monaco/Terminal's
topbar return link, and strengthened deployed smoke to click the return path for
all workspace types. The smoke also clicked the real OpenVSCode File menu and
exercised the Terminal command/new-tab/switch/close flow. The local OpenVSCode
browser proof clicked the File menu too.

A local Terminal browser exercise against the built `@edd/editor-monaco` server
found that this host's Node `v26.5.0` plus `node-pty@1.1.0` could not spawn a
PTY (`posix_spawnp failed`), even in a direct node-pty spawn outside the app. The
golden workspace image used the intended Node 22 runtime, so the full Terminal
command/tab proof stayed in the deployed/golden-image smoke. The local UI failure
mode was fixed anyway: PTY startup failure left a visible failed terminal tab
with the error text instead of silently removing all tabs and leaving a blank
terminal surface; the screenshot was inspected at
`/tmp/edd-terminal-local-visible-failure.png`.

**2026-07-10 — Fixed the non-flaky OpenVSCode CI failure, stale cost schema,
modal stacking, and disconnected UX in PR #220.** The failing e2e was reproduced
against the local golden image. Source inspection showed OpenVSCode window
settings lived in browser configuration, while the entrypoint wrote remote user
settings; `classic` was also fullscreen-sensitive. The image added an
exact-match, version-pinned patch to OpenVSCode's supported workbench
`configurationDefaults` bootstrap with menu mode `visible`. Investigation also
proved the unpacked EDD extension was absent from OpenVSCode's generated built-in
registry; the entrypoint copied it into the runtime extension scan path. The real
browser proof clicked File, asserted real file actions, compiled and ran a Go
binary in the integrated terminal, and produced inspected screenshots. The noisy
Semgrep UI extension was removed after its boot-time remote-config error appeared
in the screenshot; the Semgrep CLI remained installed.

The production Costs `sizing.vcpu=undefined` failure was traced to persisted
cost-rollup v1 rows created before sizing fields were added. The ElectroDB entity
moved to v2 and a DynamoDB integration test proved v1 rows did not enter v2
queries. Help and workspace-info overlays moved through a shared body portal so
card/header stacking contexts could not cover them. The root shell gained a
confirmed-disconnect health probe, topbar refresh action, and automatic recovery
refresh. Playwright exercised help/workspace modal layering, one-modal-at-a-time,
offline/recovery, and workspace lifecycle convergence. `AGENTS.md` and
`TESTING.md` made automatic no-hard-refresh convergence mandatory.

## 2026-07-11 — Admin traffic filtering (WAFv2)

An admin traffic-filter console + backend was added to configure and APPLY
allow/block rules to the live CLOUDFRONT-scope WAFv2 Web ACL. The pure policy
model + `compileTrafficFilter` (policy → ordered WAFv2 rule specs) already existed
in `@edd/core`; this branch built only the imperative shell around them. A
versioned single-row `trafficFilterPolicy` DynamoDB entity (`@edd/db`,
schemaVersion §6.5a) persists the policy + last apply outcome. A new
`TrafficFilterService` (`@edd/control-plane`) loads/compiles the policy, persists a
new one, applies its compiled rules through an injected `WafApplier` port, records
`appliedAt`/`appliedError`, and audits the change; an invalid policy fails loud
(compile throws before any write) and a WAF apply failure is recorded and re-thrown
as `WafApplyError`. The real applier (`apps/web/lib/waf-applier.ts`) materializes
the IPSet (GetIPSet→UpdateIPSet with LockToken) and the Web ACL (GetWebACL→
UpdateWebACL with LockToken) over `@aws-sdk/client-wafv2@3.1084.0`, emitting
GeoMatch/AsnMatch/IPSetReference/ManagedRuleGroup (AWSManagedRulesAnonymousIpList)
statements; that SDK version DOES expose `AsnMatchStatement`, so ASN rules are
native (no IPSet fallback needed). Coordinates come from env only
(`EDD_WAF_WEB_ACL_ID`/`_NAME`, `EDD_WAF_IP_SET_ID`/`_NAME`; scope fixed CLOUDFRONT →
us-east-1 / `AWS_ENDPOINT_URL` for the sim) — a missing coordinate fails loud at
apply, while `getState` works without them (§6.9, endpoint-only). Admin-gated
`GET/PUT /api/admin/traffic` return/replace the state. The admin page
(`/admin/traffic` + `TrafficFilterConsole`) edits mode/CIDRs/countries/ASNs/presets/
block-anonymous with a LIVE compiled preview computed by the SAME core
`compileTrafficFilter` (imported via a new `@edd/core/system/traffic-filter`
subpath export so the barrel's server-only `FakeStorageProvider`→node:fs never
reaches the client bundle) and surfaces load/apply errors loudly. A "Traffic" nav
entry sits by Snapshots/Users. Tests: control-plane unit (happy path + invalid
rejected + apply-failure recorded) + sim store round-trip integ, waf-applier unit
(fake WAFv2 client asserting the IPSet/WebACL update shapes), admin-authz integ for
both routes, and two Playwright specs (admin previews a compiled geo rule; non-admin
denied). Verified: db/control-plane/core build, web tsc, web+control-plane+db+core
lint, control-plane 70 unit + traffic integ, admin-authz 39, waf-applier 4,
Playwright 26/26. OPERATOR/Terraform: provision the CLOUDFRONT Web ACL + an
associated IPSet and inject the four `EDD_WAF_*` coordinates into the control-plane
task env before apply works in prod.

---

## Milestone — scale-to-zero + traffic-filter hardening (branch `harden/scale-to-zero-security`, 2026-07-11)

Post-merge verification of the scale-to-zero / traffic-filter work (#225, `e6e84cf`)
plus an adversarial DDoS / availability / cost-amplification sweep (subagent-driven
review across the wake path, WAF apply, and control-plane activity). Verified fixes
landed:

- **Wake Lambda reload storm (readiness probe).** The startup page polls the readiness
  coordinate through CloudFront, which fails that request over to the wake Lambda while
  the control plane is still down. The Lambda answered it with the same HTTP 200 startup
  page, so `res.ok` was true and the page reloaded instantly in a tight loop. The core
  (`decideWakeResponse`) now distinguishes a readiness probe (request path === the polled
  status path) and answers it `503` with a tiny JSON body (`WAKE_READINESS_STATUS`),
  keeping the poll waiting; only a real navigation gets the 200 HTML page. The shell
  (`@edd/wake-listener` `handleWake`) computes `isReadinessProbe` from the request path.
- **Wake Lambda fails soft, not 5xx.** ECS `DescribeServices`/`UpdateService` errors are
  caught and answered with the startup page (or the 503 probe response) so a CloudFront
  custom-error page can't swallow a raw 5xx; the reconciler remains the never-scale-to-zero-
  on-error backstop. Logged loudly for the alarm.
- **Control plane could scale to zero mid editor session.** Editor traffic authorized via
  `authorizeWorkspace` (and page views via `getPagePrincipal`) now stamp control-plane
  activity (`recordSystemActivity`, fire-and-forget + throttled ≤1 write/min), so an active
  editor/admin keeps the UI warm and the idle-shutdown sweep can't drop the live WebSocket.
- **Traffic-filter lockout guard + strict IPv4.** `validateTrafficFilterPolicy` now rejects
  an `allow`-mode policy that admits nothing (it compiles to default-BLOCK → would block ALL
  traffic incl. the admin + wake login) and rejects IPv6 CIDRs with a specific reason (the
  live WAF is a single IPv4 IPSet; IPv6 needs a second IPV6 IPSet — see DO_NEXT). The CIDR
  regex is now a strict per-octet IPv4 matcher (rejects `999.0.0.0/8`).
- **WAF apply preserved the Terraform baseline.** `RealWafApplier.materializeWebAcl` used to
  send only the compiled rules, wiping the Terraform-provisioned managed CommonRuleSet +
  rate-limit until the next `terraform apply`. It now keeps every non-`EddTraffic*` baseline
  rule and replaces only the EDD-prefixed band, placing EDD rules ABOVE the baseline
  priorities so an allow-listed source still passes through the managed protections (a WAF
  `Allow` terminates evaluation).
- **Editor-proxy response buffer cap.** The opencode/HTML rewrite path buffered the whole
  upstream body in the shared control-plane heap with no cap. Added
  `WORKSPACE_PROXY_MAX_REWRITE_BYTES` (16 MiB) — an over-cap body fails loud (502) instead
  of risking OOM.

Cost-amplification DoS controls (infra, same branch): wake Lambda
`reserved_concurrent_executions = 5` (caps invoke fan-out + downstream ECS-API load), the
Function URL flipped from public `NONE` to `AWS_IAM` with a CloudFront lambda-type OAC and a
scoped `InvokeFunctionUrl` grant (no direct public invoke bypassing WAF/CloudFront), a
CLOUDFRONT-scope per-IP `rate_based_statement` BLOCK (limit 2000) evaluated at the edge
before origin-group failover, and the conflicting `control_plane_cpu` autoscaling policy
removed (reconciler/wake are the sole desiredCount authority). Sim adversarial slice extended
to assert reserved concurrency, AWS_IAM URL, scoped grant, OAC binding, and the rate rule.

Verified: core/config/control-plane/wake-listener build + full unit suites green, web tsc +
full web suite (266) green, lint clean across core/web/config/wake-listener, terraform fmt +
examples/complete validate + cloudfront plan (0 cycles) + adversarial slice green.

Same branch, two more items from the deployment-verification sweep:

- **opencode blank-page in prod — the proxy corrupted the JS bundle (root-caused live).**
  `post-deploy-smoke` had been red for days on opencode. Live repro (deployed `e6e84cf`)
  showed an empty `<div id="root">` + one `Invalid regular expression flags` pageerror;
  `node --check` on the proxy-served bundle reproduced it. Cause: the #225 fix made only the
  CSS `url(` rewrite content-type-aware but left the blanket string-path rewrite running on
  JS — it fired 575× and turned e.g. `.replace(/"/g,"&quot;")` into `.replace(/"/w/<id>/g,…)`
  (`/w/` with flags `ws-…`). Fix: the proxy NEVER rewrites JavaScript (streams it byte-for-
  byte); it rewrites only CSS `url()` and root-absolute HTML tag attributes. opencode's
  root-absolute runtime requests are rebased by an injected base-path shim
  (`buildOpencodeBasePathShim` patches fetch/XHR/WebSocket/EventSource/Worker), whose sha256
  is whitelisted in the response CSP (`cspAllowingInlineScript`). The brittle smoke sentinel
  (literal "opencode", which opencode never renders in body text) now asserts the SPA mounted
  (`#root` gains children) + the document title. Regression tests use the exact prod
  corruption pattern + a realistic HTML shell; residual risk (dynamic-`import()` of split
  `/assets` chunks — not present in today's single-bundle) noted in `BUGS.md`.

- **Per-workspace-type resource defaults (user request — "0.5 vCPU / 2 GiB is too small").**
  Added `defaultResourcesForEditor` + `DEFAULT_WORKSPACE_RESOURCES_BY_EDITOR` in `@edd/core`
  (exposed via a client-safe `@edd/core/domain/workspace-resources` subpath). Grounded in each
  editor's real footprint + Fargate's valid CPU:memory pairs and confirmed with the user:
  terminal & monaco stay 0.5 vCPU / 2 GiB; openvscode & opencode default to 1 vCPU / 4 GiB
  (full VS Code server + language servers, and opencode's agent/tooling, exceed 2 GiB).
  `reserve`/`provision` use the per-editor default when resources are omitted; the create form
  (`NewSession`) pre-selects the recommended tier per chosen interface and shows a "Recommended
  for <editor>" hint, still overridable to any smaller valid tier (a pre-selected default, not
  a hard floor — user's call). Tests: core unit (per-editor validity + reserve/provision
  defaults + explicit-override) and a portal Playwright assertion that the hint + CPU/RAM
  pre-select and re-recommend as the editor changes.

---

## Milestone — cost-accuracy fix + boy-scout sweep (branch `fix/cost-accuracy-and-boyscout-sweep`, 2026-07-12)

The user was right that "it costs just cents" was wrong. Measured live via Cost Explorer:
real account usage is **~$49.51 over 30 days** (net ~$0 only because promotional credits
offset it), dominated by services the derived per-workspace model NEVER prices — ECS $14
(incl. the always-on control plane), Secrets Manager $8 (20 secrets × $0.40), ALB $7,
CodeBuild $4.6, regional data-transfer $4, VPC/NAT $3.4, CloudWatch $2.7, DynamoDB $1.2,
WAF $1.1, ECR/Route53/KMS. TWO structural bugs hid this:

- **The "AWS account" panel filtered Cost Explorer by the `edd:cost-scope` tag, which is
  NOT an activated cost-allocation tag** (confirmed: `list-cost-allocation-tags` empty;
  `get-tags edd:cost-scope` → `['']`). A tag-filtered query returns **$0** regardless of
  spend, so the "real bill" panel also read ~$0. FIX: the account summary now defaults to
  **whole-account usage** (`RECORD_TYPE=Usage`, no tag filter) — the honest bill for a
  dedicated EDD account — showing the real ~$50/mo. Tag scoping is now opt-in
  (`EDD_COST_SCOPE_ENABLED=1`, shared-account mode); `AccountCostSummary.scope` records which.
  A loud banner now fires when the account bill reads $0 while workspaces have run (§6.5).
- **The derived per-workspace numbers were mis-framed as the platform total.** Reframed as
  "attributable workspace direct cost (compute + storage per user/session)" with a heading +
  copy making clear the authoritative bill is the Cost Explorer whole-account figure, which
  excludes nothing.
- Verified region pricing against the live Price List API: eu-west-1 Fargate + snapshot match
  the us-east-1 config defaults exactly; only EBS gp3 differs ($0.088 vs $0.080/GB-mo), now set
  via `EDD_PRICE_EBS_GB_MONTH` in `install.tfvars`. Control-plane + reconciler ECS tasks now
  `propagate_tags` so their Fargate usage is cost-attributable in scoped mode.

Boy-scout fixes across four parallel audits (cost/UI/security/perf), all evidence-based:

- **Security — HIGH: GitHub App tokens were org-wide.** `gitCredential` minted an installation
  token with the whole org's repo set + granted permissions from a user-chosen `repoUrl`, so a
  developer could name any repo the App can reach and get an org-wide credential. Now the
  workspace credential is scoped to EXACTLY that one repo with only `contents` (least privilege);
  `mintInstallationToken` takes `repositories`/`permissions`. The org-wide token stays only for
  session-authed listing.
- **Security — admin read pages gated only in the layout** (privileged queries ran for
  non-admins, one refactor from leaking). Added a page-level `isAdminViewer()` guard to every
  async admin data-fetching page (workspaces, workspaces/[id], overview, quotas, logs, catalog,
  costs) so the query is skipped for non-admins.
- **Security — dev-auth backstop (deferred).** A `NODE_ENV=production` hard-disable of
  `EDD_DEV_AUTH=1` was attempted but reverted: the Playwright harness legitimately runs a
  production build WITH dev-auth, so `NODE_ENV` can't distinguish it from real prod. The
  deployment never sets `EDD_DEV_AUTH` (the real control); a backstop keyed on an explicit
  real-prod signal is tracked in DO_NEXT.
- **Security — no security headers.** Added CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, HSTS, and a tight referrer policy on the Next surface (the
  `/w/*` editor proxy is served by the custom server and keeps its own CSP).
- **Perf — `listStopping()` and `purgeExpiredTombstones()` full-table-scanned every sweep** where
  a `byState` GSI query fits (listStopping ran every 3s/replica on an almost-always-empty set).
  Both now query the GSI.
- **Perf/UX — cadence:** the workspaces list re-render dropped from 2s → 4s (still converges).
- **UX — StartupOverlay** swallowed clicks for ~1.4s (incl. right after a reconnect reload); now
  `pointer-events:none` (it's cosmetic/aria-hidden).
- **UX — the create flow** showed a red "failed to load GitHub namespaces" banner even in
  blank/public modes that don't use GitHub; scoped it to the GitHub-backed modes.
- **UX — convergence (rule 13):** added `LiveRefresh` to the admin overview + all-workspaces
  pages (were `force-dynamic` with no polling → stale until manual refresh).

Same branch, further cost/observability features requested during the sweep:

- **On-demand cost basis (no discounts).** Confirmed the account bill uses `UnblendedCost` +
  `RECORD_TYPE=Usage`, which is pure on-demand: it excludes credits/refunds AND
  reservation/Savings-Plan discounts AND tax (verified live — this account has zero RIs/SPs;
  the $49.51 usage is fully offset by credits, which is why the net looked like $0). Added a
  visible costs-page notice stating the figures are on-demand with no discounts (credits,
  refunds, reservations, Savings Plans all excluded) — the true run-rate, which can exceed the
  net invoice when credits cover it.
- **Run-rate projection.** New pure `projectRunRate` in `@edd/core` computes "$/hr and $/day if
  everything is running," split **control plane vs workspaces**: every non-terminated workspace's
  compute + live EBS volume, plus the control plane at its active replica count (from
  `controlPlaneSizing()` in `@edd/config`, defaults matching the Terraform module). Rendered as a
  "Run-rate if everything is running" tile row on the admin Costs page. On-demand rates, no
  discounts. Unit-tested (split, per-day = ×24, empty-fleet, fail-loud).
- **Image builds trackable from BOTH builders.** The admin Images console tracked only GitHub
  Actions webhook triggers; AWS CodeBuild builds (e.g. the terraform-apply bootstrap) were
  fetchable via `GET /api/admin/builds` (`listRecentBuilds`) but never shown. Added a "CodeBuild
  builds" section (status/phase, target, tag, ref, started, duration, id, triggered-by) polling
  that route, renamed the triggers section to "GitHub Actions builds," and corrected the page
  copy so both build paths are visible/trackable.
