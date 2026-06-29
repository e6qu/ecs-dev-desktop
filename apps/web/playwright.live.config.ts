// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE portal browser e2e: the same production-built app, but with REAL sim
 * adapters (`COMPUTE_PROVIDER=ecs` → EcsComputeProvider + Ec2StorageProvider
 * against the container-mode sockerless AWS sim). Browser create/stop/start/
 * delete act on real golden-image tasks with managed EBS — the UI tier on the
 * same live path as `packages/e2e/src/user-journey.e2e.ts`.
 *
 * Harness prerequisites (same as the e2e tier — see TESTING.md):
 * docker-compose.e2e.yml up, `edd-workspace:e2e` built.
 * Provisioning happens in the webServer command (Playwright starts the
 * webServer BEFORE globalSetup): `start-live-app.sh` → `live-cloud-setup.ts`.
 */
const PORT = 3220;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = process.env.CI === "true" || process.env.CI === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pwlive.ts",
  // Real task launches: create/wake legs take tens of seconds each on the sim.
  timeout: 300_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  reporter: IS_CI ? "line" : "list",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "sh e2e/start-live-app.sh",
    url: `${BASE_URL}/login`,
    timeout: 300_000,
    reuseExistingServer: !IS_CI,
  },
});
