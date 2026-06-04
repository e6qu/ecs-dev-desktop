// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Role } from "@edd/authz";
import { DEFAULT_WORKSPACE_QUOTAS, QUOTA_ENV_PREFIX } from "@edd/config";

export const QUOTA_ROLES: readonly Role[] = ["viewer", "member", "admin"];

/** The per-role workspace cap (`null` = unlimited): an `EDD_QUOTA_<ROLE>` env
 * override if set, else the typed default from `@edd/config`. */
export function workspaceLimit(role: Role): number | null {
  const override = process.env[`${QUOTA_ENV_PREFIX}${role.toUpperCase()}`];
  if (override !== undefined && override !== "") {
    const n = Number.parseInt(override, 10);
    if (!Number.isNaN(n)) return n;
  }
  return DEFAULT_WORKSPACE_QUOTAS[role] ?? null;
}
