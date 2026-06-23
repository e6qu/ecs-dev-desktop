// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser shim for `node:crypto`, aliased in vite.config.ts so `@edd/core` (which imports
// node:crypto for ids/ssh/machine-token) bundles for the static demo. Only `randomUUID` is
// actually exercised by the demo's code paths (fresh entity ids); the SSH-fingerprint /
// machine-token crypto is imported by the @edd/core barrel but never executed here, so those
// are intentionally not-implemented stubs that fail loud if a path unexpectedly reaches them.

/** Native in every modern browser — the one node:crypto export the demo really uses. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

function unsupported(name: string): never {
  throw new Error(
    `node:crypto.${name} is not supported in the static demo build (no code path should reach it)`,
  );
}

export function createHash(): never {
  return unsupported("createHash");
}
export function createHmac(): never {
  return unsupported("createHmac");
}
export function timingSafeEqual(): never {
  return unsupported("timingSafeEqual");
}
export function randomBytes(): never {
  return unsupported("randomBytes");
}

export default { randomUUID, createHash, createHmac, timingSafeEqual, randomBytes };
