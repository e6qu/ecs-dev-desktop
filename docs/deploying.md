<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Deploying to AWS

A practical runbook for standing up a real environment. The platform reaches AWS
and the IdPs through **coordinates** only (endpoints + credentials + resource
ids), so the same code the local tiers and CI exercise targets real cloud by
configuration alone — no real-vs-sim branches (`AGENTS.md` §6.8/§6.9). For the
conceptual picture (block diagram, component roles, connection sequences), see
[`architecture.md`](./architecture.md).

> **Status:** the Terraform module is built and **simulator-apply-proven every PR**
> (`terraform-sim` CI). A real `apply` is gated on an AWS account + a domain (see
> [`DO_NEXT.md`](../DO_NEXT.md) open decisions). The steps below are the intended
> production flow; items still un-exercised against real AWS are flagged.

## Prerequisites

- An AWS account + region, and credentials with permission to create the module's
  resources (VPC, ECS, DynamoDB, ECR, KMS, IAM, ALB, Route 53/ACM).
- A registered domain you can delegate: `app.<domain>` for the control plane
  (which also serves the editor at `app.<domain>/w/<workspace-id>/`) and
  `*.<ssh-base-domain>` for per-workspace SSH. Required for the ALB cert. **No
  wildcard DNS or wildcard TLS is needed for the browser/editor path** — it is
  path-based on the single control-plane domain.
- Terraform (`>=` the pin in [`infra/terraform/versions.tf`](../infra/terraform/versions.tf)),
  Docker/podman (to build & push images), and the AWS CLI.
- IdP app registrations: a **GitHub OAuth app** (and/or **GitHub App**) and/or an
  **Azure Entra** app registration. Callback URL: `https://app.<domain>/api/auth/callback/<provider>`.

## Step 1 — Terraform backend + module

The module is [`infra/terraform/modules/ecs-dev-desktop`](../infra/terraform/modules/ecs-dev-desktop/README.md);
runnable compositions are in [`infra/terraform/examples/complete`](../infra/terraform/examples/complete)
(Terraform) and [`infra/terraform/examples/terragrunt`](../infra/terraform/examples/terragrunt/terragrunt.hcl)
(Terragrunt).

1. **Bootstrap remote state** (once per environment) with
   [`scripts/bootstrap-state.sh`](../scripts/bootstrap-state.sh):
   ```sh
   scripts/bootstrap-state.sh edd-tfstate-dev us-east-1
   # creates a versioned+encrypted S3 bucket + a DynamoDB lock table, idempotently
   ```
   Configure it as the Terraform `backend` (or let Terragrunt own it via
   `remote_state`) **before** the first `apply` so state is never local.
2. Set the module inputs: `name`, `domain_name` + `route53_zone_id` (enables ACM +
   Route 53 for `app.<domain>`), and (optionally) `ssh_base_domain` +
   `route53_ssh_zone_id` for per-workspace SSH. Choose `nat_mode` (`gateway` —
   AWS-managed NAT Gateway, recommended for prod; or `instance` — a cost-optimized
   fck-nat EC2 instance). The AWS region comes from the configured AWS provider
   (the module derives it via `data "aws_region"`), not a module input.
3. `terraform apply` (or `terragrunt apply`). This creates: VPC/subnets/NAT,
   DynamoDB single-table (PK/SK + GSI1 + GSI2, on-demand), ECR repos (control-plane
   - golden + ssh-gateway), KMS, IAM roles, the ECS cluster + control-plane service
     (autoscaled, on-demand FARGATE — the cluster also registers a FARGATE_SPOT
     capacity provider — Container Insights, ECS Exec/KMS), the ALB + ACM cert +
     Route 53 records, the reconciler EventBridge schedule, CloudWatch log groups +
     alarms + dashboard, and — when `ssh_base_domain` is set — the SSH ingress (NLB
   - TCP:22 + the SSH-gateway service + the `*.<ssh-base-domain>` wildcard).

   The module can also build and push the container images during apply via
   `image_build_mode`: `local` (runs `scripts/publish-images.sh` on the operator
   machine), `codebuild` (creates an AWS CodeBuild project and starts a build), or
   `pre-published` (images already exist in ECR; Terraform resolves the digest).
   See the module README for the exact variables.

