// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Principal, Role } from "@edd/authz";
import { ownerId } from "@edd/core";
import type { Session } from "next-auth";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  DEV_ROLE_COOKIE,
  DEV_USER_COOKIE,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "./constants";

function isRole(value: string): value is Role {
  return value === "viewer" || value === "member" || value === "admin";
}

/** Whether the dev-auth shim is active (`EDD_DEV_AUTH=1`) — never in production. */
export function devAuthEnabled(): boolean {
  return process.env[DEV_AUTH_ENV] === DEV_AUTH_ENABLED;
}

/** Build a principal from a candidate id/role pair (rejects unknown roles). */
function devPrincipal(id: string | undefined, role: string | undefined): Principal | null {
  if (id === undefined || role === undefined || !isRole(role)) return null;
  return { id: ownerId(id), role };
}

/** Pure: extract the principal from an Auth.js session. */
export function principalFromSession(session: Session | null): Principal | null {
  if (session === null) return null;
  const sessionEmail = session.user.email;
  return {
    id: ownerId(session.user.id),
    role: session.user.role,
    ...(typeof sessionEmail === "string" && sessionEmail.length > 0 ? { email: sessionEmail } : {}),
  };
}

function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
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
  if (devAuthEnabled()) return devRequestPrincipal(req);
  const { auth } = await import("../auth");
  return principalFromSession(await auth());
}

/**
 * Resolve the principal for a server-rendered page. Same policy as
 * {@link getPrincipal} but reads the dev cookies via `next/headers` (server
 * components have no `Request`). Both `next/headers` and Auth.js are imported
 * lazily to keep this module import-safe in unit/integration tests.
 */
export async function getPagePrincipal(): Promise<Principal | null> {
  if (devAuthEnabled()) {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    return devPrincipal(store.get(DEV_USER_COOKIE)?.value, store.get(DEV_ROLE_COOKIE)?.value);
  }
  const { auth } = await import("../auth");
  return principalFromSession(await auth());
}
