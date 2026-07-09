// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";

import type { Role } from "@edd/authz";
import {
  createDynamoClient,
  makeAuthSessionEntity,
  makeInvitationEntity,
  makeLocalAccountEntity,
} from "@edd/db";

import { tableName } from "./control-plane";
import { hashPassword, verifyPassword } from "./passwords";

export type LocalAccountRole = Extract<Role, "developer" | "admin">;

export interface LocalAccount {
  readonly ownerId: string;
  readonly email: string;
  readonly role: LocalAccountRole;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
}

export interface LocalSession {
  readonly id: string;
  readonly ownerId: string;
  readonly role: Role;
  readonly createdAt: string;
  readonly refreshedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface Invitation {
  readonly ownerId: string;
  readonly email: string;
  readonly role: "developer";
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly acceptedAt?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INVITATION_TTL_DAYS = 1;
const MAX_INVITATION_TTL_DAYS = 30;

let accountsEntity: ReturnType<typeof makeLocalAccountEntity> | undefined;
let invitationsEntity: ReturnType<typeof makeInvitationEntity> | undefined;
let sessionsEntity: ReturnType<typeof makeAuthSessionEntity> | undefined;

function accounts(): ReturnType<typeof makeLocalAccountEntity> {
  accountsEntity ??= makeLocalAccountEntity(createDynamoClient(), tableName());
  return accountsEntity;
}

function invitations(): ReturnType<typeof makeInvitationEntity> {
  invitationsEntity ??= makeInvitationEntity(createDynamoClient(), tableName());
  return invitationsEntity;
}

function sessions(): ReturnType<typeof makeAuthSessionEntity> {
  sessionsEntity ??= makeAuthSessionEntity(createDynamoClient(), tableName());
  return sessionsEntity;
}

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) throw new Error("invalid email address");
  return trimmed;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function randomOwnerId(): string {
  return `user-${randomBytes(12).toString("base64url")}`;
}

function invitationTtlMs(daysInput?: number): number {
  const days = daysInput ?? DEFAULT_INVITATION_TTL_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVITATION_TTL_DAYS) {
    throw new Error("invitation duration must be between 1 and 30 days");
  }
  return days * DAY_MS;
}

async function ownerIdForInvitation(email: string): Promise<string> {
  const existing = await accounts().get({ email }).go();
  if (existing.data !== null) return existing.data.ownerId;
  const previous = await invitations().query.byEmail({ email }).go({ pages: "all" });
  if (previous.data.length === 0) return randomOwnerId();
  const latest = previous.data.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest.ownerId;
}

function toAccount(data: {
  ownerId: string;
  email: string;
  role: LocalAccountRole;
  createdAt: string;
  createdBy: string;
  disabledAt?: string;
}): LocalAccount {
  return {
    ownerId: data.ownerId,
    email: data.email,
    role: data.role,
    createdAt: data.createdAt,
    createdBy: data.createdBy,
    ...(data.disabledAt === undefined ? {} : { disabledAt: data.disabledAt }),
  };
}

export async function createLocalAccount(input: {
  readonly email: string;
  readonly password: string;
  readonly role: LocalAccountRole;
  readonly createdBy: string;
  readonly nowMs?: number;
}): Promise<LocalAccount> {
  if (input.password.length < 12) throw new Error("password must be at least 12 characters");
  const email = normalizeEmail(input.email);
  const existing = await accounts().get({ email }).go();
  if (existing.data !== null) throw new Error(`local account already exists for ${email}`);
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const record = {
    ownerId: randomOwnerId(),
    email,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    createdAt: now,
    createdBy: input.createdBy,
  };
  await accounts().create(record).go();
  return toAccount(record);
}

export async function authenticateLocalAccount(
  emailInput: string,
  password: string,
): Promise<LocalAccount | null> {
  const email = normalizeEmail(emailInput);
  const { data } = await accounts().get({ email }).go();
  if (data === null || data.disabledAt !== undefined) return null;
  return (await verifyPassword(password, data.passwordHash)) ? toAccount(data) : null;
}

