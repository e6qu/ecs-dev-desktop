// SPDX-License-Identifier: AGPL-3.0-or-later
// Connection-token auth, mirroring OpenVSCode's scheme so the existing in-app proxy works
// unchanged: the proxy hands the browser `?tkn=<token>` once; the server validates it, sets an
// httpOnly cookie scoped to this workspace's base path, and redirects to the clean URL. The
// expected token is the per-workspace HMAC the control plane injects as `CONNECTION_TOKEN`.
import { timingSafeEqual } from "node:crypto";

export const TOKEN_COOKIE = "edd-editor-token";

/** Constant-time token comparison (never leak length/content via timing). */
export function tokensMatch(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read a named cookie from a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** The connection token presented by a request: the `?tkn=` query (first contact) or the cookie. */
export function tokenFromRequest(
  search: URLSearchParams,
  cookieHeader: string | undefined,
): string | undefined {
  const fromQuery = search.get("tkn");
  if (fromQuery !== null && fromQuery !== "") return fromQuery;
  return cookieValue(cookieHeader, TOKEN_COOKIE);
}

/** Set-Cookie value pinning the validated token to this workspace's base path. */
export function tokenCookie(token: string, basePath: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=${basePath}; HttpOnly; SameSite=Lax`;
}
