// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import type { Role } from "@edd/authz";
import { createDynamoClient, makeAuthSessionEntity, TABLE } from "@edd/db";
import type { JWT } from "next-auth/jwt";

import { tableName } from "./control-plane";

export const AUTH_SESSION_SCHEMA_VERSION = 1;
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export interface ValidAuthSession {
  readonly id: string;
  readonly ownerId: string;
  readonly role: Role;
  readonly expiresAtMs: number;
}

let entity: ReturnType<typeof makeAuthSessionEntity> | undefined;

function sessions(): ReturnType<typeof makeAuthSessionEntity> {
  entity ??= makeAuthSessionEntity(createDynamoClient(), tableName() || TABLE);
  return entity;
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
  readonly nowMs?: number;
}): Promise<ValidAuthSession> {
  const nowMs = input.nowMs ?? Date.now();
  const id = randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  const expiry = expiresAt(nowMs);
  await sessions()
    .put({
      id,
      schemaVersion: AUTH_SESSION_SCHEMA_VERSION,
      ownerId: input.ownerId,
      role: input.role,
      createdAt: nowIso,
      refreshedAt: nowIso,
      expiresAt: expiry,
    })
    .go();
  return { id, ownerId: input.ownerId, role: input.role, expiresAtMs: parseExpiry(expiry) };
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
