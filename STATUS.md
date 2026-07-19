# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-19

## Current branch

The `fix/explicit-release-topology` branch made the release pipeline safe for both first publication and established deployments. Release bootstrap used the configured Amazon ECS cluster rather than deriving a private cluster name, discovered the real Amazon ECS and Amazon EventBridge Scheduler topology, and wrote explicit deployment and optional SSH-gateway booleans. Image publication still produced both per-architecture images and the multi-architecture manifests when the application stack did not exist, while deployment and post-deployment smoke ran only after bootstrap had proved the required runtime resources existed.

The release artifact always recorded whether a deployment occurred. The post-deployment workflow resolved that artifact before allocating its long-running browser-smoke runner, so a publication-only release neither claimed a deployment nor launched a false smoke failure. An explicitly disabled SSH gateway was distinct from missing enabled infrastructure; enabled components still failed loudly when their service, task definition, schedule, or permission was absent.

## Verified state

- The complete pre-commit gate passed: formatting, workflow lint, Terraform validation, ESLint, the complete TypeScript build and unit suite, lockfile consistency, dead-code analysis, and copy/paste analysis.
- ShellCheck and Bash/zsh parsing passed for the changed release scripts.
- The release deployer rejected invalid topology values before any AWS operation.
- The Terraform simulator CI contract exercised both the SSH-disabled and SSH-enabled release paths through the real Sockerless AWS simulator APIs.

## Deployment boundary

The private `e6qu/infra` repository owned the shared `dev.e6qu.dev` environment. Its matching change supplied `EDD_IMAGE_SOURCE_REPO` and `EDD_IMAGE_SOURCE_BRANCH`, exported the configured SSH topology, and passed that topology into release bootstrap. The live control plane remained incomplete until those infrastructure and application changes merged, exact-main Terragrunt applied them, release bootstrap was rerun, and the deployed browser acceptance suite passed.

## Durable invariants

- ECS Dev Desktop used standard OpenID Connect coordinates and had no Shauth deployment-platform knowledge.
- Cloud resources remained the source of truth; simulators differed only by endpoint coordinates.
- ARM64 remained the production default, published images remained multi-architecture, and deployable image coordinates remained immutable source-commit prefixes.
- Optional deployment components were controlled by explicit topology, never by silent missing-resource fallbacks.
- One branch and one pull request remained active at a time; the user merged pull requests.
- Every noticed defect was fixed or recorded in [BUGS.md](BUGS.md).
