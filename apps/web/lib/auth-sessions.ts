// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import type { Role } from "@edd/authz";
import {
  createDynamoClient,
  makeAuthSessionCorrelationEntity,
  makeAuthSessionEntity,
  makeOidcLogoutTokenEntity,
  writeTransaction,
} from "@edd/db";
import type { JWT } from "next-auth/jwt";

import { tableName } from "./control-plane";

export const AUTH_SESSION_SCHEMA_VERSION = 3;
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export interface ValidAuthSession {
  readonly id: string;
  readonly ownerId: string;
  readonly role: Role;
  readonly expiresAtMs: number;
}

export interface AuthSessionLogoutContext {
  readonly provider: string;
  readonly providerIdToken: string;
}

export interface ProviderLogoutToken {
  readonly tokenId: string;
  readonly expiresAtEpochSeconds: number;
  readonly providerSessionId?: string;
  readonly providerSubject?: string;
}

let entity: ReturnType<typeof makeAuthSessionEntity> | undefined;
let correlationEntity: ReturnType<typeof makeAuthSessionCorrelationEntity> | undefined;
let logoutTokenEntity: ReturnType<typeof makeOidcLogoutTokenEntity> | undefined;

function sessions(): ReturnType<typeof makeAuthSessionEntity> {
  entity ??= makeAuthSessionEntity(createDynamoClient(), tableName());
  return entity;
}

function logoutTokens(): ReturnType<typeof makeOidcLogoutTokenEntity> {
  logoutTokenEntity ??= makeOidcLogoutTokenEntity(createDynamoClient(), tableName());
  return logoutTokenEntity;
}

function correlations(): ReturnType<typeof makeAuthSessionCorrelationEntity> {
  correlationEntity ??= makeAuthSessionCorrelationEntity(createDynamoClient(), tableName());
  return correlationEntity;
}

function expiresAt(nowMs: number): string {
  return new Date(nowMs + SESSION_MAX_AGE_MS).toISOString();
}

