#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One-command AWS install for ecs-dev-desktop. Runs the linear deploy:
# validate prereqs -> bootstrap state -> bootstrap secrets -> terraform apply.
# The Terraform module itself handles image production based on `image_build_mode`:
#
#   "local" (default)  — terraform runs scripts/publish-images.sh during apply.
#                        The operator/CI machine needs docker + the source checkout.
#   "codebuild"        — terraform creates an AWS CodeBuild project and starts a
#                        build during apply (no local docker; set
#                        EDD_CODEBUILD_SOURCE_REPO to a clone-able git URL).
#   "pre-published"    — terraform expects images to already exist in ECR (e.g.
#                        from the `release` workflow). Set EDD_IMAGE_TAG to the
#                        pushed tag.
#
# Fail-fast: `set -eu` aborts on the first error so a half-bad setup is never
# "deployed". To undo everything, run scripts/uninstall.sh with the same
# EDD_NAME/EDD_REGION.
#
# PARAMETERS (env vars — set these, then run the script). Sensible defaults are
# provided; the REQUIRED ones have no default.
#
#   EDD_NAME            REQUIRED  resource name prefix (e.g. edd-dev)
#   EDD_REGION          REQUIRED  AWS region (e.g. us-east-1)
#   EDD_AZS             REQUIRED  2+ AZs, comma-separated (e.g. us-east-1a,us-east-1b)
#   EDD_DOMAIN          optional  base domain for app.<domain> (empty = HTTP-only dev)
#   EDD_ROUTE53_ZONE    optional  Route53 zone id for EDD_DOMAIN (required if domain set)
#   EDD_SSH_DOMAIN      optional  base domain for *.<ssh> (empty = no SSH ingress)
#   EDD_SSH_ZONE        optional  Route53 zone id for EDD_SSH_DOMAIN (required if SSH)
#   EDD_NAT_MODE        optional  private-subnet egress: instance (fck-nat, default) | gateway
#   EDD_NAT_INSTANCE_TYPE optional fck-nat EC2 type (default: t4g.nano; bump to a
#                         free-tier-eligible type, e.g. t4g.micro, if the account is
#                         still Free-Tier-restricted — RunInstances then rejects t4g.nano)
#   EDD_IMAGE_TAG       optional  image tag (default: main)
#   EDD_IMAGE_BUILD_MODE optional image build mode: local | codebuild | pre-published
#   EDD_CODEBUILD_SOURCE_REPO  optional  git URL for codebuild mode (e.g. https://github.com/...)
#   EDD_CODEBUILD_SOURCE_REF   optional  git ref for codebuild mode (default: main)
#   EDD_GOLDEN          optional  golden variants (space-separated; default: omnibus)
#   EDD_ADMIN_GROUPS    REQUIRED  IdP group(s) granting admin (CSV; without it NO admin)
#   EDD_MEMBER_GROUPS   optional  IdP group(s) granting member (CSV)
#   EDD_BOOTSTRAP_GITHUB_ID      optional  GitHub OAuth client id (skip = no GitHub)
#   EDD_BOOTSTRAP_GITHUB_SECRET  optional  GitHub OAuth client secret
#   EDD_BOOTSTRAP_ENTRA_ID       optional  Entra OIDC client id (skip = no Entra)
#   EDD_BOOTSTRAP_ENTRA_SECRET   optional  Entra OIDC client secret
#   EDD_TF_DIR          optional  terraform dir (default: infra/terraform/examples/complete)
#
# USAGE
#   EDD_NAME=edd-dev EDD_REGION=us-east-1 EDD_AZS=us-east-1a,us-east-1b \
#     EDD_ADMIN_GROUPS=platform-admins sh scripts/install.sh
#
# Verify afterwards:
#   sh scripts/install.sh --verify
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Requires: AWS CLI v2, Terraform >= the repo pin.

set -eu
unset CDPATH

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

mode="install"
[ "${1:-}" = "--verify" ] && mode="verify"

