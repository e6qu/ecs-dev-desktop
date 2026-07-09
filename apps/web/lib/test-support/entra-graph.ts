// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared Azure/Entra sim harness for the auth e2e suites: standard Microsoft
// Graph provisioning (client_credentials token, user/group/membership). Only
// the authority/Graph base URLs differ from real cloud (§6.8).
import { entra } from "@edd/config";
import { z } from "zod";

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

const tokenResponse = z.object({ access_token: z.string() });
const graphCreated = z.object({ id: z.string() });

/** App-only token (client_credentials) — the admin credential Graph provisioning
 * requires on real cloud. Sent as Bearer on every Graph call below. */
export async function acquireGraphToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${entra.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: FORM_HEADERS,
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }).toString(),
  });
  if (!res.ok) throw new Error(`client_credentials token failed: ${String(res.status)}`);
  return tokenResponse.parse(await res.json()).access_token;
}

export interface ProvisionedEntraUser {
  userId: string;
  groupId: string;
}

/**
 * Provision a security group + a user + the membership via standard Microsoft
 * Graph (`POST /groups`, `POST /users`, `POST /groups/{id}/members/$ref`).
 */
export async function provisionEntraUserWithGroup(
  accessToken: string,
  input: {
    userPrincipalName: string;
    password: string;
    displayName: string;
    groupDisplayName: string;
    mailNickname: string;
    groupMailNickname: string;
  },
): Promise<ProvisionedEntraUser> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const graph = (path: string, body: unknown): Promise<Response> =>
    fetch(`${entra.graphUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  const groupRes = await graph("/groups", {
    displayName: input.groupDisplayName,
    mailNickname: input.groupMailNickname,
    securityEnabled: true,
    mailEnabled: false,
  });
  if (!groupRes.ok) throw new Error(`create group failed: ${String(groupRes.status)}`);
  const groupId = graphCreated.parse(await groupRes.json()).id;

  const userRes = await graph("/users", {
    accountEnabled: true,
    displayName: input.displayName,
    userPrincipalName: input.userPrincipalName,
    mailNickname: input.mailNickname,
    passwordProfile: { password: input.password, forceChangePasswordNextSignIn: false },
  });
  if (!userRes.ok) throw new Error(`create user failed: ${String(userRes.status)}`);
  const userId = graphCreated.parse(await userRes.json()).id;

  const memberRes = await graph(`/groups/${groupId}/members/$ref`, {
    "@odata.id": `${entra.graphUrl}/directoryObjects/${userId}`,
  });
  if (!memberRes.ok) throw new Error(`add developer failed: ${String(memberRes.status)}`);

  return { userId, groupId };
}