> **Two-phase apply.** With `image_build_mode = "pre-published"`, the image tag
> defaults to `:main`, which does not exist until Step 2. Either push images first,
> or expect the first `apply` to create the service with a not-yet-pullable image
> and roll it after Step 2. `local` and `codebuild` modes avoid this because images
> are produced during apply.

Module **outputs** feed the rest: `control_plane_repository_url`,
`golden_repository_urls`, `ssh_gateway_repository_url`, the cluster/subnet/role
ids, the ALB DNS name, the SSH NLB DNS name, and the CloudWatch log groups.

## Step 2 — Build & publish images

[`scripts/publish-images.sh`](../scripts/publish-images.sh) builds and pushes all
three image kinds to the ECR repos Step 1 created (it also logs into ECR and
builds the golden base via `infra/images/base/build.sh`):

```sh
scripts/publish-images.sh <account-id> <region> <name> <tag> [variant...]
# e.g. scripts/publish-images.sh 111122223333 us-east-1 edd-dev v1.0.0 omnibus typescript
```

It publishes a **multi-arch manifest** for each image (`:<tag>`) plus per-arch
images with an architecture suffix (`:<tag>-amd64` and `:<tag>-arm64`):

```
<name>/control-plane:<tag>         manifest
<name>/control-plane:<tag>-amd64   amd64 image
<name>/control-plane:<tag>-arm64   arm64 image
```

ECS Fargate pulls the manifest and selects the correct architecture automatically.
Runners that cannot consume manifests (e.g. AWS Lambda) can pin the suffixed tag
directly. The architecture list defaults to `amd64 arm64`; limit it with
`EDD_BUILD_ARCHS=amd64` if your build host cannot emulate the other architecture.

It publishes:

1. **The control-plane app image** (`apps/web`) → `control_plane_repository_url`.
   This is the primary push: **both** the control-plane service **and** the
   reconciler run this image (the reconciler is the same image with a command
   override — the control-plane Dockerfile builds both bundles, so there is no
   separate reconciler image).
