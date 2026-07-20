# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-20

## Current branch

The `fix/terraform-owned-deployments` branch made Terraform the sole owner of
deployed task-definition attachments. The main-only release workflow published
and verified immutable native AMD64, native ARM64, and multi-architecture images,
but no longer registered task definitions, updated Amazon ECS services, or
retargeted Amazon EventBridge Scheduler. The release AWS OIDC role was reduced to
Amazon ECR push access, while a separately bootstrapped, manually dispatched smoke
role held only the Secrets Manager, DynamoDB, and KMS access required by the real
post-deployment browser suite. Its bootstrap resolved the operator-supplied auth
secret ID to the exact deployed secret ARN instead of deriving a name.

The module attached the control-plane, reconciler, and optional SSH-gateway task
definitions without lifecycle ignores. A Sockerless AWS simulator contract changed
the immutable image tag, inspected the saved Terraform plan, applied it, queried the
real ECS and Scheduler API surfaces, and proved that every runtime attachment moved
to the latest registered revision before an idempotent zero-change plan.

The release contract published only the immutable 12-character source-commit
prefix from `main`. Native AMD64 and ARM64 runners produced direct
per-architecture OCI images, and a separate job assembled and verified the bare
multi-architecture manifest. The control-plane, SSH-gateway, shared `edd-base`,
and every configured golden variant followed the same three-reference shape.
The AWS release role trusted only the repository's `main` ref, and Amazon ECR
retained at most 20 images per repository.

## Verified state

- Direct root and `/workspaces` entry redirected through Shauth and returned to the authenticated workspace list.
- Shauth catalog entry used `/` as the canonical launch URL and reused the existing Shauth session without requesting credentials again.
- `/me` rendered the authenticated email and administrator role.
- ECS Dev Desktop sign-out ended the provider session and returned to `/signed-out` on the ECS Dev Desktop origin.
- Shauth global sign-out delivered a signed Back-Channel Logout token, revoked the durable ECS Dev Desktop session, and made the next direct entry require Shauth authentication.
- Invalid or absent Shauth configuration continued to fail closed.
- Release and golden publication rejected mutable, version, manually selected,
  and non-source image tags.
- Direct `-amd64` and `-arm64` references resolved to single-platform OCI image
  manifests; the unsuffixed reference resolved to an AMD64+ARM64 OCI index.
- The complete monorepo lint, unit/integration test, production build, ShellCheck, and real Chromium Shauth SSO suites passed.
- Changing the Terraform image tag replaced the control-plane and reconciler task
  definitions and updated the control-plane ECS service plus reconciler Scheduler
  target to their newest revisions.
- The DNS/TLS simulator topology additionally replaced the SSH-gateway task
  definition and updated its ECS service; the subsequent plan had zero changes.
- Publication contained no deployment API calls or permissions, and the separate
  post-deployment smoke remained an explicit operator action.

## Deployment boundary

The private `e6qu/infra` repository owned the shared `dev.e6qu.dev` environment and
was the only deployment actor. After this branch merged, it still needed to pin a
published immutable image tag and apply synchronized `main`; publication itself no
longer changed live Amazon ECS or Scheduler resources.

## Durable invariants

- ECS Dev Desktop used standard OpenID Connect coordinates and had no Shauth deployment-platform knowledge.
- Cross-origin authorization and logout transitions used full-document navigation, never React Server Component or client data fetching.
- Shauth catalog launch, direct entry, relying-party logout, provider logout, Back-Channel Logout, and fail-closed behavior remained one real-browser acceptance contract.
- Cloud resources remained the source of truth; simulators differed only by endpoint coordinates.
- ARM64 remained the production default, published images remained multi-architecture, and deployable image coordinates remained immutable source-commit prefixes.
- Image workflows only published OCI artifacts; Terraform exclusively registered
  task definitions and attached their revisions to ECS services and Scheduler.
- Optional deployment components were controlled by explicit topology, never by silent missing-resource fallbacks.
- One branch and one pull request remained active at a time; the user merged pull requests.
- Every noticed defect was fixed or recorded in [BUGS.md](BUGS.md).
