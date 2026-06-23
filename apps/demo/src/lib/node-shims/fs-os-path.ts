// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser shim aliased (in vite.config.ts) for node:fs/promises, node:os, and node:path.
// `@edd/core`'s barrel re-exports `FakeStorageProvider`, which imports these at module load —
// but the demo never instantiates it (it ships its own InMemoryStorageProvider), so the fs/os
// operations are fail-loud stubs while the harmless path helpers get real implementations.

function unsupported(name: string): never {
  throw new Error(
    `${name} is not supported in the static demo build (FakeStorageProvider is unused)`,
  );
}

// node:fs/promises
export const cp = (): never => unsupported("fs.cp");
export const mkdir = (): never => unsupported("fs.mkdir");
export const mkdtemp = (): never => unsupported("fs.mkdtemp");
export const readFile = (): never => unsupported("fs.readFile");
export const rm = (): never => unsupported("fs.rm");
export const writeFile = (): never => unsupported("fs.writeFile");

// node:os
export const tmpdir = (): never => unsupported("os.tmpdir");

// node:path — real, harmless implementations
export const join = (...parts: string[]): string => parts.join("/").replace(/\/+/g, "/");
export const dirname = (p: string): string => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

export default { cp, mkdir, mkdtemp, readFile, rm, writeFile, tmpdir, join, dirname };
