// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devUsers } from "./index";

describe("devUsers (config)", () => {
  const env = process.env;
  let savedUsers: string | undefined;

  beforeEach(() => {
    savedUsers = env.EDD_DEV_USERS;
    delete env.EDD_DEV_USERS;
  });
  afterEach(() => {
    if (savedUsers === undefined) delete env.EDD_DEV_USERS;
    else env.EDD_DEV_USERS = savedUsers;
  });

  it("returns the built-in default accounts with explicit passwords when EDD_DEV_USERS is unset", () => {
    const users = devUsers();
    expect(users.map((u) => u.role)).toEqual(["admin", "member", "viewer"]);
    expect(users.map((u) => u.password)).toEqual(["dev", "dev", "dev"]);
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

  it("fails loudly when an EDD_DEV_USERS account omits password", () => {
    env.EDD_DEV_USERS = JSON.stringify([{ username: "x", role: "admin", email: "x@x" }]);
    expect(() => devUsers()).toThrow();
  });
});
