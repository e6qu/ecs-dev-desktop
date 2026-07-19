// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dev-auth shim constants (Phase 3 replaces this with Auth.js). Documented here
 * so there are no magic strings in the request-handling code.
 */
/** When set to "1", dev-header auth is honoured (never in production). */
export const DEV_AUTH_ENV = "EDD_DEV_AUTH";
export const DEV_AUTH_ENABLED = "1";
/** Header carrying the caller's user id under dev-header auth. */
export const USER_ID_HEADER = "x-edd-user-id";
/** Header carrying the caller's role under dev-header auth. */
export const ROLE_HEADER = "x-edd-role";
/** Cookies carrying the dev principal in a browser (Playwright e2e) — the browser
 * can't set custom headers, so the same dev-auth shim also reads these cookies. */
export const DEV_USER_COOKIE = "edd-dev-user";
export const DEV_ROLE_COOKIE = "edd-dev-role";

/** "View as" persona override cookie — a signed-in caller may downgrade their own
 * effective role (never escalate; clamped server-side against their real role
 * every time it's read). Applies in both dev-auth and production, independent of
 * the IdP/session mechanism. */
export const PERSONA_COOKIE = "edd-persona";
/** Schema version prefix inside the persona cookie's value (`<version>:<role>`),
 * per §6.5a: persisted state that outlives code changes carries a version, and a
 * reader accepts ONLY the current one — any other shape reads as "no override"
 * (fail-soft; the next write replaces it), never an error the user must clear
 * cookies to escape. Bump when the value shape changes. */
export const PERSONA_COOKIE_SCHEMA_VERSION = "1";

/** Comma-separated IdP group ids/slugs that grant the admin role. */
export const ADMIN_GROUPS_ENV = "EDD_ADMIN_GROUPS";
/** Comma-separated IdP group ids/slugs that grant the developer role. */
export const DEVELOPER_GROUPS_ENV = "EDD_DEVELOPER_GROUPS";

/** Override the GitHub REST API base URL (GitHub Enterprise, or the github sim). */
export const GITHUB_API_URL_ENV = "AUTH_GITHUB_API_URL";
/** Override the GitHub WEB base URL (GitHub Enterprise, or the github sim) —
 * sets the OAuth authorize/token endpoints via the provider's standard
 * `enterprise.baseUrl` option. Endpoint-only (§6.8); unset = github.com. */
export const GITHUB_URL_ENV = "AUTH_GITHUB_URL";

/** Shauth OpenID Connect issuer and confidential-client coordinates. */
export const SHAUTH_ISSUER_ENV = "AUTH_SHAUTH_ISSUER";
export const SHAUTH_CLIENT_ID_ENV = "AUTH_SHAUTH_ID";
export const SHAUTH_CLIENT_SECRET_ENV = "AUTH_SHAUTH_SECRET";
export const SHAUTH_POST_LOGOUT_URL_ENV = "AUTH_SHAUTH_POST_LOGOUT_URL";

/** GitHub App credentials. When BOTH are set, GitHub operations + the clone/push
 * broker act as the App (installation tokens) instead of the user's OAuth token.
 * `EDD_GITHUB_APP_KEY` is the RSA private key PEM (or base64-encoded PEM). */
export const GITHUB_APP_ID_ENV = "EDD_GITHUB_APP_ID";
export const GITHUB_APP_KEY_ENV = "EDD_GITHUB_APP_KEY";

/**
 * Machine-auth for non-interactive callers (per-workspace HMAC bearer tokens,
 * see `machine-auth.ts`). Two trust domains, two secrets:
 *   - the idle-agent inside each workspace container (heartbeat route);
 *   - the SSH gateway service (wake-on-connect routes).
 */
/** Env var on the control plane: 32-byte hex secret used to generate agent tokens. */
export const AGENT_SECRET_ENV = "EDD_AGENT_SECRET";
/** Env var on the control plane: 32-byte hex secret used to derive each workspace's
 * OpenVSCode connection token. The compute provider injects the per-workspace token
 * into the task (`CONNECTION_TOKEN`); the in-app editor proxy derives the same value
 * to hand the authenticated browser its `?tkn=`. */
export const CONNECTION_SECRET_ENV = "EDD_CONNECTION_SECRET";
/** Env var on the control plane AND the SSH gateway: 32-byte hex secret the
 * gateway derives per-workspace wake-on-connect tokens from. */
export const GATEWAY_SECRET_ENV = "EDD_GATEWAY_SECRET";
/** Bearer token header sent by machine callers (idle-agent, SSH gateway). */
export const MACHINE_AUTH_HEADER = "authorization";
