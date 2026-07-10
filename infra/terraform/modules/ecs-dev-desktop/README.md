<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# `ecs-dev-desktop` Terraform module

Provisions the AWS infrastructure for the **ecs-dev-desktop** platform — per-user
VS Code workspaces on ECS Fargate, with a Next.js control plane, a single-table
DynamoDB store, ECR golden images, managed-EBS persistence, scale-to-zero, and an
ALB front door. Parametric and provider-agnostic (no `provider` block), so it
composes from plain Terraform **or Terragrunt**, one instantiation per
environment.

## Architecture

```
                          Route53  app.<domain>  (path-based proxy, no wildcard)
                              │  (ACM-validated TLS)
                              ▼
   Internet ──▶ ALB (public subnets) ──▶ ECS service: control-plane (Next.js)
                                              │  private subnets, NAT egress
            ┌─────────────────────────────────┼───────────────────────────┐
            ▼                ▼                 ▼              ▼             ▼
       DynamoDB         ECS workspace      EBS (managed)   ECR repos   CloudWatch
   (single table,     tasks (run at        via the ECS    (control     Logs
    GSI1/GSI2, KMS)    runtime by the       infra role)    plane +
                       control plane)                      golden)
            ▲
   EventBridge Scheduler ──▶ ECS reconciler task (idle stop, snapshots, GC)
```

What this module **does** create: VPC + subnets + NAT + security groups,
DynamoDB single-table (matching `@edd/db`), KMS key, ECR repos, IAM roles
(execution, control-plane, reconciler, the ECS managed-EBS infrastructure role,
the scheduler role), the ECS cluster + control-plane service + autoscaling, the
ALB + listeners + (optional) ACM/Route53, the reconciler schedule, CloudWatch
log groups, a WAF web ACL associated to the control-plane ALB that narrows the
public GitHub image-webhook path, and — when `ssh_base_domain` is set — the **SSH
ingress** (a network LB with a raw TCP:22 listener, a target group, the
SSH-gateway ECS service, and a `*.<ssh_base_domain>` wildcard) so a workspace is
reachable as `ssh <principal>@<ws-id>.<ssh_base_domain>` (registered-key
dual-trust auth).

What it does **not** do (app/runtime layer, by design): create the auth secrets
(you pass their ARNs). The browser→VS Code workspace proxy is served by the
control-plane app itself (`app.<domain>/w/<id>/`, path-based), not a separate
service. Images can be built during apply (`image_build_mode = "local"` or
`"codebuild"`) or published out of band (`"pre-published"`); see
[`scripts/publish-images.sh`](../../../../scripts/publish-images.sh) and
[`docs/deploying.md`](../../../../docs/deploying.md). An end-to-end SSH connection
_through_ the NLB is now sim-capable (the NLB raw-TCP data plane is upstream-fixed),
but a live byte-stream loop is exercised at deploy/`e2e-aws`; the sim proves the
ingress resources are created correctly and idempotently. See
[`docs/architecture.md`](../../../../docs/architecture.md).

## Private networking & NAT

All ECS tasks (control plane, per-user workspaces, reconciler) run in **private
subnets with no public IPs**; only the ALB is internet-facing. Egress is via NAT,
selectable with `nat_mode`:

- **`gateway`** (default) — AWS-managed NAT Gateway(s); recommended for prod.
  `single_nat_gateway` toggles one shared gateway vs one per AZ (HA).
