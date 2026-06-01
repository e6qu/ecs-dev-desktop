// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.integ.ts", "lib/**/*.integ.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
