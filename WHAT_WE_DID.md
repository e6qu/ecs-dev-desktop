# WHAT_WE_DID.md — ecs-dev-desktop

> Append-only history. Three lenses per entry: **Done**, **Tried** (incl. dead
> ends and rejected options), **Filed** (bugs/issues raised). Past tense.

---

## 2026-06-01 — Project planning & scaffolding decisions

### Done
- Established the project goal: per-user VS Code workspaces on AWS ECS Fargate
  with SSH, stateful+snapshottable storage, login UI, and an admin control plane.
- Locked architecture decisions (recorded in `AGENTS.md` §1):
  - Compute: **ECS Fargate**; scale target **200+**.
  - Auth: **GitHub OAuth + Azure Entra ID**, groups → roles.
  - RBAC: **CASL**, shared across API and UI.
  - SSH: **Teleport** (chosen over custom gateway / Node SSH proxy).
  - Web + control-plane API: **Next.js**, API-first.
  - State store: **DynamoDB** single-table + **ElectroDB** (pending final confirm).
  - IaC: **Terraform**; monorepo: **Turborepo + pnpm**.
  - Persistence model: **EBS snapshot as the unit of persistence**, unifying
    stateful + snapshottable + scale-to-zero.
  - Idle policy: **scale-to-zero** with snapshot/hydrate.
  - Workspace images: **curated golden base images**; extensions via Open VSX.
- Authored continuity files (`STATUS.md`, `WHAT_WE_DID.md`, `BUGS.md`,
  `DO_NEXT.md`), `PLAN.md` (7 phases with deliverables + testing gates),
  `AGENTS.md`, and the `CLAUDE.md → AGENTS.md` symlink.
- Analyzed **DynamoDB vs Aurora** for control-plane state: concluded DynamoDB is
  cheaper (~$11/mo heartbeats vs ~$43/mo Aurora v2 floor) and a good fit given
  known access patterns; accepted implications (GSI-per-pattern, no joins,
  analytics via Streams→S3→Athena, heartbeat discipline).

### Tried
- Considered **Aurora Postgres + Prisma/Drizzle** for state — set aside in favor
  of DynamoDB + ElectroDB on cost and operational-simplicity grounds (revisit
  only if relational reporting needs grow; see `DO_NEXT.md`).
- Considered **Fargate constraints** for performance (16 vCPU / 120 GB ceiling,
  no GPU) — accepted because the workload is "light editor + builds"; noted an
  EC2-backed escape hatch is out of scope unless heavy/GPU needs appear.
- Considered **direct per-workspace SSH** and a **web-proxy SSH tunnel** —
  rejected in favor of Teleport for centralized auth/audit at 200+ scale.
- Considered **dynamic ALB host rules per workspace** — rejected (ALB ~100
  rule/listener cap); chose an identity-aware reverse proxy with wildcard DNS.

### Filed
- (none yet — see `BUGS.md`)
