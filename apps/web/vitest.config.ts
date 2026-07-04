import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./src/fuzz-setup.ts"],
    testTimeout: 30000,
    exclude: [
      "**/e2e/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.pw.ts",
      "**/*.pwlive.ts",
      "**/*.pwvscode.ts",
    ],
  },
});
