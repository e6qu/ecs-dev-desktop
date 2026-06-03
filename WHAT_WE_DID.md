# WHAT_WE_DID.md — ecs-dev-desktop

> Compressed history: durable decisions/lessons + a milestone timeline. Append new
> entries at the bottom (past tense). For the sockerless issue saga see `BUGS.md`.

---

## Key decisions & lessons (durable)

- **Architecture (locked, `AGENTS.md` §1):** ECS Fargate; DynamoDB single-table +
  ElectroDB (over Aurora — cost, fits access patterns); Teleport SSH (over a custom
  gateway); identity-aware proxy + wildcard DNS (over per-workspace ALB rules — the
  ~100-rule cap); EBS-snapshot-as-persistence + scale-to-zero; Auth.js + CASL.
- **Engineering charter (`AGENTS.md` §6, CI-enforced):** strong typing + branded
  domain types; functional core / imperative shell; no magic values / typed
  `@edd/config`; fail-loudly (no silent fallbacks/role downgrades); explicit named
  exports; SAST (Semgrep) + Trivy gates; pre-commit; deps = latest ≥ 1-day-old.
- **Sim = sockerless, from source, endpoint-only (§6.8 HARD RULE).** No
  special-casing; file gaps upstream + halt (never work around). Consumed as a
  pinned submodule. Tier-2 = process-mode (API surface); e2e = container-mode
  (real task containers).
- **Workspace runtime = ECS-managed EBS** (the real Fargate pattern): compute
  creates/releases the task's EBS volume; storage owns snapshot/restore/GC.
- **GC safety:** `Ec2StorageProvider` tags everything `edd:managed` and scopes
  enumeration to it — GC can never delete unmanaged EBS in the account.
- **Lessons:** git push over HTTPS+`gh` (the SSH key authed as the wrong user;
  local identity pinned to `e6qu` noreply) · TS6/pnpm needs explicit `@types/node`
  · Auth.js breaks under vitest → lazy `import("../auth")` · `export *` caused an
  id collision → explicit exports · ElectroDB scans need `{ pages: "all" }` at 200+
  scale · Node `fetch` opaque-filters manual redirects → use `node:http` to read a
  302 `Location` · Trivy secret-scans token-shaped literals → build dummy tokens
  piecewise · `check-deps` goes stale mid-PR (latest ≥1-day-old).

## Milestone timeline

- **2026-06-01** — Planned + scaffolded: public repo (protected `main`); `@edd/*`
  Turborepo; the `StorageProvider` port + fake + contract test + state machine;
  Tier-2 DynamoDB-Local harness + ElectroDB; CI + the standards charter.
- **2026-06-01** — Control plane (lifecycle API + CASL RBAC over `WorkspaceService`);
  Auth.js (GitHub+Entra, JWT, claim→role); portal UI; reconciler idle pass.
- **2026-06-02** — Phase 5 maintenance passes: orphan GC + scheduled snapshots
  (pure selectors over endpoint-only storage enumeration).
- **2026-06-02** — **Consume sockerless from source** (user decision): pinned
  submodule + the AWS sim in Tier-2; `@edd/storage-ec2` real EBS adapter
  (lifecycle, endpoint-only). Audited/filed the sockerless gaps (all later fixed).
- **2026-06-02** — Wired `Ec2StorageProvider` GC into the reconciler with
  managed-resource tagging (fixed a real account-wide-deletion risk).
- **2026-06-02** — Evolved `ComputeProvider` to the managed-EBS model; reworked
  `WorkspaceService` create/start/stop/remove; fakes model managed EBS.
- **2026-06-02** — **Mock-free workspace e2e** (`packages/e2e`, `docker-compose.e2e.yml`,
  container-mode sim, CI `e2e` job): data fidelity proven — a task writes a file →
  snapshot via `Ec2StorageProvider` → a new task restores it → marker present.
- **2026-06-02** — `@edd/compute-ecs` (`EcsComputeProvider`, Fargate managed EBS):
  the **product lifecycle through `WorkspaceService`** (create→stop→start→remove)
  runs mock-free against the sim.
