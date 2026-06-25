// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-workspace IDE files live in IndexedDB, NOT localStorage: the editor filesystem is the bulky,
// growable part of the demo, so it belongs in IndexedDB's larger quota — localStorage is reserved
// for the compact control-plane state (the "use storage wisely" mandate). The store is keyed by
// workspace id (one record = one workspace's files). A schema change is handled by bumping
// DB_VERSION, whose `onupgradeneeded` drops the old store (discards stale data) — the IndexedDB-
// native equivalent of the control-plane STATE_VERSION gate. The reset widget clears it.
const DB_NAME = "edd-demo";
const DB_VERSION = 1;
const STORE = "ide-files";

export type WorkspaceFiles = Record<string, string>;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // On a version bump, drop the old store + recreate — stale-shaped data is discarded, never
      // read by newer code (the IndexedDB-native version gate).
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB open failed"));
    };
  });
}

// One connection for the page lifetime (the standard IndexedDB pattern) — reused across ops,
// reopened only on a fresh page load (where a DB_VERSION bump would re-run the upgrade).
let connection: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  connection ??= openDb();
  return connection;
}

/** Run one request inside a transaction and resolve its result. */
async function run<T>(
  mode: IDBTransactionMode,
  make: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const conn = await db();
  return new Promise<T>((resolve, reject) => {
    const req = make(conn.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB request failed"));
    };
  });
}

/** A stored record is a Record<string,string> we wrote ourselves; validate the shape defensively. */
function asFiles(value: unknown): WorkspaceFiles | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: WorkspaceFiles = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return undefined;
    out[k] = v;
  }
  return out;
}

/** Default files for a fresh workspace, picked from its base-image family (best-effort). Exported
 * for unit testing (pure); the IndexedDB persistence around it is covered by the browser smoke. */
export function seedFilesFor(image: string): WorkspaceFiles {
  const readme = `# Workspace\n\nThis is an in-browser demo IDE. Edits persist locally and are wiped on reset.\n\nBase image: \`${image}\`\n`;
  // Match the EXACT language segment (the part after "golden/", minus any ":tag"), not a substring:
  // `includes("go")` wrongly matched "golden" (no slash), "django", "mongo", etc. as Go.
  const lang = (image.split("/").pop() ?? "").split(":")[0] ?? "";
  if (lang === "python") {
    return {
      "main.py":
        'def main():\n    print("hello from edd")\n\n\nif __name__ == "__main__":\n    main()\n',
      "README.md": readme,
    };
  }
  if (lang === "go" || lang === "omnibus") {
    return {
      "main.go":
        'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from edd")\n}\n',
      "go.mod": "module edd/demo\n\ngo 1.23\n",
      "README.md": readme,
    };
  }
  if (lang === "rust") {
    return { "main.rs": 'fn main() {\n    println!("hello from edd");\n}\n', "README.md": readme };
  }
  return {
    "index.ts": 'export function main(): void {\n  console.log("hello from edd");\n}\n\nmain();\n',
    "README.md": readme,
  };
}

/** Files for a workspace, seeding defaults (from its image) on first open + persisting them. */
export async function loadFiles(workspaceId: string, image: string): Promise<WorkspaceFiles> {
  const stored = asFiles(await run("readonly", (s) => s.get(workspaceId)));
  if (stored !== undefined) return stored;
  const seeded = seedFilesFor(image);
  await run("readwrite", (s) => s.put(seeded, workspaceId));
  return seeded;
}

/** Persist a single file's contents (read-modify-write the workspace's record). */
export async function saveFile(workspaceId: string, path: string, content: string): Promise<void> {
  const current = asFiles(await run("readonly", (s) => s.get(workspaceId))) ?? {};
  await run("readwrite", (s) => s.put({ ...current, [path]: content }, workspaceId));
}

/** Drop all IDE files (called by the reset widget alongside the control-plane wipe). */
export async function clearAllFiles(): Promise<void> {
  await run("readwrite", (s) => s.clear());
}
