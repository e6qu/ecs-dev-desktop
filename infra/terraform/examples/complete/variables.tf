# SPDX-License-Identifier: AGPL-3.0-or-later

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (dev/staging/prod) — used in resource names + tags."
  type        = string
  default     = "dev"
}

variable "availability_zones" {
  description = "AZs to spread across."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# ---- NAT (private-subnet egress) ----

variable "nat_mode" {
  description = "\"instance\" — fck-nat EC2 (cheap; good default). \"gateway\" — AWS-managed NAT Gateway(s) (HA, pricier)."
  type        = string
  default     = "instance"
}

variable "single_nat_gateway" {
  description = "With nat_mode=gateway: one shared NAT gateway (cheaper, non-HA) vs one per AZ. Ignored under nat_mode=instance."
  type        = bool
  default     = true
}

variable "nat_instance_type" {
  description = "With nat_mode=instance: EC2 type for the fck-nat NAT instance. The module default (t4g.nano) isn't free-tier-eligible on accounts still under AWS's Free Tier restriction (RunInstances then fails with InvalidParameterCombination) — override to a free-tier-eligible type (e.g. t4g.micro) if needed; check with `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true`."
  type        = string
  default     = "t4g.nano"
}

variable "domain_name" {
  description = "Base domain (empty = HTTP-only dev stack, no Route53/ACM)."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route53 zone id for `domain_name` (required when domain_name is set)."
  type        = string
  default     = ""
}

variable "auth_secret_arns" {
  description = "Map of env-var name → Secrets Manager ARN for ALL secret env vars (auth + crypto), e.g. AUTH_SECRET, AUTH_GITHUB_*, EDD_TOKEN_ENC_KEY, EDD_GATEWAY_SECRET, EDD_AGENT_SECRET, EDD_CONNECTION_SECRET."
  type        = map(string)
  default     = {}
}

variable "extra_environment" {
  description = "Plain (non-secret) control-plane env vars — RBAC groups (EDD_ADMIN_GROUPS/EDD_MEMBER_GROUPS), AUTH_TRUST_HOST/AUTH_URL, AUTH_MICROSOFT_ENTRA_ID_ISSUER."
  type        = map(string)
  default     = {}
}

# ---- SSH ingress (optional; gated on ssh_base_domain) ----

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

variable "image_tag" {
  description = "Image tag for the control-plane, gateway, and golden images (used in local/codebuild modes, and resolved by pre-published mode)."
  type        = string
  default     = "main"
}

variable "ssh_gateway_image" {
  description = "SSH-gateway container image — a PINNED tag/digest (no `:latest`). Required when `ssh_base_domain` is set, unless using local/codebuild build mode."
  type        = string
  default     = ""
}

# ---- Image production ----

variable "image_build_mode" {
  description = "\"local\" (terraform builds/pushes via scripts/publish-images.sh during apply) | \"codebuild\" | \"pre-published\". See the module README."
  type        = string
  default     = "local"
}

variable "seed_default_catalog" {
  description = "Seed one default base-image catalog entry (the first golden_image_repos variant) so users can create workspaces immediately."
  type        = bool
  default     = true
}

variable "codebuild_source_repo" {
  description = "(codebuild build mode) Git URL to clone inside CodeBuild. Required when image_build_mode = \"codebuild\"."
  type        = string
  default     = ""
}

variable "codebuild_source_ref" {
  description = "(codebuild build mode) Git ref to clone."
  type        = string
  default     = "main"
}

variable "build_target" {
  description = "(codebuild build mode) Images to build: web (control-plane only, fast) | golden | all."
  type        = string
  default     = "all"
}

variable "golden_image_repos" {
  description = "Golden base-image variants to build/publish (must match infra/images/ folder names)."
  type        = list(string)
  default     = ["omnibus"]
}

# ---- Cost guardrail + alarm notifications (optional) ----

variable "monthly_budget_usd" {
  description = "Monthly AWS Budgets guardrail (USD); 0 disables it."
  type        = number
  default     = 0
}

variable "alarm_sns_topic_arns" {
  description = "SNS topic ARNs notified on alarm/OK transitions and budget thresholds. Empty = alarms still evaluate/show in-console but send no notifications."
  type        = list(string)
  default     = []
}
