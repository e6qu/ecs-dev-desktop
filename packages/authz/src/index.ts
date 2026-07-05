// SPDX-License-Identifier: AGPL-3.0-or-later
import { AbilityBuilder, createMongoAbility, type MongoAbility } from "@casl/ability";
import type { OwnerId } from "@edd/core";

/**
 * RBAC, defined once and enforced in both the API and the UI.
 *
 * Roles (least → most privilege): viewer < member < admin. Roles are derived
 * from IdP groups/claims in `@edd/auth`; this module turns a role into a CASL
 * ability the rest of the system checks with `ability.can(action, subject)`.
 */
/** The role vocabulary, least → most privilege. The single source of truth: the
 * `Role` union is derived from it, and consumers (e.g. quotas) key on it so a new
 * role is a compile error wherever roles are enumerated. */
export const ROLES = ["viewer", "member", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Whether `value` is one of the {@link ROLES}. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Rank of each role, least → most privilege — the basis for persona clamping. */
const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, member: 1, admin: 2 };

/**
 * The effective role for a "view as" persona override: `requested` clamped to at
 * most `realRole`'s rank. A persona can only downgrade the caller's own real,
 * IdP-derived role — never escalate it. An invalid or absent `requested` (a
 * malformed cookie, or no override in effect) resolves to `realRole` unchanged.
 */
export function effectiveRole(realRole: Role, requested: string | undefined): Role {
  if (requested === undefined || !isRole(requested)) return realRole;
  return ROLE_RANK[requested] <= ROLE_RANK[realRole] ? requested : realRole;
}

/** The personas `realRole` may switch into via "view as": every role at or below
 * its rank, in {@link ROLES} order (so `realRole` itself is always included). */
export function personasFor(realRole: Role): readonly Role[] {
  return ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[realRole]);
}

export type Action = "create" | "read" | "update" | "delete" | "manage";
export type Subject = "Workspace" | "User" | "BaseImage" | "all";

export type AppAbility = MongoAbility<[Action, Subject]>;

export interface Principal {
  /** The caller's owner id (branded once at the identity edge, so every owner-scoped
   * service receives an `OwnerId` without per-call-site re-branding). */
  id: OwnerId;
  /** The role every ability/gate check sees — the caller's real role, or a
   * downgraded "view as" persona when one is active (see `effectiveRole`). */
  role: Role;
  /** Caller's email, when the identity source provides it. Carried so a created
   * workspace records its owner's email for per-workspace proxy authorization. It
   * stays a bare string here — validation into a branded `Email` happens at the create
   * boundary (`resolveOwnerEmail`), which is where a malformed IdP email is rejected. */
  email?: string;
  /** The caller's real, IdP-derived role, set only when a persona override is
   * active (`role` is then the downgraded persona). Absent means no override is in
   * effect — `role` already is the real role. */
  realRole?: Role;
}

export function defineAbilityFor(principal: Principal): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  // Everyone may read base images (the catalog) and read workspaces.
  can("read", "BaseImage");
  can("read", "Workspace");

  if (principal.role === "member" || principal.role === "admin") {
    // Members manage their own workspaces (ownership enforced at the data layer).
    can(["create", "update", "delete"], "Workspace");
  }

  if (principal.role === "admin") {
    can("manage", "all");
  }

  return build();
}
