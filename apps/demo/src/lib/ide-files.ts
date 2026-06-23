// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-workspace IDE files. Kept in a SEPARATE, small localStorage namespace from the control-
// plane state (a few tiny text files per workspace). When the full vscode-web workbench lands
// behind the <DemoEditor> seam it will move to IndexedDB (larger quota for a real FS); the reset
// widget clears whichever store is in use. Cleared together with everything else on reset.
const FILES_KEY = "edd-demo:ide-files:v1";

export type WorkspaceFiles = Record<string, string>;
type FileStore = Record<string, WorkspaceFiles>;

function readStore(): FileStore {
  const raw = localStorage.getItem(FILES_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as FileStore) : {};
  } catch {
    return {};
  }
}

function writeStore(store: FileStore): void {
  localStorage.setItem(FILES_KEY, JSON.stringify(store));
}

/** Default files for a fresh workspace, picked from its base-image family (best-effort). */
function seedFilesFor(image: string): WorkspaceFiles {
  const readme = `# Workspace\n\nThis is an in-browser demo IDE. Edits persist locally and are wiped on reset.\n\nBase image: \`${image}\`\n`;
  if (image.includes("python")) {
    return {
      "main.py":
        'def main():\n    print("hello from edd")\n\n\nif __name__ == "__main__":\n    main()\n',
      "README.md": readme,
    };
  }
  if (image.includes("go") || image.includes("omnibus")) {
    return {
      "main.go":
        'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from edd")\n}\n',
      "go.mod": "module edd/demo\n\ngo 1.23\n",
      "README.md": readme,
    };
  }
  if (image.includes("rust")) {
    return { "main.rs": 'fn main() {\n    println!("hello from edd");\n}\n', "README.md": readme };
  }
  return {
    "index.ts": 'export function main(): void {\n  console.log("hello from edd");\n}\n\nmain();\n',
    "README.md": readme,
  };
}

/** Files for a workspace, seeding defaults (from its image) on first open. */
export function filesFor(workspaceId: string, image: string): WorkspaceFiles {
  const store = readStore();
  const existing = store[workspaceId];
  if (existing !== undefined) return existing;
  const seeded = seedFilesFor(image);
  store[workspaceId] = seeded;
  writeStore(store);
  return seeded;
}

/** Persist a single file's contents. */
export function saveFile(workspaceId: string, path: string, content: string): void {
  const store = readStore();
  const ws = store[workspaceId] ?? {};
  ws[path] = content;
  store[workspaceId] = ws;
  writeStore(store);
}

/** Drop all IDE files (called by the reset widget alongside the control-plane wipe). */
export function clearFiles(): void {
  localStorage.removeItem(FILES_KEY);
}
