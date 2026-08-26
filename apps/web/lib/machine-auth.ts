// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from "node:crypto";

import { verifyWorkspaceToken } from "@edd/core";

import {
  AGENT_SECRET_ENV,
  GATEWAY_SECRET_ENV,
  MACHINE_AUTH_HEADER,
  MONITORING_TOKEN_ENV,
} from "./constants";

/**
 * Verify a per-workspace machine-auth bearer token (service-to-service auth for
 * non-interactive callers — no Auth.js session).
 *
 * Returns:
 *   "absent"  — no Authorization header; fall through to session auth.
 *   "invalid" — header present but token does not match; reject 401.
 *   "valid"   — HMAC matches; proceed without session auth.
 *
 * Token derivation is the shared per-workspace HMAC (`@edd/core`
 * `verifyWorkspaceToken`): the same value the compute provider injects into the task.
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

  return verifyWorkspaceToken(secret, workspaceId, candidate) ? "valid" : "invalid";
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

/**
 * Shauth's bearer for reading this deployment's monitoring observation.
 *
 * Unlike the agent and gateway tokens this is not a per-workspace HMAC: the
 * observation is fleet-wide, so there is no workspace to derive from and the
 * shared secret is compared directly. Constant-time, because a byte-by-byte
 * comparison on a fixed secret leaks it to a caller who can time the reply.
 *
 * An unconfigured token can never be valid. Serving the observation
 * unauthenticated when the secret is missing would turn a deployment omission
 * into an open endpoint, which is the failure mode worth being strict about.
 */
export function checkMonitoringAuth(req: Request): "absent" | "invalid" | "valid" {
  const authHeader = req.headers.get(MACHINE_AUTH_HEADER);
  if (authHeader === null) return "absent";

  const expected = process.env[MONITORING_TOKEN_ENV];
  if (expected === undefined || expected.length === 0) return "invalid";

  const spaceIdx = authHeader.indexOf(" ");
  if (spaceIdx === -1) return "invalid";
  if (authHeader.slice(0, spaceIdx).toLowerCase() !== "bearer") return "invalid";

  const candidate = Buffer.from(authHeader.slice(spaceIdx + 1));
  const secret = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first; a differing length is already public from the header itself.
  return candidate.length === secret.length && timingSafeEqual(candidate, secret)
    ? "valid"
    : "invalid";
}
