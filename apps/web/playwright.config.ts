// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level e2e for the portal. The app runs under `EDD_DEV_AUTH=1` so the
 * dev-auth cookie shim authenticates the browser (no real IdP); persistence is
 * the sockerless sim's DynamoDB at :4566 (the table is created in
 * `e2e/global-setup.ts`). Specs are `*.pw.ts` so the vitest unit/integration
 * runs never pick them up.
 */
const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = process.env.CI === "true" || process.env.CI === "1";

const appEnv = {
  EDD_DEV_AUTH: "1",
  AUTH_SECRET: "playwright-dev-secret",
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:4566",
  DYNAMODB_TABLE: process.env.DYNAMODB_TABLE ?? "ecs-dev-desktop-pw",
};
// global-setup runs in this process and reads these.
Object.assign(process.env, appEnv);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  reporter: IS_CI ? "line" : "list",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Run against a production build, not `next dev`: dev/turbopack HMR is unreliable
  // under headless automation (the client never hydrates), and prod mirrors reality.
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${PORT.toString()}`,
    url: `${BASE_URL}/login`,
    timeout: 240_000,
    reuseExistingServer: !IS_CI,
    env: appEnv,
  },
});
