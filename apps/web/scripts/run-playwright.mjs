// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.NO_COLOR;

const bin = process.platform === "win32" ? "playwright.cmd" : "playwright";
const result = spawnSync(bin, ["test", ...process.argv.slice(2)], {
  env,
  shell: false,
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw result.error;
}

process.exit(result.status ?? 1);
