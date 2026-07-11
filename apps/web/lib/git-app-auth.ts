// SPDX-License-Identifier: AGPL-3.0-or-later
import { createPrivateKey } from "node:crypto";

import { SignJWT } from "jose";
import { z } from "zod";

/**
 * GitHub App authentication: sign a short-lived RS256 app JWT with the app's
 * private key, then exchange it for an installation access token. This is the
 * standard GitHub App server-to-server flow; the resulting `ghs_…` installation
 * token is used as a bearer for REST and (wire-identical to a user token) for
 * git clone/push as `x-access-token`. Endpoint-only: `apiBase` points at GHES /
 * the github sim or public GitHub. We use `jose` for the signature (no
 * hand-rolled crypto) and Node's `createPrivateKey` so PKCS#1 *or* PKCS#8 PEMs
 * are accepted (real GitHub App keys are PKCS#1).
 */
export interface GitHubAppConfig {
  appId: string;
  /** RSA private key PEM (PKCS#1 "RSA PRIVATE KEY" or PKCS#8 "PRIVATE KEY"). */
  privateKeyPem: string;
  apiBase: string;
}

/** GitHub caps the app JWT at 10 minutes; use 9 to stay clear of clock skew. */
const APP_JWT_TTL_S = 9 * 60;
/** Backdate `iat` to tolerate the app server's clock running slightly fast. */
const APP_JWT_SKEW_S = 30;

/** Sign an RS256 app JWT (`iss` = app id), valid from now. `nowSec` is injected
 * so the signing is deterministic and unit-testable. */
export async function signAppJwt(cfg: GitHubAppConfig, nowSec: number): Promise<string> {
  const key = createPrivateKey(cfg.privateKeyPem);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(cfg.appId)
    .setIssuedAt(nowSec - APP_JWT_SKEW_S)
    .setExpirationTime(nowSec + APP_JWT_TTL_S)
    .sign(key);
}

const ghHeaders = (bearer: string): Record<string, string> => ({
  Authorization: `Bearer ${bearer}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

export interface InstallationToken {
  token: string;
  /** RFC3339 expiry returned by GitHub (~1 hour out). */
  expiresAt: string;
}

const tokenResponse = z.object({ token: z.string(), expires_at: z.string() });

/**
 * Optional least-privilege scoping for a minted installation token. GitHub restricts the
 * returned token to `repositories` (by name) and the requested `permissions` subset — so a
 * token handed to a single workspace can be limited to exactly the one repo it clones with
 * only the access it needs, instead of the installation's full org-wide repo set/permissions.
 */
export interface InstallationTokenScope {
  readonly repositories?: readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
}

/** Exchange the app JWT for an installation access token (`ghs_…`), optionally scoped down
 * to specific repositories/permissions (least privilege — see {@link InstallationTokenScope}). */
export async function mintInstallationToken(
  cfg: GitHubAppConfig,
  installationId: number,
  nowSec: number,
  fetchImpl: typeof fetch = fetch,
  scope?: InstallationTokenScope,
): Promise<InstallationToken> {
  const jwt = await signAppJwt(cfg, nowSec);
  const requestBody: Record<string, unknown> = {};
  if (scope?.repositories !== undefined) requestBody.repositories = [...scope.repositories];
  if (scope?.permissions !== undefined) requestBody.permissions = scope.permissions;
  const res = await fetchImpl(
    `${cfg.apiBase}/app/installations/${String(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: { ...ghHeaders(jwt), "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub installation-token mint failed: ${String(res.status)}`);
  }
  const body = tokenResponse.parse(await res.json());
  return { token: body.token, expiresAt: body.expires_at };
}

const installationSchema = z.object({
  id: z.number(),
  target_type: z.string(),
  permissions: z.record(z.string(), z.string()).default({}),
  account: z.object({ login: z.string(), type: z.string() }).nullable().optional(),
});
export type AppInstallation = z.infer<typeof installationSchema>;

/** List the app's installations (authenticated with the app JWT). */
export async function listAppInstallations(
  cfg: GitHubAppConfig,
  nowSec: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AppInstallation[]> {
  const jwt = await signAppJwt(cfg, nowSec);
  const res = await fetchImpl(`${cfg.apiBase}/app/installations?per_page=100`, {
    headers: ghHeaders(jwt),
  });
  if (!res.ok) throw new Error(`GitHub /app/installations failed: ${String(res.status)}`);
  return z.array(installationSchema).parse(await res.json());
}
