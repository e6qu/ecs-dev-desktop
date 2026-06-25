// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption (AES-256-GCM) for secrets stored at rest — the
 * user's git credential. Established primitive (node:crypto), not hand-rolled
 * crypto. The key is a 32-byte value supplied as hex via config (KMS/Secrets
 * Manager in production); ciphertext is self-describing `iv.tag.ct` (base64).
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // full 128-bit auth tag (pinned to reject short-tag forgery)

function keyFromHex(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("token encryption key must be 32 bytes (64 hex chars)");
  }
  return key;
}

/** Encrypt `plaintext`, returning `iv.tag.ciphertext` (all base64). */
export function encryptToken(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFromHex(keyHex), iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

/** Decrypt a `iv.tag.ciphertext` blob; throws if tampered or the key is wrong. */
export function decryptToken(blob: string, keyHex: string): string {
  const [ivB64, tagB64, ctB64] = blob.split(".");
  if (ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error("malformed ciphertext");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  // Validate sizes up front so a corrupt blob throws our controlled error, not a raw crypto
  // TypeError (ERR_CRYPTO_INVALID_IV) from deep inside createDecipheriv.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("malformed ciphertext");
  }
  const decipher = createDecipheriv(ALGORITHM, keyFromHex(keyHex), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}
