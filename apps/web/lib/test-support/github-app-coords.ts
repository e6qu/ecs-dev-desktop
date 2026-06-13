// SPDX-License-Identifier: AGPL-3.0-or-later
// Coordinates for the GitHub-App e2e. The test consumes ONLY these coordinates
// and is identical whether it runs against real GitHub, GHES, or the bleephub
// sim (AGENTS.md §6.9 "Coordinates, not targets").
//
//   - To target REAL GitHub (or GHES): supply a pre-registered App's coordinates
//     via env (EDD_GITHUB_APP_ID, EDD_GITHUB_APP_KEY, EDD_GITHUB_TEST_ORG,
//     EDD_GITHUB_TEST_REPO, AUTH_GITHUB_API_URL). The bleephub branch never runs.
//   - With no env coordinates (CI default): the bleephub harness provisions an
//     EQUIVALENT App + installation + repo and returns the same coordinate shape.
//
// Real GitHub Apps are registered out of band (web UI / manifest) — there is no
// API to create one — so that provisioning is inherently sim-only and lives here,
// NOT in the test, which stays target-agnostic.
import { bleephub, DEFAULT_GITHUB_API_URL } from "@edd/config";
import { z } from "zod";

import { GITHUB_API_URL_ENV, GITHUB_APP_ID_ENV, GITHUB_APP_KEY_ENV } from "../constants";

import { bleephubOAuthLogin, bleephubProvisionTeam, JSON_HEADERS } from "./bleephub-oauth";

export interface GitHubAppCoordinates {
  apiBase: string;
  appId: string;
  privateKeyPem: string;
  /** An org/account the App is installed on. */
  org: string;
  /** A repo under it the installation can access. */
  repo: string;
}

const TEST_ORG_ENV = "EDD_GITHUB_TEST_ORG";
const TEST_REPO_ENV = "EDD_GITHUB_TEST_REPO";

/** Coordinates supplied via env (real GitHub / GHES / a pre-provisioned App), or
 * null when not fully specified. */
function coordinatesFromEnv(): GitHubAppCoordinates | null {
  const appId = process.env[GITHUB_APP_ID_ENV];
  const key = process.env[GITHUB_APP_KEY_ENV];
  const org = process.env[TEST_ORG_ENV];
  const repo = process.env[TEST_REPO_ENV];
  if (!appId || !key || !org || !repo) return null;
  const privateKeyPem = key.includes("PRIVATE KEY")
    ? key
    : Buffer.from(key, "base64").toString("utf8");
  return {
    apiBase: process.env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL,
    appId,
    privateKeyPem,
    org,
    repo,
  };
}

const BLEEPHUB_ADMIN = "admin";
const BLEEPHUB_OAUTH = {
  client_id: "edd-app-e2e",
  client_secret: "secret",
  redirect_uri: "http://localhost/cb",
  scope: "read:org",
};
const APP_PERMISSIONS = { administration: "write", contents: "write", metadata: "read" };
const appCreateResponse = z.object({ id: z.number(), pem: z.string() });

/** Provision an App + installation + repo on bleephub and return the same
 * coordinate shape a real-GitHub deployment supplies out of band. */
async function provisionViaBleephub(): Promise<GitHubAppCoordinates> {
  const org = "app-org";
  const repo = "app-repo";
  const token = await bleephubOAuthLogin(BLEEPHUB_ADMIN, BLEEPHUB_OAUTH);
  const authed: RequestInit = {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  };
  await bleephubProvisionTeam(token, org, "devs");
  await fetch(`${bleephub.apiUrl}/orgs/${org}/repos`, {
    method: "POST",
    ...authed,
    body: JSON.stringify({ name: repo, private: true, auto_init: true }),
  });

  const appRes = await fetch(`${bleephub.url}/internal/apps`, {
    method: "POST",
    ...authed,
    body: JSON.stringify({ name: "edd-app-e2e", permissions: APP_PERMISSIONS }),
  });
  if (!appRes.ok) throw new Error(`bleephub app create failed: ${String(appRes.status)}`);
  const app = appCreateResponse.parse(await appRes.json());

  const instRes = await fetch(`${bleephub.url}/internal/apps/${String(app.id)}/installations`, {
    method: "POST",
    ...authed,
    body: JSON.stringify({
      target_type: "Organization",
      target_login: org,
      permissions: APP_PERMISSIONS,
    }),
  });
  if (!instRes.ok)
    throw new Error(`bleephub installation create failed: ${String(instRes.status)}`);

  return { apiBase: bleephub.apiUrl, appId: String(app.id), privateKeyPem: app.pem, org, repo };
}

/**
 * Resolve the GitHub-App coordinates the test runs against: env (real GitHub /
 * GHES) when fully specified, else provisioned via the bleephub harness. Also
 * points `AUTH_GITHUB_API_URL` at the resolved base so the provider + REST hit
 * the same endpoint. The test never learns which target it is.
 */
export async function ensureGitHubAppCoordinates(): Promise<GitHubAppCoordinates> {
  const coords = coordinatesFromEnv() ?? (await provisionViaBleephub());
  process.env[GITHUB_API_URL_ENV] = coords.apiBase;
  return coords;
}
