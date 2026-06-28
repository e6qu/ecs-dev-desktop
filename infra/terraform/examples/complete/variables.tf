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
