// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { mapClaimsToRole, type RoleMappingConfig } from "./index";

const config: RoleMappingConfig = {
  adminGroups: ["acme/platform-admins", "entra-group-admin-guid"],
  memberGroups: ["acme/engineers"],
  defaultRole: "viewer",
};

describe("mapClaimsToRole", () => {
  it("maps a GitHub admin team to admin", () => {
    expect(
      mapClaimsToRole({ idp: "github", subject: "u", groups: ["acme/platform-admins"] }, config),
    ).toBe("admin");
  });

  it("maps an Entra group guid to member/admin", () => {
    expect(
      mapClaimsToRole({ idp: "entra", subject: "u", groups: ["entra-group-admin-guid"] }, config),
    ).toBe("admin");
  });

  it("falls back to the default role when no group matches", () => {
    expect(mapClaimsToRole({ idp: "github", subject: "u", groups: [] }, config)).toBe("viewer");
  });
});
