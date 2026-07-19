# DO_NEXT.md — ecs-dev-desktop

> Immediate work remaining after the current branch. Durable defects live in [BUGS.md](BUGS.md).

## Release and shared-development deployment

1. The Shauth lifecycle-hardening branch needed to merge through its single pull request and publish its immutable multi-architecture image.
2. The private `e6qu/infra` development environment needed to pin the merged module and image revisions, register the `ecs-dev-desktop-dev` Shauth client, add ECS Dev Desktop to the Shauth app catalog, and inject only AWS Secrets Manager ARNs for secret values.
3. The environment needed to set `AUTH_SHAUTH_ISSUER`, `AUTH_SHAUTH_ID`, and `AUTH_SHAUTH_POST_LOGOUT_URL`, while sourcing `AUTH_SHAUTH_SECRET` from AWS Secrets Manager.
4. Terragrunt needed to be applied only from an exact, synchronized `main` branch after the infrastructure pull request merged.
5. The deployed acceptance run needed to prove both entry paths in a real browser:
   - direct ECS Dev Desktop entry while signed out redirected through Shauth and returned to the application;
   - Shauth app-catalog entry reused the existing Shauth session without another GitHub prompt;
   - `/me` showed the exact Shauth subject, name, icon, and role;
   - local logout revoked the ECS Dev Desktop session but preserved the Shauth SSO session;
   - re-entry silently created a fresh application session;
   - global Shauth logout invalidated access and did not fail open;
   - callback, consent, identity, readiness, and logout requests emitted no 4xx/5xx, browser console error, or failed network request.

## Existing product follow-ups

- The open CodeBuild ARM64 bootstrap, IAM propagation, reconciler task-definition tagging, and per-task `DescribeTasks` tolerance defects remained tracked in [BUGS.md](BUGS.md).
- Live workspace/editor verification remained mandatory after deployment: OpenVSCode, Monaco, Terminal, opencode, SSH, lifecycle, persistence, and cleanup all had to pass against real Amazon ECS Fargate resources.
- The environment's eventual infrastructure plan needed a persistent-resource deletion audit before apply.
