#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
unset CDPATH

root=$(cd "$(dirname "$0")/.." && pwd)
release="$root/.github/workflows/release.yml"
golden="$root/.github/workflows/golden-images.yml"
publisher="$root/scripts/publish-images.sh"
registry="$root/infra/terraform/modules/ecs-dev-desktop/registry.tf"
variables="$root/infra/terraform/modules/ecs-dev-desktop/variables.tf"
bootstrap="$root/scripts/bootstrap-release-oidc.sh"
smoke_workflow="$root/.github/workflows/post-deploy-smoke.yml"
fixture_retention="$root/scripts/retain-ghcr-package-versions.sh"
deploy="$root/scripts/deploy-release-images.sh"
ecs="$root/infra/terraform/modules/ecs-dev-desktop/ecs.tf"
reconciler="$root/infra/terraform/modules/ecs-dev-desktop/reconciler.tf"
ssh_ingress="$root/infra/terraform/modules/ecs-dev-desktop/ssh-ingress.tf"

for workflow in "$release" "$golden"; do
  if grep -Eq 'workflow_dispatch:|tags:|:(latest|main)([[:space:]]|$)' "$workflow"; then
    echo "edd: publication must be main-only and must not emit mutable tags: $workflow" >&2
    exit 1
  fi
  if ! grep -Fq 'branches: [main]' "$workflow"; then
    echo "edd: publication workflow did not target main: $workflow" >&2
    exit 1
  fi
  if ! grep -Fq "TAG: \${{ github.sha }}" "$workflow"; then
    echo "edd: publication workflow did not derive its tag from github.sha: $workflow" >&2
    exit 1
  fi
  if ! grep -Fq "\"\${TAG:0:12}\"" "$workflow"; then
    echo "edd: publication workflow did not publish the immutable 12-character source prefix: $workflow" >&2
    exit 1
  fi
done

for architecture in amd64 arm64; do
  if ! grep -Fq "arch: $architecture" "$release" || ! grep -Fq "arch: $architecture" "$golden"; then
    echo "edd: both publication workflows must build $architecture" >&2
    exit 1
  fi
done

if [ "$(grep -Fc 'runner: ubuntu-24.04-arm' "$release")" -ne 1 ] ||
  [ "$(grep -Fc 'runner: ubuntu-24.04-arm' "$golden")" -ne 1 ]; then
  echo "edd: every ARM64 publication path must use the native GitHub ARM64 runner" >&2
  exit 1
fi

if grep -Fq 'refs/tags/' "$bootstrap" ||
  ! grep -Fq "repo:\${GITHUB_REPO}:ref:refs/heads/main" "$bootstrap"; then
  echo "edd: the AWS release role trust must be restricted to the main branch" >&2
  exit 1
fi
trust_condition_count=$(awk '/cat >"\$trust_policy"/,/^EOF$/' "$bootstrap" |
  grep -Fc '"StringEquals": {')
if [ "$trust_condition_count" -ne 1 ]; then
  echo "edd: the AWS release role trust must keep audience and subject in one StringEquals condition" >&2
  exit 1
fi

if [ "$(grep -Fc -- '--provenance=false' "$publisher")" -ne 2 ] ||
  [ "$(grep -Fc -- '--sbom=false' "$publisher")" -ne 2 ]; then
  echo "edd: every per-architecture build path must disable provenance and SBOM indexes" >&2
  exit 1
fi

for repository in control-plane ssh-gateway edd-base; do
  if ! grep -Fq "push_manifest $repository" "$publisher"; then
    echo "edd: missing generic multi-architecture manifest publication for $repository" >&2
    exit 1
  fi
done
if ! grep -Fq "push_manifest \"golden/\${v}\"" "$publisher"; then
  echo "edd: missing generic multi-architecture manifest publication for golden variants" >&2
  exit 1
fi

if [ "$(grep -Fc 'sh scripts/verify-published-images.sh' "$release")" -ne 1 ] ||
  [ "$(grep -Fc 'sh scripts/verify-published-images.sh' "$golden")" -ne 1 ]; then
  echo "edd: both publication workflows must verify their pushed OCI image shape" >&2
  exit 1
fi

for golden_mode in base-only variants-only; do
  if [ "$(grep -Fc "EDD_GOLDEN_MODE: $golden_mode" "$golden")" -ne 1 ]; then
    echo "edd: golden publication must split $golden_mode work into one bounded matrix path" >&2
    exit 1
  fi
done
if ! grep -Fq 'needs: [prepare, publish-base]' "$golden" ||
  ! grep -Fq "variant: \${{ fromJSON(needs.prepare.outputs.variants) }}" "$golden"; then
  echo "edd: golden variants must fan out only after the immutable per-architecture base exists" >&2
  exit 1
fi

if [ -e "$deploy" ]; then
  echo "edd: release-side ECS deployment script must not exist; Terraform owns deployments" >&2
  exit 1
fi

