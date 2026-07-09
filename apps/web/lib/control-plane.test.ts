// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { fakeProvidersAllowed, realProviderSecrets } from "./control-plane";

describe("fakeProvidersAllowed (production guard against silent fake fallback)", () => {
  it("allows fakes outside production", () => {
    expect(fakeProvidersAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(fakeProvidersAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(fakeProvidersAllowed({})).toBe(true); // NODE_ENV unset
  });

  it("FORBIDS fakes in production by default (the dangerous no-op case)", () => {
    expect(fakeProvidersAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("allows fakes in production only behind an explicit dev/test signal", () => {
    // dev-auth shim on → plainly a dev/test deployment
    expect(fakeProvidersAllowed({ NODE_ENV: "production", EDD_DEV_AUTH: "1" })).toBe(true);
    // explicit opt-in
    expect(fakeProvidersAllowed({ NODE_ENV: "production", EDD_ALLOW_FAKE_PROVIDERS: "1" })).toBe(
      true,
    );
    // a non-"1" value does not count
    expect(fakeProvidersAllowed({ NODE_ENV: "production", EDD_DEV_AUTH: "0" })).toBe(false);
  });
});

describe("realProviderSecrets", () => {
  it("requires both workspace machine-auth and editor-token secrets", () => {
    expect(() => realProviderSecrets({})).toThrow("COMPUTE_PROVIDER=ecs requires EDD_AGENT_SECRET");
    expect(() => realProviderSecrets({ EDD_AGENT_SECRET: "a".repeat(64) })).toThrow(
      "COMPUTE_PROVIDER=ecs requires EDD_CONNECTION_SECRET",
    );
  });

  it("returns the configured secrets when both are present", () => {
    expect(
      realProviderSecrets({
        EDD_AGENT_SECRET: "a".repeat(64),
        EDD_CONNECTION_SECRET: "b".repeat(64),
      }),
    ).toEqual({
      agentSecret: "a".repeat(64),
      connectionSecret: "b".repeat(64),
    });
  });
});