# ---- parameters + required-field validation (fail-fast) ---------------------
EDD_NAME="${EDD_NAME:-}"
EDD_REGION="${EDD_REGION:-}"
EDD_AZS="${EDD_AZS:-}"
EDD_DOMAIN="${EDD_DOMAIN:-}"
EDD_ROUTE53_ZONE="${EDD_ROUTE53_ZONE:-}"
EDD_SSH_DOMAIN="${EDD_SSH_DOMAIN:-}"
EDD_SSH_ZONE="${EDD_SSH_ZONE:-}"
EDD_NAT_MODE="${EDD_NAT_MODE:-instance}"
EDD_NAT_INSTANCE_TYPE="${EDD_NAT_INSTANCE_TYPE:-t4g.nano}"
EDD_TAG="${EDD_IMAGE_TAG:-main}"
EDD_IMAGE_BUILD_MODE="${EDD_IMAGE_BUILD_MODE:-local}"
EDD_CODEBUILD_SOURCE_REPO="${EDD_CODEBUILD_SOURCE_REPO:-}"
EDD_CODEBUILD_SOURCE_REF="${EDD_CODEBUILD_SOURCE_REF:-main}"
EDD_GOLDEN="${EDD_GOLDEN:-omnibus}"
EDD_ADMIN_GROUPS="${EDD_ADMIN_GROUPS:-}"
EDD_MEMBER_GROUPS="${EDD_MEMBER_GROUPS:-}"
EDD_TF_DIR="${EDD_TF_DIR:-infra/terraform/examples/complete}"
export EDD_BOOTSTRAP_GITHUB_ID="${EDD_BOOTSTRAP_GITHUB_ID:-}"
export EDD_BOOTSTRAP_GITHUB_SECRET="${EDD_BOOTSTRAP_GITHUB_SECRET:-}"
export EDD_BOOTSTRAP_ENTRA_ID="${EDD_BOOTSTRAP_ENTRA_ID:-}"
export EDD_BOOTSTRAP_ENTRA_SECRET="${EDD_BOOTSTRAP_ENTRA_SECRET:-}"

missing() { # <name> <value>
  [ -n "$2" ] && return 0
  echo "edd: missing required parameter $1 (set it as an env var)" >&2
  return 1
}
missing EDD_NAME "$EDD_NAME" || exit 1
missing EDD_REGION "$EDD_REGION" || exit 1
# The rest (AZs, admin groups, build-mode/nat-mode shape, domain/SSH zone pairing) are
# install-only concerns — `--verify` is read-only and never writes a tfvars file, so
# requiring the full install parameter set for it (as a prior version of this script
# did unconditionally) broke the documented "just EDD_NAME/EDD_REGION" verify usage.
if [ "$mode" = "install" ]; then
  missing EDD_AZS "$EDD_AZS" || exit 1
  missing EDD_ADMIN_GROUPS "$EDD_ADMIN_GROUPS" || exit 1
  if [ "$EDD_IMAGE_BUILD_MODE" != "local" ] && [ "$EDD_IMAGE_BUILD_MODE" != "codebuild" ] && [ "$EDD_IMAGE_BUILD_MODE" != "pre-published" ]; then
    echo "edd: EDD_IMAGE_BUILD_MODE must be local, codebuild, or pre-published" >&2
    exit 1
  fi
  if [ "$EDD_NAT_MODE" != "instance" ] && [ "$EDD_NAT_MODE" != "gateway" ]; then
    echo "edd: EDD_NAT_MODE must be instance or gateway" >&2
    exit 1
  fi
  if [ "$EDD_IMAGE_BUILD_MODE" = "codebuild" ]; then
    missing EDD_CODEBUILD_SOURCE_REPO "$EDD_CODEBUILD_SOURCE_REPO" || exit 1
  fi
  if [ -n "$EDD_DOMAIN" ]; then missing EDD_ROUTE53_ZONE "$EDD_ROUTE53_ZONE" || exit 1; fi
  if [ -n "$EDD_SSH_DOMAIN" ]; then missing EDD_SSH_ZONE "$EDD_SSH_ZONE" || exit 1; fi
fi

