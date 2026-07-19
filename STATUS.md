# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-19

## Current branch

The `fix/shauth-sso-provider` branch hardened the merged Shauth OpenID Connect integration without removing GitHub, Microsoft Entra ID, or administrator-managed local accounts. Each external provider was registered and displayed only when its complete confidential-client coordinates were present; partial provider credentials failed configuration instead of exposing a broken login. Shauth additionally accepted only absolute HTTPS issuer/portal URLs, required PKCE, state, and nonce, retained `offline_access` for refresh tokens, and validated Shauth's exact subject, username, email, picture, and authoritative `developer`/`admin` role before creating an application session.

The application exposed `/login/shauth` as its catalog launch coordinate. Sign-out revoked the durable Auth.js session before clearing all chunked session cookies, then returned to the configured Shauth applications portal. A signed-out browser therefore could not continue using the prior ECS Dev Desktop session while the central Shauth SSO session remained available for silent re-entry.

The merged shared-environment mode reused an environment-owned VPC, subnets, NAT path, gateway endpoints, and Amazon ECS cluster. This branch added Terraform state moves for the formerly singleton VPC, internet gateway, public route table, S3 and DynamoDB gateway endpoints, cluster, and cluster capacity providers so standalone upgrades preserved those resources.

The deployment image contract became immutable end to end. The Terraform module required a 7-40 character lowercase hexadecimal source-commit prefix instead of defaulting to `main`; the control-plane Amazon ECR repository became immutable; publication refused dirty or mismatched source; and the installer, release deployer, complete example, Terragrunt example, simulator fixture, and module documentation all enforced the same coordinate. Published images retained the bare multi-architecture manifest plus `-amd64` and `-arm64` per-architecture tags.

## Verified state

- The complete pre-commit gate passed: formatting, workflow lint, Terraform validation, ESLint, TypeScript, unit and fuzz tests, lockfile consistency, dead-code analysis, and copy/paste analysis.
- `pnpm --filter @edd/web test` passed 48 files and 297 tests.
- `pnpm build` passed all 22 build tasks and emitted the dynamic `/login/shauth` route.
- `terraform test` passed the mock-provider shared-environment plan contract.
- ShellCheck and negative installer/release-deployer checks proved that mutable or missing image tags failed before AWS mutation.
- The GitHub Actions shell sweep followed checked-in source directives on both Linux and macOS, removed the unused untrusted Homebrew tap before package installation, and matched the immutable ECR contract without asking the API-only simulator runtime to execute containers.
- A real local Sockerless AWS simulator apply created 146 resources, reported the control-plane repository as immutable and the service at desired/running `0/0`, produced an idempotent no-change plan with no container-runtime errors, and destroyed all 146 resources.
- Every age-eligible AWS SDK client resolved to `3.1090.0`; the exact CI dependency gate passed.
- The branch was rebased onto `origin/main` after Shauth PR #245 and shared-environment PR #246 merged.

## Deployment boundary

The reusable module remained in this repository. The private `e6qu/infra` repository owned the shared `dev.e6qu.dev` Terragrunt environment and would pin the merged immutable module and image revisions. ECS Dev Desktop was not considered live in that environment until the infrastructure change was merged, applied from exact `main`, and the direct-entry plus Shauth-portal browser flows passed against the deployed service.

## Durable invariants

- ECS Dev Desktop used standard OpenID Connect coordinates and had no Shauth deployment-platform knowledge.
- Cloud resources remained the source of truth; simulators differed only by endpoint coordinates.
- ARM64 remained the production default, published images remained multi-architecture, and deployable image coordinates remained immutable source-commit prefixes.
- One branch and one pull request remained active at a time; the user merged pull requests.
- Every noticed defect was fixed or recorded in [BUGS.md](BUGS.md).
