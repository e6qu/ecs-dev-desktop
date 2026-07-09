// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const PASSWORD_HASH_VERSION = "scrypt-v1";
const KEY_LEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const key = (await scrypt(password, salt, KEY_LEN)) as Buffer;
  return `${PASSWORD_HASH_VERSION}:${salt}:${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("invalid password hash shape");
  const [version, salt, expected] = parts;
  if (version !== PASSWORD_HASH_VERSION)
    throw new Error(`unsupported password hash version ${version}`);
  if (salt.length === 0) throw new Error("password hash missing salt");
  if (expected.length === 0) throw new Error("password hash missing verifier");
  const actual = (await scrypt(password, salt, KEY_LEN)) as Buffer;
  const expectedBytes = Buffer.from(expected, "base64url");
  if (expectedBytes.length !== actual.length) return false;
  return timingSafeEqual(actual, expectedBytes);
}
