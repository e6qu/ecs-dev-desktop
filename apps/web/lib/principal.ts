// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Principal, Role } from "@edd/authz";

const ROLES: ReadonlySet<Role> = new Set<Role>(["viewer", "member", "admin"]);

/**
 * Resolve the caller's principal. Phase 3 replaces this with an Auth.js session
 * (GitHub / Azure Entra → role via `@edd/auth`). Until then, dev-header auth is
 * honoured ONLY when `EDD_DEV_AUTH=1`, so production is locked (401) rather than
 * open by default.
 */
export function getPrincipal(req: Request): Principal | null {
  if (process.env.EDD_DEV_AUTH !== "1") return null;
  const id = req.headers.get("x-edd-user-id");
  const role = req.headers.get("x-edd-role");
  if (!id || !role || !ROLES.has(role as Role)) return null;
  return { id, role: role as Role };
}
