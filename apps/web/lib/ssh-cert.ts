// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Sign a user's SSH public key with the workspace SSH CA.
 *
 * Produces an OpenSSH certificate granting the holder the given `principal`
 * (which must match the workspace node's AuthorizedPrincipalsFile entry).
 * The cert TTL is 1 hour — short-lived, appropriate for a single session.
 *
 * @param caKeyPath  Path to the CA private key (from EDD_SSH_CA_KEY_PATH).
 * @param publicKey  User's SSH public key in OpenSSH format.
 * @param principal  SSH principal the cert grants (e.g. "dev-abc123").
 * @param identity   Audit identity label embedded in the cert (e.g. "user@email").
 * @returns The signed OpenSSH certificate string.
 * @throws  If ssh-keygen fails or the CA key is missing.
 */
export function signCert(
  caKeyPath: string,
  publicKey: string,
  principal: string,
  identity: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), "edd-ssh-cert-"));
  try {
    const pubKeyFile = join(dir, "key.pub");
    writeFileSync(pubKeyFile, publicKey, { mode: 0o600 });
    const result = spawnSync(
      "ssh-keygen",
      ["-s", caKeyPath, "-I", identity, "-n", principal, "-V", "+1h", pubKeyFile],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`ssh-keygen failed (exit ${result.status ?? -1}): ${result.stderr}`);
    }
    return readFileSync(join(dir, "key-cert.pub"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the SSH CA key path from env; throw loudly if absent (config error, not user error). */
export function caKeyPath(): string {
  const p = process.env.EDD_SSH_CA_KEY_PATH;
  if (!p) throw new Error("EDD_SSH_CA_KEY_PATH is required for SSH cert issuance");
  return p;
}
