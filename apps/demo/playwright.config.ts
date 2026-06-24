// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

const inCI = process.env.CI !== undefined;

// Browser smoke for the static demo: build it, serve the production bundle via `vite preview`, and
// drive it in a real browser. This catches runtime crashes the vitest unit tests can't (e.g. the
// blank-screen-on-stale-state regression) before they reach the live Pages site.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: inCI,
  retries: inCI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173/",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Default base ("/"), so the preview serves at the root — the smoke test is about the SPA
    // working, not the project-Pages base path (the deploy itself verifies that).
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173/",
    reuseExistingServer: !inCI,
    timeout: 180_000,
  },
});
