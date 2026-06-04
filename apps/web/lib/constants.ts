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

/** Comma-separated IdP group ids/slugs that grant the admin role. */
export const ADMIN_GROUPS_ENV = "EDD_ADMIN_GROUPS";
/** Comma-separated IdP group ids/slugs that grant the member role. */
export const MEMBER_GROUPS_ENV = "EDD_MEMBER_GROUPS";

/** Override the GitHub REST API base URL (GitHub Enterprise, or the bleephub sim). */
export const GITHUB_API_URL_ENV = "AUTH_GITHUB_API_URL";
