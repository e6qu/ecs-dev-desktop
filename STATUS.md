# STATUS.md — ecs-dev-desktop

> Current project snapshot. Durable history lives in git and [WHAT_WE_DID.md](WHAT_WE_DID.md).

**Last updated:** 2026-07-19

## Current branch

The `fix/shauth-launch-route` branch completed the Shauth browser-session lifecycle. The catalog launch coordinate moved from a React Server Component into a Next.js Route Handler, so Auth.js created the authorization request inside a request context that was permitted to write callback, state, PKCE, and nonce cookies. Shauth sessions also retained their verified provider `sid`, `sub`, and ID token in the durable application-session record. Signing out used standard RP-Initiated Logout and returned to the EDD-origin `/signed-out` landing accepted by Ory Hydra. Signed OIDC Back-Channel Logout tokens revoked every local session correlated through `sid`, `sub`, or both, and a durable one-use `jti` record rejected replays. Non-Shauth sessions returned to the ordinary login page without claiming a global Shauth logout. Every durable session carried complete provider-session facets, preserving GitHub, Microsoft Entra ID, and local-account sign-in alongside Shauth global logout.

## Verified state

- The Shauth launch regression tests covered configured and unconfigured provider states.
- The production Next.js bundle built successfully and emitted `/login/shauth` as a dynamic route.
- A running production bundle returned a 307 to Shauth and set Auth.js callback, state, PKCE, and nonce cookies instead of returning HTTP 500.
- Real DynamoDB integration coverage proved atomic primary-index `sid`/`sub` correlation, replay rejection, and multi-session revocation without relying on eventually-consistent global secondary indexes.
- Real asymmetric JWT coverage proved issuer, audience, age, event, `sid`/`sub`, `jti`, expiry, and prohibited-`nonce` enforcement for Back-Channel Logout.
- Configuration coverage rejected the former cross-origin Shauth-portal post-logout URL and required the exact EDD `/signed-out` coordinate on the stable Auth.js origin.
- The complete web unit suite passed, the complete web integration suite passed 156 tests against the real Sockerless AWS simulator, and the production bundle emitted the direct launch, callback, back-channel, and signed-out routes.
- Chromium rendered the hydrated `/signed-out` page with the shared-session outcome and explicit fresh-sign-in choices.

## Deployment boundary

The private `e6qu/infra` repository owned the shared `dev.e6qu.dev` environment. The live control plane still required the merged immutable ARM64 image plus the callback `https://app.edd.dev.e6qu.dev/api/auth/callback/shauth`, post-logout `https://app.edd.dev.e6qu.dev/signed-out`, and back-channel `https://app.edd.dev.e6qu.dev/api/auth/shauth/backchannel-logout` coordinates to be registered, pinned, and applied before the complete deployed login/logout matrix could prove the repair.

## Durable invariants

- ECS Dev Desktop used standard OpenID Connect coordinates and had no Shauth deployment-platform knowledge.
- Cloud resources remained the source of truth; simulators differed only by endpoint coordinates.
- ARM64 remained the production default, published images remained multi-architecture, and deployable image coordinates remained immutable source-commit prefixes.
- Optional deployment components were controlled by explicit topology, never by silent missing-resource fallbacks.
- One branch and one pull request remained active at a time; the user merged pull requests.
- Every noticed defect was fixed or recorded in [BUGS.md](BUGS.md).
