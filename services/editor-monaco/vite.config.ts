// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite";

// Builds the Monaco SPA to dist/spa. `base: "./"` makes every asset URL relative, so the same
// bundle works under any `/w/<id>/` base path the proxy serves it from.
export default defineConfig({
  root: "src/spa",
  base: "./",
  build: {
    outDir: "../../dist/spa",
    emptyOutDir: true,
    // Monaco's editor core is one large chunk; raise the advisory limit rather than warn.
    chunkSizeWarningLimit: 5000,
  },
});
