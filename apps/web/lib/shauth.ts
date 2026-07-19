// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OIDCConfig } from "next-auth/providers";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions } from "jose";
import { z } from "zod";

import {
  AUTH_URL_ENV,
  SHAUTH_CLIENT_ID_ENV,
  SHAUTH_CLIENT_SECRET_ENV,
  SHAUTH_ISSUER_ENV,
  SHAUTH_POST_LOGOUT_URL_ENV,
} from "./constants";

export interface ShauthOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  postLogoutUrl: string;
}

const SHAUTH_CALLBACK_PATH = "/api/auth/callback/shauth";
const SHAUTH_SIGNED_OUT_PATH = "/signed-out";

const profileSchema = z.object({
  sub: z.string().min(1),
  preferred_username: z.string().min(1),
  email: z.email(),
  role: z.enum(["developer", "admin"]),
  picture: z.url().optional(),
});

type ShauthProfile = z.infer<typeof profileSchema>;

const logoutEvent = "http://schemas.openid.net/event/backchannel-logout";
const discoverySchema = z.object({
  issuer: z.url(),
  jwks_uri: z.url(),
});
const remoteKeys = new Map<string, Promise<JWTVerifyGetKey>>();

function absoluteHTTPSURL(name: string, value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${name} must be an absolute HTTPS URL without credentials, query, or fragment`,
    );
  }
  return value.replace(/\/+$/, "");
}

/**
 * Reads Shauth's confidential OpenID Connect client coordinates. Shauth is
 * disabled only when every coordinate is absent; a partial configuration fails
 * during startup instead of presenting a login route that cannot complete.
 */
export function shauthOidcConfig(env: NodeJS.ProcessEnv = process.env): ShauthOidcConfig | null {
  const issuer = env[SHAUTH_ISSUER_ENV]?.trim() ?? "";
  const clientId = env[SHAUTH_CLIENT_ID_ENV]?.trim() ?? "";
  const clientSecret = env[SHAUTH_CLIENT_SECRET_ENV] ?? "";
  const postLogoutUrl = env[SHAUTH_POST_LOGOUT_URL_ENV]?.trim() ?? "";
  const configuredCoordinates = [issuer, clientId, clientSecret, postLogoutUrl].filter(
    (value) => value.length > 0,
  ).length;
  if (configuredCoordinates === 0) return null;
  if (configuredCoordinates !== 4) {
    throw new Error(
      `${SHAUTH_ISSUER_ENV}, ${SHAUTH_CLIENT_ID_ENV}, ${SHAUTH_CLIENT_SECRET_ENV}, and ${SHAUTH_POST_LOGOUT_URL_ENV} must be configured together`,
    );
  }
  const authUrlValue = env[AUTH_URL_ENV]?.trim() ?? "";
  if (authUrlValue === "") {
    throw new Error(`${AUTH_URL_ENV} is required when Shauth is configured`);
  }
  const authUrl = new URL(absoluteHTTPSURL(AUTH_URL_ENV, authUrlValue));
  if (authUrl.pathname !== "/") {
    throw new Error(`${AUTH_URL_ENV} must identify the ECS Dev Desktop origin`);
  }
  const normalizedPostLogoutUrl = absoluteHTTPSURL(SHAUTH_POST_LOGOUT_URL_ENV, postLogoutUrl);
  const parsedPostLogoutUrl = new URL(normalizedPostLogoutUrl);
  if (
    parsedPostLogoutUrl.origin !== authUrl.origin ||
    parsedPostLogoutUrl.pathname !== SHAUTH_SIGNED_OUT_PATH
  ) {
    const callbackUrl = new URL(SHAUTH_CALLBACK_PATH, authUrl).toString();
    throw new Error(
      `${SHAUTH_POST_LOGOUT_URL_ENV} must be ${authUrl.origin}${SHAUTH_SIGNED_OUT_PATH}, on the same origin as ${callbackUrl}`,
    );
  }
  return {
    issuer: absoluteHTTPSURL(SHAUTH_ISSUER_ENV, issuer),
    clientId,
    clientSecret,
    postLogoutUrl: normalizedPostLogoutUrl,
  };
}

export function shauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return shauthOidcConfig(env) !== null;
}

export function shauthEndSessionURL(config: ShauthOidcConfig, idToken: string): string {
  if (idToken.length === 0) throw new Error("Shauth ID token must not be empty");
  const endSession = new URL("/oauth2/sessions/logout", config.issuer);
  endSession.searchParams.set("id_token_hint", idToken);
  endSession.searchParams.set("post_logout_redirect_uri", config.postLogoutUrl);
  return endSession.toString();
}

export function shauthProvider(): OIDCConfig<ShauthProfile> | null {
  const config = shauthOidcConfig();
  if (config === null) return null;
  return {
    id: "shauth",
    name: "Shauth",
    type: "oidc",
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    checks: ["pkce", "state", "nonce"],
    authorization: { params: { scope: "openid profile email offline_access" } },
    profile(rawProfile) {
      const profile = profileSchema.parse(rawProfile);
      return {
        id: profile.sub,
        name: profile.preferred_username,
        email: profile.email,
        image: profile.picture ?? null,
      };
    },
  };
}

async function discoverShauthKeys(config: ShauthOidcConfig): Promise<JWTVerifyGetKey> {
  let pending = remoteKeys.get(config.issuer);
  if (pending === undefined) {
    pending = (async () => {
      const discoveryUrl = new URL("/.well-known/openid-configuration", config.issuer);
      const response = await fetch(discoveryUrl, {
        cache: "force-cache",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`Shauth discovery returned HTTP ${response.status}`);
      }
      const discovery = discoverySchema.parse(await response.json());
      if (discovery.issuer.replace(/\/+$/, "") !== config.issuer) {
        throw new Error("Shauth discovery issuer did not match the configured issuer");
      }
      const jwksUrl = new URL(discovery.jwks_uri);
      if (jwksUrl.protocol !== "https:" || jwksUrl.username !== "" || jwksUrl.password !== "") {
        throw new Error("Shauth discovery returned an insecure JWKS URL");
      }
      return createRemoteJWKSet(jwksUrl);
    })();
    remoteKeys.set(config.issuer, pending);
    pending.catch(() => remoteKeys.delete(config.issuer));
  }
  return pending;
}

export async function verifyShauthBackchannelLogoutToken(
  logoutToken: string,
  config: ShauthOidcConfig,
  getKey?: JWTVerifyGetKey,
): Promise<string> {
  const key = getKey ?? (await discoverShauthKeys(config));
  const options: JWTVerifyOptions = {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: [
      "RS256",
      "RS384",
      "RS512",
      "PS256",
      "PS384",
      "PS512",
      "ES256",
      "ES384",
      "ES512",
      "EdDSA",
    ],
    maxTokenAge: "5m",
    clockTolerance: 5,
  };
  const { payload } = await jwtVerify(logoutToken, key, options);
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("Shauth logout token did not contain a jti claim");
  }
  if (payload.nonce !== undefined) {
    throw new Error("Shauth logout token contained a prohibited nonce claim");
  }
  if (
    typeof payload.events !== "object" ||
    payload.events === null ||
    !(logoutEvent in payload.events)
  ) {
    throw new Error("Shauth logout token did not contain the back-channel logout event");
  }
  if (typeof payload.sid !== "string" || payload.sid.length === 0) {
    throw new Error("Shauth logout token did not identify a provider session");
  }
  return payload.sid;
}
