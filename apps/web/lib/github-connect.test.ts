// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  exchangeGithubConnectCode,
  githubAuthorizeUrl,
  githubOAuthConfigFromEnv,
  signGithubConnectState,
  verifyGithubConnectState,
  type GithubOAuthConfig,
} from "./github-connect";

const env = {
  AUTH_SECRET: "state-secret",
  AUTH_GITHUB_ID: "client-id",
  AUTH_GITHUB_SECRET: "client-secret",
};

describe("GitHub account linking OAuth helpers", () => {
  it("requires all OAuth coordinates and defaults to github.com web endpoints", () => {
    expect(() => githubOAuthConfigFromEnv({})).toThrow("AUTH_GITHUB_ID is required");
    expect(() => githubOAuthConfigFromEnv({ AUTH_GITHUB_ID: "id" })).toThrow(
      "AUTH_GITHUB_SECRET is required",
    );
    expect(githubOAuthConfigFromEnv(env)).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      webBase: "https://github.com",
    });
  });

  it("signs owner-bound state and rejects tampering or expiry", () => {
    const now = new Date("2026-07-07T12:00:00.000Z");
    const state = signGithubConnectState("entra-user", now, env);

    expect(verifyGithubConnectState(state, now, env).ownerId).toBe("entra-user");
    expect(() => verifyGithubConnectState(`${state.slice(0, -1)}x`, now, env)).toThrow(
      "invalid GitHub connect state",
    );
    expect(() =>
      verifyGithubConnectState(state, new Date("2026-07-07T12:11:00.000Z"), env),
    ).toThrow("expired GitHub connect state");
  });

  it("builds an authorize URL with the repo-capable scope", () => {
    const url = new URL(
      githubAuthorizeUrl(
        githubOAuthConfigFromEnv(env),
        "https://app.example.com/api/github/connect/callback",
        "state",
      ),
    );

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("read:user user:email read:org repo");
    expect(url.searchParams.get("state")).toBe("state");
  });

  it("exchanges a callback code for the linked user's token", async () => {
    const cfg: GithubOAuthConfig = githubOAuthConfigFromEnv(env);
    const calls: string[] = [];
    const token = await exchangeGithubConnectCode(
      cfg,
      "code-123",
      "https://app.example.com/api/github/connect/callback",
      ((input, init) => {
        calls.push(
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
        );
        expect(init?.method).toBe("POST");
        return Response.json({
          access_token: "gho_linked",
          scope: "read:user,user:email,read:org,repo",
          token_type: "bearer",
        });
      }) satisfies typeof fetch,
    );

    expect(calls[0]).toBe("https://github.com/login/oauth/access_token");
    expect(token).toEqual({
      accessToken: "gho_linked",
      scope: "read:user,user:email,read:org,repo",
      tokenType: "bearer",
    });
  });
});
