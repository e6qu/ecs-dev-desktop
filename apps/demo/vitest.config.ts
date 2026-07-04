import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./src/fuzz-setup.ts"],
    exclude: ["**/e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
