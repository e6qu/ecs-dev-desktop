# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-20

## Current branch

The `fix/shauth-sso-terminal-contract` branch completed the ECS Dev Desktop
relying-party contract for Shauth and the real browser terminal. Direct entry and
catalog launch used standard OpenID Connect, application logout ended the Shauth
session, and the browser returned to the persistent ECS Dev Desktop `/signed-out`
page with an explicit `Sign in with Shauth` control. Invalid local credentials
returned to the login page instead of surfacing a production HTTP 500.

The Shauth release-validator boundary stayed deployment-neutral. ECS Dev Desktop
exposed its immutable source revision and build time through `/api/healthz`, used
`/workspaces` as its authenticated validation page, and used `/signed-out` as its
stable signed-out page. Shauth validator credentials were absent from the
application runtime and were rejected through Basic auth, bearer/API-key auth,
development identity headers and cookies, and the local-account form. Only a
real exact-issuer Shauth OpenID Connect exchange established an application
session. The real provider bootstrap password was injected only into Shauth and
the isolated browser validator, while Terraform rejected every Shauth bootstrap
or validator variable from both the plain and secret control-plane environments.

The first-party Monaco terminal gained explicit tab-close signaling and terminated
the complete PTY process group. The browser test typed commands into two real PTYs,
observed both shells, closed one tab, verified that its shell exited, and then
proved stop/wake storage persistence. The general end-to-end job installed its
pinned Chromium runtime before that browser lifecycle and preserved the primary
startup error during cleanup. The live simulator harness selected
`host.containers.internal` on Podman and `host.docker.internal` on Docker, fixing
idle-agent heartbeat and SSH authorization reachability in nested awsvpc tasks.

## Verified state

- The real Shauth, Ory Hydra, PostgreSQL, DynamoDB, production Next.js, and Chromium contract passed against Shauth `main` at `6d06480`.
- Direct entry, catalog launch, silent SSO reuse, `/me`, relying-party logout, provider global logout, Back-Channel Logout revocation, and fail-closed re-entry passed in one browser lifecycle.
- The sentinel Shauth validator credential failed every ECS Dev Desktop local credential shape; exact-issuer OpenID Connect succeeded.
- The 13-file container-mode Sockerless AWS simulator suite passed 37/37 tests, including browser terminal input, PTY teardown, IDE bridges, SSH, heartbeats, snapshots, wake, and ECS lifecycle.
- The complete Chromium portal suite passed 31/31 tests, including stable sign-out plus WCAG contrast in light and dark mode.
- Language-variant image tests and GitHub App tests no longer reported skipped success when their required images or coordinates were absent.
- Repository lint, unit/integration tests, production build, formatting, ShellCheck, and pre-commit checks passed.

## Deployment boundary

The private `e6qu/infra` repository remained the sole deployment owner. Shauth's
new application-registration schema had not yet merged while this branch was
prepared, so Infra retained responsibility for adding the opaque release revision,
`https://app.edd.dev.e6qu.dev/workspaces` validation URL, and
`https://app.edd.dev.e6qu.dev/signed-out` signed-out URL after both application
contracts merged.

## Durable invariants

- ECS Dev Desktop used standard OpenID Connect coordinates and had no Shauth deployment-platform knowledge.
- Validator credentials authenticated only to Shauth and never appeared in ECS Dev Desktop configuration, environment, cookies, or application auth paths.
- Cross-origin authorization and logout transitions used full-document navigation, never React Server Component or client data fetching.
- Sign-out from ECS Dev Desktop ended the shared Shauth session and returned to ECS Dev Desktop, not to the provider portal.
- Browser terminal acceptance required real keystrokes, real PTYs, observable process teardown, and persistent storage across stop/wake.
- Cloud resources remained the source of truth; simulators differed only by endpoint coordinates.
- Missing tools, images, or credentials failed required tests instead of producing skipped green results.
- One branch and one pull request remained active at a time; the user merged pull requests.
- Every noticed defect was fixed or recorded in [BUGS.md](BUGS.md).
