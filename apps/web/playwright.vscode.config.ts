// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

/**
 * OpenVSCode workspace browser proof: drive the REAL VS Code (OpenVSCode Server)
 * running in the golden workspace image, in a real browser — load the workbench,
 * use the integrated terminal to compile a program in the preinstalled
 * toolchain, and verify the build artifact. `globalSetup` launches the golden
 * image with its HTTP port published; `globalTeardown` removes it.
 *
 * Prerequisite: `edd-workspace:e2e` built (docker build infra/images/workspace).
 */
const IS_CI = process.env.CI === "true" || process.env.CI === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pwvscode.ts",
  globalSetup: "./e2e/vscode-global-setup.ts",
  globalTeardown: "./e2e/vscode-global-teardown.ts",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: 0,
  reporter: IS_CI ? "line" : "list",
  outputDir: "./playwright-vscode-output",
  use: { trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
