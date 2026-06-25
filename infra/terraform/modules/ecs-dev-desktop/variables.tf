# SPDX-License-Identifier: AGPL-3.0-or-later
# Inputs for the ecs-dev-desktop platform module. Everything that ties the stack
# to an account, region, domain, or sizing is a variable — so the same module
# stands up dev, staging, and prod by inputs alone (Terragrunt-friendly).

variable "name" {
  description = "Name prefix for all resources (e.g. \"edd\", \"edd-prod\"). Lowercase, hyphenated."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be 2-31 chars, lowercase alphanumeric or hyphen, starting with a letter."
  }
}

variable "tags" {
  description = "Tags applied to every resource that supports tagging."
  type        = map(string)
  default     = {}
}

# ---- Networking ----

variable "vpc_cidr" {
  description = "CIDR for the platform VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "AZs to spread subnets across (2-3 recommended). Must exist in the provider region."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "Provide at least two availability zones for HA."
  }
}

variable "nat_mode" {
  description = <<-EOT
    Private-subnet egress mechanism:
      "gateway"  — AWS-managed NAT Gateway(s) (recommended for prod).
      "instance" — a fck-nat EC2 NAT instance (much cheaper; great for dev /
                   cost-sensitive). Uses the reputable RaJiska/fck-nat module.
    Either way the dev-desktop tasks stay private-only — only egress changes.
  EOT
  type        = string
  default     = "gateway"

  validation {
    condition     = contains(["gateway", "instance"], var.nat_mode)
    error_message = "nat_mode must be \"gateway\" or \"instance\"."
  }
}

variable "single_nat_gateway" {
  description = "With nat_mode=gateway: one shared NAT gateway (cheaper, non-HA) vs one per AZ."
  type        = bool
  default     = true
}

variable "nat_instance_type" {
  description = "With nat_mode=instance: EC2 type for the fck-nat NAT instance."
  type        = string
  default     = "t4g.nano"
}

variable "nat_instance_ha" {
  description = "With nat_mode=instance: run fck-nat in HA mode (ASG + floating ENI)."
  type        = bool
  default     = false
}

variable "nat_instance_use_spot" {
  description = "With nat_mode=instance: use a spot instance (cheaper; non-HA dev)."
  type        = bool
  default     = false
}

# ---- Data ----

variable "dynamodb_table_name" {
  description = "Name of the single-table store. Must match @edd/config DEFAULT_DYNAMODB_TABLE (or its env override)."
  type        = string
  default     = "ecs-dev-desktop"
}

variable "dynamodb_point_in_time_recovery" {
  description = "Enable DynamoDB point-in-time recovery (recommended for prod)."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Protect stateful resources (DynamoDB, ALB) from accidental destroy."
  type        = bool
  default     = true
}

# ---- Control-plane service (the Next.js app) ----

variable "control_plane_image" {
  description = "Full image ref for the control-plane app. Defaults to the module's ECR repo at :latest."
  type        = string
  default     = ""
}

variable "control_plane_cpu" {
  description = "Fargate CPU units for the control-plane task (256, 512, 1024, ...)."
  type        = number
  default     = 512
}

variable "control_plane_memory" {
  description = "Fargate memory (MiB) for the control-plane task."
  type        = number
  default     = 1024
}

variable "control_plane_desired_count" {
  description = "Number of control-plane tasks to run."
  type        = number
  default     = 2
}

variable "control_plane_port" {
  description = "Port the Next.js control-plane listens on."
  type        = number
  default     = 3000
}

variable "workspace_port" {
  description = "Port the per-user workspace editor (OpenVSCode) listens on. The control plane proxies to it; only the control-plane security group may reach it."
  type        = number
  default     = 3000
}

variable "control_plane_min_count" {
  description = "Autoscaling floor for the control-plane service."
  type        = number
  default     = 2
}

variable "control_plane_max_count" {
  description = "Autoscaling ceiling for the control-plane service."
  type        = number
  default     = 10
}

variable "extra_environment" {
  description = "Additional plain (non-secret) environment variables for the control-plane task."
  type        = map(string)
  default     = {}
}

variable "secret_environment" {
  description = <<-EOT
    Secret environment variables for the control-plane task, mapped to the
    Secrets Manager / SSM ARNs that hold them. The module grants the execution role
    read access to every referenced ARN. Provide the auth + crypto secrets here
    (never as plain env vars): AUTH_SECRET, AUTH_GITHUB_ID/SECRET,
    AUTH_MICROSOFT_ENTRA_ID_ID/SECRET, EDD_TOKEN_ENC_KEY, EDD_GATEWAY_SECRET,
    EDD_AGENT_SECRET, EDD_CONNECTION_SECRET (the editor connection-token secret).
    Non-secret config (RBAC groups, AUTH_TRUST_HOST, base domain, JWKS) goes in
    extra_environment.
  EOT
  type        = map(string)
  default     = {}
}

# ---- DNS / TLS (optional; gated on domain_name) ----

