# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

1. The direct-entry Shauth SSO repair needed to merge and publish its immutable ARM64 image.
2. The private `e6qu/infra` development environment needed to pin that exact image and apply it from synchronized `main`. Its Shauth client coordinates remained callback `https://app.edd.dev.e6qu.dev/api/auth/callback/shauth`, post-logout `https://app.edd.dev.e6qu.dev/signed-out`, and Back-Channel Logout `https://app.edd.dev.e6qu.dev/api/auth/shauth/backchannel-logout` with session correlation required.
3. Deployed acceptance needed to repeat the real-browser contract against `https://app.edd.dev.e6qu.dev`: direct root and `/workspaces` entry, Shauth catalog launch at `/`, silent SSO reuse, `/me`, ECS Dev Desktop logout returning locally, Shauth global logout, Back-Channel Logout revocation, fail-closed re-entry, and all workspace/editor flows without 4xx/5xx or browser-console failures.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, reconciler task-definition tagging, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`, not an implicit release-side resource assumption.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
