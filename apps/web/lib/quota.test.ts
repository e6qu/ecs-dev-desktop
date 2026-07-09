// SPDX-License-Identifier: AGPL-3.0-or-later
import { QUOTA_ENV_PREFIX } from "@edd/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workspaceLimit } from "./quota";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspaceLimit", () => {
  it("uses a valid non-negative integer env override", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}DEVELOPER`, "7");
    expect(workspaceLimit("developer")).toBe(7);
  });

  it("falls back to the typed default when no override is set", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}DEVELOPER`, "");
    // The default for developer is a finite cap (not unlimited) per @edd/config.
    expect(workspaceLimit("developer")).not.toBeUndefined();
  });

  it("fails loud on a negative override (would otherwise lock the role out of creating)", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}DEVELOPER`, "-5");
    expect(() => workspaceLimit("developer")).toThrow(/non-negative integer/);
  });

  it("fails loud on a fractional override", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}DEVELOPER`, "2.5");
    expect(() => workspaceLimit("developer")).toThrow(/non-negative integer/);
  });

  it("fails loud on a non-numeric override", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}DEVELOPER`, "lots");
    expect(() => workspaceLimit("developer")).toThrow(/non-negative integer/);
  });
});
