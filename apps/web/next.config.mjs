// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
};

export default nextConfig;
