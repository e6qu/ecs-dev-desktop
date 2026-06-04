// SPDX-License-Identifier: AGPL-3.0-or-later
/** @type {import('next').NextConfig} */
const nextConfig = {
  // We lint via the repo-wide ESLint config (`pnpm lint`), not Next's bundled
  // eslint-config-next, so skip ESLint during `next build`.
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages ship TS source (no prebuilt dist) — Next transpiles them.
  transpilePackages: [
    "@edd/api-client",
    "@edd/api-contracts",
    "@edd/authz",
    "@edd/control-plane",
    "@edd/core",
    "@edd/db",
  ],
};

export default nextConfig;
