// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure CLI helpers (no I/O), separated so they are unit-testable without triggering
// the `edd.ts` entry point's argv dispatch.

/** Auth headers for an API request: a bearer token (real deployment) if `EDD_API_TOKEN`
 * is set, else the dev-auth shim identity (`x-edd-*`, honoured only under EDD_DEV_AUTH=1
 * locally), defaulting to admin/admin. */
export function authHeaders(env: Record<string, string | undefined>): Record<string, string> {
  if (env.EDD_API_TOKEN !== undefined && env.EDD_API_TOKEN.length > 0) {
    return { Authorization: `Bearer ${env.EDD_API_TOKEN}` };
  }
  return { "x-edd-user-id": env.EDD_USER ?? "admin", "x-edd-role": env.EDD_ROLE ?? "admin" };
}

/** A status glyph: ✓ ok · ✗ drift/down · ? unknown. */
export function sym(status: string): string {
  if (status === "ok") return "✓";
  if (status === "drift" || status === "down") return "✗";
  return "?";
}
