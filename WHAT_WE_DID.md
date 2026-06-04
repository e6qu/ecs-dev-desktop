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

<!-- Append new milestones below. -->
