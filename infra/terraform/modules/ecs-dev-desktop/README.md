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
                          Route53  *.devbox.<domain>, app.<domain>
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
ALB + listeners + (optional) ACM/Route53, the reconciler schedule, and CloudWatch
log groups.

What it does **not** do (app/runtime layer, by design): build/push the
control-plane image or golden images; create the auth secrets (you pass their
ARNs); deploy the SSH gateway or Pomerium (identity-aware `*.devbox` routing) —
those run behind this ALB and are configured at the app layer.

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
  golden_image_repos = ["node-20", "go-1.22"]

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
  golden_image_repos = ["node-20", "go-1.22"]
}
```

## Prerequisites

1. **Remote state backend** — an S3 bucket + DynamoDB lock table for Terraform
   state (bootstrap once; Terragrunt can manage it).
2. **Auth secrets in Secrets Manager** — `AUTH_SECRET` and the GitHub/Entra OAuth
   client id+secret. Pass their ARNs via `secret_environment`; the module grants
   the control-plane task read access and injects them.
3. **Domain + Route53 zone** (only if using TLS / workspace routing).
4. **Control-plane image in ECR** — after `apply`, push the app image to the
   created repo (`control_plane_repository_url` output), then redeploy the service.

## Deploy flow

```
terraform apply                         # stand up the infra
docker push <control_plane_repository_url>:<tag>
# set control_plane_image (or push :latest) and re-apply to roll the service
```

## Testing against the simulator

The module `terraform apply`s identically against real AWS and the **sockerless**
AWS simulator — point the provider's per-service `endpoints` at the sim (see
[`tests/sim`](tests/sim)). The CI `terraform-sim` job applies, asserts,
idempotency-checks, and destroys the module against the live sim for the default,
fck-nat, and DNS/TLS configurations. We do **not** branch the module around the
sim (AGENTS.md §6.8).

## Inputs

| Name                                                  | Type         | Default           | Description                                                                          |
| ----------------------------------------------------- | ------------ | ----------------- | ------------------------------------------------------------------------------------ |
| `name`                                                | string       | —                 | Resource name prefix (lowercase, hyphenated).                                        |
| `availability_zones`                                  | list(string) | —                 | AZs (≥2) to spread subnets across.                                                   |
| `tags`                                                | map(string)  | `{}`              | Extra tags on every resource.                                                        |
| `vpc_cidr`                                            | string       | `10.42.0.0/16`    | VPC CIDR.                                                                            |
| `nat_mode`                                            | string       | `gateway`         | Private egress: `gateway` (managed) or `instance` (fck-nat).                         |
| `single_nat_gateway`                                  | bool         | `true`            | (gateway) One shared NAT vs one per AZ.                                              |
| `nat_instance_type`                                   | string       | `t4g.nano`        | (instance) fck-nat EC2 type.                                                         |
| `nat_instance_ha`                                     | bool         | `false`           | (instance) fck-nat HA (ASG + floating ENI).                                          |
| `nat_instance_use_spot`                               | bool         | `false`           | (instance) Use a spot instance.                                                      |
| `dynamodb_table_name`                                 | string       | `ecs-dev-desktop` | Single-table name (match `@edd/config`).                                             |
| `dynamodb_point_in_time_recovery`                     | bool         | `true`            | Enable PITR.                                                                         |
| `deletion_protection`                                 | bool         | `true`            | Protect DynamoDB + ALB from destroy.                                                 |
| `control_plane_image`                                 | string       | `""`              | App image ref; defaults to this stack's ECR `:latest`.                               |
| `control_plane_cpu` / `control_plane_memory`          | number       | `512` / `1024`    | Fargate sizing.                                                                      |
| `control_plane_desired_count`                         | number       | `2`               | Task count (before autoscaling).                                                     |
| `control_plane_port`                                  | number       | `3000`            | App listen port.                                                                     |
| `control_plane_min_count` / `control_plane_max_count` | number       | `2` / `10`        | Autoscaling bounds.                                                                  |
| `extra_environment`                                   | map(string)  | `{}`              | Extra plain env vars.                                                                |
| `secret_environment`                                  | map(string)  | `{}`              | Env var → Secrets Manager ARN.                                                       |
| `ssh_ca_public_key`                                   | string       | `""`              | OpenSSH CA public key for golden workspace SSH.                                      |
| `domain_name`                                         | string       | `""`              | Base domain (empty = HTTP-only dev).                                                 |
| `route53_zone_id`                                     | string       | `""`              | Zone id (required with `domain_name`).                                               |
| `workspaces_subdomain`                                | string       | `devbox`          | `*.<this>.<domain>` routing.                                                         |
| `golden_image_repos`                                  | list(string) | `[]`              | Golden base-image ECR repos to create.                                               |
| `image_retention_count`                               | number       | `20`              | Images kept per ECR repo.                                                            |
| `reconciler_schedule`                                 | string       | `rate(5 minutes)` | Reconciler cadence.                                                                  |
| `reconciler_command`                                  | list(string) | `["node", …]`     | Reconciler container command.                                                        |
| `log_retention_days`                                  | number       | `30`              | CloudWatch Logs retention.                                                           |
| `enable_metric_alarms`                                | bool         | `true`            | Create CloudWatch alarms on the EMF metrics (off for the sim — no metrics endpoint). |
| `alarm_sns_topic_arns`                                | list(string) | `[]`              | SNS topics notified on alarm/OK (empty = alarms still evaluate, just don't notify).  |
| `wake_latency_alarm_ms`                               | number       | `120000`          | Threshold (ms) for the wake-on-connect p99 latency alarm.                            |

## Outputs

| Name                                                                                                                | Description                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `vpc_id`, `private_subnet_ids`, `public_subnet_ids`                                                                 | Networking.                        |
| `alb_security_group_id`, `tasks_security_group_id`                                                                  | Security groups (ALB / ECS tasks). |
| `nat_mode`, `nat_instance_eni_id`                                                                                   | NAT egress mode + fck-nat ENI.     |
| `dynamodb_table_name`, `dynamodb_table_arn`                                                                         | Single-table store.                |
| `kms_key_arn`                                                                                                       | Platform KMS key.                  |
| `ecs_cluster_name`, `ecs_cluster_arn`                                                                               | ECS cluster.                       |
| `control_plane_repository_url`, `golden_repository_urls`                                                            | ECR push targets.                  |
| `alb_dns_name`, `control_plane_url`                                                                                 | Front door.                        |
| `control_plane_task_role_arn`, `reconciler_task_role_arn`, `ecs_infrastructure_role_arn`, `task_execution_role_arn` | IAM.                               |
| `log_group_names`                                                                                                   | CloudWatch log groups.             |
