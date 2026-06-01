// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Principal, Role } from "@edd/authz";
import type { Session } from "next-auth";

import { DEV_AUTH_ENABLED, DEV_AUTH_ENV, ROLE_HEADER, USER_ID_HEADER } from "./constants";

function isRole(value: string): value is Role {
  return value === "viewer" || value === "member" || value === "admin";
}

/** Pure: extract the principal from an Auth.js session. */
export function principalFromSession(session: Session | null): Principal | null {
  if (session === null) return null;
  return { id: session.user.id, role: session.user.role };
}

/** Dev-header principal — only honoured when `EDD_DEV_AUTH=1` (local/integration). */
function devHeaderPrincipal(req: Request): Principal | null {
  const id = req.headers.get(USER_ID_HEADER);
  const role = req.headers.get(ROLE_HEADER);
  if (id === null || role === null || !isRole(role)) return null;
  return { id, role };
}

/**
 * Resolve the caller's principal. In production this is the Auth.js session
 * (GitHub / Azure Entra → role). The dev-header shim is honoured ONLY when
 * `EDD_DEV_AUTH=1`, so production is never open by default. Auth.js is imported
 * lazily so this module stays import-safe outside the Next runtime (tests).
 */
export async function getPrincipal(req: Request): Promise<Principal | null> {
  if (process.env[DEV_AUTH_ENV] === DEV_AUTH_ENABLED) return devHeaderPrincipal(req);
  const { auth } = await import("../auth");
  return principalFromSession(await auth());
}
