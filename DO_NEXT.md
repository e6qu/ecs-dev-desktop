# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

The branch left no unresolved local CI acceptance work; release and deployment
remained the next shared-environment steps.

1. The main-only publication workflow needed to publish the merged commit's exact 12-character ARM64, AMD64, and multi-architecture image references.
2. The private `e6qu/infra` development environment needed to pin the published immutable image, register ECS Dev Desktop's opaque release revision, `/auth/validation` validation URL, `/signed-out` signed-out URL, and exact `/auth/shauth/logout/complete` post-logout bridge, and apply synchronized `main`.
3. The deployed acceptance matrix needed to repeat direct entry, Shauth catalog launch, silent SSO, local and global logout, validator checks, browser terminal typing, PTY close, SSH, and stop/wake persistence against the live endpoint.

## Open decision: the simulator pin

The pinned `third_party/sockerless` (`b5126463`, 2026-07-07) is 127 commits behind upstream `main` and predates the `#906` awsvpc-resolver fix that explains multi-minute silent container starts; the shared dev environment showed 185 s and 239 s starts on 2026-09-06 (`BUGS.md`, external blockers, `#931`). Upstream `#922` since moved the simulators into `e6qu/sockerless-cloud`, consumed as pinned modules, so the next bump is a restructuring of how `docker-compose.tier2.yml`/`.e2e.yml` build the sim (submodule of the new repo, or a published image coordinate), not a one-line pin change. This needs a decision before the work starts; until then the dev environment's slow starts should be verified against a simulator build that includes `#906`.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
