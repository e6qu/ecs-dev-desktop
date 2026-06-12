// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";

import { AGENT_SECRET_ENV, GATEWAY_SECRET_ENV, MACHINE_AUTH_HEADER } from "./constants";

/**
 * Verify a per-workspace machine-auth bearer token (service-to-service auth for
 * non-interactive callers — no Auth.js session).
 *
 * Returns:
 *   "absent"  — no Authorization header; fall through to session auth.
 *   "invalid" — header present but token does not match; reject 401.
 *   "valid"   — HMAC matches; proceed without session auth.
 *
 * Token derivation: HMAC-SHA256(hex(secret), workspaceId) → hex. Per-workspace,
 * so a token observed for one workspace cannot act on another.
 */
function checkMachineAuth(
  req: Request,
  workspaceId: string,
  secretEnv: string,
): "absent" | "invalid" | "valid" {
  const authHeader = req.headers.get(MACHINE_AUTH_HEADER);
  if (authHeader === null) return "absent";

  const secret = process.env[secretEnv];
  // If the secret is not configured, machine tokens can never be valid.
  if (secret === undefined || secret.length === 0) return "invalid";

  const spaceIdx = authHeader.indexOf(" ");
  if (spaceIdx === -1) return "invalid";
  const scheme = authHeader.slice(0, spaceIdx);
  const candidate = authHeader.slice(spaceIdx + 1);
  if (scheme.toLowerCase() !== "bearer" || candidate.length === 0) return "invalid";

  const expected = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(workspaceId)
    .digest("hex");

  if (expected.length !== candidate.length) return "invalid";
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate)) ? "valid" : "invalid";
}

/**
 * The in-workspace idle-agent's token for the heartbeat route. The same
 * derivation runs in `EcsComputeProvider.runTask` before task launch, which
 * injects the token into the workspace container's environment.
 */
export function checkAgentAuth(req: Request, workspaceId: string): "absent" | "invalid" | "valid" {
  return checkMachineAuth(req, workspaceId, AGENT_SECRET_ENV);
}

/**
 * The SSH gateway's token for the wake-on-connect routes (`POST /connect`,
 * `GET /:id`, `GET /connect-info`). The gateway holds `EDD_GATEWAY_SECRET` and
 * derives the per-workspace token in `wake-and-forward.sh` at connect time.
 */
export function checkGatewayAuth(
  req: Request,
  workspaceId: string,
): "absent" | "invalid" | "valid" {
  return checkMachineAuth(req, workspaceId, GATEWAY_SECRET_ENV);
}
