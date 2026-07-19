<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Install to AWS — linear runbook

The end-to-end install, top to bottom. Set the parameters once at the top, then
paste the install command; paste the verification block separately afterwards.
To undo everything (including a partial or failed install), run the cleanup
command with the same parameters.

The scripts are **fail-fast** (`set -eu`): the first error aborts, so a
half-bad setup is never left "deployed". For the conceptual picture behind these
steps (block diagram, deploy sequence, connection sequences), see
[`architecture.md`](./architecture.md). This runbook drives the same module and
scripts the [`deploying.md`](./deploying.md) runbook describes step by step.

> **Status:** the Terraform module is sim-apply-proven every PR; a real `apply`
> needs your AWS account + a domain (see [`DO_NEXT.md`](../DO_NEXT.md) open
> decisions). These instructions are the intended production flow.

## Prerequisites

- **AWS account + credentials** with permission to create VPC, ECS, DynamoDB, ECR,
  KMS, IAM, ALB, ACM, Route53, Secrets Manager, CloudWatch, EventBridge. Configure
  the AWS CLI: `aws configure` (or `AWS_PROFILE=…`).
- **Tools:** the AWS CLI v2, Terraform (`>=` the repo pin), Docker (or podman
  aliased as `docker`). The scripts check for these and abort if missing.
- **A Route53 hosted zone** for `app.<domain>` (the editor proxy is path-based on
  that one host — no wildcard). Optionally a second zone for `*.<ssh-base-domain>`.
- **IdP app registrations** (GitHub OAuth/App and/or Azure Entra) with the callback
  URL `https://app.<domain>/api/auth/callback/<provider>`.

## 1. Set the parameters

Export these once in your shell — the install/verify/cleanup scripts all read them.
The `REQUIRED` ones have no default; the rest are optional.

```sh
# --- REQUIRED ---
export EDD_NAME="edd-dev"                       # resource name prefix (lowercase, hyphenated)
export EDD_REGION="us-east-1"                   # AWS region
export EDD_AZS="us-east-1a,us-east-1b"          # 2+ AZs, comma-separated
export EDD_ADMIN_GROUPS="platform-admins"       # IdP group(s) granting admin (CSV).
                                                #   WITHOUT THIS, NO ONE IS AN ADMIN.
export EDD_IMAGE_SOURCE_REPO="e6qu/ecs-dev-desktop" # repo observed for golden catalog rollout

# --- editor domain (omit both for an HTTP-only dev stack with no TLS) ---
export EDD_DOMAIN="dev.example.com"             # app.<this> control-plane URL
export EDD_ROUTE53_ZONE="Z0123456789ABCDEFGHIJ" # Route53 zone id for EDD_DOMAIN

# --- SSH front door (omit all three for no SSH ingress) ---
export EDD_SSH_DOMAIN="ssh.dev.example.com"     # *.<this> per-workspace SSH
export EDD_SSH_ZONE="Z0123456789ABCDEFGHIJ"     # Route53 zone id for EDD_SSH_DOMAIN

# --- IdP creds (omit to skip that provider; headless — no prompt) ---
export EDD_BOOTSTRAP_GITHUB_ID="iv1.xxxxx"      # GitHub OAuth client id
export EDD_BOOTSTRAP_GITHUB_SECRET="yyyyyy"     # GitHub OAuth client secret
# export EDD_BOOTSTRAP_ENTRA_ID="…"             # Azure Entra client id
# export EDD_BOOTSTRAP_ENTRA_SECRET="…"         # Azure Entra client secret

# --- optional knobs ---
# export EDD_NAT_MODE="instance"                # instance (fck-nat, default) | gateway
# export EDD_IMAGE_BUILD_MODE="local"           # local | codebuild | pre-published
export EDD_IMAGE_TAG="6d37b95b49c"             # required source-commit prefix
# export EDD_CODEBUILD_SOURCE_REPO="https://github.com/..." # required for codebuild mode
# export EDD_GOLDEN="omnibus typescript"        # golden variants to build (default: omnibus)
# export EDD_DEVELOPER_GROUPS="engineering"        # IdP group(s) granting developer (CSV)
# export EDD_AWS_PRICING="1"                    # require live AWS Price List rates (default)
# export EDD_EMAIL_FROM="EDD <noreply@dev.example.com>" # SES verified sender for invitations
```