- **`instance`** — a cost-optimized **[fck-nat](https://fck-nat.dev)** EC2 NAT
  instance (via the reputable `RaJiska/fck-nat` module), ~10× cheaper for dev /
  cost-sensitive fleets; `nat_instance_ha` enables its ASG + floating-ENI HA, and
  `nat_instance_use_spot` runs it on spot. Running NAT as an ECS service is not
  viable (Fargate can't disable source/dest check and task ENIs are ephemeral), so
  a dedicated NAT instance is the right "unmanaged NAT" — the tasks stay
  private-only either way.

## Usage (Terraform)

```hcl
module "ecs_dev_desktop" {
  source = "github.com/e6qu/ecs-dev-desktop//infra/terraform/modules/ecs-dev-desktop?ref=v1.0.0"

  name               = "edd-dev"
  availability_zones = ["us-east-1a", "us-east-1b"]
  golden_image_repos = ["omnibus", "typescript"]

  # Optional TLS + workspace routing:
  domain_name     = "dev.example.com"
  route53_zone_id = "Z0123456789ABCDEFGHIJ"

  # Auth secrets (created out of band) injected as env vars:
  secret_environment = {
    AUTH_SECRET        = "arn:aws:secretsmanager:us-east-1:111122223333:secret:edd/auth-secret-AbCdEf"
    AUTH_GITHUB_SECRET = "arn:aws:secretsmanager:us-east-1:111122223333:secret:edd/github-secret-AbCdEf"
  }
}
```

A runnable version is in [`../../examples/complete`](../../examples/complete).

## Usage (Terragrunt)

Terragrunt owns the remote state backend and the AWS provider, then drives the
module by inputs. See [`../../examples/terragrunt/terragrunt.hcl`](../../examples/terragrunt/terragrunt.hcl):

```hcl
terraform {
  source = "git::https://github.com/e6qu/ecs-dev-desktop.git//infra/terraform/modules/ecs-dev-desktop?ref=v1.0.0"
}
inputs = {
  name               = "edd-dev"
  availability_zones = ["us-east-1a", "us-east-1b"]
  golden_image_repos = ["omnibus", "typescript"]
}
```

## Prerequisites

1. **Remote state backend** — an S3 bucket + DynamoDB lock table for Terraform
   state. Bootstrap once with [`scripts/bootstrap-state.sh`](../../../../scripts/bootstrap-state.sh);
   Terragrunt can then manage it.
2. **Auth + runtime secrets in Secrets Manager** — `AUTH_SECRET`, the GitHub/Entra
   OAuth client id+secret, crypto HMAC/AES keys, and image-source webhook secret.
   Bootstrap with
   [`scripts/bootstrap-secrets.sh`](../../../../scripts/bootstrap-secrets.sh) (generates
   the crypto/webhook secrets; prompts for IdP creds); pass the printed ARNs via
   `secret_environment`.
3. **Domain + Route53 zone** (only if using TLS / the editor/SSH front doors) —
   `app.<domain>` for the editor proxy, and (optionally) a separate
   `*.<ssh-base-domain>` zone for per-workspace SSH.
4. **Images in ECR** — choose how they are produced:
   - `image_build_mode = "local"` (default in the runnable examples) — Terraform
     runs `scripts/publish-images.sh` during apply; your machine needs Docker +
     the source checkout.
   - `image_build_mode = "codebuild"` — Terraform creates an AWS CodeBuild
     project and starts a build during apply; set `codebuild_source_repo`.
   - `image_build_mode = "pre-published"` (module default) — images already exist
     in ECR (e.g. from the `release` workflow); Terraform resolves the digest of
     `:<image_tag>` for auto-roll.

   Images are published as multi-arch manifests (`:<tag>`) plus per-arch tags
   (`:<tag>-amd64` and `:<tag>-arm64`). See
   [`scripts/publish-images.sh`](../../../../scripts/publish-images.sh) and
   [`docs/deploying.md`](../../../../docs/deploying.md).

## Deploy flow

```
scripts/bootstrap-state.sh <bucket> <region>           # once: S3 + DynamoDB lock
scripts/bootstrap-secrets.sh <name> <region>           # once: crypto + IdP secrets
terraform apply                                        # stand up the infra
# With image_build_mode = "local" or "codebuild", images are built during apply.
# With "pre-published", run separately:
scripts/publish-images.sh <acct> <region> <name> <tag> # push manifests + per-arch images
aws ecs update-service --force-new-deployment …        # roll the control-plane service
```

The control-plane and reconciler **share one image** (the reconciler runs it with a
command override), so the control-plane Dockerfile builds both bundles. See
[`docs/deploying.md`](../../../../docs/deploying.md) for the full runbook and
[`docs/architecture.md`](../../../../docs/architecture.md) for the deploy sequence.

## Testing against the simulator

The module `terraform apply`s identically against real AWS and the **sockerless**
AWS simulator — point the provider's per-service `endpoints` at the sim (see
[`tests/sim`](tests/sim)). The CI `terraform-sim` job applies, asserts,
idempotency-checks, and destroys the module against the live sim for the default,
fck-nat, and DNS/TLS configurations. We do **not** branch the module around the
sim (AGENTS.md §6.8).

## Inputs

| Name                                                  | Type         | Default                 | Description                                                                         |
| ----------------------------------------------------- | ------------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `name`                                                | string       | —                       | Resource name prefix (lowercase, hyphenated).                                       |
| `availability_zones`                                  | list(string) | —                       | AZs (≥2) to spread subnets across.                                                  |
| `tags`                                                | map(string)  | `{}`                    | Extra tags on every resource.                                                       |
| `cost_scope`                                          | string       | `"edd-alpha"`           | Value for `edd:cost-scope`; activate that tag key in AWS Billing for cost reports.  |
| `vpc_cidr`                                            | string       | `10.42.0.0/16`          | VPC CIDR.                                                                           |
| `nat_mode`                                            | string       | `gateway`               | Private egress: `gateway` (managed) or `instance` (fck-nat).                        |
| `single_nat_gateway`                                  | bool         | `true`                  | (gateway) One shared NAT vs one per AZ.                                             |
| `nat_instance_type`                                   | string       | `t4g.nano`              | (instance) fck-nat EC2 type.                                                        |
| `nat_instance_ha`                                     | bool         | `false`                 | (instance) fck-nat HA (ASG + floating ENI).                                         |
| `nat_instance_use_spot`                               | bool         | `false`                 | (instance) Use a spot instance.                                                     |
| `dynamodb_table_name`                                 | string       | `ecs-dev-desktop`       | Single-table name (match `@edd/config`).                                            |
| `dynamodb_point_in_time_recovery`                     | bool         | `true`                  | Enable PITR.                                                                        |
| `deletion_protection`                                 | bool         | `true`                  | Protect DynamoDB + ALB from destroy.                                                |
| `control_plane_image`                                 | string       | `""`                    | App image ref; defaults to this stack's ECR at `:<image_tag>`.                      |
| `control_plane_cpu` / `control_plane_memory`          | number       | `512` / `1024`          | Fargate sizing.                                                                     |
| `control_plane_desired_count`                         | number       | `2`                     | Task count (before autoscaling).                                                    |
| `control_plane_port`                                  | number       | `3000`                  | App listen port.                                                                    |
| `workspace_port`                                      | number       | `3000`                  | Per-user editor port (reachable from the control plane only).                       |
| `control_plane_min_count` / `control_plane_max_count` | number       | `2` / `10`              | Autoscaling bounds.                                                                 |
| `extra_environment`                                   | map(string)  | `{}`                    | Extra plain env vars.                                                               |
| `secret_environment`                                  | map(string)  | `{}`                    | Env var → Secrets Manager ARN.                                                      |
| `domain_name`                                         | string       | `""`                    | Base domain (empty = HTTP-only dev).                                                |
| `route53_zone_id`                                     | string       | `""`                    | Zone id (required with `domain_name`).                                              |
| `ssh_base_domain`                                     | string       | `""`                    | Base domain for per-workspace SSH (empty = no SSH ingress).                         |
| `route53_ssh_zone_id`                                 | string       | `""`                    | SSH zone id (required with `ssh_base_domain`).                                      |
| `ssh_gateway_image`                                   | string       | `""`                    | Pinned SSH-gateway image; defaults to ECR `:<image_tag>` in build modes.            |
| `ssh_gateway_cpu` / `ssh_gateway_memory`              | number       | `256` / `512`           | SSH-gateway Fargate sizing.                                                         |
| `ssh_gateway_desired_count`                           | number       | `1`                     | SSH-gateway task count.                                                             |
| `image_build_mode`                                    | string       | `"pre-published"`       | How images are produced: `local`, `codebuild`, or `pre-published`.                  |
| `image_tag`                                           | string       | `"main"`                | Tag used for ECR images and manifest resolution.                                    |
| `local_build_context_path`                            | string       | `"../../../../"`        | Path from module to repo root for local build mode.                                 |
| `codebuild_source_repo`                               | string       | `""`                    | Git URL for CodeBuild mode.                                                         |
| `codebuild_source_ref`                                | string       | `"main"`                | Git ref for CodeBuild mode.                                                         |
| `codebuild_compute_type`                              | string       | `BUILD_GENERAL1_MEDIUM` | CodeBuild compute type.                                                             |
| `seed_default_catalog`                                | bool         | `true`                  | Create a default catalog entry during apply.                                        |
| `seed_catalog_variant`                                | string       | `"omnibus"`             | Golden variant to seed as the default catalog entry.                                |
| `seed_catalog_name`                                   | string       | `"Omnibus"`             | Display name for the seeded catalog entry.                                          |
| `seed_catalog_description`                            | string       | `...`                   | Description for the seeded catalog entry.                                           |
| `seed_catalog_tags`                                   | list(string) | `["omnibus"]`           | Tags for the seeded catalog entry.                                                  |
| `seed_catalog_tools`                                  | list(string) | `[...]`                 | Tooling highlights for the seeded catalog entry.                                    |
| `golden_image_repos`                                  | list(string) | `[]`                    | Golden base-image ECR repos to create.                                              |
| `image_retention_count`                               | number       | `20`                    | Images kept per ECR repo.                                                           |
| `reconciler_schedule`                                 | string       | `rate(5 minutes)`       | Reconciler cadence.                                                                 |
| `reconciler_command`                                  | list(string) | `["node", …]`           | Reconciler container command.                                                       |
| `log_retention_days`                                  | number       | `30`                    | CloudWatch Logs retention.                                                          |
| `enable_metric_alarms`                                | bool         | `true`                  | Create CloudWatch alarms on the EMF metrics.                                        |
| `enable_cloudwatch_dashboard`                         | bool         | `true`                  | Create the `<name>-ops` CloudWatch dashboard.                                       |
| `alarm_sns_topic_arns`                                | list(string) | `[]`                    | SNS topics notified on alarm/OK (empty = alarms still evaluate, just don't notify). |
| `wake_latency_alarm_ms`                               | number       | `120000`                | Threshold (ms) for the wake-on-connect p99 latency alarm.                           |
| `control_plane_5xx_threshold`                         | number       | `10`                    | Target 5xx/period for the control-plane-erroring alarm.                             |
| `reconciler_liveness_period`                          | number       | `900`                   | Window (s) with no sweep before the not-running alarm fires.                        |
| `privilege_attempt_alarm_threshold`                   | number       | `5`                     | Blocked privileged-tool attempts/period for the security alarm.                     |
| `stuck_error_alarm_threshold`                         | number       | `0`                     | Workspaces in `error`/15-min for the stuck-error alarm.                             |
| `dynamodb_throttle_threshold`                         | number       | `0`                     | Throttle events/period for the DynamoDB-throttling alarm.                           |
| `monthly_budget_usd`                                  | number       | `0`                     | Monthly cost-budget guardrail (0 disables; notifies at 80%/100%).                   |

## Outputs

| Name                                                                                                                                           | Description                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `vpc_id`, `private_subnet_ids`, `public_subnet_ids`                                                                                            | Networking.                                 |
| `alb_security_group_id`, `tasks_security_group_id`, `workspaces_security_group_id`                                                             | Security groups (ALB / tasks / workspaces). |
| `nat_mode`, `nat_instance_eni_id`                                                                                                              | NAT egress mode + fck-nat ENI.              |
| `dynamodb_table_name`, `dynamodb_table_arn`                                                                                                    | Single-table store.                         |
| `kms_key_arn`                                                                                                                                  | Platform KMS key.                           |
| `ecs_cluster_name`, `ecs_cluster_arn`                                                                                                          | ECS cluster.                                |
| `control_plane_repository_url`, `golden_repository_urls`, `ssh_gateway_repository_url`                                                         | ECR push targets.                           |
| `alb_dns_name`, `control_plane_url`                                                                                                            | Front door.                                 |
| `ssh_nlb_dns_name`                                                                                                                             | SSH NLB DNS (null when SSH ingress is off). |
| `control_plane_task_role_arn`, `reconciler_task_role_arn`, `workspace_task_role_arn`, `ecs_infrastructure_role_arn`, `task_execution_role_arn` | IAM.                                        |
| `log_group_names`                                                                                                                              | CloudWatch log groups.                      |
