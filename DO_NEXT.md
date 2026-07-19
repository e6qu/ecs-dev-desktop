# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

1. The Shauth bootstrap-reconciliation repair needed to merge and publish its immutable ARM64 image.
2. The matching private `e6qu/infra` change needed to merge and be applied from exact synchronized `main`, supplying the required image-source repository/branch coordinates and the explicit disabled-SSH topology.
3. Release bootstrap needed to run again after the complete infrastructure apply so `RELEASE_ECS_CLUSTER=dev` and `RELEASE_DEPLOYMENT_ENABLED=true` reflected the shared cluster, control-plane service, task definitions, and reconciler schedule.
4. The release workflow needed to roll the published ARM64 control-plane image and reconciler task definition, after which the post-deployment smoke needed to consume the deployed artifact.
5. Deployed acceptance needed to prove direct and Shauth-catalog entry, silent SSO reuse, `/me`, local logout, global logout, and all four workspace/editor flows without 4xx/5xx, browser-console, lifecycle, persistence, or cleanup failures.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, reconciler task-definition tagging, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- SSH ingress remained deliberately disabled in the low-cost shared development topology; enabling it required an explicit architecture/cost decision and `ssh_base_domain`, not an implicit release-side resource assumption.
- The environment's next infrastructure plan still required a persistent-resource deletion audit before apply.
