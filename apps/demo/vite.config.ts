// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

const shim = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// The static demo runs the real @edd/core in the browser, so node: builtins it imports are
// aliased to browser shims (see src/lib/node-shims). Base path is env-driven: GitHub *project*
// Pages serve under /<repo>/, so production builds set DEMO_BASE=/ecs-dev-desktop/demo/; dev
// and a future custom domain use "/".
export default defineConfig({
  base: process.env.DEMO_BASE ?? "/",
  // Monaco's editor core is a single large (~4 MB) chunk, lazy-loaded only on the IDE route —
  // expected, so raise the advisory size limit rather than see it warn on every build.
  build: { chunkSizeWarningLimit: 5000 },
  // Vitest runs the unit tests under src/ only; the Playwright browser smoke lives in e2e/ and
  // must not be picked up here (it imports @playwright/test, not vitest).
  test: { include: ["src/**/*.test.ts"] },
  plugins: [react()],
  resolve: {
    alias: {
      "node:crypto": shim("./src/lib/node-shims/crypto.ts"),
      "node:fs/promises": shim("./src/lib/node-shims/fs-os-path.ts"),
      "node:os": shim("./src/lib/node-shims/fs-os-path.ts"),
      "node:path": shim("./src/lib/node-shims/fs-os-path.ts"),
    },
  },
});
