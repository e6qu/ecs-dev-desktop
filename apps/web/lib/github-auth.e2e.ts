// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import { bleephub } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { normalizeClaims } from "./claims";
import { GITHUB_API_URL_ENV } from "./constants";
import { fetchGithubTeamGroups } from "./github-teams";

/**
 * Mock-free GitHub login → team → role e2e against bleephub, using only standard
 * GitHub-Enterprise behaviour so the same flow runs against real GitHub by base URL
 * alone (AGENTS.md §6.8). The login uses the **conformant** OAuth web flow — a real
 * session cookie + an `authenticity_token` (CSRF) the approve POST must echo, with
 * the code bound to the session user (bleephub #399→#401) — so there is no hardcoded
 * seed token and no `auto=1`. Org provisioning uses the standard GHES site-admin
 * endpoint `POST /admin/organizations` (auth-enforced, bleephub #400→#401), not the
 * non-standard `POST /user/orgs`.
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
  state: "xyz",
};

const jsonHeaders = { "Content-Type": "application/json", Accept: "application/vnd.github+json" };
const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
const tokenResponse = z.object({ access_token: z.string() });
const profileSchema = z.object({ login: z.string(), id: z.union([z.number(), z.string()]) });

const root = (path: string, init: RequestInit): Promise<Response> =>
  fetch(`${bleephub.url}${path}`, init);
const api = (path: string, init: RequestInit): Promise<Response> =>
  fetch(`${bleephub.apiUrl}${path}`, init);

/** The conformant GitHub OAuth web flow (session + CSRF), returning the access token
 * bound to `user`. Mirrors what a browser does against real GitHub. */
async function login(user: string): Promise<string> {
  // 1. Establish a session (real GitHub: the interactive web login).
  const session = await root("/login", {
    method: "POST",
    redirect: "manual",
    headers: formHeaders,
    body: new URLSearchParams({ login: user }).toString(),
  });
  const cookie = session.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (cookie === "")
    throw new Error(`login set no session cookie (status ${String(session.status)})`);

  // 2. The consent page carries the CSRF token the approve POST must echo.
  const query = new URLSearchParams({
    client_id: OAUTH.client_id,
    redirect_uri: OAUTH.redirect_uri,
    scope: OAUTH.scope,
    state: OAUTH.state,
  }).toString();
  const consent = await root(`/login/oauth/authorize?${query}`, { headers: { Cookie: cookie } });
  const csrf = /name="authenticity_token"\s+value="([^"]+)"/.exec(await consent.text())?.[1];
  if (csrf === undefined) throw new Error("consent page missing authenticity_token");

  // 3. Approve (session cookie + CSRF) → 302 with the authorization code.
  const approve = await root("/login/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { ...formHeaders, Cookie: cookie },
    body: new URLSearchParams({
      client_id: OAUTH.client_id,
      redirect_uri: OAUTH.redirect_uri,
      scope: OAUTH.scope,
      state: OAUTH.state,
      authenticity_token: csrf,
    }).toString(),
  });
  const location = approve.headers.get("location");
  const code = location === null ? null : new URL(location, bleephub.url).searchParams.get("code");
  if (code === null) throw new Error(`approve returned no code (status ${String(approve.status)})`);

  // 4. Exchange the code for an access token (bound to the session user).
  const exchanged = await root("/login/oauth/access_token", {
    method: "POST",
    headers: { ...formHeaders, Accept: "application/json" },
    body: new URLSearchParams({
      client_id: OAUTH.client_id,
      client_secret: OAUTH.client_secret,
      code,
    }).toString(),
  });
  return tokenResponse.parse(await exchanged.json()).access_token;
}

describe("GitHub login via bleephub → team → role (mock-free, conformant flow)", () => {
  let token: string;
  let profile: unknown;

  beforeAll(async () => {
    token = await login(USER);
    const auth = { ...jsonHeaders, Authorization: `Bearer ${token}` };
    profile = await (await api("/user", { headers: auth })).json();
    const userLogin = profileSchema.parse(profile).login;

    // Provision org/team/membership via standard GitHub-Enterprise APIs.
    await api("/admin/organizations", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ login: ORG, admin: userLogin, profile_name: ORG }),
    });
    await api(`/orgs/${ORG}/teams`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: TEAM }),
    });
    await api(`/orgs/${ORG}/teams/${TEAM}/memberships/${userLogin}`, {
      method: "PUT",
      headers: auth,
    });
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
