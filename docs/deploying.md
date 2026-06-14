<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Deploying to AWS

A practical runbook for standing up a real environment. The platform reaches AWS
and the IdPs through **coordinates** only (endpoints + credentials + resource
ids), so the same code the local tiers and CI exercise targets real cloud by
configuration alone — no real-vs-sim branches (`AGENTS.md` §6.8/§6.9).

> **Status:** the Terraform module is built and **simulator-apply-proven every PR**
> (`terraform-sim` CI). A real `apply` is gated on an AWS account + a domain (see
> [`DO_NEXT.md`](../DO_NEXT.md) open decisions). The steps below are the intended
> production flow; items still un-exercised against real AWS are flagged.

## Prerequisites

- An AWS account + region, and credentials with permission to create the module's
  resources (VPC, ECS, DynamoDB, ECR, KMS, IAM, ALB, Route 53/ACM).
- A registered domain you can delegate (`*.devbox.<domain>` for workspaces,
  `app.<domain>` for the control plane). Required for the ALB cert + wildcard
  workspace routing.
- Terraform (`>=` the pin in [`infra/terraform/versions.tf`](../infra/terraform/versions.tf)),
  Docker/podman (to build & push images), and the AWS CLI.
- IdP app registrations: a **GitHub OAuth app** (and/or **GitHub App**) and/or an
  **Azure Entra** app registration. Callback URL: `https://app.<domain>/api/auth/callback/<provider>`.

## Step 1 — Terraform backend + module

The module is [`infra/terraform/modules/ecs-dev-desktop`](../infra/terraform/modules/ecs-dev-desktop/README.md);
a runnable composition is in [`infra/terraform/examples/complete`](../infra/terraform/examples/complete).

1. **Bootstrap remote state** (S3 bucket + DynamoDB lock table) and configure it as
   the Terraform `backend` — do this before the first `apply` so state is never
   local. (The module README lists this as prerequisite #1.)
2. Set the module inputs: `name`, `aws_region`, `domain_name` (enables ACM +
   Route 53 + the `*.devbox` wildcard), `ssh_ca_public_key` (see Step 4), the
   optional `nat_mode` (`managed` NAT gateway or cost-optimized `fck-nat`
   instance), task sizing, and `secret_environment` (see Step 3).
3. `terraform apply`. This creates: VPC/subnets/NAT, DynamoDB single-table
   (PK/SK + GSI1 + GSI2, on-demand), ECR repos (control-plane + golden), KMS,
   IAM roles, the ECS cluster + control-plane service (autoscaled, FARGATE_SPOT
   capacity, Container Insights, ECS Exec/KMS), the ALB + ACM cert + Route 53
   records, the reconciler EventBridge schedule, and CloudWatch log groups.

> **Two-phase apply.** The control-plane image tag defaults to `:latest`, which
> does not exist until Step 2. Either push images first, or expect the first
> `apply` to create the service with a not-yet-pullable image and roll it after
> Step 2.

Module **outputs** feed the rest: `control_plane_repository_url`,
`golden_repository_url`, the cluster/subnet/role ids, the ALB DNS name, and the
CloudWatch log groups.

## Step 2 — Build & publish images

Two images go to the ECR repos the module created:

1. **The control-plane app image** (`apps/web`) → `control_plane_repository_url`.
   This is the primary push: **both** the control-plane service **and** the
   reconciler run this image (the reconciler is the same image with a command
   override — there is no separate reconciler image).
2. **The golden workspace image** ([`infra/images/workspace`](../infra/images/README.md))
   → `golden_repository_url`. This bakes OpenVSCode Server, the toolchains, and
   `sshd` + the SSH CA wiring (there is no separate "SSH proxy" image — SSH is
   served from the workspace task).

```sh
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
# build + tag + push each image to its repo URL, then roll the ECS service (or re-apply).
```

## Step 3 — Configure the control plane (env + secrets)

The module **already injects** the infra coordinates into the task definition:
`COMPUTE_PROVIDER=ecs`, `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`,
`AWS_REGION`, `DYNAMODB_TABLE`, `ECS_CLUSTER`, `ECS_SUBNETS`,
`ECS_SECURITY_GROUPS`, `ECS_EBS_ROLE_ARN`, `EDD_KMS_KEY_ARN`, `CONTROL_PLANE_URL`,
`EDD_APP_NAME`, and `ECS_LOG_GROUP_WORKSPACES`. You do **not** set these by hand.

What **you must supply** via the module's `secret_environment` (backed by Secrets
Manager) — these are not injected and the app fails loudly without them:

