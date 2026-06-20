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
    const n = Number(override);
    // A negative or fractional quota is a misconfiguration (a negative would lock the
    // role out of creating ANY workspace). Fail loud (§6.5) rather than silently driving
    // enforcement with garbage — and it keeps the report contract's nonnegative-int invariant.
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid ${envKey}="${override}": expected a non-negative integer`);
    }
    return n;
  }
  return DEFAULT_WORKSPACE_QUOTAS[role] ?? null;
}
