// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure unit test of the file seeder. The IndexedDB persistence layer around it (load/save/clear +
// the version gate) is integration-tested in a REAL browser by the Playwright smoke (e2e/), where
// IndexedDB actually exists — the source of truth for the demo's storage.
import { describe, expect, it } from "vitest";

import { seedFilesFor } from "./ide-files";

describe("seedFilesFor", () => {
  it("picks language-appropriate starter files by base-image family", () => {
    expect(seedFilesFor("golden/go")["main.go"]).toBeDefined();
    expect(seedFilesFor("golden/omnibus")["main.go"]).toBeDefined();
    expect(seedFilesFor("golden/python")["main.py"]).toBeDefined();
    expect(seedFilesFor("golden/rust")["main.rs"]).toBeDefined();
    expect(seedFilesFor("golden/typescript")["index.ts"]).toBeDefined();
  });

  it("always includes a README referencing the base image", () => {
    const files = seedFilesFor("golden/python");
    expect(files["README.md"]).toContain("golden/python");
  });
});
