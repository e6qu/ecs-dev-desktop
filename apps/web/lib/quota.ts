// SPDX-License-Identifier: AGPL-3.0-or-later
import { ROLES, type Role } from "@edd/authz";
import { DEFAULT_WORKSPACE_QUOTAS, QUOTA_ENV_PREFIX } from "@edd/config";

/** Every role, from the single source in `@edd/authz` (no hand-maintained list). */
export const QUOTA_ROLES = ROLES;

/** The per-role workspace cap (`null` = unlimited): an `EDD_QUOTA_<ROLE>` env
 * override if set, else the typed default from `@edd/config`. */
export function workspaceLimit(role: Role): number | null {
  const envKey = `${QUOTA_ENV_PREFIX}${role.toUpperCase()}`;
  const override = process.env[envKey];
  if (override !== undefined && override !== "") {
    // Strict decimal only. `Number()` would silently accept `0x10`/`1e1`/`0b101`/`" 5 "` as
    // "integers" — surprising, and contradicting the documented non-negative-integer contract.
    // A negative/fractional/garbage quota is a misconfiguration (a negative would lock the role
    // out of creating ANY workspace); fail loud (§6.5) rather than driving enforcement with it.
    if (!/^\d+$/.test(override)) {
      throw new Error(`invalid ${envKey}="${override}": expected a non-negative integer`);
    }
    return Number(override);
  }
  return DEFAULT_WORKSPACE_QUOTAS[role] ?? null;
}
