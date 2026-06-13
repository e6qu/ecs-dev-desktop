// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared bleephub OAuth harness for the auth e2e suites: the CONFORMANT GitHub
// web flow (real session cookie + authenticity_token CSRF echo) plus standard
// GitHub-Enterprise provisioning. Only base URLs differ from real GitHub (§6.8).
import { bleephub } from "@edd/config";
import { z } from "zod";

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
export const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
};

const tokenResponse = z.object({ access_token: z.string() });
const profileSchema = z.object({ login: z.string(), id: z.union([z.number(), z.string()]) });

const bleephubRoot = (path: string, init: RequestInit): Promise<Response> =>
  fetch(`${bleephub.url}${path}`, init);
export const bleephubApi = (path: string, init: RequestInit): Promise<Response> =>
  fetch(`${bleephub.apiUrl}${path}`, init);

/** Establish a web session for `user` (real GitHub: the interactive login). */
export async function bleephubSession(user: string): Promise<string> {
  const session = await bleephubRoot("/login", {
    method: "POST",
    redirect: "manual",
    headers: FORM_HEADERS,
    body: new URLSearchParams({ login: user }).toString(),
  });
  const cookie = session.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (cookie === "")
    throw new Error(`login set no session cookie (status ${String(session.status)})`);
  return cookie;
}

/**
 * Drive the consent page for a full authorize URL (any OAuth client's — ours or
 * Auth.js's) and approve it: GET consent → parse authenticity_token → POST the
 * approval echoing the request's own query params. Returns the redirect
 * Location carrying `code` (+ `state`).
 */
export async function bleephubApprove(cookie: string, authorizeUrl: string): Promise<string> {
  const url = new URL(authorizeUrl);
  const consent = await fetch(url, { headers: { Cookie: cookie } });
  const csrf = /name="authenticity_token"\s+value="([^"]+)"/.exec(await consent.text())?.[1];
  if (csrf === undefined) throw new Error("consent page missing authenticity_token");

  const body = new URLSearchParams(url.searchParams);
  body.set("authenticity_token", csrf);
  const approve = await fetch(`${url.origin}${url.pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM_HEADERS, Cookie: cookie },
    body: body.toString(),
  });
  const location = approve.headers.get("location");
  if (location === null)
    throw new Error(`approve returned no redirect (status ${String(approve.status)})`);
  return location;
}

/** Exchange an authorization code for an access token. */
export async function bleephubExchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const exchanged = await bleephubRoot("/login/oauth/access_token", {
    method: "POST",
    headers: { ...FORM_HEADERS, Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }).toString(),
  });
  return tokenResponse.parse(await exchanged.json()).access_token;
}

/** OAuth client coordinates for the conformant web-login flow. */
export interface BleephubOAuthApp {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scope: string;
}

/** Run the full conformant OAuth web flow for `user` (session → consent →
 * approve → code → token) and return the access token bound to that user.
 * Mirrors what a browser does against real GitHub. */
export async function bleephubOAuthLogin(user: string, app: BleephubOAuthApp): Promise<string> {
  const cookie = await bleephubSession(user);
  const query = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: app.redirect_uri,
    scope: app.scope,
  }).toString();
  const location = await bleephubApprove(cookie, `${bleephub.url}/login/oauth/authorize?${query}`);
  const code = new URL(location, bleephub.url).searchParams.get("code");
  if (code === null) throw new Error(`approve redirect carried no code: ${location}`);
  return bleephubExchangeCode(code, app.client_id, app.client_secret);
}

/** The authenticated user's login name. */
async function bleephubLogin(token: string): Promise<string> {
  const auth = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
  const profile: unknown = await (await bleephubApi("/user", { headers: auth })).json();
  return profileSchema.parse(profile).login;
}

/**
 * Provision org + team + membership for the token's user via standard
 * GitHub-Enterprise APIs (site-admin org creation). Idempotent enough for
 * reuse across suites: bleephub re-creates respond non-fatally.
 */
export async function bleephubProvisionTeam(
  token: string,
  org: string,
  team: string,
): Promise<string> {
  const auth = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
  const userLogin = await bleephubLogin(token);
  await bleephubApi("/admin/organizations", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ login: org, admin: userLogin, profile_name: org }),
  });
  await bleephubApi(`/orgs/${org}/teams`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: team }),
  });
  await bleephubApi(`/orgs/${org}/teams/${team}/memberships/${userLogin}`, {
    method: "PUT",
    headers: auth,
  });
  return userLogin;
}
