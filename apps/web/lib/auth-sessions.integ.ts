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
process.env.AWS_ENDPOINT_URL ??= dynamodb.endpoint;
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

  it("revokes only the session the sid names, leaving the account's other sessions alone", async () => {
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

    // ONE session: the one `sid` names. Revoking the account's other sessions
    // too (which a sid+sub token used to do) logs the user out of sessions the
    // provider never ended -- including ones established after the logout
    // event, since back-channel delivery is asynchronous. Every application
    // that shared this SSO session still logs out, because they share the sid.
    await expect(consumeProviderLogoutToken("shauth", token, nowMs)).resolves.toBe(1);
    await expect(consumeProviderLogoutToken("shauth", token, nowMs)).rejects.toThrow();

    const validate = async (id: string, uid: string, role: "developer" | "admin") =>
      validateAuthSessionToken({
        authSessionId: id,
        authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
        uid,
        role,
      });

    // The named session is gone...
    await expect(validate(sameSession.id, "user-correlated", "developer")).resolves.toBeNull();
    // ...the same account's OTHER provider session is untouched...
    await expect(validate(sameSubject.id, "user-correlated", "developer")).resolves.toMatchObject({
      id: sameSubject.id,
    });
    // ...and another account is of course untouched.
    await expect(validate(unrelated.id, "user-unrelated", "admin")).resolves.toMatchObject({
      id: unrelated.id,
    });

    // A sub-only token keeps its OpenID Connect meaning: end every session the
    // account holds, including the one the sid-scoped revocation spared.
    const accountWide = {
      tokenId: "logout-token-account-wide",
      expiresAtEpochSeconds: Math.floor(nowMs / 1000) + 300,
      providerSubject: "user-correlated",
    };
    await expect(consumeProviderLogoutToken("shauth", accountWide, nowMs)).resolves.toBe(1);
    await expect(validate(sameSubject.id, "user-correlated", "developer")).resolves.toBeNull();
    await expect(validate(unrelated.id, "user-unrelated", "admin")).resolves.toMatchObject({
      id: unrelated.id,
    });
  });
});
