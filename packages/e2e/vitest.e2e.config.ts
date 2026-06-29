// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

const IS_CI = process.env.CI === "true" || process.env.CI === "1";

// Tier-3-local e2e: the full workspace data-fidelity loop against the
// CONTAINER-MODE sockerless AWS sim (docker-compose.e2e.yml — executes real task
// containers). Slow; run explicitly via `pnpm test:e2e`, never in the unit run.
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000,
    retry: IS_CI ? 1 : 0,
  },
});
