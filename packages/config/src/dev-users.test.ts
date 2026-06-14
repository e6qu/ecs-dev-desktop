// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DEV_PASSWORD, devPassword, devUsers } from "./index";

describe("devUsers / devPassword (config)", () => {
  const env = process.env;
  let savedUsers: string | undefined;
  let savedPw: string | undefined;

  beforeEach(() => {
    savedUsers = env.EDD_DEV_USERS;
    savedPw = env.EDD_DEV_PASSWORD;
    delete env.EDD_DEV_USERS;
    delete env.EDD_DEV_PASSWORD;
  });
  afterEach(() => {
    if (savedUsers === undefined) delete env.EDD_DEV_USERS;
    else env.EDD_DEV_USERS = savedUsers;
    if (savedPw === undefined) delete env.EDD_DEV_PASSWORD;
    else env.EDD_DEV_PASSWORD = savedPw;
  });

  it("returns the built-in default accounts when EDD_DEV_USERS is unset", () => {
    const users = devUsers();
    expect(users.map((u) => u.role)).toEqual(["admin", "member", "viewer"]);
  });

  it("parses EDD_DEV_USERS JSON, including a per-user password", () => {
    env.EDD_DEV_USERS = JSON.stringify([
      { username: "ops", role: "admin", email: "ops@x.io", password: "p1" },
    ]);
    const users = devUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: "ops", role: "admin", password: "p1" });
  });

  it("fails loudly on invalid EDD_DEV_USERS (bad role)", () => {
    env.EDD_DEV_USERS = JSON.stringify([{ username: "x", role: "root", email: "x@x" }]);
    expect(() => devUsers()).toThrow();
  });

  it("devPassword falls back to the documented default", () => {
    expect(devPassword()).toBe(DEFAULT_DEV_PASSWORD);
    env.EDD_DEV_PASSWORD = "custom";
    expect(devPassword()).toBe("custom");
  });
});
