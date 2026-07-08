// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { DEFAULT_GITHUB_URL } from "@edd/config";
import { z } from "zod";

import { GITHUB_URL_ENV } from "./constants";

const STATE_VERSION = 1;
const STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_CONNECT_SCOPE = "read:user user:email read:org repo";

interface GithubConnectState {
  readonly version: typeof STATE_VERSION;
  readonly ownerId: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface GithubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webBase: string;
}

export interface GithubTokenExchange {
  readonly accessToken: string;
  readonly scope: string;
  readonly tokenType: string;
}

type EnvReader = Readonly<Record<string, string | undefined>>;

const stateSchema = z.object({
  version: z.literal(STATE_VERSION),
  ownerId: z.string().min(1),
  nonce: z.uuid(),
  expiresAt: z.iso.datetime(),
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string(),
  token_type: z.string().min(1),
});

function authSecret(env: EnvReader = process.env): string {
  const secret = env.AUTH_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new Error("AUTH_SECRET is required for GitHub account linking");
  }
  return secret;
}

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeJson(value: GithubConnectState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(payload: string): unknown {
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function githubOAuthConfigFromEnv(env: EnvReader = process.env): GithubOAuthConfig {
  const clientId = env.AUTH_GITHUB_ID;
  if (clientId === undefined || clientId.length === 0) {
    throw new Error("AUTH_GITHUB_ID is required for GitHub account linking");
  }
  const clientSecret = env.AUTH_GITHUB_SECRET;
  if (clientSecret === undefined || clientSecret.length === 0) {
    throw new Error("AUTH_GITHUB_SECRET is required for GitHub account linking");
  }
  const webBase = (env[GITHUB_URL_ENV] ?? DEFAULT_GITHUB_URL).replace(/\/+$/, "");
  return { clientId, clientSecret, webBase };
}

export function signGithubConnectState(
  ownerId: string,
  now: Date,
  env: EnvReader = process.env,
): string {
  const payload = encodeJson({
    version: STATE_VERSION,
    ownerId,
    nonce: randomUUID(),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  });
  return `${payload}.${hmac(authSecret(env), payload)}`;
}

export function verifyGithubConnectState(
  state: string,
  now: Date,
  env: EnvReader = process.env,
): GithubConnectState {
  const parts = state.split(".");
  if (parts.length !== 2) throw new Error("invalid GitHub connect state");
  const [payload, signature] = parts;
  const expected = hmac(authSecret(env), payload);
  if (!safeEqual(signature, expected)) throw new Error("invalid GitHub connect state");
  const parsed = stateSchema.parse(decodeJson(payload));
  if (Date.parse(parsed.expiresAt) <= now.getTime()) {
    throw new Error("expired GitHub connect state");
  }
  return parsed;
}

export function githubAuthorizeUrl(
  cfg: GithubOAuthConfig,
  redirectUri: string,
  state: string,
): string {
  const url = new URL("/login/oauth/authorize", cfg.webBase);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GITHUB_CONNECT_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGithubConnectCode(
  cfg: GithubOAuthConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTokenExchange> {
  const res = await fetchImpl(new URL("/login/oauth/access_token", cfg.webBase), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`GitHub OAuth token exchange failed: ${String(res.status)}`);
  const parsed = tokenSchema.parse(await res.json());
  return {
    accessToken: parsed.access_token,
    scope: parsed.scope,
    tokenType: parsed.token_type,
  };
}
