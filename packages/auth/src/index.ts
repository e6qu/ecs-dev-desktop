// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identity → role mapping, shared by the Auth.js callbacks (GitHub OAuth +
 * Azure Entra ID). This is the pure, fully-testable core; the Auth.js provider
 * wiring (interactive flow) lands with `apps/web` in Phase 3.
 *
 * Mapping is config-driven so admin/developer groups are not hard-coded per env.
 */
export type Role = "viewer" | "developer" | "admin";

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
  /** Group identifiers that grant developer. */
  developerGroups: string[];
  /** Role assigned when no group matches. */
  defaultRole: Role;
}

export function mapClaimsToRole(claims: IdentityClaims, config: RoleMappingConfig): Role {
  // Group identifiers are case-insensitive on both IdPs — GitHub `org/team` slugs are
  // lowercased by GitHub, Entra group object-ids are hex GUIDs — but operators configure
  // `EDD_ADMIN_GROUPS`/`EDD_DEVELOPER_GROUPS` with arbitrary casing. Match case-insensitively
  // so a casing mismatch can't silently downgrade an admin/developer to the default role.
  const groups = new Set(claims.groups.map((g) => g.toLowerCase()));
  const granted = (configured: string[]): boolean =>
    configured.some((g) => groups.has(g.toLowerCase()));
  if (granted(config.adminGroups)) return "admin";
  if (granted(config.developerGroups)) return "developer";
  return config.defaultRole;
}
