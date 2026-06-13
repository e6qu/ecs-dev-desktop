// SPDX-License-Identifier: AGPL-3.0-or-later
import { POMERIUM_JWKS_URL_ENV } from "@edd/config";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { KeyObject } from "node:crypto";

/**
 * Verification of the Pomerium identity assertion (`X-Pomerium-Jwt-Assertion`).
 *
 * Pomerium signs this JWT (ES256) and, per its source
 * (`authorize/evaluator/headers_evaluator_evaluation.go`, v0.32.2), sets:
 *   - `aud` = the requested route hostname (the workspace host),
 *   - `iss` = the route hostname (bare; `https://<host>/` only under the URI
 *     issuer format),
 *   - `sub`/`user` = the IdP user id, `email` = the directory/IdP email,
 *     `groups` = the user's groups (an empty list, never null).
 *
 * Binding `aud` to the workspace host is the key property: a token minted for
 * one workspace cannot be replayed against another. We verify the signature
 * against Pomerium's JWKS, the expiry, and that `aud`/`iss` equal the expected
 * host, then trust the identity claims (the documented downstream pattern —
 * Pomerium can't itself enforce DynamoDB-backed ownership).
 */

/** Identity claims trusted after a successful assertion verification. */
export interface AssertedIdentity {
  readonly subject: string;
  readonly email: string | undefined;
  readonly groups: string[];
}

/** A jose key input: the remote JWKS resolver, a local JWKS function, or a key. */
export type AssertionKey = JWTVerifyGetKey | CryptoKey | KeyObject | Uint8Array;

const jwksByUrl = new Map<string, JWTVerifyGetKey>();

/** Resolver for Pomerium's JWKS endpoint, cached per URL (the URL is read at
 * call time so it can be configured after import). Throws loudly if unset,
 * rather than silently accepting tokens. */
function defaultKey(): JWTVerifyGetKey {
  const url = process.env[POMERIUM_JWKS_URL_ENV];
  if (url === undefined || url.length === 0) {
    throw new Error(`${POMERIUM_JWKS_URL_ENV} is not configured`);
  }
  let resolver = jwksByUrl.get(url);
  if (resolver === undefined) {
    resolver = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, resolver);
  }
  return resolver;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Verify a Pomerium assertion for `expectedHost` and return the trusted
 * identity. Throws if the signature, expiry, audience, or issuer is invalid.
 * `key` is injectable for tests; production uses the remote JWKS.
 */
export async function verifyAssertion(
  token: string,
  expectedHost: string,
  key: AssertionKey = defaultKey(),
): Promise<AssertedIdentity> {
  const options = { algorithms: ["ES256"], audience: expectedHost };
  const { payload } =
    typeof key === "function"
      ? await jwtVerify(token, key, options)
      : await jwtVerify(token, key, options);
  // iss is the bare host by default, or https://<host>/ under the URI format.
  const iss = payload.iss;
  if (iss !== expectedHost && iss !== `https://${expectedHost}/`) {
    throw new Error(`assertion iss mismatch: ${iss ?? "(none)"}`);
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("assertion missing sub");
  }
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { subject: payload.sub, email, groups: asStringArray(payload.groups) };
}
