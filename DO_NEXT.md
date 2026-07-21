# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

1. The main-only publication workflow needed to publish the merged commit's exact 12-character ARM64, AMD64, and multi-architecture image references.
2. Shauth commit `74735a1710fa69d472e7eb27ae95ce317c7c1a3d` needed to merge before Infra registered ECS Dev Desktop's opaque release revision, `/auth/validation` validation URL, `/signed-out` signed-out URL, and exact `/auth/shauth/logout/complete` post-logout bridge.
3. The private `e6qu/infra` development environment needed to pin the published immutable image and apply synchronized `main`.
4. The deployed acceptance matrix needed to repeat direct entry, Shauth catalog launch, silent SSO, local and global logout, validator checks, browser terminal typing, PTY close, SSH, and stop/wake persistence against the live endpoint.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
