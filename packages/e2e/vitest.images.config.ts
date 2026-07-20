// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// The golden-images workflow builds every language variant before running this
// required suite. Keeping it separate from the omnibus workspace suite makes
// the image dependency explicit: absent images fail instead of reporting a
// misleading skipped success.
export default defineConfig({
  test: {
    include: ["src/image-variants.e2e.ts"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
