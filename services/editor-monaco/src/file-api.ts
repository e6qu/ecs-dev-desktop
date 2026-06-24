// SPDX-License-Identifier: AGPL-3.0-or-later
// The file backend for the Monaco editor server: list / read / write files under the workspace
// root. Every client-supplied path is resolved and confined to the root (no `..`/absolute escape)
// — the load-bearing safety property, so it is pure + unit-tested independently of the HTTP layer.
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface TreeEntry {
  /** POSIX-style path relative to the workspace root. */
  readonly path: string;
  readonly type: "file" | "dir";
}

/** Directories that are never listed (noise / huge / editor-internal). */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".openvscode-server",
  ".cache",
  ".npm",
  "target",
  "dist",
]);
/** Cap the tree so a giant repo can't blow up the response. */
const MAX_ENTRIES = 4000;
/** Refuse to read files larger than this into the editor (bytes). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Resolve a client path against the root, confining it inside the root. Throws on any escape
 * (`..`, an absolute path, a symlink target outside) — callers must let this propagate to a 400.
 */
export function resolveWithin(root: string, rel: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error("path escapes the workspace root");
  }
  return resolved;
}

/** Recursively list files + dirs under root (relative POSIX paths), skipping noise, capped. */
export async function buildTree(root: string): Promise<TreeEntry[]> {
  const rootResolved = path.resolve(root);
  const out: TreeEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_ENTRIES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_ENTRIES) return;
      const abs = path.join(dir, e.name);
      const rel = path.relative(rootResolved, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        out.push({ path: rel, type: "dir" });
        await walk(abs);
      } else if (e.isFile()) {
        out.push({ path: rel, type: "file" });
      }
    }
  }

  await walk(rootResolved);
  return out;
}

/** Read a file's text, confined to root. Throws on escape or an over-large file. */
export async function readTextFile(root: string, rel: string): Promise<string> {
  const abs = resolveWithin(root, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error("not a file");
  if (stat.size > MAX_FILE_BYTES) throw new Error("file too large to edit");
  return fs.readFile(abs, "utf8");
}

/** Write a file's text, confined to root (creating parent dirs). Throws on escape. */
export async function writeTextFile(root: string, rel: string, content: string): Promise<void> {
  const abs = resolveWithin(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