export async function listLocalAccounts(): Promise<readonly LocalAccount[]> {
  const rows = await Promise.all([
    accounts().query.byRole({ role: "admin" }).go({ pages: "all" }),
    accounts().query.byRole({ role: "developer" }).go({ pages: "all" }),
  ]);
  return rows
    .flatMap((r) => r.data.map((a) => toAccount(a)))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function createDeveloperInvitation(input: {
  readonly email: string;
  readonly createdBy: string;
  readonly durationDays?: number;
  readonly nowMs?: number;
}): Promise<{ readonly invitation: Invitation; readonly token: string }> {
  const email = normalizeEmail(input.email);
  const nowMs = input.nowMs ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const ownerId = await ownerIdForInvitation(email);
  const record = {
    tokenHash: tokenHash(token),
    email,
    ownerId,
    role: "developer" as const,
    createdAt: new Date(nowMs).toISOString(),
    createdBy: input.createdBy,
    expiresAt: new Date(nowMs + invitationTtlMs(input.durationDays)).toISOString(),
  };
  await invitations().create(record).go();
  return { invitation: record, token };
}

export async function acceptDeveloperInvitation(input: {
  readonly token: string;
  readonly password: string;
  readonly nowMs?: number;
}): Promise<LocalAccount> {
  const nowMs = input.nowMs ?? Date.now();
  const hash = tokenHash(input.token);
  const { data } = await invitations().get({ tokenHash: hash }).go();
  if (data === null) throw new Error("invitation not found");
  if (data.acceptedAt !== undefined) throw new Error("invitation already accepted");
  if (Date.parse(data.expiresAt) <= nowMs) throw new Error("invitation expired");
  const existing = await accounts().get({ email: data.email }).go();
  const nowIso = new Date(nowMs).toISOString();
  const passwordHash = await hashPassword(input.password);
  const account =
    existing.data === null
      ? {
          ownerId: data.ownerId,
          email: data.email,
          role: "developer" as const,
          passwordHash,
          createdAt: nowIso,
          createdBy: data.createdBy,
        }
      : {
          ...existing.data,
          passwordHash,
          disabledAt: undefined,
        };
  if (existing.data === null) {
    await accounts().create(account).go();
  } else {
    await accounts().patch({ email: data.email }).set({ passwordHash }).remove(["disabledAt"]).go();
  }
  await invitations()
    .patch({ tokenHash: hash })
    .set({ acceptedAt: new Date(nowMs).toISOString() })
    .go();
  return toAccount(account);
}

export async function listInvitations(): Promise<readonly Invitation[]> {
  const rows = await invitations().scan.go({ pages: "all" });
  return rows.data
    .map((i) => ({
      ownerId: i.ownerId,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      createdBy: i.createdBy,
      expiresAt: i.expiresAt,
      ...(i.acceptedAt === undefined ? {} : { acceptedAt: i.acceptedAt }),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAuthSessions(): Promise<readonly LocalSession[]> {
  const rows = await sessions().scan.go({ pages: "all" });
  return rows.data
    .map((s) => ({
      id: s.id,
      ownerId: s.ownerId,
      role: s.role,
      createdAt: s.createdAt,
      refreshedAt: s.refreshedAt,
      expiresAt: s.expiresAt,
      ...(s.revokedAt === undefined ? {} : { revokedAt: s.revokedAt }),
    }))
    .sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
}

export async function revokeUserSessions(ownerId: string): Promise<number> {
  const rows = await sessions().query.byOwner({ ownerId }).go({ pages: "all" });
  let count = 0;
  for (const row of rows.data) {
    if (row.revokedAt === undefined) {
      await sessions().patch({ id: row.id }).set({ revokedAt: new Date().toISOString() }).go();
      count += 1;
    }
  }
  return count;
}

export async function revokeAllSessions(): Promise<number> {
  const rows = await sessions().scan.go({ pages: "all" });
  let count = 0;
  for (const row of rows.data) {
    if (row.revokedAt === undefined) {
      await sessions().patch({ id: row.id }).set({ revokedAt: new Date().toISOString() }).go();
      count += 1;
    }
  }
  return count;
}
