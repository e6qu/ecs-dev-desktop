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

<!-- Append new milestones below. -->
