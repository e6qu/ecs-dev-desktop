// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { mapClaimsToRole } from "@edd/auth";
import { entraSim } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { normalizeClaims } from "./claims";

/**
 * Mock-free Entra login → group → role e2e, driven entirely through STANDARD
 * Microsoft surfaces against the sockerless Azure sim: Microsoft Graph user/group
 * provisioning + membership, then the ROPC token grant for a non-interactive
 * id_token. Nothing here is sim-specific — only `entraSim.authority`/`graphUrl`
 * (base URLs) differ from real cloud (`login.microsoftonline.com` /
 * `graph.microsoft.com`), the allowed endpoint-only exception (`AGENTS.md` §6.8).
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
const ADMIN_GROUP_NAME = `EDD Platform Admins ${RUN_ID}`;

const TOKEN_URL = `${entraSim.authority}/oauth2/v2.0/token`;
const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

const tokenResponse = z.object({ access_token: z.string(), id_token: z.string().optional() });
const graphCreated = z.object({ id: z.string() });

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** Decode a JWT payload (no verification needed — we assert on our own claims). */
function decodeJwtPayload(jwt: string): unknown {
  const segments = jwt.split(".");
  if (segments.length !== 3) throw new Error("id_token is not a well-formed JWT");
  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

/** App-only token (client_credentials) — the admin credential Graph provisioning
 * requires on real cloud. Sent as Bearer on every Graph call below. */
async function acquireGraphToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: formBody({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) throw new Error(`client_credentials token failed: ${String(res.status)}`);
  return tokenResponse.parse(await res.json()).access_token;
}

describe("Entra login → group → role (mock-free, standard Graph + ROPC)", () => {
  let groupId: string;
  let userId: string;

  beforeAll(async () => {
    const accessToken = await acquireGraphToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const graph = (path: string, body: unknown): Promise<Response> =>
      fetch(`${entraSim.graphUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

    // 1. Provision a security group (Microsoft Graph — standard).
    const groupRes = await graph("/groups", {
      displayName: ADMIN_GROUP_NAME,
      mailNickname: `edd-platform-admins-${RUN_ID}`,
      securityEnabled: true,
      mailEnabled: false,
    });
    if (!groupRes.ok) throw new Error(`create group failed: ${String(groupRes.status)}`);
    groupId = graphCreated.parse(await groupRes.json()).id;

    // 2. Provision the user (Microsoft Graph — standard).
    const userRes = await graph("/users", {
      accountEnabled: true,
      displayName: "Alice Admin",
      userPrincipalName: USER_UPN,
      mailNickname: `alice-${RUN_ID}`,
      passwordProfile: { password: USER_PASSWORD, forceChangePasswordNextSignIn: false },
    });
    if (!userRes.ok) throw new Error(`create user failed: ${String(userRes.status)}`);
    userId = graphCreated.parse(await userRes.json()).id;

    // 3. Add the user to the group (Microsoft Graph members/$ref — standard).
    const memberRes = await graph(`/groups/${groupId}/members/$ref`, {
      "@odata.id": `${entraSim.graphUrl}/directoryObjects/${userId}`,
    });
    if (!memberRes.ok) throw new Error(`add member failed: ${String(memberRes.status)}`);
  });

  it("derives the role from the user's Entra groups after a (ROPC) login", async () => {
    // ROPC login (grant_type=password) → id_token carrying the user's `groups`.
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: "password",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username: USER_UPN,
        password: USER_PASSWORD,
        scope: "openid profile",
      }),
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
      mapClaimsToRole(claims, { adminGroups: [groupId], memberGroups: [], defaultRole: "viewer" }),
    ).toBe("admin");
    expect(
      mapClaimsToRole(claims, { adminGroups: [], memberGroups: [], defaultRole: "viewer" }),
    ).toBe("viewer");
  });
});
