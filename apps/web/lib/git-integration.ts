// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_GITHUB_API_URL, DEFAULT_GITHUB_URL } from "@edd/config";

import {
  GITHUB_API_URL_ENV,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_KEY_ENV,
  GITHUB_URL_ENV,
} from "./constants";

/**
 * What this deployment can do for a session that needs git access — derived purely from
 * configuration, so the launcher, the admin views, and the docs all tell the same story
 * instead of offering a "Connect GitHub" button that the deployment cannot honour.
 *
 * - `tokens`: how an HTTPS git token can be obtained. `app` — a GitHub App mints a
 *   per-repository installation token (no user action; needs `EDD_GITHUB_APP_ID` +
 *   `EDD_GITHUB_APP_KEY`). `oauth` — the user links their GitHub account and their OAuth
 *   token is stored encrypted (needs `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` and the
 *   store's `EDD_TOKEN_ENC_KEY`). `none` — neither is configured: only public
 *   repositories clone over HTTPS.
 * - `sshKeys`: whether users can generate platform-held SSH keys for the git host
 *   (needs only `EDD_TOKEN_ENC_KEY`, which encrypts the private halves at rest).
 */
export interface GitIntegration {
  readonly tokens: "app" | "oauth" | "none";
  readonly sshKeys: boolean;
  /** The git host users add SSH keys to (from the deployment's GitHub web coordinate). */
  readonly host: string;
  /** The host's REST API base (where published SSH host keys are read from). */
  readonly apiUrl: string;
}

type EnvReader = Readonly<Record<string, string | undefined>>;

const present = (value: string | undefined): boolean => value !== undefined && value.length > 0;

/** Pure over `env`; unit-testable. */
export function gitIntegrationFromEnv(env: EnvReader): GitIntegration {
  const encryptionKey = present(env.EDD_TOKEN_ENC_KEY);
  const app = present(env[GITHUB_APP_ID_ENV]) && present(env[GITHUB_APP_KEY_ENV]);
  const oauth = present(env.AUTH_GITHUB_ID) && present(env.AUTH_GITHUB_SECRET) && encryptionKey;
  const webUrl = env[GITHUB_URL_ENV] ?? DEFAULT_GITHUB_URL;
  return {
    tokens: app ? "app" : oauth ? "oauth" : "none",
    sshKeys: encryptionKey,
    host: new URL(webUrl).hostname,
    apiUrl: env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL,
  };
}

/** The running process's integration. */
export function gitIntegration(): GitIntegration {
  return gitIntegrationFromEnv(process.env);
}
