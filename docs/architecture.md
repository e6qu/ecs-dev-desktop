<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Architecture

How ecs-dev-desktop fits together: the components, the block diagram, the
deployment sequence, and the user-connection sequences. This is the conceptual
companion to the deploy runbook ([`deploying.md`](./deploying.md)) and the
operations runbook ([`runbook.md`](./runbook.md)). The locked decisions behind
this design live in [`AGENTS.md`](../AGENTS.md) §1 (the architecture table);
this document explains _how_ they play out.

> **Status:** the platform is sim-proven end to end (control plane, real ECS
> workspace lifecycle, reconciler scale-to-zero, in-app editor proxy, SSH
> dual-trust) and the Terraform module is apply-proven against the simulator
> every PR. Real-AWS delivery is gated on the AWS account/domain decisions — see
> [`DO_NEXT.md`](../DO_NEXT.md). Where a path is sim-proven but real-AWS-unrun,
> this doc says so.

## Goal

Self-hosted cloud dev environments: each user gets a private **VS Code** (OpenVSCode
Server) workspace on **AWS ECS Fargate**, with SSH access, **stateful +
snapshottable** storage (an EBS volume per workspace, snapshot = the unit of
persistence), a login UI, and an admin control plane. Think self-hosted Coder or
GitHub Codespaces.

## Block diagram

```
                              Browser
                    (app.<domain>/w/<id>/  editor proxy)
                    (app.<domain>          portal/admin/API)
                                │  (TLS, ACM-validated, single-host — no wildcard)
                                ▼
   Internet ──────────▶ ALB (public subnets)
                                │
                                ▼
            ┌───────────────────────────────────────────────┐
            │  ECS service: control plane (Next.js)         │  private subnets, NAT egress
            │  • portal + admin UI + control-plane API      │
            │  • path-based /w/<id>/ editor proxy (in-proc) │
            │  • authorizes off the Auth.js session         │
            │      (uid-ownership or admin)                 │
            └───────┬───────────────────────┬───────────────┘
                    │ DynamoDB               │ ECS RunTask (at runtime)
                    ▼                        ▼
        ┌──────────────────┐   ┌──────────────────────────────────────┐
        │ DynamoDB         │   │ Per-user workspace ECS tasks          │
        │ single-table +   │   │ (Fargate, awsvpc ENI, managed EBS)    │
        │ GSI1/GSI2 (KMS)  │   │ • OpenVSCode Server (--server-base-   │
        └──────────────────┘   │   path /w/<id>/)                      │
                               │ • sshd (registered-key auth)          │
                               │ • idle-agent (heartbeat → scale-zero) │
                               │ • git-credential helper               │
                               │ security group: editor/sshd reachable │
                               │   from the control plane ONLY         │
                               └───────────────┬──────────────────────┘
                                               │ EBS volume (/home/workspace)
                                               ▼
                                          ┌────────┐
                                          │  EBS   │  snapshot = unit of persistence
                                          └────────┘

   EventBridge Scheduler ──rate(5m)──▶ ECS reconciler task (same image, command override)
                                       • idle stop → scale-to-zero
                                       • scheduled + early snapshots
                                       • orphan-volume/task GC
                                       • stuck-provisioning self-heal
                                       • quota-counter drift correction

   SSH (separate front door, optional):
   Internet ──ssh──▶ NLB (TCP:22) ──▶ ECS service: ssh-gateway (OpenSSH)
                                          │ registered-key dual-trust:
                                          │ AuthorizedKeysCommand → control-plane
                                          │   POST /api/workspaces/:id/ssh-authorize
                                          ▼  (wakes if stopped, then forwards)
                                     workspace sshd
```

Supporting services (created by the [Terraform module](../infra/terraform/modules/ecs-dev-desktop/README.md)):

