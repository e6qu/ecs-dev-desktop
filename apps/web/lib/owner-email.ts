// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Email, email } from "@edd/core";

/** Outcome of resolving a workspace owner email from the caller's session. */
export type OwnerEmailResult =
  | { readonly ok: true; readonly email: Email | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the workspace owner email from the session principal's email.
 *
 * The owner email backs proxy ownership (the web gate authorizes a caller against a
 * workspace by matching emails), so getting it wrong silently produces a workspace
 * that is created but can never be opened through the proxy. Therefore:
 *
 * - A present email MUST be valid — a malformed value is rejected, never silently
 *   dropped to `undefined` (§6.5 fail-loud).
 * - A real (non-dev) session with NO email is rejected: the workspace would be
 *   unopenable through the proxy, so fail at create instead of producing a no-op.
 * - Under the dev-auth shim, principals legitimately carry no email (the portal dev
 *   flows don't go through the proxy), so an absent email is allowed.
 */
export function resolveOwnerEmail(
  rawEmail: string | undefined,
  devAuth: boolean,
): OwnerEmailResult {
  if (rawEmail !== undefined) {
    try {
      return { ok: true, email: email(rawEmail) };
    } catch {
      return { ok: false, reason: "your account's email address is malformed" };
    }
  }
  if (!devAuth) {
    return {
      ok: false,
      reason: "your account has no email address; a workspace requires one to be reachable",
    };
  }
  return { ok: true, email: undefined };
}
