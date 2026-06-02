// SPDX-License-Identifier: AGPL-3.0-or-later
import { request } from "node:http";

import { mapClaimsToRole } from "@edd/auth";
import { bleephub } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { normalizeClaims } from "./claims";
import { GITHUB_API_URL_ENV } from "./constants";
import { fetchGithubTeamGroups } from "./github-teams";

// Point our GitHub API base (used by fetchGithubTeamGroups) at bleephub.
process.env[GITHUB_API_URL_ENV] = bleephub.apiUrl;

// bleephub seeds an admin user (login `admin`, id 1) with this fixed token.
const ADMIN_TOKEN = "ghp_0000000000000000000000000000000000000000";
const ORG = "acme";
const TEAM = "platform-admins";
const TEAM_GROUP = `${ORG}/${TEAM}`;

const json = { "Content-Type": "application/json", Accept: "application/vnd.github+json" };
const tokenResponse = z.object({ access_token: z.string() });

function ghApi(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${bleephub.apiUrl}${path}`, init);
}

/** GET the OAuth authorize endpoint and capture the `code` from its 302 (Node
 * `fetch` opaque-filters manual redirects, so use node:http to read Location). */
function authorizeCode(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET" }, (res) => {
      res.resume();
      const loc = res.headers.location;
      if (loc === undefined) {
        reject(new Error(`authorize did not redirect (status ${String(res.statusCode)})`));
        return;
      }
      const code = new URL(loc, bleephub.url).searchParams.get("code");
      if (code === null) reject(new Error("no code in authorize redirect"));
      else resolve(code);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("GitHub login via bleephub → team → role (mock-free)", () => {
  beforeAll(async () => {
    const auth = { ...json, Authorization: `Bearer ${ADMIN_TOKEN}` };
    await ghApi("/user/orgs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ login: ORG }),
    });
    await ghApi(`/orgs/${ORG}/teams`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: TEAM }),
    });
    await ghApi(`/orgs/${ORG}/teams/${TEAM}/memberships/admin`, { method: "PUT", headers: auth });
  });

  it("derives the role from the user's GitHub teams after an OAuth-code login", async () => {
    // 1. mock-free OAuth authorization-code login → access token.
    const authorize = new URL(`${bleephub.url}/login/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: "edd",
      redirect_uri: "http://localhost/callback",
      scope: "read:org",
      state: "xyz",
      auto: "1",
    }).toString();
    const code = await authorizeCode(authorize.toString());

    const exchanged = await fetch(`${bleephub.url}/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: "edd", client_secret: "secret", code }).toString(),
    });
    const { access_token: token } = tokenResponse.parse(await exchanged.json());

    // 2. our real auth code, against bleephub's real endpoints.
    const profile: unknown = await (
      await ghApi("/user", { headers: { ...json, Authorization: `Bearer ${token}` } })
    ).json();
    const claims = normalizeClaims("github", profile);
    const groups = await fetchGithubTeamGroups({ accessToken: token });
    expect(groups).toContain(TEAM_GROUP);

    // 3. role mapping: the team grants admin; an empty config falls back to viewer.
    const role = mapClaimsToRole(
      { ...claims, groups },
      { adminGroups: [TEAM_GROUP], memberGroups: [], defaultRole: "viewer" },
    );
    expect(role).toBe("admin");
    expect(
      mapClaimsToRole(
        { ...claims, groups },
        { adminGroups: [], memberGroups: [], defaultRole: "viewer" },
      ),
    ).toBe("viewer");
  });
});
