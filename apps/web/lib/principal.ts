// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Principal, Role } from "@edd/authz";

import { DEV_AUTH_ENABLED, DEV_AUTH_ENV, ROLE_HEADER, USER_ID_HEADER } from "./constants";

function isRole(value: string): value is Role {
  return value === "viewer" || value === "member" || value === "admin";
}

/**
 * Resolve the caller's principal. Phase 3 replaces this with an Auth.js session
 * (GitHub / Azure Entra → role via `@edd/auth`). Until then, dev-header auth is
 * honoured ONLY when `EDD_DEV_AUTH=1`, so production is locked (401) rather than
 * open by default.
 */
export function getPrincipal(req: Request): Principal | null {
  if (process.env[DEV_AUTH_ENV] !== DEV_AUTH_ENABLED) return null;
  const id = req.headers.get(USER_ID_HEADER);
  const role = req.headers.get(ROLE_HEADER);
  if (id === null || role === null || !isRole(role)) return null;
  return { id, role };
}
