// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identity → role mapping, shared by the Auth.js callbacks (GitHub OAuth +
 * Azure Entra ID). This is the pure, fully-testable core; the Auth.js provider
 * wiring (interactive flow) lands with `apps/web` in Phase 3.
 *
 * Mapping is config-driven so admin/member groups are not hard-coded per env.
 */
export type Role = "viewer" | "member" | "admin";

export type IdP = "github" | "entra";

/** Normalised claims extracted from either IdP's token/profile. */
export interface IdentityClaims {
  idp: IdP;
  subject: string;
  /** GitHub: `org/team` slugs or org names. Entra: group object Ids. */
  groups: string[];
}

export interface RoleMappingConfig {
  /** Group identifiers that grant admin. */
  adminGroups: string[];
  /** Group identifiers that grant member. */
  memberGroups: string[];
  /** Role assigned when no group matches. */
  defaultRole: Role;
}

export function mapClaimsToRole(
  claims: IdentityClaims,
  config: RoleMappingConfig,
): Role {
  const groups = new Set(claims.groups);
  if (config.adminGroups.some((g) => groups.has(g))) return "admin";
  if (config.memberGroups.some((g) => groups.has(g))) return "member";
  return config.defaultRole;
}
