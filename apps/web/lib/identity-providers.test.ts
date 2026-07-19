// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { entraOAuthClient, githubOAuthClient } from "./identity-providers";

describe("optional identity-provider clients", () => {
  it("omits providers whose credentials are absent", () => {
    expect(githubOAuthClient({})).toBeNull();
    expect(entraOAuthClient({})).toBeNull();
  });

  it("returns complete confidential-client credentials", () => {
    expect(
      githubOAuthClient({ AUTH_GITHUB_ID: "github-id", AUTH_GITHUB_SECRET: "secret" }),
    ).toEqual({
      clientId: "github-id",
      clientSecret: "secret",
    });
    expect(
      entraOAuthClient({
        AUTH_MICROSOFT_ENTRA_ID_ID: "entra-id",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "secret",
      }),
    ).toEqual({ clientId: "entra-id", clientSecret: "secret" });
  });

  it("rejects partial provider credentials instead of exposing a broken login", () => {
    expect(() => githubOAuthClient({ AUTH_GITHUB_ID: "github-id" })).toThrow(
      /AUTH_GITHUB_ID and AUTH_GITHUB_SECRET together/,
    );
    expect(() => entraOAuthClient({ AUTH_MICROSOFT_ENTRA_ID_SECRET: "secret" })).toThrow(
      /AUTH_MICROSOFT_ENTRA_ID_ID and AUTH_MICROSOFT_ENTRA_ID_SECRET together/,
    );
  });
});
