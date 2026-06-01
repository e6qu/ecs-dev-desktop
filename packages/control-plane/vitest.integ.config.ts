// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integ.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
