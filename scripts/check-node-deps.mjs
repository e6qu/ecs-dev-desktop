#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TYPESCRIPT_PACKAGE = "typescript";
const TYPESCRIPT_ESLINT_PACKAGE = "typescript-eslint";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    fail(`Cannot parse semantic version "${version}".`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }
  return leftVersion.patch - rightVersion.patch;
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
  if (!match) {
    fail(`Cannot evaluate unsupported semver comparator "${comparator}".`);
  }
  const operator = match[1] ?? "=";
  const order = compareVersions(version, match[2]);
  if (operator === ">=") {
    return order >= 0;
  }
  if (operator === ">") {
    return order > 0;
  }
  if (operator === "<=") {
    return order <= 0;
  }
  if (operator === "<") {
    return order < 0;
  }
  return order === 0;
}

function satisfiesRange(version, range) {
  if (range.includes("||")) {
    return range.split("||").some((part) => satisfiesRange(version, part.trim()));
  }
  const comparators = range.split(/\s+/).filter(Boolean);
  if (comparators.length === 0) {
    fail("Cannot evaluate an empty semver range.");
  }
  return comparators.every((comparator) => satisfiesComparator(version, comparator));
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

function readInstalledPackage(packageName) {
  const packageJson = readFileSync(`node_modules/${packageName}/package.json`, "utf8");
  return JSON.parse(packageJson);
}

function typescriptPeerRange() {
  const packageJson = readInstalledPackage(TYPESCRIPT_ESLINT_PACKAGE);
  const peerDependencies = packageJson.peerDependencies;
  if (
    typeof peerDependencies !== "object" ||
    peerDependencies === null ||
    typeof peerDependencies.typescript !== "string"
  ) {
    fail(`${TYPESCRIPT_ESLINT_PACKAGE} does not declare a TypeScript peer range.`);
  }
  return peerDependencies.typescript;
}

function isPeerBlockedTypeScript(name, entry) {
  if (packageNameFromEntry(name, entry) !== TYPESCRIPT_PACKAGE) {
    return false;
  }
  if (typeof entry.current !== "string" || typeof entry.latest !== "string") {
    fail("pnpm outdated reported TypeScript without current/latest versions.");
  }
  const peerRange = typescriptPeerRange();
  if (!satisfiesRange(entry.current, peerRange)) {
    fail(
      `Installed TypeScript ${entry.current} is outside ${TYPESCRIPT_ESLINT_PACKAGE}'s peer range ${peerRange}.`,
    );
  }
  if (satisfiesRange(entry.latest, peerRange)) {
    return false;
  }
  console.log(
    `TypeScript ${entry.current} was retained because ${TYPESCRIPT_ESLINT_PACKAGE} requires ${peerRange}; latest age-eligible ${entry.latest} is outside that range.`,
  );
  return true;
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

const staleEntries = Object.entries(outdated).filter(
  ([name, entry]) => !isPeerBlockedTypeScript(name, entry),
);

if (staleEntries.length === 0) {
  console.log("All JS/TS dependencies are current or explicitly blocked by peer compatibility.");
  process.exit(0);
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