- **2026-06-03** — **Mock-free GitHub auth e2e** (`apps/web/lib/github-auth.e2e.ts`):
  OAuth-code login via bleephub (built from source, `-tags noui`) → our real
  `normalizeClaims` + `fetchGithubTeamGroups` + `mapClaimsToRole` → role. Also added
  GitHub org/team→role (`read:org` + `/user/teams`).

- **2026-06-03** — **Endpoint-only swappability, enforced project-wide** (user
  directive sharpening §6.8): the whole project — product code _and_ test fixtures —
  must differ from real cloud by endpoint/base-domain only; no `/sim/...` endpoints,
  seed tokens, non-standard endpoints, branches, or fallbacks. Audit found product
  code clean but two auth e2es' **fixtures** non-swappable. The Entra `groups` claim
  (added by #389) shipped via a sim-only seed → filed **#390** (need standard Graph /
  `azuread` Terraform + ROPC). bleephub's `POST /user/orgs` isn't a real GitHub/GHES
  endpoint → filed **#391** (need standard `POST /admin/organizations`). Both auth
  e2es halted pending swappable provisioning; lesson: a feature reachable only through
  a sim-only endpoint is still a blocker, not a fix.

- **2026-06-03** — **Mock-free Entra auth e2e** (`apps/web/lib/entra-auth.e2e.ts`,
  azure sim added to `docker-compose.e2e.yml` in process mode): standard Microsoft
  Graph user/group/membership provisioning → ROPC (`grant_type=password`) login →
  id_token `groups` → our real `normalizeClaims` + `mapClaimsToRole` → admin role.
  Endpoint-only — no `/sim/...`; unblocked once #390/#391 landed in #393. This is the
  reference pattern for swappable, standard-surface auth fixtures.

- **2026-06-03** — **SSH via Teleport, connect e2e** (`services/ssh-gateway`,
  `docker-compose.ssh.yml`): a real Teleport auth+proxy cluster + a workspace SSH node
  (Teleport runs as the single non-root workspace principal — no root/host-user
  switching). The e2e provisions a Teleport user/role via `tctl`, signs an identity
  file, `tsh`-connects, and asserts the session lands as `workspacePrincipal("e2e")`;
  an ungranted login is denied. Teleport pinned at 18.6.2; Teleport is the real product
  (not a sim), so no endpoint-only policy applies. Phase 4 → 🟡 (federation, recording,
  wake-on-connect remain).

- **2026-06-03** — **Identity-aware wildcard routing via Pomerium** (`infra/proxy`,
  Pomerium + workspace upstream added to `docker-compose.e2e.yml`, OIDC IdP = the azure
  sim; `packages/e2e/src/proxy-routing.e2e.ts`): a real Pomerium proxy proves the
  `<name>.devbox.<domain>` model — a public route reaches the upstream (200), and any
  workspace subdomain is gated to sign-in when unauthenticated (verified for two
  subdomains → genuinely wildcard). Pomerium pinned 0.32.2; runs `insecure_server` +
  all-zeros throwaway secrets for the e2e. Phase 3 routing → ✅ on the harness (real
  DNS/TLS + authenticated-pass remain). Note: `from` URLs must be `https://` even with
  `insecure_server`.

- **2026-06-03** — **Wake-on-connect, control-plane half** (`planConnect` in
  `@edd/core`; `WorkspaceService.connect()`; `POST /workspaces/:id/connect` +
  `connectWorkspace` client): an idempotent connect-time wake — running→no-op (unlike
  `start()`, which throws when running), scaled-to-zero→wake from snapshot. Proven on
  real ECS+EBS by extending the lifecycle e2e (stop→connect wakes→connect no-op). The
  wake data-path was already sim-proven, so no sim gap; the Teleport→`connect()` trigger
  (golden image auto-enrol + gateway call) is deployment/AWS-tier, not a sim concern.

<!-- Append new milestones below. -->
