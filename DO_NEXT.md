# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

1. The Shauth launch and global-session repair needed to merge and publish its immutable ARM64 image.
2. The private `e6qu/infra` development environment needed to pin that image; set `AUTH_URL=https://app.edd.dev.e6qu.dev` and `AUTH_SHAUTH_POST_LOGOUT_URL=https://app.edd.dev.e6qu.dev/signed-out`; register callback `https://app.edd.dev.e6qu.dev/api/auth/callback/shauth`, post-logout `https://app.edd.dev.e6qu.dev/signed-out`, and Back-Channel Logout with session correlation required at `https://app.edd.dev.e6qu.dev/api/auth/shauth/backchannel-logout`; enable the DynamoDB TTL change; and apply it from exact synchronized `main`.
3. Deployed acceptance needed to prove direct and Shauth-catalog entry, silent SSO reuse, `/me`, provider-coordinated global logout, and all four workspace/editor flows without 4xx/5xx, browser-console, lifecycle, persistence, or cleanup failures.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, reconciler task-definition tagging, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`, not an implicit release-side resource assumption.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
