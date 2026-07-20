# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

1. The main-only publication workflow needed to publish the merged commit's exact
   12-character tag and verified ARM64, AMD64, and multi-architecture references.
2. The release and smoke OIDC bootstraps needed to be run once so the legacy
   release role lost deployment permissions and the separately scoped smoke role
   and repository variables existed.
3. The private `e6qu/infra` development environment needed to pin that exact image
   and apply it from synchronized `main`. Its Shauth client coordinates remained
   callback `https://app.edd.dev.e6qu.dev/api/auth/callback/shauth`, post-logout
   `https://app.edd.dev.e6qu.dev/signed-out`, and Back-Channel Logout
   `https://app.edd.dev.e6qu.dev/api/auth/shauth/backchannel-logout` with session
   correlation required.
4. An operator then needed to dispatch post-deployment smoke with the exact applied
   12-character tag and repeat the full live browser/workspace acceptance matrix.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, and per-task `DescribeTasks`
  tolerance defects remained tracked in [BUGS.md](BUGS.md). Terraform task-definition
  tags now supplied reconciler cost attribution without a release-side registration
  path.
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`, not an implicit release-side resource assumption.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