> You can run the IdP prompts interactively instead: leave the
> `EDD_BOOTSTRAP_*` vars unset and `install.sh` will hand them to
> `bootstrap-secrets.sh`, which prompts. (Set them to run fully unattended.)

## 2. Install (one command)

```sh
sh scripts/install.sh
```

This runs the whole linear flow, aborting on the first error:

1. **Prereq checks** — AWS CLI / Terraform / Docker present; AWS credentials work.
2. **Bootstrap remote state** — `scripts/bootstrap-state.sh` creates the
   versioned/encrypted S3 bucket + DynamoDB lock table (`edd-tfstate-<name>` /
   `edd-tfstate-locks`), idempotently.
3. **Bootstrap secrets** — `scripts/bootstrap-secrets.sh` creates
   `<name>/AUTH_SECRET`, `<name>/EDD_TOKEN_ENC_KEY`, `<name>/EDD_GATEWAY_SECRET`,
   `<name>/EDD_AGENT_SECRET`, `<name>/EDD_CONNECTION_SECRET`,
   `<name>/EDD_IMAGE_SOURCE_WEBHOOK_SECRET` (randomly generated) and the IdP creds
   you supplied, then prints their ARNs.
4. **Terraform init + apply** — writes an `install.tfvars` from your parameters,
   points at the remote state, and applies the
   [`complete` example](../infra/terraform/examples/complete) (VPC, DynamoDB, ECR,
   KMS, IAM, ECS control-plane service, ALB + ACM + Route53, reconciler schedule,
   CloudWatch logs/alarms/dashboard, and the SSH NLB when `EDD_SSH_DOMAIN` is set).
   Based on `EDD_IMAGE_BUILD_MODE`, Terraform also builds/pushes the images during
   apply:
   - `local` (default) — Terraform runs `scripts/publish-images.sh` from the repo
     root. Your machine needs Docker + the source checkout. This is the one-command
     path: one `apply` provisions infra and images.
   - `codebuild` — Terraform creates an AWS CodeBuild project and starts a build
     during apply. No local Docker; set `EDD_CODEBUILD_SOURCE_REPO` to a
     clone-able git URL. The build runs on a standard x86_64 CodeBuild image and
     publishes `amd64` images (add an arm64 runner later for full dual-arch).
   - `pre-published` — Terraform expects images to already exist in ECR (e.g. from
     the `release` workflow). Set `EDD_IMAGE_TAG` to the pushed tag; Terraform
     resolves the manifest digest so the first deployment pins the published
     image.

5. **Image roll** — the ECS task definitions reference the image by tag/digest, so
   the first deployment pulls the freshly built/published image. No separate
   `update-service --force-new-deployment` is required.

Images are published as multi-arch manifests (`:<tag>`) plus per-arch tags
(`:<tag>-amd64` and `:<tag>-arm64`). Fargate pulls the manifest; runners that
cannot consume manifests (e.g. Lambda) can pin the suffixed tag directly.

On success it prints the control-plane URL. Set `EDD_IMAGE_BUILD_MODE=pre-published`
and push images out of band if you want to inspect resources before building the
~3 GB golden image.

## 3. Verify (paste separately, after install completes)

```sh
sh scripts/install.sh --verify
```

Read-only — checks the deployed stack, no mutation:

- the ALB/health endpoints respond (`/api/healthz`, `/api/readyz`);
- the control-plane ECS service `desired` vs `running` count;
- the reconciler EventBridge schedule exists and is `ENABLED`;
- Terraform reports **no drift** (`plan -detailed-exitcode`, exit 0).

Manual spot-checks:

```sh
# Sign in at the printed control-plane URL (your EDD_ADMIN_GROUPS IdP group),
# then add a base-image catalog entry so workspaces can launch (admin Catalog UI
# or the API). Until you seed the catalog, users can't create workspaces.
```

## 4. Seed the base-image catalog (default catalog entry is already seeded)

By default the module creates one base-image catalog entry in DynamoDB during apply
(`seed_default_catalog = true`), pointing at the golden variant you configured with
`EDD_GOLDEN`. Users can create workspaces immediately. If you prefer to manage the
catalog entirely by hand, set `EDD_SEED_CATALOG=false` before install and add entries
via the admin **Catalog** UI or API after sign-in.

## Cleanup — undo everything (including a partial/failed install)

