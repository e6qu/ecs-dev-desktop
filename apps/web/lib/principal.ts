// SPDX-License-Identifier: AGPL-3.0-or-later
import { effectiveRole, isRole, type Principal } from "@edd/authz";
import { ownerId } from "@edd/core";
import type { Session } from "next-auth";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  DEV_ROLE_COOKIE,
  DEV_USER_COOKIE,
  PERSONA_COOKIE,
  PERSONA_COOKIE_SCHEMA_VERSION,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "./constants";
import { recordSystemActivity } from "./system-activity";

/**
 * Whether the dev-auth shim is active (`EDD_DEV_AUTH=1`) — never in production. Dev-auth
 * derives the whole principal (identity AND role, up to `admin`) from request
 * headers/cookies with no IdP, so the deployment MUST NOT set `EDD_DEV_AUTH` in prod (it
 * doesn't — see `extra_environment`). A `NODE_ENV=production` backstop can't be used here:
 * the Playwright harness legitimately runs a PRODUCTION build with `EDD_DEV_AUTH=1`, so
 * keying off `NODE_ENV` would break the test harness (and any prod-build-with-dev-auth
 * staging). A backstop keyed on an explicit real-prod signal is tracked in DO_NEXT.
 */
export function devAuthEnabled(): boolean {
  return process.env[DEV_AUTH_ENV] === DEV_AUTH_ENABLED;
}

/** Decode the persona cookie's `<version>:<role>` value. Any shape other than the
 * CURRENT schema version — a legacy un-prefixed value, a future version, or plain
 * garbage — reads as "no override" (§6.5a: loaders accept only the current
 * version, and a stale cookie must degrade, never block, the user; the next
 * persona write replaces it). Exported for property testing. */
export function decodePersonaCookie(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const sep = raw.indexOf(":");
  if (sep === -1) return undefined;
  if (raw.slice(0, sep) !== PERSONA_COOKIE_SCHEMA_VERSION) return undefined;
  return raw.slice(sep + 1);
}

/** Encode a persona role into the cookie's current `<version>:<role>` shape. */
export function encodePersonaCookie(role: string): string {
  return `${PERSONA_COOKIE_SCHEMA_VERSION}:${role}`;
}

/** Apply a "view as" persona override on top of the real principal (downgrade-only,
 * see {@link effectiveRole}). Unchanged when no override cookie is present, it has
 * a stale/foreign schema, or it doesn't differ from the real role. */
export function withPersona(
  principal: Principal,
  personaCookieValue: string | undefined,
): Principal {
  const effective = effectiveRole(principal.role, decodePersonaCookie(personaCookieValue));
  return effective === principal.role
    ? principal
    : { ...principal, role: effective, realRole: principal.role };
}

/** Build a principal from a candidate id/role pair (rejects unknown roles). */
function devPrincipal(id: string | undefined, role: string | undefined): Principal | null {
  if (id === undefined || role === undefined || !isRole(role)) return null;
  return { id: ownerId(id), role };
}

/** Pure: extract the principal from an Auth.js session. */
export function principalFromSession(session: Session | null): Principal | null {
  if (session === null) return null;
  const id = session.user.id;
  const role = session.user.role;
  if (id === undefined || role === undefined) return null;
  if (typeof id !== "string") throw new Error("Auth.js session user id is not a string");
  if (typeof role !== "string" || !isRole(role)) {
    throw new Error("Auth.js session user role is invalid");
  }
  const sessionEmail = session.user.email;
  const sessionName = session.user.name;
  const sessionImage = session.user.image;
  return {
    id: ownerId(id),
    role,
    ...(typeof sessionName === "string" && sessionName.length > 0
      ? { displayName: sessionName }
      : {}),
    ...(typeof sessionImage === "string" && sessionImage.length > 0 ? { image: sessionImage } : {}),
    ...(typeof sessionEmail === "string" && sessionEmail.length > 0 ? { email: sessionEmail } : {}),
  };
}

/** Parse one cookie's value out of a `Cookie:` header (URL-decoded), or undefined
 * when absent. Exported for property testing (never throws on a malformed header:
 * `decodeURIComponent` throws a URIError on truncated percent-escapes like a bare
 * `%` — and the Cookie header is attacker-controlled on every request — so a value
 * that fails to decode is returned raw instead; downstream validators reject
 * garbage values anyway). */
export function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

/**
 * Dev principal from a request — the `x-edd-*` headers (integration tests) or, for a
 * real browser that can't set custom headers, the `edd-dev-*` cookies (Playwright).
 * Only consulted when `EDD_DEV_AUTH=1`.
 */
function devRequestPrincipal(req: Request): Principal | null {
  const cookies = req.headers.get("cookie");
  const id = req.headers.get(USER_ID_HEADER) ?? cookieValue(cookies, DEV_USER_COOKIE);
  const role = req.headers.get(ROLE_HEADER) ?? cookieValue(cookies, DEV_ROLE_COOKIE);
  return devPrincipal(id ?? undefined, role ?? undefined);
}

/**
 * Resolve the caller's principal for an API route. In production this is the Auth.js
 * session (GitHub / Azure Entra → role). The dev shim is honoured ONLY when
 * `EDD_DEV_AUTH=1`, so production is never open by default. Auth.js is imported
 * lazily so this module stays import-safe outside the Next runtime (tests).
 */
export async function getPrincipal(req: Request): Promise<Principal | null> {
  const principal = devAuthEnabled()
    ? devRequestPrincipal(req)
    : principalFromSession(await (await import("../auth")).auth());
  if (principal === null) return null;
  // Stamp control-plane activity on real authenticated requests (control-plane
  // scale-to-zero). Fire-and-forget + throttled internally: it never blocks or fails the
  // request (it catches + logs its own errors), and a busy CP writes DynamoDB ~1/min.
  // The heavy control-plane graph is lazy-imported inside `recordSystemActivity`.
  void recordSystemActivity();
  return withPersona(principal, cookieValue(req.headers.get("cookie"), PERSONA_COOKIE));
}

/**
 * Resolve the principal for a server-rendered page. Same policy as
 * {@link getPrincipal} but reads the dev cookies via `next/headers` (server
 * components have no `Request`). Both `next/headers` and Auth.js are imported
 * lazily to keep this module import-safe in unit/integration tests.
 */
export async function getPagePrincipal(): Promise<Principal | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const principal = devAuthEnabled()
    ? devPrincipal(store.get(DEV_USER_COOKIE)?.value, store.get(DEV_ROLE_COOKIE)?.value)
    : principalFromSession(await (await import("../auth")).auth());
  if (principal === null) return null;
  // A rendered page view is live use of the control plane — stamp activity so
  // scale-to-zero doesn't tear the app down under an active operator. Same
  // fire-and-forget + throttled contract as {@link getPrincipal}.
  void recordSystemActivity();
  return withPersona(principal, store.get(PERSONA_COOKIE)?.value);
}

/**
 * Independent page-level admin gate for admin server components. The `/admin` layout
 * denies non-admins by discarding `{children}`, but in the App Router the page RSC — and
 * its privileged data-fetch (e.g. `cp.list()` across every user's workspaces) — STILL runs
 * regardless of the layout's decision. Calling this at the TOP of each admin page, before any
 * fetch, short-circuits so the privileged query never runs for a non-admin: authorization is
 * on the page itself, not one refactor away in the layout. Returns true iff the viewer is an
 * admin; a non-admin page should `return null` (the layout renders the "Admins only" block).
 */
export async function isAdminViewer(): Promise<boolean> {
  return (await getPagePrincipal())?.role === "admin";
}