| Group        | Variable                                                                                         | Purpose                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Auth.js      | `AUTH_SECRET`                                                                                    | session/JWT signing                                       |
| Auth.js      | `AUTH_URL` or `AUTH_TRUST_HOST=true`                                                             | correct callback/redirect behind the ALB                  |
| IdP (GitHub) | `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`                                                           | GitHub OAuth/App                                          |
| IdP (Entra)  | `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | Azure Entra OIDC                                          |
| RBAC         | `EDD_ADMIN_GROUPS`, `EDD_MEMBER_GROUPS`                                                          | IdP group → role mapping (**see admin bootstrap below**)  |
| Crypto       | `EDD_TOKEN_ENC_KEY`                                                                              | 32-byte hex AES key — gates git-credential storage        |
| Crypto       | `EDD_GATEWAY_SECRET`                                                                             | gateway↔control-plane machine-auth HMAC (connect/wake)    |
| Crypto       | `EDD_AGENT_SECRET`                                                                               | idle-agent heartbeat HMAC                                 |
| SSH          | `EDD_SSH_CA_KEY_PATH`                                                                            | path to the CA **private** key for cert issuance (Step 4) |
| Proxy        | `EDD_WORKSPACE_BASE_DOMAIN`, `EDD_POMERIUM_JWKS_URL`                                             | workspace routing + proxy JWT verification                |

> **Admin bootstrap (important).** RBAC is purely IdP-group-driven: the default
> role is `viewer`, and an account is an admin **only** if its IdP groups intersect
> `EDD_ADMIN_GROUPS`. If you leave `EDD_ADMIN_GROUPS` unset, **no one can administer
> the platform.** Set it to your admin IdP group before first sign-in.

## Step 4 — SSH CA

Workspace SSH uses short-lived OpenSSH **certificates** signed by your CA.

1. Generate the CA keypair (`scripts/gen-ssh-ca.sh` produces `ca` + `ca.pub`).
2. Pass the **public** key to Terraform as `ssh_ca_public_key` — the module injects
   it into workspace tasks so `sshd` trusts certs signed by your CA.
3. Store the **private** key as a secret and point the control plane at it via
   `EDD_SSH_CA_KEY_PATH` (it is read at cert-issuance time). Without this, the SSH
   cert route throws — keep the private key out of the image and mount/inject it.

## Step 5 — DNS/TLS + identity-aware proxy

- The module provisions the ACM cert + Route 53 records for `app.<domain>` and the
  `*.devbox.<domain>` wildcard when `domain_name` is set.
- Deploy **Pomerium** ([`infra/proxy`](../infra/proxy/README.md)) and the
  **workspace gate** (PEP, `services/workspace-gate`) in front of workspaces:
  browser → Pomerium (OIDC) → gate (per-workspace authz via the control-plane PDP
  `/api/internal/authz`) → the workspace. The gate consumes `EDD_CONTROL_PLANE_URL`,
  `EDD_GATEWAY_SECRET`, `EDD_POMERIUM_JWKS_URL`, and `EDD_WORKSPACE_BASE_DOMAIN`.
  This whole chain is proven live in CI (`e2e-gate`).

## Step 6 — Seed the base-image catalog

Workspaces launch from a `BaseImage` resolved from the **catalog** stored in
DynamoDB. Production starts empty — until you add an entry pointing at your golden
ECR image, users cannot create workspaces. Add base images via the admin catalog
API/UI (the local `scripts/dev.sh` seeds one for dev; production has no auto-seed).

## Observability

- **Health:** the ALB target group health-checks `/api/readyz` (DynamoDB-backed
  readiness — a task that can't reach its data store leaves the LB) while the ECS
  container healthcheck uses `/api/healthz` (liveness). The admin Health board
  (`/admin/health`) shows live compute/storage/DynamoDB status.
- **Logs:** the control plane and reconciler emit structured JSON lines to
  CloudWatch (`LOG_PROVIDER=cloudwatch`, injected by the module).
- **Metrics + alarms:** wake-on-connect latency and reconciler action/failure
  counts are emitted as CloudWatch EMF. The module creates alarms
  (reconciler-failed, wake-latency-p99); set `alarm_sns_topic_arns` to be notified,
  `wake_latency_alarm_ms` to tune the SLO, or `enable_metric_alarms = false` to skip.

## What is still un-exercised against real AWS

The `e2e-aws` tier (real account/region/IdP) has not run — it is gated on the AWS
account decision. So real EBS durability/latency, Fargate cold-start, 200+ load,
IAM enforcement, ACM/DNS issuance, KMS/DR, and live GitHub/Entra federation are
**unverified end-to-end**. See [`TESTING.md`](../TESTING.md) (real-AWS tier) and
[`docs/observability-gaps.md`](./observability-gaps.md) for the full gap list.

## See also

- [`infra/terraform/README.md`](../infra/terraform/README.md) ·
  [module README](../infra/terraform/modules/ecs-dev-desktop/README.md)
- [`docs/running-locally.md`](./running-locally.md) — the same code, by local coordinates
- [`docs/observability-gaps.md`](./observability-gaps.md) — logs/health/metrics/testing gaps
