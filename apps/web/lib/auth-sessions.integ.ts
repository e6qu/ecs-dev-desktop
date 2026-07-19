// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDynamoClient, dropTable, dynamodb, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUTH_SESSION_SCHEMA_VERSION,
  consumeProviderLogoutToken,
  createAuthSession,
  getAuthSessionLogoutContext,
  revokeAuthSessionsByProviderSession,
  validateAuthSessionToken,
} from "./auth-sessions";

const TEST_TABLE = "edd-auth-sessions-integ";
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

describe("durable Shauth session correlation (DynamoDB Local)", () => {
  const client = createDynamoClient();

  beforeAll(async () => {
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("revokes every local session correlated with a provider sid", async () => {
    const first = await createAuthSession({
      ownerId: "user-1",
      role: "developer",
      provider: "shauth",
      providerSessionId: "provider-session-1",
      providerIdToken: "header.payload.signature",
    });
    const second = await createAuthSession({
      ownerId: "user-1",
      role: "developer",
      provider: "shauth",
      providerSessionId: "provider-session-1",
      providerIdToken: "header.payload.signature",
    });
    await createAuthSession({
      ownerId: "user-2",
      role: "admin",
      provider: "shauth",
      providerSessionId: "provider-session-2",
      providerIdToken: "another.id.token",
    });

    await expect(getAuthSessionLogoutContext(first.id)).resolves.toEqual({
      provider: "shauth",
      providerIdToken: "header.payload.signature",
    });
    await expect(revokeAuthSessionsByProviderSession("shauth", "provider-session-1")).resolves.toBe(
      2,
    );
    for (const session of [first, second]) {
      await expect(
        validateAuthSessionToken({
          authSessionId: session.id,
          authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
          uid: "user-1",
          role: "developer",
        }),
      ).resolves.toBeNull();
    }
    await expect(revokeAuthSessionsByProviderSession("shauth", "provider-session-1")).resolves.toBe(
      0,
    );
  });

  it("writes complete provider-session index facets for non-Shauth sessions", async () => {
    const github = await createAuthSession({
      ownerId: "user-github",
      role: "developer",
      provider: "github",
    });
    const local = await createAuthSession({ ownerId: "user-local", role: "admin" });

    await expect(
      validateAuthSessionToken({
        authSessionId: github.id,
        authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
        uid: "user-github",
        role: "developer",
      }),
    ).resolves.toMatchObject({ id: github.id });
    await expect(
      validateAuthSessionToken({
        authSessionId: local.id,
        authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
        uid: "user-local",
        role: "admin",
      }),
    ).resolves.toMatchObject({ id: local.id });
    await expect(getAuthSessionLogoutContext(github.id)).resolves.toBeNull();
    await expect(getAuthSessionLogoutContext(local.id)).resolves.toBeNull();
  });

  it("consumes each signed-token identifier once and revokes by sid and sub", async () => {
    const sameSession = await createAuthSession({
      ownerId: "user-correlated",
      role: "developer",
      provider: "shauth",
      providerSubject: "user-correlated",
      providerSessionId: "provider-session-correlated",
      providerIdToken: "header.payload.signature",
    });
    const sameSubject = await createAuthSession({
      ownerId: "user-correlated",
      role: "developer",
      provider: "shauth",
      providerSubject: "user-correlated",
      providerSessionId: "provider-session-other-device",
      providerIdToken: "another.header.payload",
    });
    const unrelated = await createAuthSession({
      ownerId: "user-unrelated",
      role: "admin",
      provider: "shauth",
      providerSubject: "user-unrelated",
      providerSessionId: "provider-session-unrelated",
      providerIdToken: "unrelated.header.payload",
    });
    const nowMs = Date.parse("2026-07-19T19:00:00.000Z");
    const token = {
      tokenId: "logout-token-correlated",
      expiresAtEpochSeconds: Math.floor(nowMs / 1000) + 300,
      providerSessionId: "provider-session-correlated",
      providerSubject: "user-correlated",
    };

    await expect(consumeProviderLogoutToken("shauth", token, nowMs)).resolves.toBe(2);
    await expect(consumeProviderLogoutToken("shauth", token, nowMs)).rejects.toThrow();

    for (const session of [sameSession, sameSubject]) {
      await expect(
        validateAuthSessionToken({
          authSessionId: session.id,
          authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
          uid: "user-correlated",
          role: "developer",
        }),
      ).resolves.toBeNull();
    }
    await expect(
      validateAuthSessionToken({
        authSessionId: unrelated.id,
        authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
        uid: "user-unrelated",
        role: "admin",
      }),
    ).resolves.toMatchObject({ id: unrelated.id });
  });
});