# "a,b" -> ["a","b"]. (The previous version forced a trailing comma before quoting
# every comma, which turned that same trailing comma into a closing `","` and left
# nothing for the final substitution to convert into `"]` — always emitting an
# unclosed HCL list, e.g. ["eu-west-1a","eu-west-1b","; found on the first real apply.)
azs_list=$(printf '%s' "$EDD_AZS" | sed 's/,/","/g; s/^/["/; s/$/"]/')
state_bucket="edd-tfstate-${EDD_NAME}"

banner() { printf '\n\033[1m=== edd: %s ===\033[0m\n' "$*"; }

tfdir="$repo/$EDD_TF_DIR"

# ============================================================================
# VERIFY MODE — re-check a deployed stack (read-only, no mutation). Paste-able.
# ============================================================================
if [ "$mode" = "verify" ]; then
  banner "verifying $EDD_NAME in $EDD_REGION"
  for c in aws terraform; do
    command -v "$c" >/dev/null 2>&1 || {
      echo "edd: '$c' not found on PATH" >&2
      exit 1
    }
  done
  aws sts get-caller-identity --region "$EDD_REGION" >/dev/null

  (cd "$tfdir" && terraform init -backend-config "bucket=$state_bucket" \
    -backend-config "key=ecs-dev-desktop/${EDD_NAME}/terraform.tfstate" \
    -backend-config "region=$EDD_REGION" -input=false >/dev/null)

  cp_url=$(cd "$tfdir" && terraform output -raw control_plane_url)
  cluster=$(cd "$tfdir" && terraform output -raw ecs_cluster_name)
  table=$(cd "$tfdir" && terraform output -raw dynamodb_table_name)

  echo "control plane URL : $cp_url"
  echo "ecs cluster       : $cluster"
  echo "dynamodb table    : $table"

  printf '\n[1/5] ALB health (HTTPS requires the cert to be issued):\n'
  curl -fsS -o /dev/null -w "  HTTP %{http_code} in %{time_total}s\n" "$cp_url/api/healthz" ||
    echo "  WARN: $cp_url/api/healthz not reachable (DNS/cert/SG?)"

  echo "[2/5] control-plane service:"
  aws ecs describe-services --region "$EDD_REGION" --cluster "$cluster" \
    --services "${EDD_NAME}-control-plane" \
    --query 'services[0].[desiredCount,runningCount,status]' --output text |
    {
      read -r desired running status
      printf '  desired=%s running=%s status=%s\n' "$desired" "$running" "$status"
    }

  echo "[3/5] reconciler schedule:"
  aws scheduler get-schedule --region "$EDD_REGION" --name "${EDD_NAME}-reconciler" \
    --group-name default --query 'State' --output text 2>/dev/null |
    {
      read -r s
      printf '  state=%s\n' "${s:-MISSING}"
    }

  echo "[4/5] readiness probe (/api/readyz — DynamoDB-backed):"
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$cp_url/api/readyz" || echo 000)
  if [ "$code" = "200" ]; then echo "  OK (200)"; else echo "  WARN: /api/readyz returned $code (503 = DynamoDB not reachable)"; fi

  echo "[5/5] Terraform drift (exit 0 = no drift):"
  (cd "$tfdir" && terraform plan -detailed-exitcode -input=false -var-file=install.tfvars >/dev/null 2>&1 &&
    echo "  no drift") || echo "  drift detected (or plan failed) — re-run install to reconcile"
  banner "verify complete"
  exit 0
fi

# ============================================================================
# INSTALL MODE
# ============================================================================

banner "prerequisite checks"
for c in aws terraform; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "edd: '$c' not found on PATH" >&2
    exit 1
  }
done
echo "edd: aws caller identity:"
aws sts get-caller-identity --region "$EDD_REGION" >/dev/null || {
  echo "edd: AWS credentials not configured (run 'aws configure' or set profile/role)" >&2
  exit 1
}
echo "  ok"

if [ "$EDD_IMAGE_BUILD_MODE" = "local" ]; then
  command -v docker >/dev/null 2>&1 || {
    echo "edd: 'docker' not found on PATH (required for local build mode)" >&2
    exit 1
  }
