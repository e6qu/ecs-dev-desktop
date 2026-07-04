// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (which roots at src/spa for the SPA build): the server unit tests
// live under src/ and run in node.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./src/fuzz-setup.ts"],
    testTimeout: 60000,
  },
});
