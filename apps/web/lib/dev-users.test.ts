// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DevUser } from "@edd/config";
import { describe, expect, it } from "vitest";

import { matchDevUser } from "./dev-users";

const USERS: readonly DevUser[] = [
  { username: "admin", role: "admin", email: "admin@edd.local", password: "admin-password" },
  { username: "member", role: "member", email: "member@edd.local", password: "member-password" },
  { username: "vip", role: "admin", email: "vip@edd.local", password: "s3cret" },
];

describe("matchDevUser", () => {
  it("matches a username with its explicit account password", () => {
    expect(matchDevUser(USERS, "admin", "admin-password")).toMatchObject({ role: "admin" });
    expect(matchDevUser(USERS, "member", "member-password")?.role).toBe("member");
    expect(matchDevUser(USERS, "vip", "s3cret")?.username).toBe("vip");
  });

  it("rejects a wrong password and an unknown username", () => {
    expect(matchDevUser(USERS, "admin", "nope")).toBeNull();
    expect(matchDevUser(USERS, "ghost", "dev")).toBeNull();
  });
});
