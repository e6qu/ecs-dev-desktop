// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoleMappingConfig } from "@edd/auth";

import { ADMIN_GROUPS_ENV, MEMBER_GROUPS_ENV } from "./constants";

function parseGroupList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build the IdP-group → role mapping from environment config. */
export function roleMappingConfig(): RoleMappingConfig {
  return {
    adminGroups: parseGroupList(process.env[ADMIN_GROUPS_ENV]),
    memberGroups: parseGroupList(process.env[MEMBER_GROUPS_ENV]),
    defaultRole: "viewer",
  };
}
