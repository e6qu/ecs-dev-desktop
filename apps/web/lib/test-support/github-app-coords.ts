// SPDX-License-Identifier: AGPL-3.0-or-later
// Coordinates for the GitHub-App e2e. Per AGENTS.md §6.9 the test targets real
// GitHub, GHES, or the github sim by COORDINATES ALONE and never knows which —
// and uses NO sim-internal/private feature: github is treated exactly like real
// GitHub, differing only by base URL + credentials.
//
// A GitHub App is registered out of band on every target (no standard API creates
// one with a retrievable key), so its coordinates are always supplied externally:
//   AUTH_GITHUB_API_URL, EDD_GITHUB_APP_ID, EDD_GITHUB_APP_KEY (PEM or base64 PEM),
//   EDD_GITHUB_TEST_ORG, EDD_GITHUB_TEST_REPO.
// Absent them the e2e skips — there is intentionally no sim-internal shortcut
// (github's `/internal/apps` is off-limits). github cannot yet be seeded with
// a pre-registered App via standard config, so CI cannot supply sim coordinates;
// that is filed upstream (BUGS.md → External blockers, e6qu/sockerless).
import { DEFAULT_GITHUB_API_URL } from "@edd/config";

import { GITHUB_API_URL_ENV, GITHUB_APP_ID_ENV, GITHUB_APP_KEY_ENV } from "../constants";

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

/** Resolve the App coordinates from env (real GitHub / GHES / a pre-registered
 * App on any target), or null when not fully specified — in which case the e2e
 * skips. The same env targets the sim once it can be seeded with an App. */
export function gitHubAppCoordinatesFromEnv(): GitHubAppCoordinates | null {
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
