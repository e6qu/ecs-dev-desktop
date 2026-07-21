# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-21

## Current branch

The `fix/shauth-sso-terminal-contract` branch completed the ECS Dev Desktop
relying-party contract for Shauth and the real browser terminal. Direct entry and
catalog launch used standard OpenID Connect, application logout ended the Shauth
session, and the browser returned to the persistent ECS Dev Desktop `/signed-out`
page through the app-owned `/auth/shauth/logout/complete` bridge with an explicit
`Sign in with Shauth` control. The bridge ignored request query parameters and
could not select a destination. Invalid local credentials returned to the login
page instead of surfacing a production HTTP 500.

The Shauth release-validator boundary stayed deployment-neutral. ECS Dev Desktop
exposed its immutable source revision and build time through `/api/healthz`, used
`/auth/validation` as its authenticated validation page, and used `/signed-out` as its
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

Every GitHub Actions job had an explicit timeout of at most 15 minutes. Long
end-to-end, Terraform-simulator, and golden-image work was split into bounded
matrix jobs without weakening the real acceptance surfaces. Fixture-package
retention streamed paginated GitHub API rows through the current GitHub CLI
instead of combining its mutually exclusive `--slurp` and `--jq` options. The
workspace base and omnibus fixtures ran as separate exact run-scoped GitHub
Container Registry publications while the simulator fixture remained independent;
the measured jobs completed in 5m17s and 12m12s. One shared POSIX-shell retention
helper kept the newest 20 versions of each package and retried only bounded,
idempotent transient GitHub API failures.

## Verified state

- The real Shauth, Ory Hydra, PostgreSQL, DynamoDB, production Next.js, Sockerless AWS simulator, and Chromium contract passed against merged Shauth commit `08f5a78fb8b159fcbfe8317f24f430dbdfd3ed56`.
- Direct entry, catalog launch, silent SSO reuse, `/me`, relying-party logout, provider global logout, Back-Channel Logout revocation, and fail-closed re-entry passed in one browser lifecycle.
- The app-owned completion bridge returned only to Shauth's issuer-origin completion endpoint; hostile query parameters and a consumed-correlation replay remained on Shauth's safe signed-out page.
- The sentinel Shauth validator credential failed every ECS Dev Desktop local credential shape; exact-issuer OpenID Connect succeeded.
- The 13-file container-mode Sockerless AWS simulator suite passed 37/37 tests, including browser terminal input, PTY teardown, IDE bridges, SSH, heartbeats, snapshots, wake, and ECS lifecycle.
- Every production-web process started by the container-mode and portal Playwright suites received the exact checked-out Git revision when no deployment revision was supplied, while explicit deployment revisions remained authoritative. Config-level regression coverage kept both Playwright production-server launchers on the shared release-environment contract.
- The complete Chromium portal suite passed 31/31 tests, including stable sign-out plus WCAG contrast in light and dark mode.
- Language-variant image tests and GitHub App tests no longer reported skipped success when their required images or coordinates were absent.
- Repository lint, unit/integration tests, production build, formatting, ShellCheck, and pre-commit checks passed.
- Monaco Editor `0.56.0` was current in both consumers; the first-party editor and demo used its canonical export paths and production bundles contained their real editor, JSON, and TypeScript worker assets.

## Deployment boundary

The private `e6qu/infra` repository remained the sole deployment owner. Shauth's
application-registration schema had merged, and Infra retained responsibility for adding the opaque release revision,
`https://app.edd.dev.e6qu.dev/auth/validation` validation URL, and
`https://app.edd.dev.e6qu.dev/signed-out` signed-out URL, and registering
`https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete` as the sole
post-logout redirect after both application contracts merged.

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
