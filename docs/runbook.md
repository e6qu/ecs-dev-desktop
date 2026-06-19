<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Operations runbook — incident response

Where to look and what to do when an alarm fires or something is wrong. Companion
to the deploy guide ([`deploying.md`](./deploying.md)); the alarms/metrics referenced
here are defined in `infra/terraform/modules/ecs-dev-desktop/{alarms,monitoring}.tf`
and emitted as CloudWatch EMF from `@edd/core` (namespace `edd/control-plane`).

## First stops (every incident)

- **Ops dashboard** — `<name>-ops` (CloudWatch Dashboards): fleet size + cost, wake
  latency, control-plane health + 5xx, reconciler actions/failures, DynamoDB throttling.
- **Health board** — `GET /api/admin/health` (admin UI): per-component status
  (control-plane, DynamoDB, compute, storage, reconciler heartbeat).
- **Per-workspace logs** — admin Logs (`/api/admin/logs?workspaceId=…`) → the
  workspace's CloudWatch task stream.
- **Audit feed** — admin Audit: who did what, newest first.
- **Correlation id** — every API response carries `x-edd-request-id`; grep it in the
  control-plane logs to see that request's access + error lines.
- **Break-glass** — `aws ecs execute-command` into a live workspace task (ECS Exec is
  enabled) for in-container inspection.

## Alarms → response

### `…-control-plane-unhealthy` — the control plane is down

No healthy task behind the ALB. ECS self-heals (the service replaces unhealthy tasks;
the deployment circuit breaker rolls back a bad deploy), so first confirm it isn't
already recovering.

1. Check the ECS service events + task `stoppedReason` (crash-loop? image pull? OOM?).
2. `GET /api/readyz` — 503 means it can't reach DynamoDB; check the DynamoDB component
   on the Health board and `…-dynamodb-throttle`.
3. If a bad deploy: the circuit breaker should have rolled back; if not, roll the
   service back to the prior task-def revision.

### `…-control-plane-5xx` — the API is erroring (but up)

Target 5xx over threshold. Find the failing requests by `x-edd-request-id` /
`route` in the `api request threw` logs; check the Health board for a degraded
dependency (DynamoDB/compute/storage).

### `…-reconciler-not-running` — the self-healing engine is dead

**Most urgent.** No sweep ran in the window, so scale-to-zero, snapshots, GC, the
orphan-task reaper, and stuck-provisioning recovery are all stalled (idle cost climbs;
orphans leak).

1. Check `…-reconciler-dlq` — a non-empty DLQ means the scheduled invocation is
   failing to launch (capacity, image pull, IAM); inspect the DLQ message and the
   EventBridge Scheduler.
2. Check the `aws_scheduler_schedule` is enabled and its cadence (`reconciler_schedule`).
3. Check the reconciler task definition / image is valid; run it once manually if needed.

### `…-reconciler-failed` — a sweep ran but threw

The sweep launched but errored. Find the structured `maintenance sweep failed` error
line in the reconciler logs (it carries the cause). Distinct from _not-running_ above.

### `…-reconciler-gc-failed` / `…-reconciler-reap-failed` — a stuck, cost-leaking orphan

A delete/stop the sweep retried still failed. The sweep keeps running (best-effort),
but a resource is stuck and accruing cost. The `gc:`/`reap:` warn logs name the
`volumeId`/`taskId`/`workspaceId`. Inspect it in the EC2/ECS console — usually a
volume wedged in `in-use`/`deleting` or a task that won't stop; clear it manually.

### `…-dynamodb-throttle` — sustained throttling

Clients retry with adaptive backoff, so a burst self-absorbs; a _sustained_ alarm
means a hot partition or a runaway loop. Check the dashboard's throttle widget, the
table's consumed vs provisioned (on-demand should scale), and recent deploys for a
tight read/write loop.

### `…-monthly` budget (80% / 100%) — cost guardrail

Forecast or actual spend crossed the budget. Check the fleet cost widget + admin Costs
(`/api/admin/costs`); the usual culprit is leaked Fargate tasks (see `reap-failed`) or
a wake storm. The orphan-task reaper self-heals leaked tasks each sweep — confirm the
reconciler is running.

## Common symptoms (no alarm)

### A workspace won't wake / connect

- A wake that crashed mid-flight leaves the record in `provisioning`; the reconciler
  **self-heals** this back to `stopped` (within `EDD_PROVISIONING_TIMEOUT_MS`, default
  10 min) so a retry works. If it's still stuck, confirm the reconciler is running.
- Check the wake-latency alarm/widget for a slow cold start; admin Inspect
  (`/api/admin/workspaces/:id`) shows the task ARN + volume + ENI; the per-workspace
  logs show the container boot + idle-agent.

### A workspace task is RUNNING but unresponsive

ECS Exec into it; check the editor/sshd processes. A wedged task that stops
heartbeating will scale to zero on the next idle sweep and wake fresh on reconnect.

## Reliability notes

- **NAT**: `nat_mode = "instance"` (cheap dev default) is a single-AZ SPOF for egress —
  if the fck-nat instance dies, private tasks lose internet (image pulls, the idle
  agent reaching the control plane). Use `nat_mode = "gateway"` (AWS-managed, HA) for
  production.
- **DynamoDB**: point-in-time recovery (`dynamodb_point_in_time_recovery`) and
  `deletion_protection` should be **on** in production for table durability.
