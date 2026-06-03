// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Mock-free auth e2e against the sockerless auth sims (docker-compose.e2e.yml):
// the bleephub GitHub server and the Azure/Entra simulator. Run via
// `pnpm test:e2e`; kept out of the unit/integration runs.
export default defineConfig({
  test: {
    include: ["app/**/*.e2e.ts", "lib/**/*.e2e.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
