# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-20

## Current branch

The `fix/shauth-direct-entry` branch completed ECS Dev Desktop's browser-level Shauth SSO contract. Direct entry through `/` or `/workspaces` entered Shauth with a full-document navigation, so Next.js React Server Component fetching could not turn the cross-origin OpenID Connect redirect into a browser CORS failure. The catalog launch coordinate remained the canonical application root, an existing Shauth browser session returned silently without a second credential prompt, and the account page exposed the authenticated identity. Relying-party logout ended the Shauth session and returned to the EDD-origin `/signed-out` landing; provider-initiated logout delivered a signed Back-Channel Logout token that revoked the correlated durable EDD session. Subsequent direct entry failed closed at Shauth instead of exposing an authenticated workspace.

The CI contract exercised the real Shauth and Ory Hydra services, a production Next.js bundle, real DynamoDB and Amazon ECS coordinates provisioned through the pinned Sockerless AWS simulator, and a real headless Chromium browser. It used no mock identity provider, fake cloud provider, synthetic HTTP response, or `oauth2-proxy` dependency.

## Verified state

- Direct root and `/workspaces` entry redirected through Shauth and returned to the authenticated workspace list.
- Shauth catalog entry used `/` as the canonical launch URL and reused the existing Shauth session without requesting credentials again.
- `/me` rendered the authenticated email and administrator role.
- ECS Dev Desktop sign-out ended the provider session and returned to `/signed-out` on the ECS Dev Desktop origin.
- Shauth global sign-out delivered a signed Back-Channel Logout token, revoked the durable ECS Dev Desktop session, and made the next direct entry require Shauth authentication.
- Invalid or absent Shauth configuration continued to fail closed.
- The complete monorepo lint, unit/integration test, production build, ShellCheck, and real Chromium Shauth SSO suites passed.

## Deployment boundary

The private `e6qu/infra` repository owned the shared `dev.e6qu.dev` environment. The live control plane still required this branch's merged immutable ARM64 image to be published, pinned, and applied before the complete deployed login/logout matrix could prove the repair at `https://app.edd.dev.e6qu.dev`.

## Durable invariants

- ECS Dev Desktop used standard OpenID Connect coordinates and had no Shauth deployment-platform knowledge.
- Cross-origin authorization and logout transitions used full-document navigation, never React Server Component or client data fetching.
- Shauth catalog launch, direct entry, relying-party logout, provider logout, Back-Channel Logout, and fail-closed behavior remained one real-browser acceptance contract.
- Cloud resources remained the source of truth; simulators differed only by endpoint coordinates.
- ARM64 remained the production default, published images remained multi-architecture, and deployable image coordinates remained immutable source-commit prefixes.
- Optional deployment components were controlled by explicit topology, never by silent missing-resource fallbacks.
- One branch and one pull request remained active at a time; the user merged pull requests.
- Every noticed defect was fixed or recorded in [BUGS.md](BUGS.md).
