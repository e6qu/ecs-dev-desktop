// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { mapClaimsToRole, type RoleMappingConfig } from "./index";

const config: RoleMappingConfig = {
  adminGroups: ["acme/platform-admins", "entra-group-admin-guid"],
  developerGroups: ["acme/engineers"],
  defaultRole: "viewer",
};

describe("mapClaimsToRole", () => {
  it("honours the signed Shauth admin role over group mappings", () => {
    expect(
      mapClaimsToRole(
        { idp: "shauth", subject: "user-123", groups: [], role: "admin" },
        { adminGroups: [], developerGroups: [], defaultRole: "viewer" },
      ),
    ).toBe("admin");
  });

  it("maps a GitHub admin team to admin", () => {
    expect(
      mapClaimsToRole({ idp: "github", subject: "u", groups: ["acme/platform-admins"] }, config),
    ).toBe("admin");
  });

  it("maps an Entra group guid to developer/admin", () => {
    expect(
      mapClaimsToRole({ idp: "entra", subject: "u", groups: ["entra-group-admin-guid"] }, config),
    ).toBe("admin");
  });

  it("matches groups case-insensitively (config vs claim casing must not silently downgrade)", () => {
    // Config has `acme/platform-admins`; the claim arrives with different casing.
    expect(
      mapClaimsToRole({ idp: "github", subject: "u", groups: ["Acme/Platform-Admins"] }, config),
    ).toBe("admin");
    // And the reverse (Entra GUIDs are case-insensitive hex).
    expect(
      mapClaimsToRole({ idp: "entra", subject: "u", groups: ["ENTRA-GROUP-ADMIN-GUID"] }, config),
    ).toBe("admin");
  });

  it("maps a developer group to developer", () => {
    expect(
      mapClaimsToRole({ idp: "github", subject: "u", groups: ["acme/engineers"] }, config),
    ).toBe("developer");
  });

  it("admin takes precedence when a user is in both an admin and a developer group", () => {
    expect(
      mapClaimsToRole(
        { idp: "github", subject: "u", groups: ["acme/engineers", "acme/platform-admins"] },
        config,
      ),
    ).toBe("admin");
  });

  it("falls back to the default role when no group matches", () => {
    expect(mapClaimsToRole({ idp: "github", subject: "u", groups: [] }, config)).toBe("viewer");
  });

  it("uses the role asserted by the trusted Shauth provider", () => {
    expect(
      mapClaimsToRole({ idp: "shauth", subject: "u", groups: [], role: "developer" }, config),
    ).toBe("developer");
    expect(
      mapClaimsToRole({ idp: "shauth", subject: "u", groups: [], role: "admin" }, config),
    ).toBe("admin");
  });
});
