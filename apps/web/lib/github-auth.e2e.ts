// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import { github } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";

import { normalizeClaims } from "./claims";
import { GITHUB_API_URL_ENV } from "./constants";
import { fetchGithubTeamGroups } from "./github-teams";
import {
  githubApi,
  githubOAuthLogin,
  githubProvisionTeam,
  JSON_HEADERS,
  registerOAuthApp,
} from "./test-support/github-oauth";

/**
 * Mock-free GitHub login → team → role e2e against github, using only standard
 * GitHub-Enterprise behaviour so the same flow runs against real GitHub by base URL
 * alone (AGENTS.md §6.8). The login uses the **conformant** OAuth web flow — a real
 * session cookie + an `authenticity_token` (CSRF) the approve POST must echo, with
 * the code bound to the session user (github #399→#401) — so there is no hardcoded
 * seed token and no `auto=1`. Org provisioning uses the standard GHES site-admin
 * endpoint `POST /admin/organizations` (auth-enforced, github #400→#401), not the
 * non-standard `POST /user/orgs`. Flow helpers: `test-support/github-oauth.ts`
 * (shared with the Auth.js callback-route e2e).
 */
// Point our GitHub Enterprise API base at github (AUTH_GITHUB_API_URL is a standard
// GHE feature — the only base-domain difference from real cloud).
process.env[GITHUB_API_URL_ENV] = github.apiUrl;

// Test identity: github's seeded site admin (its pre-seeded user). Against real
// GHES this would be an env-supplied site-admin test user. It is both the provisioner
// (org creation needs site-admin) and the login subject whose role we derive.
const USER = "admin";
const ORG = "acme";
const TEAM = "platform-admins";
const TEAM_GROUP = `${ORG}/${TEAM}`;
// GitHub mints an OAuth App's client id and secret, so this run registers its
// own (see registerOAuthApp) and uses what the server issued — a chosen pair is
// not a client the server knows, and authorize answers
// incorrect_client_credentials. Provisioning uses admin:org (team creation and
// membership require it); the login subject uses read:org, the scope our
// Auth.js provider requests.
const REDIRECT_URI = "http://localhost/callback";
let OAUTH_ADMIN: {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scope: string;
};
let OAUTH_READ: typeof OAUTH_ADMIN;

describe("GitHub login via github → team → role (mock-free, conformant flow)", () => {
  let token: string;
  let profile: unknown;

  beforeAll(async () => {
    // Provision with admin:org scope (team creation/membership requires it).
    const app = await registerOAuthApp("edd-github-auth-e2e", REDIRECT_URI);
    const client = { client_id: app.clientId, client_secret: app.clientSecret };
    OAUTH_ADMIN = { ...client, redirect_uri: REDIRECT_URI, scope: "admin:org" };
    OAUTH_READ = { ...client, redirect_uri: REDIRECT_URI, scope: "read:org" };
    const adminToken = await githubOAuthLogin(USER, OAUTH_ADMIN);
    await githubProvisionTeam(adminToken, ORG, TEAM);

    // Login subject uses read:org — the scope Auth.js requests in production.
    token = await githubOAuthLogin(USER, OAUTH_READ);
    profile = await (
      await githubApi("/user", {
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      })
    ).json();
  });

  it("derives the role from the user's GitHub teams after an OAuth login", async () => {
    // Our real auth code, against github's real endpoints.
    const claims = normalizeClaims("github", profile);
    const groups = await fetchGithubTeamGroups({ accessToken: token });
    expect(groups).toContain(TEAM_GROUP);

    // The team grants admin; an empty config falls back to viewer.
    expect(
      mapClaimsToRole(
        { ...claims, groups },
        { adminGroups: [TEAM_GROUP], developerGroups: [], defaultRole: "viewer" },
      ),
    ).toBe("admin");
    expect(
      mapClaimsToRole(
        { ...claims, groups },
        { adminGroups: [], developerGroups: [], defaultRole: "viewer" },
      ),
    ).toBe("viewer");
  });
});