```sh
# Same parameters as install (EDD_NAME / EDD_REGION). Re-exports them if needed.
sh scripts/uninstall.sh

# To ALSO purge the remote-state S3 bucket + DynamoDB lock table (otherwise kept
# so you can re-apply if a destroy was incomplete):
EDD_PURGE_STATE=1 sh scripts/uninstall.sh
```

`uninstall.sh` runs the steps in reverse dependency order; **each step is
best-effort** (a piece already gone, or never created, is logged and skipped), so a
half-finished install is fully reclaimable:

1. **`terraform destroy`** with `deletion_protection=false` (so a prod-protected
   DynamoDB table / ALB is still removable) — removes all module-managed infra.
2. **Secrets Manager** — force-deletes every secret under `<name>/*`.
3. **Leaked runtime resources** — stops stray workspace ECS tasks and deletes EBS
   volumes/snapshots tagged `edd:managed` for this name (the runtime resources the
   control plane creates, which Terraform does not own).
4. _(optional)_ the remote-state bucket + lock table.

It does **not** delete things you own outside the stack: Route53 hosted zones, IdP
app registrations, or the release-workflow IAM OIDC role. The script lists these at
the end.

## AWS bootstrap outside the EDD stack

Before the `release` workflow can publish and deploy control-plane images,
bootstrap GitHub Actions access to the AWS account:

```sh
EDD_RELEASE_GITHUB_REPO=e6qu/ecs-dev-desktop \
EDD_RELEASE_AWS_ACCOUNT=111122223333 \
EDD_RELEASE_AWS_REGION=eu-west-1 \
EDD_RELEASE_NAME_PREFIX=edd-prod \
EDD_RELEASE_GOLDEN_VARIANTS="omnibus" \
sh scripts/bootstrap-release-oidc.sh
```

This creates or updates the account-level GitHub OIDC provider, the
`<name>-github-release` IAM role, and the GitHub `RELEASE_*` repo variables. Those
repo variables are non-secret coordinates only; do not store static secrets in
GitHub variables or secrets for this path. The
bootstrap is not part of the Terraform module because EDD must be releasable
before EDD is deployed. The role trust is constrained to this repository's `main`
branch and `v*` tags, and the permissions are scoped to the release path: ECR
pushes for the control-plane, SSH-gateway, and golden-image repositories, ECS
task-definition registration and service updates for the control-plane/SSH/reconciler
families, Scheduler updates for the reconciler schedule, and `iam:PassRole` for
the exact runtime roles those resources already use. `RELEASE_GOLDEN_VARIANTS`
drives the separate `golden-images` workflow; it is a non-secret coordinate, not a
static credential.

## What the scripts are

| Script                                                                      | Purpose                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`scripts/install.sh`](../scripts/install.sh)                               | one-command install (`--verify` re-checks a stack)              |
| [`scripts/uninstall.sh`](../scripts/uninstall.sh)                           | full teardown, partial-safe (`EDD_PURGE_STATE=1` for state too) |
| [`scripts/bootstrap-state.sh`](../scripts/bootstrap-state.sh)               | S3 bucket + DynamoDB lock (idempotent)                          |
| [`scripts/bootstrap-secrets.sh`](../scripts/bootstrap-secrets.sh)           | crypto (generated) + IdP secrets in Secrets Manager             |
| [`scripts/bootstrap-release-oidc.sh`](../scripts/bootstrap-release-oidc.sh) | GitHub OIDC release role + release workflow repo variables      |
| [`scripts/publish-images.sh`](../scripts/publish-images.sh)                 | build + push control-plane / golden / gateway images to ECR     |
| [`scripts/deploy-release-images.sh`](../scripts/deploy-release-images.sh)   | roll published release images into ECS services + Scheduler     |
| [`release`](../.github/workflows/release.yml) workflow                      | CI-driven image publish + deploy on `main`/`v*`/manual          |
| [`golden-images`](../.github/workflows/golden-images.yml) workflow          | CI-driven golden image publish on `main`/manual                 |

## See also

- [`architecture.md`](./architecture.md) — block diagram, deploy sequence, connection sequences.
- [`deploying.md`](./deploying.md) — the same deploy, explained step by step (the module inputs, every secret, DNS/TLS, the editor proxy).
- [`runbook.md`](./runbook.md) — incident response (alarm → diagnosis → remediation).
- [module README](../infra/terraform/modules/ecs-dev-desktop/README.md) — Terraform inputs/outputs.
