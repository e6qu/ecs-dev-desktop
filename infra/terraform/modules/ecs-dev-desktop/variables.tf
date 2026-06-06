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
    Secrets Manager / SSM ARNs that hold them (e.g. AUTH_SECRET, AUTH_GITHUB_SECRET,
    EDD_AGENT_SECRET). The module grants the execution role read access to every
    referenced ARN. EDD_AGENT_SECRET must be provided here — never as a plain env var.
  EOT
  type        = map(string)
  default     = {}
}

# ---- DNS / TLS (optional; gated on domain_name) ----

variable "domain_name" {
  description = <<-EOT
    Base domain for the control plane and workspace wildcard routing
    (`app.<domain>` and `*.devbox.<domain>`). Empty disables Route53/ACM and
    serves the ALB over HTTP only (dev). Requires `route53_zone_id` when set.
  EOT
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route53 hosted-zone id for `domain_name`. Required when `domain_name` is set."
  type        = string
  default     = ""
}

variable "workspaces_subdomain" {
  description = "Subdomain under which per-user workspaces are routed (`*.<this>.<domain>`)."
  type        = string
  default     = "devbox"
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
