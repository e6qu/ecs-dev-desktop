// SPDX-License-Identifier: AGPL-3.0-or-later
import { X509Certificate } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Browser OIDC login through Pomerium: no webServer — Pomerium (real TLS) +
 * the azure-sim + the workspace upstream come from docker-compose.e2e.yml
 * (run scripts/gen-sim-tls-cert.sh before bring-up).
 *
 * Certificate trust: Chromium cannot read NODE_EXTRA_CA_CERTS and OS
 * trust-store installation is platform-specific, so the harness CA/leaf are
 * trusted by SPKI pin (--ignore-certificate-errors-spki-list with the SHA-256
 * hashes of OUR keys). This is explicit trust of these specific keys — any
 * other untrusted certificate still fails — equivalent in effect to adding
 * the CA to a trust store, not blanket-disabled verification.
 *
 * Chromium resolves *.localhost to loopback natively, so the
 * *.devbox.localhost:8443 hosts need no /etc/hosts entry. The IdP authorize
 * URL uses the compose-internal hostname `azure-sim`; --host-resolver-rules
 * maps it to 127.0.0.1 (its published port) — harness name resolution only.
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
  testMatch: "**/*.pwpom.ts",
  timeout: 60_000,
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