for forbidden in \
  RELEASE_DEPLOYMENT_ENABLED RELEASE_ECS_CLUSTER RELEASE_SSH_GATEWAY_ENABLED \
  release-deploy deploy-release-images.sh 'aws ecs update-service' \
  'aws ecs register-task-definition'; do
  if grep -Fq "$forbidden" "$release" "$bootstrap" "$publisher"; then
    echo "edd: publication path contains deployment-only contract '$forbidden'" >&2
    exit 1
  fi
done

for forbidden_action in \
  'ecs:DescribeServices' 'ecs:UpdateService' 'ecs:DescribeTaskDefinition' \
  'ecs:RegisterTaskDefinition' 'scheduler:GetSchedule' 'scheduler:UpdateSchedule' \
  'iam:PassRole' 'dynamodb:GetItem' 'secretsmanager:GetSecretValue' 'kms:Decrypt'; do
  if grep -Fq "$forbidden_action" "$bootstrap"; then
    echo "edd: image-publication role contains non-ECR permission '$forbidden_action'" >&2
    exit 1
  fi
done

for coordinate in EDD_SHAUTH_ISSUER EDD_SHAUTH_SMOKE_USERNAME EDD_SHAUTH_SMOKE_PASSWORD; do
  if ! grep -Fq "$coordinate" "$smoke_workflow"; then
    echo "edd: deployed smoke is missing Shauth coordinate '$coordinate'" >&2
    exit 1
  fi
done
if grep -Eq 'AUTH_SECRET_ID|secretsmanager:|dynamodb:|configure-aws-credentials|workflow_run:' "$smoke_workflow"; then
  echo "edd: deployed smoke must authenticate through Shauth and must not forge app sessions or mutate infrastructure" >&2
  exit 1
fi

for managed_attachment in "$ecs" "$reconciler" "$ssh_ingress"; do
  if grep -Eq 'ignore_changes[[:space:]]*=.*task_definition|task_definition.*ignore_changes' "$managed_attachment"; then
    echo "edd: Terraform must own task-definition attachments: $managed_attachment" >&2
    exit 1
  fi
done

if ! grep -Fq 'countNumber = var.image_retention_count' "$registry" ||
  ! grep -A4 -F 'variable "image_retention_count"' "$variables" | grep -Fq 'default     = 20'; then
  echo "edd: Amazon ECR repositories must retain at most 20 images" >&2
  exit 1
fi

if [ "$(grep -Fc "sh scripts/retain-ghcr-package-versions.sh \"\$OWNER\" \"\$PACKAGE_NAME\" 20" .github/workflows/ci.yml)" -ne 3 ] ||
  ! grep -Fq "tail -n \"+\$((keep + 1))\"" "$fixture_retention"; then
  echo "edd: GitHub Container Registry test fixtures must retain only the newest 20 versions" >&2
  exit 1
fi

if ! grep -Fq 'max_attempts=4' "$fixture_retention" ||
  ! grep -Fq 'HTTP (408|429|500|502|503|504)' "$fixture_retention" ||
  ! grep -Fq 'already absent after an ambiguous delete' "$fixture_retention"; then
  echo "edd: fixture retention must retry only transient idempotent GitHub API operations within a fixed bound" >&2
  exit 1
fi

if ! grep -Fq 'e2e-workspace-base:' .github/workflows/ci.yml ||
  ! grep -Fq 'name: e2e fixture (workspace base)' .github/workflows/ci.yml ||
  ! grep -Fq 'e2e-simulator-image:' .github/workflows/ci.yml ||
  ! grep -Fq 'name: e2e fixture (simulator)' .github/workflows/ci.yml ||
  ! grep -Fq 'name: e2e fixture (workspace)' .github/workflows/ci.yml ||
  ! grep -Fq "WORKSPACE_BASE: ghcr.io/\${{ github.repository_owner }}/edd-ci-workspace-base" .github/workflows/ci.yml ||
  ! grep -Fq 'needs: e2e-workspace-base' .github/workflows/ci.yml ||
  ! grep -Fq 'needs: [e2e-images, e2e-simulator-image]' .github/workflows/ci.yml ||
  ! grep -Fq 'PACKAGE_NAME: edd-ci-workspace-base' .github/workflows/ci.yml; then
  echo "edd: the workspace fixture must consume a separately bounded, run-scoped base fixture with independent retention" >&2
  exit 1
fi

if grep -Fq 'infra/images/base/build.sh edd-base:ci' .github/workflows/ci.yml ||
  grep -Fq 'matrix.fixture' .github/workflows/ci.yml ||
  ! grep -Fq "BASE: ghcr.io/\${{ github.repository_owner }}/edd-ci-workspace-base" .github/workflows/ci.yml ||
  [ "$(grep -Fc -- '--push' .github/workflows/ci.yml)" -lt 2 ]; then
  echo "edd: workspace and simulator fixtures must publish independently instead of serializing unrelated work or local builds and pushes" >&2
  exit 1
fi

if grep -Eq -- 'gh api .*--paginate .*--slurp|gh api .*--slurp .*--paginate' .github/workflows/ci.yml "$fixture_retention"; then
  echo "edd: GitHub CLI rejects --slurp with --jq; fixture retention must stream paginated rows" >&2
  exit 1
fi

echo "edd: container publication contract passed"
