// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Integration tier for @edd/e2e: lighter than the container-mode e2e — specs that
// drive real subprocesses/sockets but need no sim or DynamoDB (e.g. the idle-agent
// heartbeat-resumption script test). Runs in the `integration` CI job via
// `pnpm test:integ`.
export default defineConfig({
  test: {
    include: ["src/**/*.integ.ts"],
    hookTimeout: 30_000,
    testTimeout: 60_000,
  },
});
