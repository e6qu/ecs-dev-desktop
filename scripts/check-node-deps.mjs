#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function packageNameFromEntry(name, entry) {
  if (typeof entry === "object" && entry !== null && "packageName" in entry) {
    const value = entry.packageName;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return name;
}

const result = spawnSync("pnpm", ["outdated", "-r", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status === 0) {
  console.log("All JS/TS dependencies are on the latest age-eligible version.");
  process.exit(0);
}

if (result.error) {
  fail(`Could not run pnpm outdated: ${result.error.message}`);
}

if (result.stderr.trim().length > 0) {
  process.stderr.write(result.stderr);
}

const stdout = result.stdout.trim();
if (stdout.length === 0) {
  fail(`pnpm outdated failed without JSON output; exit status ${result.status ?? "unknown"}.`);
}

let outdated;
try {
  outdated = JSON.parse(stdout);
} catch (error) {
  fail(
    `pnpm outdated returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (typeof outdated !== "object" || outdated === null || Array.isArray(outdated)) {
  fail("pnpm outdated returned an unexpected JSON shape.");
}

const staleEntries = Object.entries(outdated);

if (staleEntries.length === 0) {
  fail(
    `pnpm outdated exited with status ${result.status ?? "unknown"} but reported no outdated dependency.`,
  );
}

console.error("JS/TS dependencies behind the latest age-eligible version:");
for (const [name, entry] of staleEntries) {
  if (typeof entry !== "object" || entry === null) {
    fail(`pnpm outdated entry "${name}" has an unexpected shape.`);
  }
  const packageName = packageNameFromEntry(name, entry);
  const current = typeof entry.current === "string" ? entry.current : "(unknown)";
  const wanted = typeof entry.wanted === "string" ? entry.wanted : "(unknown)";
  const latest = typeof entry.latest === "string" ? entry.latest : "(unknown)";
  console.error(`- ${packageName}: current ${current}, wanted ${wanted}, latest ${latest}`);
}
fail(
  "JS/TS deps behind the latest age-eligible version — run 'pnpm update --latest -r' and commit.",
);
