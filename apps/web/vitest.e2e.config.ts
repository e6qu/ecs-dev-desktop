// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Mock-free auth e2e against the sockerless auth sims (docker-compose.e2e.yml):
// the bleephub GitHub server and the Azure/Entra simulator. Run via
// `pnpm test:e2e`; kept out of the unit/integration runs.
export default defineConfig({
  // next-auth's ESM imports `next/server` extensionless; Node resolution under
  // vitest needs the explicit .js entry (Next maps it via package exports), and
  // next-auth must be inlined so the alias applies to its imports too.
  resolve: { alias: { "next/server": "next/server.js" } },
  test: {
    include: ["app/**/*.e2e.ts", "lib/**/*.e2e.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    server: { deps: { inline: ["next-auth"] } },
  },
});
