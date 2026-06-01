// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AbilityBuilder,
  createMongoAbility,
  type MongoAbility,
} from "@casl/ability";

/**
 * RBAC, defined once and enforced in both the API and the UI.
 *
 * Roles (least → most privilege): viewer < member < admin. Roles are derived
 * from IdP groups/claims in `@edd/auth`; this module turns a role into a CASL
 * ability the rest of the system checks with `ability.can(action, subject)`.
 */
export type Role = "viewer" | "member" | "admin";

export type Action = "create" | "read" | "update" | "delete" | "manage";
export type Subject = "Workspace" | "User" | "BaseImage" | "all";

export type AppAbility = MongoAbility<[Action, Subject]>;

export interface Principal {
  id: string;
  role: Role;
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
