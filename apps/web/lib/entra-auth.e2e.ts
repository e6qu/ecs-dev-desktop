// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { mapClaimsToRole } from "@edd/auth";
import { entra } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { normalizeClaims } from "./claims";
import { acquireGraphToken, provisionEntraUserWithGroup } from "./test-support/entra-graph";

/**
 * Mock-free Entra login → group → role e2e, driven entirely through STANDARD
 * Microsoft surfaces against the sockerless Azure sim: Microsoft Graph user/group
 * provisioning + membership, then the ROPC token grant for a non-interactive
 * id_token. Nothing here is sim-specific — only `entra.authority`/`graphUrl`
 * (base URLs) differ from real cloud (`login.microsoftonline.com` /
 * `graph.microsoft.com`), the allowed endpoint-only exception (`AGENTS.md` §6.8).
 * Provisioning helpers: `test-support/entra-graph.ts` (shared with the Auth.js
 * callback-route e2e).
 *
 * App-registration coordinates (client/tenant) and the test identity are plain
 * fixtures; against real Entra they'd come from env-supplied app credentials.
 */
const CLIENT_ID = "edd-e2e-client";
const CLIENT_SECRET = "edd-e2e-secret";
const RUN_ID = randomUUID().slice(0, 8);
const USER_UPN = `alice-${RUN_ID}@edd-e2e.example.com`;
// ROPC password — real Entra validates it against the user's passwordProfile; the
// sim looks the user up by userPrincipalName. Sent on both create and login.
const USER_PASSWORD = "Edd-e2e-Passw0rd!";

const TOKEN_URL = `${entra.authority}/oauth2/v2.0/token`;
const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

const tokenResponse = z.object({ access_token: z.string(), id_token: z.string().optional() });

/** Decode a JWT payload (no verification needed — we assert on our own claims). */
function decodeJwtPayload(jwt: string): unknown {
  const segments = jwt.split(".");
  if (segments.length !== 3) throw new Error("id_token is not a well-formed JWT");
  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

describe("Entra login → group → role (mock-free, standard Graph + ROPC)", () => {
  let groupId: string;

  beforeAll(async () => {
    const accessToken = await acquireGraphToken(CLIENT_ID, CLIENT_SECRET);
    ({ groupId } = await provisionEntraUserWithGroup(accessToken, {
      userPrincipalName: USER_UPN,
      password: USER_PASSWORD,
      displayName: "Alice Admin",
      groupDisplayName: `EDD Platform Admins ${RUN_ID}`,
      mailNickname: `alice-${RUN_ID}`,
      groupMailNickname: `edd-platform-admins-${RUN_ID}`,
    }));
  });

  it("derives the role from the user's Entra groups after a (ROPC) login", async () => {
    // ROPC login (grant_type=password) → id_token carrying the user's `groups`.
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({
        grant_type: "password",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username: USER_UPN,
        password: USER_PASSWORD,
        scope: "openid profile",
      }).toString(),
    });
    expect(res.ok).toBe(true);
    const idToken = tokenResponse.parse(await res.json()).id_token;
    expect(idToken).toBeDefined();

    // Our real auth code: normalise the id_token profile, then map groups → role.
    const claims = normalizeClaims("microsoft-entra-id", decodeJwtPayload(idToken ?? ""));
    expect(claims.idp).toBe("entra");
    expect(claims.groups).toContain(groupId);

    // The admin group grants admin; an empty config falls back to the default.
    expect(
      mapClaimsToRole(claims, {
        adminGroups: [groupId],
        developerGroups: [],
        defaultRole: "viewer",
      }),
    ).toBe("admin");
    expect(
      mapClaimsToRole(claims, { adminGroups: [], developerGroups: [], defaultRole: "viewer" }),
    ).toBe("viewer");
  });
});
