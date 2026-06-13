// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import { bleephub } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";

import { normalizeClaims } from "./claims";
import { GITHUB_API_URL_ENV } from "./constants";
import { fetchGithubTeamGroups } from "./github-teams";
import {
  bleephubApi,
  bleephubOAuthLogin,
  bleephubProvisionTeam,
  JSON_HEADERS,
} from "./test-support/bleephub-oauth";

/**
 * Mock-free GitHub login → team → role e2e against bleephub, using only standard
 * GitHub-Enterprise behaviour so the same flow runs against real GitHub by base URL
 * alone (AGENTS.md §6.8). The login uses the **conformant** OAuth web flow — a real
 * session cookie + an `authenticity_token` (CSRF) the approve POST must echo, with
 * the code bound to the session user (bleephub #399→#401) — so there is no hardcoded
 * seed token and no `auto=1`. Org provisioning uses the standard GHES site-admin
 * endpoint `POST /admin/organizations` (auth-enforced, bleephub #400→#401), not the
 * non-standard `POST /user/orgs`. Flow helpers: `test-support/bleephub-oauth.ts`
 * (shared with the Auth.js callback-route e2e).
 */
// Point our GitHub Enterprise API base at bleephub (AUTH_GITHUB_API_URL is a standard
// GHE feature — the only base-domain difference from real cloud).
process.env[GITHUB_API_URL_ENV] = bleephub.apiUrl;

// Test identity: bleephub's seeded site admin (its pre-seeded user). Against real
// GHES this would be an env-supplied site-admin test user. It is both the provisioner
// (org creation needs site-admin) and the login subject whose role we derive.
const USER = "admin";
const ORG = "acme";
const TEAM = "platform-admins";
const TEAM_GROUP = `${ORG}/${TEAM}`;
// Arbitrary OAuth app coordinates (fixtures); real cloud supplies real app creds.
const OAUTH = {
  client_id: "edd",
  client_secret: "secret",
  redirect_uri: "http://localhost/callback",
  scope: "read:org",
};

describe("GitHub login via bleephub → team → role (mock-free, conformant flow)", () => {
  let token: string;
  let profile: unknown;

  beforeAll(async () => {
    token = await bleephubOAuthLogin(USER, OAUTH);
    profile = await (
      await bleephubApi("/user", {
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      })
    ).json();
    await bleephubProvisionTeam(token, ORG, TEAM);
  });

  it("derives the role from the user's GitHub teams after an OAuth login", async () => {
    // Our real auth code, against bleephub's real endpoints.
    const claims = normalizeClaims("github", profile);
    const groups = await fetchGithubTeamGroups({ accessToken: token });
    expect(groups).toContain(TEAM_GROUP);

    // The team grants admin; an empty config falls back to viewer.
    expect(
      mapClaimsToRole(
        { ...claims, groups },
        { adminGroups: [TEAM_GROUP], memberGroups: [], defaultRole: "viewer" },
      ),
    ).toBe("admin");
    expect(
      mapClaimsToRole(
        { ...claims, groups },
        { adminGroups: [], memberGroups: [], defaultRole: "viewer" },
      ),
    ).toBe("viewer");
  });
});
