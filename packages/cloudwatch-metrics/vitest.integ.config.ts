// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Tier-2 integration tests against the sockerless AWS simulator (docker harness).
// Separated from the unit run by the `.integ.ts` suffix.
export default defineConfig({
  test: {
    include: ["test/**/*.integ.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
