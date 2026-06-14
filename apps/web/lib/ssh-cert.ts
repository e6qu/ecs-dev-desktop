// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Where `EDD_SSH_CA_KEY` material is materialized for `ssh-keygen -s` (which needs
 * a file path). A fixed location, rewritten per call (the file is small and cert
 * issuance is infrequent) so there is no module state and nothing leaks. */
const MATERIALIZED_CA_DIR = join(tmpdir(), "edd-ssh-ca");
const MATERIALIZED_CA_PATH = join(MATERIALIZED_CA_DIR, "ca");

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

/**
 * Resolve the SSH CA private key to a file path for `ssh-keygen -s`.
 *
 * Two supported coordinates (config error if neither, not a user error):
 * - `EDD_SSH_CA_KEY_PATH` — a path to the CA private key already on disk.
 * - `EDD_SSH_CA_KEY` — the key *material* (e.g. injected from Secrets Manager,
 *   the same way `AUTH_SECRET`/`EDD_AGENT_SECRET` are), materialized to a 0600
 *   file here. This is the deployment default (the CA private key never lands in
 *   Terraform state — the operator stores it in Secrets Manager and passes the
 *   ARN via `secret_environment`; see docs/deploying.md).
 *
 * The explicit path wins when both are set.
 */
export function caKeyPath(): string {
  const explicit = process.env.EDD_SSH_CA_KEY_PATH;
  if (explicit) return explicit;
  const material = process.env.EDD_SSH_CA_KEY;
  if (material) {
    mkdirSync(MATERIALIZED_CA_DIR, { recursive: true, mode: 0o700 });
    // OpenSSH private keys must end with a newline; secret stores often strip it.
    const pem = material.endsWith("\n") ? material : `${material}\n`;
    writeFileSync(MATERIALIZED_CA_PATH, pem, { mode: 0o600 });
    return MATERIALIZED_CA_PATH;
  }
  throw new Error(
    "SSH cert issuance requires EDD_SSH_CA_KEY_PATH (file) or EDD_SSH_CA_KEY (key material)",
  );
}
