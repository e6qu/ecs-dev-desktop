// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { gitIntegrationFromEnv } from "./git-integration";

const KEY = "0".repeat(64);

describe("gitIntegrationFromEnv", () => {
  it("reports nothing configured on a Shauth-only deployment with just the store key", () => {
    expect(gitIntegrationFromEnv({ EDD_TOKEN_ENC_KEY: KEY })).toEqual({
      tokens: "none",
      sshKeys: true,
      host: "github.com",
      apiUrl: "https://api.github.com",
    });
  });

  it("prefers the GitHub App when both it and OAuth linking are configured", () => {
    expect(
      gitIntegrationFromEnv({
        EDD_TOKEN_ENC_KEY: KEY,
        AUTH_GITHUB_ID: "id",
        AUTH_GITHUB_SECRET: "s",
        EDD_GITHUB_APP_ID: "1",
        EDD_GITHUB_APP_KEY: "pem",
      }).tokens,
    ).toBe("app");
  });

  it("offers OAuth linking only when the token store can hold the result", () => {
    expect(gitIntegrationFromEnv({ AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "s" })).toEqual({
      tokens: "none",
      sshKeys: false,
      host: "github.com",
      apiUrl: "https://api.github.com",
    });
    expect(
      gitIntegrationFromEnv({
        AUTH_GITHUB_ID: "id",
        AUTH_GITHUB_SECRET: "s",
        EDD_TOKEN_ENC_KEY: KEY,
      }).tokens,
    ).toBe("oauth");
  });

  it("takes the host from the GitHub web coordinate (GHES or a simulator)", () => {
    const integration = gitIntegrationFromEnv({
      AUTH_GITHUB_URL: "https://ghe.example:8443",
      AUTH_GITHUB_API_URL: "https://ghe.example:8443/api/v3",
    });
    expect(integration.host).toBe("ghe.example");
    expect(integration.apiUrl).toBe("https://ghe.example:8443/api/v3");
  });
});
