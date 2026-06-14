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

**Gaps.**

- **No per-workspace log view** — the `container` stream is one shared group; the
  admin UI can't filter to a single workspace. _Medium._
- **No request/response (access) logging** on the API routes (request id,
  method, path, status, latency) — only error-path logging exists so far. _Medium._
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

**Gaps.**

- **`control-plane` component health is hardcoded `ok`** — can never self-report
  degraded. _Medium._
- **`reconciler` health is hardcoded `unknown`** — no last-run/staleness signal,
  so a wedged reconciler (snapshots/scale-to-zero not running) is invisible on the
  board. _Medium._
- The assembled `HealthService.report` (mixed multi-component statuses; a provider
  `health()` throwing) is only exercised incidentally — no dedicated roll-up test.
  _Low._

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

**Gaps.**

- **API request latency + error rate** for the ALB-fronted control plane — not yet
  emitted (no central request middleware). _Medium._
- **Fleet gauges** (running/stopped/total, active users, quota utilization) and a
  **cost/spend gauge** — the data exists for the overview but isn't emitted as a
  time series. _Medium._

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
reconciler counts) with CloudWatch alarms, and CloudTrail audit pagination.

Remaining:

1. Unblock and run `e2e-aws` once the AWS account decision lands (the entire
   real-cloud tier is still unverified).
2. API request-latency + error-rate metrics and access logging (needs central
   request middleware), plus fleet/cost gauges.
3. Per-workspace log view; reconciler/self health signals on the board.
4. `EDD_SSH_CA_KEY_PATH` (CA private key) Terraform provisioning (see
   [`deploying.md`](./deploying.md) Step 4).
