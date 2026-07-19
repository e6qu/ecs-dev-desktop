// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OIDCConfig } from "next-auth/providers";
import { z } from "zod";

import {
  SHAUTH_CLIENT_ID_ENV,
  SHAUTH_CLIENT_SECRET_ENV,
  SHAUTH_ISSUER_ENV,
  SHAUTH_POST_LOGOUT_URL_ENV,
} from "./constants";

export interface ShauthOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  postLogoutUrl: string | null;
}

const profileSchema = z.object({
  sub: z.string().min(1),
  preferred_username: z.string().min(1),
  email: z.email(),
  role: z.enum(["developer", "admin"]),
  picture: z.url().optional(),
});

type ShauthProfile = z.infer<typeof profileSchema>;

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
  const configuredCoordinates = [issuer, clientId, clientSecret].filter(
    (value) => value.length > 0,
  ).length;
  if (configuredCoordinates === 0 && postLogoutUrl === "") return null;
  if (configuredCoordinates !== 3) {
    throw new Error(
      `${SHAUTH_ISSUER_ENV}, ${SHAUTH_CLIENT_ID_ENV}, and ${SHAUTH_CLIENT_SECRET_ENV} must be configured together`,
    );
  }
  return {
    issuer: absoluteHTTPSURL(SHAUTH_ISSUER_ENV, issuer),
    clientId,
    clientSecret,
    postLogoutUrl:
      postLogoutUrl === "" ? null : absoluteHTTPSURL(SHAUTH_POST_LOGOUT_URL_ENV, postLogoutUrl),
  };
}

export function shauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return shauthOidcConfig(env) !== null;
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
