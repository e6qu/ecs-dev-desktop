// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Live PEP→PDP gate e2e: a real browser request flows through Pomerium → the
 * wildcard route → the workspace GATE → the control-plane PDP → the upstream.
 * No webServer — Pomerium (real TLS), the gate, the web/PDP container, azure-sim
 * and the upstream all come from docker-compose.gate.yml (run
 * scripts/gen-sim-tls-cert.sh before bring-up). globalSetup seeds the owned /
 * non-owned workspaces. Trust + name-resolution mirror playwright.pomerium.config.ts:
 * Chromium trusts our harness keys by SPKI pin (it cannot read NODE_EXTRA_CA_CERTS)
 * and resolves *.localhost natively; the azure-sim authorize host maps to loopback.
 */
const IS_CI = process.env.CI === "true" || process.env.CI === "1";
const TLS_DIR = join(import.meta.dirname, "../../temp/sim-tls");

/** Base64(SHA-256(SubjectPublicKeyInfo)) — the form Chromium's pin list takes. */
function spkiHash(pemPath: string): string {
  let pem: Buffer;
  try {
    pem = readFileSync(pemPath);
  } catch {
    throw new Error(`missing ${pemPath} — run: sh scripts/gen-sim-tls-cert.sh`);
  }
  const der = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64");
}

const spkiPins = [spkiHash(join(TLS_DIR, "server.pem")), spkiHash(join(TLS_DIR, "ca.pem"))].join(
  ",",
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pwgate.ts",
  globalSetup: "./e2e/gate-global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: 0,
  reporter: IS_CI ? "line" : "list",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP azure-sim 127.0.0.1",
            `--ignore-certificate-errors-spki-list=${spkiPins}`,
          ],
        },
      },
    },
  ],
});