variable "domain_name" {
  description = <<-EOT
    Base domain for the control plane (`app.<domain>`). The editor proxy is path-based
    (`app.<domain>/w/<id>/`) — no workspace wildcard. Empty disables Route53/ACM and serves the ALB
    over HTTP only (dev). Requires `route53_zone_id` when set.
  EOT
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route53 hosted-zone id for `domain_name`. Required when `domain_name` is set."
  type        = string
  default     = ""
}

# ---- SSH ingress (Slice 3) ----
# Public SSH front door: an NLB + TCP:22 listener + a `*.<ssh_base_domain>` wildcard, so a workspace
# is reachable as `ssh <principal>@<ws-id>.<ssh_base_domain>` (registered-key dual-trust auth). Gated
# on `ssh_base_domain` (empty = no SSH ingress). Separate from the editor `domain_name` above.
variable "ssh_base_domain" {
  description = "Base domain for per-workspace SSH (`<ws-id>.<this>`). Empty disables SSH ingress."
  type        = string
  default     = ""
}

variable "route53_ssh_zone_id" {
  description = "Route53 hosted-zone id for `ssh_base_domain`. Required when `ssh_base_domain` is set."
  type        = string
  default     = ""
}

variable "ssh_gateway_image" {
  description = "SSH-gateway container image — a PINNED tag/digest (no `:latest`), e.g. `<ssh_gateway_repository_url>:<tag>`. Required when `ssh_base_domain` is set (a task-def precondition enforces it)."
  type        = string
  default     = ""
}

variable "ssh_gateway_cpu" {
  description = "SSH-gateway Fargate task CPU units."
  type        = number
  default     = 256
}

variable "ssh_gateway_memory" {
  description = "SSH-gateway Fargate task memory (MiB)."
  type        = number
  default     = 512
}

variable "ssh_gateway_desired_count" {
  description = "SSH-gateway service desired task count."
  type        = number
  default     = 1
}

# ---- Golden images / ECR ----

variable "golden_image_repos" {
  description = "ECR repository names to create for curated golden base images (e.g. [\"node-20\", \"go-1.22\"])."
  type        = list(string)
  default     = []
}

variable "image_retention_count" {
  description = "Keep this many most-recent images per ECR repo (older are expired)."
  type        = number
  default     = 20
}

# ---- Reconciler (scale-to-zero / GC cron) ----

variable "reconciler_schedule" {
  description = "EventBridge Scheduler expression for the reconciler sweep."
  type        = string
  default     = "rate(5 minutes)"
}

variable "reconciler_command" {
  description = "Container command for the reconciler task (overrides the image's default)."
  type        = list(string)
  default     = ["node", "services/reconciler/dist/run.js"]
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for app/reconciler/workspace log groups."
  type        = number
  default     = 30
}

# ---- Observability alarms (on the control-plane/reconciler EMF metrics) ----

variable "enable_metric_alarms" {
  description = "Create CloudWatch alarms on the control-plane/reconciler EMF metrics. Disable where CloudWatch metrics are unavailable (e.g. the simulator, which has no metrics endpoint)."
  type        = bool
  default     = true
}

variable "enable_cloudwatch_dashboard" {
  description = "Create the CloudWatch ops dashboard (aws_cloudwatch_dashboard). Separate from enable_metric_alarms because it needs the CloudWatch PutDashboard API specifically; disable where PutDashboard is unavailable."
  type        = bool
  default     = true
}

variable "alarm_sns_topic_arns" {
  description = "SNS topic ARNs notified on alarm/OK transitions. Empty = alarms still evaluate and show in the console, but send no notifications."
  type        = list(string)
  default     = []
}

variable "wake_latency_alarm_ms" {
  description = "Threshold (ms) for the wake-on-connect cold-start latency p99 alarm."
  type        = number
  default     = 120000
}

variable "control_plane_5xx_threshold" {
  description = "Target 5xx responses (per 5-minute period) above which the control-plane-erroring alarm fires."
  type        = number
  default     = 10
}

variable "reconciler_liveness_period" {
  description = "Window (seconds) over which at least one reconciler sweep must run before the not-running alarm fires. Set comfortably above the reconciler schedule cadence (default schedule rate(5 minutes))."
  type        = number
  default     = 900
}

variable "privilege_attempt_alarm_threshold" {
  description = "Blocked privileged-tool attempts (per 5-min period) above which the security alarm fires. 0 = alarm on any."
  type        = number
  default     = 5
}

variable "stuck_error_alarm_threshold" {
  description = "Workspaces in unrecoverable `error` (over a 15-min window) above which the stuck-error alarm fires (needs a human). 0 = alarm on any."
  type        = number
  default     = 0
}

variable "dynamodb_throttle_threshold" {
  description = "Read+write throttle events (per 5-minute period) above which the DynamoDB throttling alarm fires."
  type        = number
  default     = 0
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget (USD) for the AWS Budgets guardrail; 0 disables it. Notifies alarm_sns_topic_arns at 80% (forecast) and 100% (actual)."
  type        = number
  default     = 0
}
