// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { mapClaimsToRole } from "@edd/auth";
import {
  POMERIUM_ASSERTION_HEADER,
  WORKSPACE_BASE_DOMAIN,
  WORKSPACE_HOST_HEADER,
} from "@edd/config";
import { decideWorkspaceAccess, email, workspaceIdFromHost, type Email } from "@edd/core";

import { roleMappingConfig } from "../../../../lib/auth-config";
import { getControlPlane } from "../../../../lib/control-plane";
import { verifyAssertion } from "../../../../lib/pomerium-assertion";

/**
 * Per-workspace authorization decision point (PDP) for the identity-aware proxy
 * (DO_NEXT #5). The workspace gate (PEP) fronts each `<ws>.devbox.<domain>`
 * request and calls this endpoint, forwarding the Pomerium identity assertion
 * (`X-Pomerium-Jwt-Assertion`) and the workspace host (`X-Edd-Workspace-Host`).
 *
 * We verify the assertion against Pomerium's JWKS (signature + expiry + that its
 * `aud`/`iss` equal the workspace host, binding the token to that workspace),
 * derive the caller's role from the assertion's groups, and allow only if the
 * caller is an admin or owns the workspace named in the subdomain (owner email
 * match). Pomerium itself can't make this decision — ownership lives in
 * DynamoDB, not in any identity claim.
 *
 * 204 → allow, 403 → deny, 401 → missing/invalid assertion or host.
 */

const allow = () => new NextResponse(null, { status: 204 });
const deny = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

/** Brand a claim string as an Email, or undefined if it is malformed/absent. */
function toEmail(value: string | undefined): Email | undefined {
  if (value === undefined) return undefined;
  try {
    return email(value);
  } catch {
    return undefined;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const rawHost = req.headers.get(WORKSPACE_HOST_HEADER);
  const token = req.headers.get(POMERIUM_ASSERTION_HEADER);
  if (rawHost === null || token === null) return unauthorized();

  // The proxy forwards the original Host, which may carry a non-default port
  // (e.g. the harness's :8443; production Pomerium is on :443 so none appears).
  // Pomerium binds the assertion's aud/iss to the bare route hostname, and a
  // workspace's identity is port-independent — so authorize on the hostname.
  const host = rawHost.split(":")[0] ?? rawHost;

  const wsId = workspaceIdFromHost(host, WORKSPACE_BASE_DOMAIN);
  if (wsId === undefined) return deny();

  let identity;
  try {
    identity = await verifyAssertion(token, host);
  } catch {
    return unauthorized();
  }

  const cp = await getControlPlane();
  const detail = await cp.inspect(wsId);
  // Unknown workspace → deny (don't distinguish from a forbidden one).
  if (detail === null) return deny();

  const callerIsAdmin =
    mapClaimsToRole(
      { idp: "entra", subject: identity.subject, groups: identity.groups },
      roleMappingConfig(),
    ) === "admin";

  const granted = decideWorkspaceAccess({
    callerEmail: toEmail(identity.email),
    callerIsAdmin,
    ownerEmail: toEmail(detail.workspace.ownerEmail),
  });
  return granted ? allow() : deny();
}
