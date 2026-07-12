// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Baseline security headers for the control-plane / admin / login / API surface (the
 * Next-rendered routes). These do NOT reach the editor proxy at `/w/*`, which the custom
 * server serves directly (bypassing Next's headers()) and which carries the workspace's own
 * CSP. A full script-src CSP would need nonce plumbing through Next's hydration scripts, so
 * we ship the high-value, low-risk headers now: clickjacking protection (`frame-ancestors`
 * + `X-Frame-Options` — the admin console must never be framed), MIME-sniffing off, HSTS, and
 * a tight referrer policy. (A full script/style CSP is tracked as a follow-up in DO_NEXT.)
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No `preload` — submitting to the browser preload list is a long-term commitment the
  // operator should opt into deliberately, not a library default.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: repoRoot },
  // Workspace packages ship TS source (no prebuilt dist) — Next transpiles them.
  transpilePackages: [
    "@edd/api-client",
    "@edd/api-contracts",
    "@edd/authz",
    "@edd/control-plane",
    "@edd/core",
    "@edd/db",
  ],
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