2. **The SSH-gateway image** (`services/ssh-gateway`) →
   `ssh_gateway_repository_url`. **Push a pinned tag each time** — that ECR repo is
   `IMMUTABLE` (a re-pushed tag can't silently swap the SSH front door), and pass
   the tag as `ssh_gateway_image`.
3. **A golden workspace image** (the [`infra/images`](../infra/images/README.md)
   collection — a shared `base` plus the `omnibus`/per-language variants) → the
   matching entry in `golden_repository_urls`. These bake OpenVSCode Server
   (served under `--server-base-path /w/<id>/` so the editor mounts under the
   control-plane path proxy), the toolchains, and `sshd` + its registered-key
   authorizer.

For CI-driven publishes, the [`release`](../.github/workflows/release.yml) workflow
builds + pushes on a `v*` tag (or manual dispatch) via GitHub OIDC → an AWS role
with ECR push permissions (no static keys). It sets up QEMU and Docker Buildx so
the default `amd64 arm64` multi-arch build succeeds on GitHub's x86*64 runners.
It is gated on the `RELEASE_AWS*\*` repo variables (see the workflow header) and
otherwise skips, so it is inert until the AWS account decision lands.

For the production CodeBuild-backed install path, CI should still own the
control-plane image build/publish path (the small app image). The EDD control
plane owns only post-merge **workspace/golden image** rebuilds, because those are
runtime fleet assets operators need to track and roll independently. This is not
a fallback release path: EDD must remain releasable from CI/operator release
flows even when no EDD deployment exists.

Set `EDD_IMAGE_SOURCE_REPO` (`owner/repo`, e.g. `e6qu/ecs-dev-desktop`) and
optionally `EDD_IMAGE_SOURCE_BRANCH` (default `main`) before running
`scripts/install.sh`, and create a Secrets Manager secret named
`<EDD_NAME>/EDD_IMAGE_SOURCE_WEBHOOK_SECRET`. The install fails if either is
missing. Then configure a GitHub `push` webhook to:

```text
https://app.<domain>/api/integrations/github/image-webhook
```

Store the webhook secret as the control-plane secret env var
`EDD_IMAGE_SOURCE_WEBHOOK_SECRET` (for `scripts/install.sh`, creating a Secrets
Manager secret named `<EDD_NAME>/EDD_IMAGE_SOURCE_WEBHOOK_SECRET` makes it part of
the generated `auth_secret_arns` map). The webhook is HMAC-verified via
`X-Hub-Signature-256`; there is no polling backstop. If source sync is
misconfigured, `/admin/images` surfaces the API error instead of presenting a
disabled or "not configured" state.

When a new commit changes workspace-image inputs (`infra/images/**`,
`pnpm-lock.yaml`, or the image publish/build wiring), EDD starts the existing
CodeBuild image project asynchronously with `EDD_BUILD_TARGET=golden`,
`SOURCE_REF=<branch>`, `SOURCE_VERSION=<exact sha>`, and a short-SHA image tag.
It does not replace CI for control-plane image builds.

After publishing, roll the running services:

```sh
aws ecs update-service --cluster <name>-workspaces \
  --service <name>-control-plane --force-new-deployment
```

## Step 3 — Configure the control plane (env + secrets)

The module **already injects** the infra coordinates into the task definition:
`COMPUTE_PROVIDER=ecs`, `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`,
`AWS_REGION`, `DYNAMODB_TABLE`, `ECS_CLUSTER`, `ECS_SUBNETS`,
`ECS_SECURITY_GROUPS`, `ECS_EBS_ROLE_ARN`, `EDD_KMS_KEY_ARN`, `CONTROL_PLANE_URL`,
`EDD_APP_NAME`, and `ECS_LOG_GROUP_WORKSPACES`. You do **not** set these by hand.

What **you must supply** (the module injects none of these; the app fails loudly
without the required ones). [`scripts/bootstrap-secrets.sh`](../scripts/bootstrap-secrets.sh)
creates them all in Secrets Manager — it generates the crypto secrets for you and
prompts for the IdP creds, then prints the ARNs to paste into `secret_environment`.
Two channels: **`secret_environment`** — a map of name → Secrets Manager / SSM ARN,
for secrets — and **`extra_environment`** — plain name → value, for non-secret
config.

Secrets (`secret_environment`):

| Group        | Variable                                                       | Purpose                                                                |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Auth.js      | `AUTH_SECRET`                                                  | session/JWT signing                                                    |
| IdP (GitHub) | `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`                         | GitHub OAuth/App                                                       |
| IdP (Entra)  | `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Azure Entra OIDC client                                                |
| Crypto       | `EDD_TOKEN_ENC_KEY`                                            | 32-byte hex AES key — gates git-credential storage                     |
| Crypto       | `EDD_GATEWAY_SECRET`                                           | gateway↔control-plane machine-auth HMAC (connect/wake + ssh-authorize) |
| Crypto       | `EDD_AGENT_SECRET`                                             | idle-agent heartbeat + workspace ssh-authorize HMAC                    |
| Crypto       | `EDD_CONNECTION_SECRET`                                        | per-workspace OpenVSCode connection token HMAC (editor-proxy handoff)  |

Non-secret config (`extra_environment`):

| Group       | Variable                                | Purpose                                            |
| ----------- | --------------------------------------- | -------------------------------------------------- |
| Auth.js     | `AUTH_URL` or `AUTH_TRUST_HOST=true`    | correct callback/redirect behind the ALB           |
| IdP (Entra) | `AUTH_MICROSOFT_ENTRA_ID_ISSUER`        | Entra OIDC issuer URL                              |
| RBAC        | `EDD_ADMIN_GROUPS`, `EDD_MEMBER_GROUPS` | IdP group → role mapping (**see admin bootstrap**) |

> **Admin bootstrap (important).** RBAC is purely IdP-group-driven: the default
> role is `viewer`, and an account is an admin **only** if its IdP groups intersect
> `EDD_ADMIN_GROUPS`. If you leave `EDD_ADMIN_GROUPS` unset, **no one can administer
> the platform.** Set it to your admin IdP group before first sign-in.

## Step 4 — SSH access (registered keys)

Workspace SSH is **registered-key only** — no CA, no certificates, no deploy-time
SSH key material. Each user registers their own public key in the portal
(`/settings` → SSH keys, `POST /api/ssh-keys`), and access is **dual-trust**: both
the SSH gateway's `sshd` and the workspace's `sshd` run an `AuthorizedKeysCommand`
that calls the control plane's `POST /api/workspaces/:id/ssh-authorize`, which
authorizes the presented key iff it is registered to that workspace's owner.

There is nothing to provision here beyond the HMAC secrets already set in Step 3:
the gateway authenticates to `ssh-authorize` with `EDD_GATEWAY_SECRET`, and the
in-workspace authorizer with its injected agent token (derived from
`EDD_AGENT_SECRET`). Users self-serve key registration after first sign-in. The
full dual-trust handshake is diagrammed in
[`architecture.md`](./architecture.md#ssh-registered-key-dual-trust).

## Step 5 — DNS/TLS + editor routing

- The module provisions the ACM cert + Route 53 records for `app.<domain>` when
  `domain_name` is set. **No wildcard cert or wildcard DNS is required** for the
  browser/editor path — there is a single control-plane domain.
- The browser→editor proxy is **folded into the Next.js control-plane app** (a
  custom server, `apps/web/server.ts` + `apps/web/lib/workspace-proxy.ts`): the
  editor is reached at **`app.<domain>/w/<workspace-id>/`**, path-based on the one
  domain. Routing is:
  browser → control-plane app (`/w/<id>/` proxy) → the workspace.
- **Authorization is the same Auth.js session that protects the portal** — the
  proxy authorizes in-process by **uid-based ownership** (`session.uid ===
workspace.ownerId`) or admin. There is no separate proxy, no Pomerium, no PDP
  round-trip, and no email bridge.
- **Defence-in-depth connection token.** On top of the session check, each
  workspace task runs OpenVSCode behind a **per-workspace connection token** =
  `HMAC(EDD_CONNECTION_SECRET, workspace-id)`, injected via Secrets Manager
  (`edd/workspace/<id>/connection`). The proxy hands the already-session-authorized
  browser this token on the first document navigation (a 302 to `…?tkn=<token>`); the
  user never sees or supplies it.
- **Network isolation.** Workspace tasks run in a **dedicated `workspaces` security
  group** whose editor port (`workspace_port`, default 3000) and sshd (22) are
  reachable **only from the control-plane security group** — never
  workspace-to-workspace. The module exposes `workspaces_security_group_id`; the
  control plane points workspace tasks at it via `ECS_SECURITY_GROUPS`.
- The app runs as **one process** in dev/prod (`apps/web` is started via the
  custom server, not `next start`); no extra service to deploy in front of
  workspaces.

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
  counts are emitted as CloudWatch EMF. The module creates alarms — `reconciler-failed`,
  **`reconciler-not-running`** (no sweep ran in the window → the self-healing engine is
  down), **`reconciler-gc-failed`** / **`reconciler-reap-failed`** (a stuck cost-leaking
  orphan), `wake-latency-p99`, **`dynamodb-throttle`**, **`reconciler-dlq`** (a dropped
  sweep invocation), and (on AWS-managed ALB metrics, so they fire even if the app can't
  emit) `control-plane-unhealthy` and `control-plane-5xx` — plus a `…-ops` **CloudWatch
  dashboard** and an optional `monthly_budget_usd` cost guardrail. Set `alarm_sns_topic_arns`
  to be notified; `wake_latency_alarm_ms` / `control_plane_5xx_threshold` /
  `dynamodb_throttle_threshold` / `reconciler_liveness_period` / `monthly_budget_usd` to
  tune; or `enable_metric_alarms = false` to skip. Incident response: see the
  [operations runbook](./runbook.md).

## What is still un-exercised against real AWS

The `e2e-aws` tier (real account/region/IdP) has not run — it is gated on the AWS
account decision. So real EBS durability/latency, Fargate cold-start, 200+ load,
IAM enforcement, ACM/DNS issuance (only `app.<domain>`, no wildcard), KMS/DR, and
live GitHub/Entra federation are **unverified end-to-end**. See
[`TESTING.md`](../TESTING.md) (real-AWS tier) and
[`docs/observability-gaps.md`](./observability-gaps.md) for the full gap list.

## See also

- [`architecture.md`](./architecture.md) — block diagram, deploy sequence, connection sequences
- [`infra/terraform/README.md`](../infra/terraform/README.md) ·
  [module README](../infra/terraform/modules/ecs-dev-desktop/README.md)
- [`running-locally.md`](./running-locally.md) — the same code, by local coordinates
- [`observability-gaps.md`](./observability-gaps.md) — logs/health/metrics/testing gaps
