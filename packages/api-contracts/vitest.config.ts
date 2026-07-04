import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./src/fuzz-setup.ts"],
    testTimeout: 60000,
  },
});
