// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// SSH e2e against a real Teleport cluster in Docker (docker-compose.ssh.yml):
// provision a Teleport user/role, then connect via `tsh` and assert the session
// lands as the workspace principal. Slow; run via `pnpm test:e2e`, not the unit run.
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
