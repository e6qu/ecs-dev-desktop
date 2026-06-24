// SPDX-License-Identifier: AGPL-3.0-or-later
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTree, readTextFile, resolveWithin, writeTextFile } from "./file-api";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "edd-editor-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveWithin", () => {
  it("confines a relative path to the root", () => {
    expect(resolveWithin(root, "a/b.txt")).toBe(path.join(root, "a", "b.txt"));
  });
  it("rejects traversal + absolute escapes", () => {
    expect(() => resolveWithin(root, "../escape")).toThrow(/escapes/);
    expect(() => resolveWithin(root, "a/../../escape")).toThrow(/escapes/);
    expect(() => resolveWithin(root, "/etc/passwd")).toThrow(/escapes/);
  });
});

describe("file ops", () => {
  it("writes, reads, and lists files while skipping noise dirs", async () => {
    await writeTextFile(root, "src/main.go", "package main");
    await writeTextFile(root, "README.md", "# hi");
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "x.js"), "noise");

    expect(await readTextFile(root, "src/main.go")).toBe("package main");

    const paths = (await buildTree(root)).map((e) => e.path);
    expect(paths).toContain("src/main.go");
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
  });

  it("refuses reads/writes that escape the root (no path traversal)", async () => {
    await expect(readTextFile(root, "../../etc/passwd")).rejects.toThrow(/escapes/);
    await expect(writeTextFile(root, "../evil", "x")).rejects.toThrow(/escapes/);
  });
});
