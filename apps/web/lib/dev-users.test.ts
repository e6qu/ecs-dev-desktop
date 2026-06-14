// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DevUser } from "@edd/config";
import { describe, expect, it } from "vitest";

import { matchDevUser } from "./dev-users";

const USERS: readonly DevUser[] = [
  { username: "admin", role: "admin", email: "admin@edd.local" },
  { username: "member", role: "member", email: "member@edd.local" },
  { username: "vip", role: "admin", email: "vip@edd.local", password: "s3cret" },
];

describe("matchDevUser", () => {
  it("matches a username with the shared fallback password", () => {
    expect(matchDevUser(USERS, "admin", "dev", "dev")).toMatchObject({ role: "admin" });
    expect(matchDevUser(USERS, "member", "dev", "dev")?.role).toBe("member");
  });

  it("uses a per-account password over the fallback", () => {
    expect(matchDevUser(USERS, "vip", "s3cret", "dev")?.username).toBe("vip");
    // The fallback does NOT unlock an account that set its own password.
    expect(matchDevUser(USERS, "vip", "dev", "dev")).toBeNull();
  });

  it("rejects a wrong password and an unknown username", () => {
    expect(matchDevUser(USERS, "admin", "nope", "dev")).toBeNull();
    expect(matchDevUser(USERS, "ghost", "dev", "dev")).toBeNull();
  });
});