fi

banner "bootstrap remote-state backend ($state_bucket)"
sh "$here/bootstrap-state.sh" "$state_bucket" "$EDD_REGION"

banner "bootstrap secrets ($EDD_NAME/*)"
sh "$here/bootstrap-secrets.sh" "$EDD_NAME" "$EDD_REGION"

banner "terraform init + apply ($EDD_NAME in $EDD_REGION, mode=$EDD_IMAGE_BUILD_MODE)"
(cd "$tfdir" && terraform init -backend-config "bucket=$state_bucket" \
  -backend-config "key=ecs-dev-desktop/${EDD_NAME}/terraform.tfstate" \
  -backend-config "region=$EDD_REGION" -backend-config "encrypt=true" \
  -backend-config "dynamodb_table=edd-tfstate-locks" -input=false)

secret_map=$(
  aws secretsmanager list-secrets --region "$EDD_REGION" \
    --filter Key=name,Values="${EDD_NAME}/" \
    --query 'SecretList[].[Name,ARN]' --output text 2>/dev/null |
    while IFS="$(printf '\t')" read -r sname arn; do
      key="${sname#"${EDD_NAME}"/}"
      printf '  %s = "%s"\n' "$key" "$arn"
    done
)

tfvars="$tfdir/install.tfvars"
{
  printf 'region = "%s"\n' "$EDD_REGION"
  printf 'environment = "%s"\n' "${EDD_NAME#edd-}"
  printf 'availability_zones = %s\n' "$azs_list"
  printf 'domain_name = "%s"\n' "$EDD_DOMAIN"
  printf 'route53_zone_id = "%s"\n' "$EDD_ROUTE53_ZONE"
  printf 'ssh_base_domain = "%s"\n' "$EDD_SSH_DOMAIN"
  printf 'route53_ssh_zone_id = "%s"\n' "$EDD_SSH_ZONE"
  printf 'nat_mode = "%s"\n' "$EDD_NAT_MODE"
  printf 'nat_instance_type = "%s"\n' "$EDD_NAT_INSTANCE_TYPE"
  printf 'image_build_mode = "%s"\n' "$EDD_IMAGE_BUILD_MODE"
  printf 'image_tag = "%s"\n' "$EDD_TAG"
  printf 'golden_image_repos = ["%s"]\n' "$(printf '%s' "$EDD_GOLDEN" | sed 's/ /", "/g')"
  printf 'seed_default_catalog = true\n'
  printf 'codebuild_source_repo = "%s"\n' "$EDD_CODEBUILD_SOURCE_REPO"
  printf 'codebuild_source_ref = "%s"\n' "$EDD_CODEBUILD_SOURCE_REF"
  printf 'auth_secret_arns = {\n%s}\n' "$secret_map"
  printf 'extra_environment = {\n'
  printf '  EDD_ADMIN_GROUPS = "%s"\n' "$EDD_ADMIN_GROUPS"
  [ -n "$EDD_MEMBER_GROUPS" ] && printf '  EDD_MEMBER_GROUPS = "%s"\n' "$EDD_MEMBER_GROUPS"
  printf '  AUTH_TRUST_HOST = "true"\n'
  printf '}\n'
} >"$tfvars"

echo "edd: generated $tfvars — applying"
(cd "$tfdir" && terraform apply -auto-approve -input=false -var-file=install.tfvars)

cp_url=$(cd "$tfdir" && terraform output -raw control_plane_url)
cluster=$(cd "$tfdir" && terraform output -raw ecs_cluster_name)

banner "install complete"
cat <<EOF
  control plane : $cp_url
  cluster       : $cluster
  build mode    : $EDD_IMAGE_BUILD_MODE
  images tag    : $EDD_TAG

  Next: sign in at $cp_url (set EDD_ADMIN_GROUPS IdP group). The default
  base-image catalog entry is already seeded, so users can create workspaces.
  Verify with: sh scripts/install.sh --verify
EOF
