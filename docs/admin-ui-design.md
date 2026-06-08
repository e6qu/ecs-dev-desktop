<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Admin console + troubleshooting/health/logs — design

> Status: **implemented through 8C** (2026-06-08). The admin UI and
> troubleshooting surface (component health, per-workspace diagnostics, logs/audit)
> are admin-only, work mock-free locally, and use CloudTrail/CloudWatch adapters
> against the sockerless AWS simulator. Metrics/cost remain real-AWS gated.

## Principles

- **Ports & adapters** (`AGENTS.md` §5). Observability is a set of ports with
  local adapters and AWS adapters; the UI and API are identical across both.
- **No custom audit/event store.** Per the product decision, events/audit/logs are
  **derived**: from the control plane's **current state** now, and from the cloud's
  native **CloudTrail** (audit of API mutations) + **CloudWatch Logs/Metrics**
  (container/app/reconciler logs, cost, utilization) on AWS. We do not reinvent an
  audit log in DynamoDB.
- **Admin-only**, behind CASL (`manage`/admin) + the page principal check.
- **Sim-testable now**: unit + integration + Playwright; CloudTrail/CloudWatch
  adapters are integration-tested against the sockerless AWS simulator.

## Information architecture — a dedicated `/admin` shell

A separate admin section with a left **sidebar**, distinct from the user portal:

```
/admin
  Overview      counts by state, totals, active users, catalog size, reconciler freshness, (cost→AWS)
  Workspaces    all workspaces across users; filter by state/owner/image; row actions + Inspect →
  Health        component status board (control-plane, DynamoDB, compute, storage, reconciler, auth; proxy/SSH→AWS)
  Inspect/:id   one workspace: state + derived lifecycle timeline + runtime bindings + snapshots + logs pane
  Logs          control-plane events + reconciler runs + audit (CloudWatch/CloudTrail slot in on AWS)
  Catalog       existing /base-images, folded in
  Users         owners + IdP role + quota usage (role is IdP-driven; read-mostly)
  Quotas        per-role workspace limits + usage, enforced at create
```

## Observability ports (new — `@edd/core` ports + fakes, real adapters per provider)

| Port            | `query`/shape                              | Local adapter                                                                  | AWS adapter                                            |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `HealthChecker` | `check() → ComponentHealth[]`              | DynamoDB ping; compute/storage `health()`; reconciler freshness (derived)      | + ECS/EBS/SSH/Pomerium real checks                     |
| `AuditSource`   | `query(filter) → AuditEvent[]`             | **derive** per-workspace timeline from records + in-process recent-action ring | **CloudTrail** `LookupEvents` (our roles/resources)    |
| `LogSource`     | `read(target, filter) → LogLine[]`         | reconciler run summaries + control-plane structured events (derived)           | **CloudWatch Logs** (app/reconciler/container streams) |
| `MetricsSource` | `read(metric, range) → Point[]` (deferred) | n/a (cost/utilization need the cloud)                                          | **CloudWatch Metrics** + Cost Explorer/CUR             |

- **Health** is composed from per-provider `health()` added to the existing
  `StorageProvider`/`ComputeProvider` ports (sim returns reachable; AWS does a real
  Describe call) plus a DynamoDB `DescribeTable` ping. Each check →
  `{ component, status: ok|degraded|down, detail, checkedAt }`.
- **Audit (derived now):** a workspace's record already encodes its history —
  `createdAt` (created→running), `latestSnapshotAt` (snapshots), `lastActivity`
  (activity), and current `state` — enough to render a plausible **lifecycle
  timeline** with no store. A small **in-process ring buffer** in the Next runtime
  records the last N mutations (actor + action) for a live "recent actions" feed
  (ephemeral, best-effort). On AWS, **CloudTrail** is the durable source — same
  `AuditEvent` shape, different adapter.
- **Logs (now):** the Logs screen shows the derived audit timeline + recent-actions
  buffer + reconciler run summaries, clearly marked that **container/CloudWatch logs
  appear on AWS**. On AWS, `LogSource` reads CloudWatch log groups (app, reconciler
  scheduled task, per-workspace container streams).
- **Reconciler freshness:** on AWS, derived from the scheduled task's CloudWatch
  logs/metrics. Pre-AWS there is no durable run history; Health shows reconciler as
  **"n/a (local)"** or a derived proxy (e.g. "idle workspaces past threshold still
  running" ⇒ reconciler not sweeping). No new store added.

## API surface (admin-only)

- `GET /api/admin/health` → `HealthReport` (the component board).
- `GET /api/admin/workspaces` → all workspaces (admin list; already have `cp.list()`).
- `GET /api/admin/workspaces/:id/events` → derived lifecycle timeline (AuditSource).
- `GET /api/admin/audit` → recent audit events (AuditSource).
- `GET /api/admin/logs?target=…` → log lines (LogSource).
- `GET /api/admin/quotas` / `PUT …` → quota config + usage.

All gated by CASL `manage` (admin). Contracts in `@edd/api-contracts`; client in
`@edd/api-client`; same dev-auth + Playwright coverage as the portal.

## Phasing

- ✅ **Phase A — Foundation + Health:** the observability ports +
  local adapters; `GET /api/admin/health`; the `/admin` sidebar shell; the **Health
  board**; per-workspace **Inspect** (state + derived timeline + bindings +
  snapshots). Unit + integration + Playwright.
- ✅ **Phase B — Audit/Logs + Overview + Workspaces + Quotas:**
  `AuditSource`/`LogSource` local adapters; the **Logs/Audit** screen; the admin
  **Overview** dashboard; the all-workspaces management table; **quotas** (config +
  create-time enforcement).
- ✅ **Phase C — CloudTrail + CloudWatch Logs adapters:** CloudTrail audit adapter
  and CloudWatch Logs adapter (container/app/reconciler), endpoint-only and
  integration-tested against the sockerless AWS simulator.
- ⬜ **Phase C remainder — Metrics/cost + deploy health:** CloudWatch Metrics +
  Cost Explorer/CUR dashboard, plus real ECS/EBS/SSH/Pomerium health; validated at
  `e2e-aws`.

## Notes / open points

- **Metrics/cost** are inherently cloud-only → deferred to Phase C with a clear
  placeholder in Overview.
- **Real-time:** polling/auto-refresh now (simple, decision-free); SSE/websockets
  only if needed later.
- **Users list** is derived from workspace owners + the session role; in-app role
  changes are out of scope (role is IdP-driven), but group→role mapping is shown.
