# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

The branch left no unresolved local CI acceptance work; release and deployment
remained the next shared-environment steps.

1. The main-only publication workflow needed to publish the merged commit's exact 12-character ARM64, AMD64, and multi-architecture image references.
2. The private `e6qu/infra` development environment needed to pin the published immutable image, register ECS Dev Desktop's opaque release revision, `/auth/validation` validation URL, `/signed-out` signed-out URL, and exact `/auth/shauth/logout/complete` post-logout bridge, and apply synchronized `main`.
3. The deployed acceptance matrix needed to repeat direct entry, Shauth catalog launch, silent SSO, local and global logout, validator checks, browser terminal typing, PTY close, SSH, and stop/wake persistence against the live endpoint.

## Dev environment: enable git access

The shared dev environment (`e6qu/infra`) still configures no GitHub App and no GitHub sign-in, so its Health board reports `git-integration` degraded and users can clone private repositories only with their generated SSH keys. Installing a GitHub App on the `e6qu` org and supplying `EDD_GITHUB_APP_ID` + `EDD_GITHUB_APP_KEY` (see `docs/deploying.md`, _Git access for sessions_) restores repository browsing and creation in the launcher and HTTPS clone/push without per-user setup.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
