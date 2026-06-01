// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Tier-2 integration tests (require the docker harness). Kept separate from the
// default unit run via the `.integ.ts` suffix.
export default defineConfig({
  test: {
    include: ["src/**/*.integ.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
