// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";

import { AGENT_AUTH_HEADER, AGENT_SECRET_ENV } from "./constants";

/**
 * Verify the idle-agent's machine-auth token for a heartbeat request.
 *
 * Returns:
 *   "absent"  — no Authorization header; fall through to session auth.
 *   "invalid" — header present but token does not match; reject 401.
 *   "valid"   — HMAC matches; proceed without session auth.
 *
 * Token derivation: HMAC-SHA256(hex(EDD_AGENT_SECRET), workspaceId) → hex.
 * The same derivation runs in EcsComputeProvider.runTask before task launch.
 */
export function checkAgentAuth(req: Request, workspaceId: string): "absent" | "invalid" | "valid" {
  const authHeader = req.headers.get(AGENT_AUTH_HEADER);
  if (authHeader === null) return "absent";

  const secret = process.env[AGENT_SECRET_ENV];
  // If EDD_AGENT_SECRET is not set, agent tokens can never be valid.
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