function parseExpiry(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid auth session expiresAt: ${value}`);
  return ms;
}

export async function createAuthSession(input: {
  readonly ownerId: string;
  readonly role: Role;
  readonly provider?: string;
  readonly providerSubject?: string;
  readonly providerSessionId?: string;
  readonly providerIdToken?: string;
  readonly nowMs?: number;
}): Promise<ValidAuthSession> {
  const nowMs = input.nowMs ?? Date.now();
  const id = randomUUID();
  const provider = input.provider ?? "credentials";
  const providerSessionId = input.providerSessionId ?? id;
  const providerSubject = input.providerSubject ?? input.ownerId;
  const nowIso = new Date(nowMs).toISOString();
  const expiry = expiresAt(nowMs);
  const session = {
    id,
    schemaVersion: AUTH_SESSION_SCHEMA_VERSION,
    ownerId: input.ownerId,
    role: input.role,
    provider,
    providerSubject,
    providerSessionId,
    ...(input.providerIdToken === undefined ? {} : { providerIdToken: input.providerIdToken }),
    createdAt: nowIso,
    refreshedAt: nowIso,
    expiresAt: expiry,
  };
  if (provider === "shauth") {
    const expiresAtEpochSeconds = Math.floor(parseExpiry(expiry) / 1000);
    const result = await writeTransaction(
      { session: sessions(), correlation: correlations() },
      ({ session: sessionEntity, correlation }) => [
        sessionEntity.create(session).commit(),
        correlation
          .create({
            provider,
            kind: "session",
            value: providerSessionId,
            authSessionId: id,
            expiresAtEpochSeconds,
          })
          .commit(),
        correlation
          .create({
            provider,
            kind: "subject",
            value: providerSubject,
            authSessionId: id,
            expiresAtEpochSeconds,
          })
          .commit(),
      ],
    ).go();
    if (result.canceled) throw new Error("create Shauth session correlation transaction failed");
  } else {
    await sessions().create(session).go();
  }
  return { id, ownerId: input.ownerId, role: input.role, expiresAtMs: parseExpiry(expiry) };
}

export async function getAuthSessionLogoutContext(
  id: string,
): Promise<AuthSessionLogoutContext | null> {
  const { data } = await sessions().get({ id }).go();
  if (
    data === null ||
    data.revokedAt !== undefined ||
    typeof data.provider !== "string" ||
    typeof data.providerIdToken !== "string"
  ) {
    return null;
  }
  return { provider: data.provider, providerIdToken: data.providerIdToken };
}

export async function revokeAuthSessionsByProviderSession(
  provider: string,
  providerSessionId: string,
): Promise<number> {
  return revokeAuthSessionsByCorrelation(provider, "session", providerSessionId);
}

async function revokeAuthSessionsByProviderSubject(
  provider: string,
  providerSubject: string,
): Promise<number> {
  return revokeAuthSessionsByCorrelation(provider, "subject", providerSubject);
}

async function revokeAuthSessionsByCorrelation(
  provider: string,
  kind: "session" | "subject",
  value: string,
): Promise<number> {
  const { data: pointers } = await correlations()
    .query.primary({ provider, kind, value })
    .go({ pages: "all", consistent: true });
  const loaded = await Promise.all(
    pointers.map(({ authSessionId }) =>
      sessions().get({ id: authSessionId }).go({ consistent: true }),
    ),
  );
  const active = loaded.flatMap(({ data }) =>
    data !== null && data.provider === provider && data.revokedAt === undefined ? [data] : [],
  );
  const revokedAt = new Date().toISOString();
  await Promise.all(
    active.map((session) => sessions().patch({ id: session.id }).set({ revokedAt }).go()),
  );
  return active.length;
}

/**
 * Consumes a verified provider logout token exactly once, then revokes every
 * matching application session. Back-channel logout identifies the provider
 * session by `sid`, the provider account by `sub`, or both; either standard
 * correlation key therefore invalidates every matching EDD browser session.
 */
export async function consumeProviderLogoutToken(
  provider: string,
  token: ProviderLogoutToken,
  nowMs = Date.now(),
): Promise<number> {
  if (token.providerSessionId === undefined && token.providerSubject === undefined) {
    throw new Error("provider logout token did not contain sid or sub");
  }
  if (
    !Number.isSafeInteger(token.expiresAtEpochSeconds) ||
    token.expiresAtEpochSeconds <= Math.floor(nowMs / 1000)
  ) {
    throw new Error("provider logout token expiry is invalid");
  }
  await logoutTokens()
    .create({
      provider,
      tokenId: token.tokenId,
      consumedAt: new Date(nowMs).toISOString(),
      expiresAtEpochSeconds: token.expiresAtEpochSeconds,
    })
    .go();

  let revoked = 0;
  if (token.providerSessionId !== undefined) {
    revoked += await revokeAuthSessionsByProviderSession(provider, token.providerSessionId);
  }
  if (token.providerSubject !== undefined) {
    revoked += await revokeAuthSessionsByProviderSubject(provider, token.providerSubject);
  }
  return revoked;
}

export async function validateAuthSessionToken(
  token: Pick<JWT, "authSessionId" | "authSessionVersion" | "uid" | "role">,
  nowMs = Date.now(),
): Promise<ValidAuthSession | null> {
  if (token.authSessionVersion !== AUTH_SESSION_SCHEMA_VERSION) return null;
  if (typeof token.authSessionId !== "string" || token.authSessionId.length === 0) return null;
  const { data } = await sessions().get({ id: token.authSessionId }).go();
  if (data === null) return null;
  if (data.schemaVersion !== AUTH_SESSION_SCHEMA_VERSION) return null;
  if (data.revokedAt !== undefined) return null;
  const expiresAtMs = parseExpiry(data.expiresAt);
  if (expiresAtMs <= nowMs) return null;
  if (data.ownerId !== token.uid) return null;
  if (data.role !== token.role) return null;
  const refreshedExpiry = expiresAt(nowMs);
  await sessions()
    .patch({ id: data.id })
    .set({ refreshedAt: new Date(nowMs).toISOString(), expiresAt: refreshedExpiry })
    .go();
  if (data.provider === "shauth") {
    const expiresAtEpochSeconds = Math.floor(parseExpiry(refreshedExpiry) / 1000);
    await Promise.all(
      (
        [
          ["session", data.providerSessionId],
          ["subject", data.providerSubject],
        ] as const
      ).map(([kind, value]) =>
        correlations()
          .patch({ provider: data.provider, kind, value, authSessionId: data.id })
          .set({ expiresAtEpochSeconds })
          .go(),
      ),
    );
  }
  return {
    id: data.id,
    ownerId: data.ownerId,
    role: data.role,
    expiresAtMs: parseExpiry(refreshedExpiry),
  };
}

export async function revokeAuthSession(id: string): Promise<void> {
  const { data } = await sessions().get({ id }).go();
  if (data === null) return;
  await sessions().patch({ id }).set({ revokedAt: new Date().toISOString() }).go();
}
