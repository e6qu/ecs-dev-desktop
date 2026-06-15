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
  description = "Map of env-var name → Secrets Manager ARN for ALL secret env vars (auth + crypto + SSH CA), e.g. AUTH_SECRET, AUTH_GITHUB_*, EDD_TOKEN_ENC_KEY, EDD_GATEWAY_SECRET, EDD_AGENT_SECRET, EDD_SSH_CA_KEY."
  type        = map(string)
  default     = {}
}

variable "extra_environment" {
  description = "Plain (non-secret) control-plane env vars — RBAC groups (EDD_ADMIN_GROUPS/EDD_MEMBER_GROUPS), AUTH_TRUST_HOST/AUTH_URL, EDD_WORKSPACE_BASE_DOMAIN, EDD_POMERIUM_JWKS_URL, AUTH_MICROSOFT_ENTRA_ID_ISSUER."
  type        = map(string)
  default     = {}
}
