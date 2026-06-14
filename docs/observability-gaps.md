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

**Gaps.**

- **No structured logging in the control plane or reconciler.** There is no
  request/response logging, request ids, JSON format, or levels — so the
  CloudWatch `control-plane` stream is near-empty in production (the local
  `DerivedLogSource` masks this by projecting the audit feed). _High._
- **Reconciler emits no operational logs** — one JSON result line per sweep, no
  per-action (stop/snapshot/GC/drift) lines, no errors, no timing. _High._
- **No per-workspace log view** — the `container` stream is one shared group; the
  admin UI can't filter to a single workspace. _Medium._
- `parseLevel` infers level by substring-matching the raw message (brittle) — a
  symptom of the no-structured-levels gap. _Low._

## Health

**Exists.** `summarizeHealth` (pure) + `HealthService` aggregating five components
(control-plane, dynamodb, compute, storage, reconciler). Real checks: DynamoDB
(`DescribeTable`), compute (`DescribeClusters`), and **storage now does a live
`DescribeAvailabilityZones`** (added 2026-06-14 — closed the inverted contract
that left storage `unknown` on AWS). Admin board `GET /api/admin/health` + UI, and
a liveness endpoint `GET /api/healthz` wired to the ALB target group + the ECS
container healthcheck.

**Gaps.**

- **`/api/healthz` is a static `{status:"ok"}`, not a real readiness check** — it
  doesn't verify DynamoDB or any dependency, so the ALB keeps a control-plane task
  in service even when its deps are down. Needs a readiness variant (DB +
  critical deps) distinct from liveness, with care not to flap the whole fleet on
  a transient blip. _High._
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

**Exists: nothing.** No `PutMetricData`, EMF, Prometheus, or StatsD anywhere in
`apps`/`services`/`packages`, and no metrics port analogous to `LogSource`. This is
the largest gap. Highest-value first metrics:

- **Cold-start / wake-on-connect latency** — a core SLO (scale-to-zero → hydrate),
  currently unmeasurable. _High._
- **Reconciler action + failure counts** — stops, snapshots, GC reaps, drift
  corrections, errors. _High._
- **API request latency + error rate** for the ALB-fronted control plane. _High._
- **Fleet gauges** (running/stopped/total, active users, quota utilization) and a
  **cost/spend gauge** — the data exists for the overview but is never emitted as a
  time series. _Medium._
- **No CloudWatch alarms / alerting path** wired in Terraform. _Medium._

> This is a design decision (a metrics abstraction + provider, like `LogSource`):
> worth agreeing the shape before building.

## Audit

**Exists.** A first-class stored, actor-attributed feed (`StoredAuditSource`,
`session.*`/`repo.*` in DynamoDB) merged with a derived fleet-lifecycle feed
(`DerivedAuditSource`), plus a real `CloudTrailAuditSource` (`LookupEvents`).
Unit + live-route integ tested.

**Gaps.**

- **`CloudTrailAuditSource.recent` has no pagination / time-window** — at volume
  the feed truncates to the first page (same class as the resolved DynamoDB
  quota-pagination bug; the derived source already does `pages:"all"`). Needs
  pagination + a `>1`-page test. _Medium._
- Audit-source failures degrade to `[]` (by design) but with no metric/alert it's
  invisible. _Low._

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

1. Real readiness check for `/api/healthz` (DB + critical deps).
2. Structured logging in the control plane + reconciler (request ids, levels,
   per-action reconciler lines).
3. A metrics layer — start with cold-start/wake latency, reconciler action/failure
   counts, API error rate; add CloudWatch alarms.
4. Unblock and run `e2e-aws` once the AWS account decision lands.
5. CloudTrail audit pagination (+ a `>1`-page test).