- **ECR** — the control-plane image, the SSH-gateway image, and one repo per golden
  workspace image. No images are published by the module; the [release
  pipeline](#deployment-sequence) pushes them after the first apply.
- **KMS** — encrypts DynamoDB, EBS snapshots, CloudWatch Logs, ECS Exec, ECR.
- **CloudWatch** — structured logs (control plane, reconciler, workspaces, gateway),
  EMF metrics, alarms, and the `<name>-ops` dashboard. See
  [`observability-gaps.md`](./observability-gaps.md).
- **CloudTrail** — the audit feed (management events) merged with the stored
  in-app audit ledger.
- **Secrets Manager** — auth + crypto secrets, injected as task env vars; also the
  per-workspace agent/connection secrets the control plane creates at runtime.

## Components

| Component              | What it is                                                                                                       | Source                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Control plane          | Next.js (custom server): portal + admin UI + control-plane API + the in-app `/w/<id>/` editor proxy              | [`apps/web`](../apps/web/)                                                                                |
| Reconciler             | Scale-to-zero, snapshots, GC, self-heal — runs the control-plane image with a command override                   | [`services/reconciler`](../services/reconciler/)                                                          |
| SSH gateway            | OpenSSH proxy: registered-key auth, then wake-and-forward to the workspace sshd                                  | [`services/ssh-gateway`](../services/ssh-gateway/)                                                        |
| Core                   | Functional core: branded domain types, the workspace lifecycle state machine, pure ports (Storage/Compute/Clock) | [`packages/core`](../packages/core/)                                                                      |
| Control-plane service  | Imperative shell over core + db + ports (`WorkspaceService`, `SshKeyService`, …)                                 | [`packages/control-plane`](../packages/control-plane/)                                                    |
| DB                     | DynamoDB single-table + ElectroDB entities                                                                       | [`packages/db`](../packages/db/)                                                                          |
| Storage adapter        | Real EBS `StorageProvider` over the EC2 API                                                                      | [`packages/storage-ec2`](../packages/storage-ec2/)                                                        |
| Compute adapter        | Real Fargate `ComputeProvider` (managed EBS, awsvpc)                                                             | [`packages/compute-ecs`](../packages/compute-ecs/)                                                        |
| Authz / Auth           | CASL abilities; IdP claim → role mapping (GitHub OAuth/App + Azure Entra)                                        | [`packages/authz`](../packages/authz/) · [`packages/auth`](../packages/auth/)                             |
| API contracts / client | Zod contracts (single source of API truth) + typed HTTP client                                                   | [`packages/api-contracts`](../packages/api-contracts/) · [`packages/api-client`](../packages/api-client/) |
| Golden images          | OpenVSCode + sshd + toolchains, `FROM` a shared `base`                                                           | [`infra/images`](../infra/images/)                                                                        |
| Terraform              | All AWS infra, parametric, provider-agnostic (Terraform **or** Terragrunt)                                       | [`infra/terraform`](../infra/terraform/)                                                                  |

### Functional core, imperative shell

Decisions are **pure functions** in `@edd/core` (data in → domain object out, no
I/O, no doubles); the thin shell (`WorkspaceService`, route handlers, the AWS
adapters) does all the I/O. Every external dependency has a port + a fake + a real
adapter, so the same logic runs against fakes, the simulators, and real cloud.
This is also why the safety-critical invariants are property-tested
([`TESTING.md`](../TESTING.md)).

### Coordinates, not targets

The app and its tests have **no notion of "sim vs. real"**. The only thing that
exists is **coordinates** — endpoints, credentials, resource ids. The same code
and the same test hit a simulator or the real cloud by changing coordinates alone
(`AGENTS.md` §6.8/§6.9). A simulator divergence is an upstream bug to file, never
a branch to add.

## Persistence model

- Each workspace owns **one EBS volume** (`/home/workspace`), attached via Fargate
  managed-EBS (`ECS_EBS_ROLE_ARN`, passed on `RunTask`).
- **An EBS snapshot is the unit of persistence.** Stop → snapshot → release the
  volume (scale-to-zero); wake → create volume from the latest snapshot → attach.
  This is what makes scale-to-zero and snapshot/restore the same mechanism.
- The reconciler takes **scheduled + early** snapshots, retains the teardown
  snapshot (tagged `edd:retain`), and GCs orphan volumes/snapshots/tasks it no
  longer references.
- Cross-region snapshot **copy** is the DR primitive (sim-validatable; real-AWS
  durability is an `e2e-aws` certification).

## Auth model

- **Auth.js** (NextAuth): GitHub OAuth (and/or GitHub App) + Azure Entra ID.
- **RBAC is group-driven**: an account's role (`admin`/`member`/`viewer`) comes
  from the intersection of its IdP groups with `EDD_ADMIN_GROUPS`/`EDD_MEMBER_GROUPS`.
  Default is `viewer`. **If `EDD_ADMIN_GROUPS` is unset, no one is an admin.**
  Abilities are CASL ([`packages/authz`](../packages/authz/)), shared by API and UI.
- **Editor proxy auth** = the Auth.js session, checked in-process (uid-ownership or
  admin). Defence-in-depth: the browser is handed a per-workspace **connection
  token** = `HMAC(EDD_CONNECTION_SECRET, workspaceId)`.
- **SSH auth** = registered-key, dual-trust (see below).

## Deployment sequence

The infra and the images are two phases (the module creates the ECR repos; images
are pushed after). The full runbook is [`deploying.md`](./deploying.md); the
shape is:

1. **Decide the external facts** (`DO_NEXT.md` open decisions): an AWS account +
   region, a domain (with its Route53 zone) for `app.<domain>`, and (optionally) a
   separate zone for `*.<ssh-base-domain>`. Register the IdP apps (GitHub and/or
   Entra) with the callback URL `https://app.<domain>/api/auth/callback/<provider>`.
2. **Bootstrap the state backend** — `scripts/bootstrap-state.sh <bucket> <region>`
   creates the versioned/encrypted S3 bucket + DynamoDB lock table (once per env).
3. **Bootstrap the secrets** — `scripts/bootstrap-secrets.sh <name> <region>`
   generates the crypto secrets and prompts for the IdP creds, printing the ARNs.
4. **Apply the Terraform module** — VPC/NAT, DynamoDB, ECR, KMS, IAM, the ECS
   cluster + control-plane service (autoscaled), the ALB + ACM + Route53, the
   reconciler schedule, CloudWatch logs/alarms/dashboard, and (when
   `ssh_base_domain` is set) the SSH NLB + gateway service. Use plain Terraform or
   Terragrunt (`examples/terragrunt`). Pass the Step-3 secret ARNs as
   `secret_environment`; set `EDD_ADMIN_GROUPS` in `extra_environment`.
5. **Publish the images** — `scripts/publish-images.sh` builds + pushes the
   control-plane, SSH-gateway, and golden variant images to the ECR repos the
   apply just created. For ongoing releases, the `release` workflow via GitHub
   OIDC builds and pushes the control-plane/SSH images, registers fresh task
   definitions, rolls the ECS services, and retargets the reconciler schedule.
   Workspace/golden post-merge rebuilds are owned by the deployed EDD
   image-source flow.
6. **Seed the base-image catalog** — production starts with an empty catalog; add
   an entry (admin UI or API) pointing at a golden ECR image, or users can't
   launch workspaces.

> The control-plane and reconciler **share one image** — the reconciler is the
> control-plane image run with a command override (`node services/reconciler/dist/run.js`),
> which is why the control-plane Dockerfile builds both bundles.

## User connection sequences

### Browser → editor (the in-app path-based proxy)

```
1. User signs in (Auth.js) at app.<domain>  →  Auth.js session cookie
2. User clicks "Open editor" on a workspace card
3. Browser navigates to app.<domain>/w/<workspace-id>/
4. Control-plane proxy checks the session:
      session.uid == workspace.ownerId  OR  session.role == admin   → allow
      otherwise                                                         → 403/login
   (the decision is the pure decideWorkspaceAccessBySubject in @edd/core)
5. If the workspace is STOPPED, the proxy wakes it (start → provisioning → running)
6. On the first document navigation, the proxy 302s the browser to
   …/w/<id>/?tkn=<HMAC(EDD_CONNECTION_SECRET, id)>  — defence-in-depth; the
   user never sees the token. The session cookie is stripped before forwarding.
7. The browser loads the OpenVSCode workbench (served by the workspace task under
   --server-base-path /w/<id>/); the control plane proxies HTTP + WebSocket to the
   workspace task's ENI (port workspace_port, reachable only from the control-plane SG).
```

### SSH (registered-key dual-trust)

```
1. User registers their public key in the portal (POST /api/ssh-keys). (Once per user.)
2. User runs:  ssh <principal>@<workspace-id>.<ssh-base-domain>
3. DNS *.<ssh-base-domain> → the SSH NLB → the ssh-gateway ECS service (OpenSSH)
4. Gateway sshd runs AuthorizedKeysCommand → POST /api/workspaces/:id/ssh-authorize
   (authenticates to the control plane with HMAC(EDD_GATEWAY_SECRET, id)).
   The control plane authorizes the presented key IFF it is registered to that
   workspace's owner → returns the key (allow) or empty (deny).
5. Gateway sshd ForceCommand = wake-and-forward.sh: wakes the workspace if stopped,
   then forwards the TCP session to the workspace task's sshd.
6. Workspace sshd runs its OWN AuthorizedKeysCommand → the SAME ssh-authorize
   endpoint (authenticating with the workspace's agent token, HMAC(EDD_AGENT_SECRET)).
   The same registered key is checked again → dual trust.
7. The user lands on the workspace shell.
```

There is **no SSH CA and no certificates** — the CA path was removed in a clean
break. Both hops authorize the same registered key via `ssh-authorize`.

## Workspace lifecycle (the state machine)

The pure state machine in `@edd/core` drives every transition; the reconciler and
the control-plane service are the only mutators. Highlights (full set in the
core tests):

```
                 start                 wake-on-connect
   stopped ─────────────▶ provisioning ─────────────▶ running
     ▲ │                    │                            │
     │ │ (scale-to-zero:    │ (crashed wake →            │ stop / idle
     │ │  reconciler)       │  reconciler self-heal)     ▼
     │ ▼                    ▼                          stopped  (snapshot retained)
   (snapshot)             stopped                         │
                                                          │ delete
                                                          ▼
                                                       deleting (tombstone)
                                                          │ reconciler finishDeleting:
                                                          │   snapshot → release volume → GC
                                                          ▼
                                                       terminated
```

- **Scale-to-zero:** the idle-agent heartbeats; the reconciler stops idle
  workspaces (snapshot + release volume) so a stopped workspace costs only snapshot
  storage. Wake-on-connect rebuilds the volume from the snapshot.
- **Self-heal:** a wake that crashed mid-flight leaves the record in `provisioning`;
  the reconciler reverts it to `stopped` (within `EDD_PROVISIONING_TIMEOUT_MS`) so a
  retry works. An interrupted delete is resumable via the `deleting` tombstone.
- **Teardown data-safety:** `delete` opens a `deleting` tombstone (202); the
  reconciler's `finishDeleting` takes a retained snapshot of the live volume before
  releasing it, so accidental deletes are recoverable.

## Observability & reliability (summary)

Structured JSON logs, a `MetricSink` (CloudWatch EMF over stdout), CloudWatch
alarms (reconciler liveness, GC/reap failures, wake-latency p99, control-plane
unhealthy/5xx, DynamoDB throttle, privilege attempts, monthly budget), and the
`<name>-ops` dashboard. Incident response is the [`runbook.md`](./runbook.md). The
control plane health-checks DynamoDB (`/api/readyz` readiness; `/api/healthz`
liveness); the reconciler stamps a heartbeat each sweep. The full gap inventory is
[`observability-gaps.md`](./observability-gaps.md).

Reliability knobs worth knowing: use `nat_mode = "gateway"` (HA) for production
(`instance`/fck-nat is a single-AZ dev default); keep `dynamodb_point_in_time_recovery`
and `deletion_protection` on in prod.

## See also

- [`deploying.md`](./deploying.md) — the AWS deploy runbook (step-by-step).
- [`runbook.md`](./runbook.md) — incident response (alarm → diagnosis → remediation).
- [`running-locally.md`](./running-locally.md) — run/develop/test locally (fakes → sims).
- [`observability-gaps.md`](./observability-gaps.md) — logs/health/metrics/audit gaps.
- [module README](../infra/terraform/modules/ecs-dev-desktop/README.md) — Terraform inputs/outputs.
- [`AGENTS.md`](../AGENTS.md) §1 — the locked architecture-decision table.
- [`TESTING.md`](../TESTING.md) — the test tiers (unit → integration → e2e → e2e-aws).
