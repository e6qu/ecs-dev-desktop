<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Observability & launch-readiness gaps

What exists today across **logs / health / status / metrics / audit**, what is
tested, and the concrete gaps remaining before a production launch. Prioritized;
each gap is a candidate task. Cross-referenced from [`DO_NEXT.md`](../DO_NEXT.md)
and [`BUGS.md`](../BUGS.md).

## Logs

**Exists.** A `LogSource` port in `@edd/core` with three streams (`control-plane`,
`reconciler`, `container`) and two adapters selected by `LOG_PROVIDER`:
`DerivedLogSource` (local — projects the audit feed) and `CloudWatchLogSource`
(real — `FilterLogEvents`). Admin route `GET /api/admin/logs` + UI. Workspace task
stdout ships to CloudWatch via `awslogs`. Both adapters are unit/integ-tested
(incl. a live CloudWatch read via the sim).

**Done (2026-06-14).** A structured (JSON-per-line) logger is now wired:
`createLogger`/`formatLogLine` in `@edd/core` (pure, writer injected); the control
plane logs through `apps/web/lib/logger.ts` (audit-source failures, audit-record
failures, sign-in credential-store failures — replacing the ad-hoc `console.*`),
and the reconciler emits a structured per-sweep line plus a structured error line
on failure. CloudWatch Logs Insights can now query by field (level, service,
action, …).

**Done (later 2026-06-14).** Per-workspace log view: the `LogSource.read` port
takes an optional `{ taskId }` filter; the CloudWatch adapter narrows the shared
workspaces group to the workspace's task stream (`workspace/<container>/<taskId>`),
and the admin Logs route + UI accept `?workspaceId=`. Access logging: every
business API route is wrapped with `withObservability`, which emits a structured
`api request` line (method/route/status/duration) per request.

**Gaps.**

- `parseLevel` infers level by substring-matching the raw message (brittle) — a
  symptom of the no-structured-levels gap on the read side. _Low._

## Health

**Exists.** `summarizeHealth` (pure) + `HealthService` aggregating five components
(control-plane, dynamodb, compute, storage, reconciler). Real checks: DynamoDB
(`DescribeTable`), compute (`DescribeClusters`), and **storage now does a live
`DescribeAvailabilityZones`** (added 2026-06-14 — closed the inverted contract
that left storage `unknown` on AWS). Admin board `GET /api/admin/health` + UI, and
a liveness endpoint `GET /api/healthz` wired to the ALB target group + the ECS
container healthcheck.

**Done (2026-06-14).** `/api/readyz` is a real readiness probe (DynamoDB
`DescribeTable` ping → 200 ready / 503 unready) and the ALB target group now health-
checks it, while `/api/healthz` stays liveness (static, drives the ECS container
restart). A task that can't reach its data store is pulled from the load balancer
without being killed.

**Done (later 2026-06-14).** Reconciler health is now real: the reconciler stamps a
heartbeat (last-successful-sweep time) each sweep, and the board reports it
`ok`/`degraded` via `reconcilerHealthFromHeartbeat` (stale after
`DEFAULT_RECONCILER_STALE_MS` = 15 min), or `unknown` until the first sweep. The
`HealthService` reconciler branch now has a dedicated unit test.

**Gaps.**

- **`control-plane` component health is hardcoded `ok`** — can never self-report
  degraded (it is, by construction, the process answering the request — lower
  value to change). _Low._

## Status

**Exists.** Admin overview (fleet tallies, active users, base-image + by-state
breakdown via `tallyWorkspaceStates`), per-workspace inspect, costs, quotas.

**Gaps.**

- Overview recomputes from a full `cp.list()` scan per load — fine now, but the
  platform targets 200+ workspaces; no cached/aggregated fleet status. _Medium._
- No real-time status (cold-start in progress, wake latency, per-workspace
  last-heartbeat age). _Low._

## Metrics

**Done (2026-06-14).** A metrics port now exists: `MetricSink` (count/gauge/timing)
in `@edd/core` with `NoopMetricSink`/`InMemoryMetricSink`, and a CloudWatch
**EMF-over-stdout** adapter `@edd/cloudwatch-metrics` (`metricSinkFromEnv()` → EMF
when `LOG_PROVIDER=cloudwatch`, else no-op; no `PutMetricData` calls). Wired:

