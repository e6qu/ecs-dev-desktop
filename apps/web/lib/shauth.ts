// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  SHAUTH_CLIENT_ID_ENV,
  SHAUTH_CLIENT_SECRET_ENV,
  SHAUTH_ISSUER_ENV,
} from "./constants";

export interface ShauthOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

function configured(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

/**
 * Reads Shauth's confidential OpenID Connect client coordinates. Shauth is
 * disabled only when every coordinate is absent; a partial configuration fails
 * during startup instead of presenting a login route that cannot complete.
 */
export function shauthOidcConfig(env: NodeJS.ProcessEnv = process.env): ShauthOidcConfig | null {
  const issuer = env[SHAUTH_ISSUER_ENV];
  const clientId = env[SHAUTH_CLIENT_ID_ENV];
  const clientSecret = env[SHAUTH_CLIENT_SECRET_ENV];
  if (!configured(issuer) && !configured(clientId) && !configured(clientSecret)) return null;
  if (
    issuer === undefined ||
    issuer.length === 0 ||
    clientId === undefined ||
    clientId.length === 0 ||
    clientSecret === undefined ||
    clientSecret.length === 0
  ) {
    throw new Error(
      `${SHAUTH_ISSUER_ENV}, ${SHAUTH_CLIENT_ID_ENV}, and ${SHAUTH_CLIENT_SECRET_ENV} must be configured together`,
    );
  }
  return { issuer, clientId, clientSecret };
}

export function shauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return shauthOidcConfig(env) !== null;
}
