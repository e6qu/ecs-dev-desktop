// SPDX-License-Identifier: AGPL-3.0-or-later
import { QUOTA_ENV_PREFIX } from "@edd/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workspaceLimit } from "./quota";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspaceLimit", () => {
  it("uses a valid non-negative integer env override", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}MEMBER`, "7");
    expect(workspaceLimit("member")).toBe(7);
  });

  it("falls back to the typed default when no override is set", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}MEMBER`, "");
    // The default for member is a finite cap (not unlimited) per @edd/config.
    expect(workspaceLimit("member")).not.toBeUndefined();
  });

  it("fails loud on a negative override (would otherwise lock the role out of creating)", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}MEMBER`, "-5");
    expect(() => workspaceLimit("member")).toThrow(/non-negative integer/);
  });

  it("fails loud on a fractional override", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}MEMBER`, "2.5");
    expect(() => workspaceLimit("member")).toThrow(/non-negative integer/);
  });

  it("fails loud on a non-numeric override", () => {
    vi.stubEnv(`${QUOTA_ENV_PREFIX}MEMBER`, "lots");
    expect(() => workspaceLimit("member")).toThrow(/non-negative integer/);
  });
});
