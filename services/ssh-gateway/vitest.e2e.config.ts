// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// SSH e2e against a real OpenSSH workspace node in Docker (docker-compose.ssh.yml):
// sign a user cert with the ephemeral SSH CA and assert the session lands as the
// correct workspace principal. Slow; run via `pnpm test:e2e`, not the unit run.
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