- **Cold-start / wake-on-connect latency** (`workspace.wake.latency_ms`, timing) —
  emitted from `WorkspaceService.start`, dimensioned by base image.
- **Reconciler action + failure counts** — sweep, drift-lost, idle-stopped,
  snapshots-taken, gc-deleted, skipped, and `reconciler.sweep.failed`.
- **CloudWatch alarms** (`alarms.tf`): reconciler-failed and wake-latency-p99-high,
  with optional `alarm_sns_topic_arns` (gated by `enable_metric_alarms`; off for the
  sim, which exposes no metrics endpoint).

**Done (later 2026-06-14).**

- **API request latency + error rate** — `withObservability` emits
  `api.request.latency_ms` (timing), `api.request` (count, dimensioned by route +
  status class), and `api.request.error` (5xx) for every business route.
- **Fleet gauges** — the reconciler emits `fleet.workspaces.{total,running,stopped,
active}` and a priced `fleet.cost.usd` once per sweep.

**Gaps.**

- Per-user quota-utilization gauges are not yet emitted. _Low._
- Real-AWS verification that EMF stdout lands as CloudWatch metrics + alarms fire
  (only the JSON shape is unit-tested; the sim has no metrics endpoint). _Tracked
  under `e2e-aws`._

## Audit

**Exists.** A first-class stored, actor-attributed feed (`StoredAuditSource`,
`session.*`/`repo.*` in DynamoDB) merged with a derived fleet-lifecycle feed
(`DerivedAuditSource`), plus a real `CloudTrailAuditSource` (`LookupEvents`).
Unit + live-route integ tested.

**Done (2026-06-14).** `CloudTrailAuditSource.recent` now follows `NextToken`
across pages up to the requested limit (CloudTrail caps a page at 50), with unit
tests covering multi-page collection and stop-at-limit — no more first-page
truncation at volume.

**Gaps.**

- Audit-source failures degrade to `[]` (by design) and are now logged via the
  structured logger, but there's no metric/alert on the degradation. _Low._

## Testing gaps

- **`e2e-aws` (real account/region/IdP) has never run** — blocked on the AWS
  account decision. EBS durability/latency, real Fargate cold-start, 200+ load,
  IAM enforcement, ACM/DNS, KMS/DR, and GitHub/Entra federation are all unverified
  against real AWS. Highest launch risk. _High._
- **sockerless#569 (open):** process-mode `RunTask` with managed EBS panics the
  sim, so the managed-EBS launch path (incl. agent-secret injection) runs only in
  container-mode e2e, never in the lighter process-mode integration job. _Medium._
- **Idle-agent heartbeat RESUMPTION** after the control plane returns — tolerance
  is proven, resumption is not (the remaining live-test candidate). _Medium._
- **`CONNECTION_TOKEN` injection** unimplemented/untested — deferred to the future
  DYNAMIC wake-on-connect gate. _Low._

## Priority summary (pre-launch)

Done (2026-06-14): readiness probe (`/api/readyz`), storage Health-board check,
structured logging (control plane + reconciler), a metrics layer (wake latency +
reconciler counts) with CloudWatch alarms, CloudTrail audit pagination, **API
request latency/error metrics + access logging, fleet + cost gauges, reconciler
health (heartbeat staleness), per-workspace log view, and SSH CA key-material
support** (`EDD_SSH_CA_KEY` via Secrets Manager — no CA key in Terraform state).

Remaining:

1. **Unblock and run `e2e-aws`** once the AWS account decision lands (open decision
   #1, the top blocker). This is the one substantial item left and is **external** —
   the entire real-cloud tier is unverified, and it's also where the EMF→CloudWatch
   metrics, alarms firing, and live SSH-cert issuance get their first real check.
2. Minor follow-ups (all _Low_): per-user quota-utilization gauges; `parseLevel`
   heuristic on the log read side; control-plane self-health; cached fleet status
   for 200+ scale.
