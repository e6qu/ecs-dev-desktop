// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { respondTo, scriptFor } from "./agent-script";
import { seedFilesFor } from "./ide-files";

const agentArb = fc.constantFrom("claude-code" as const, "codex" as const);

describe("seedFilesFor (fuzz)", () => {
  it("is total: any image -> a non-empty record whose README embeds the image", () => {
    fc.assert(
      fc.property(fc.string(), (image) => {
        const files = seedFilesFor(image);
        expect(Object.keys(files).length).toBeGreaterThan(0);
        expect(files["README.md"] ?? "").toContain(image);
        for (const v of Object.values(files)) expect(typeof v).toBe("string");
      }),
    );
  });

  it("matches the EXACT language segment — no 'go' substring collision", () => {
    expect("main.go" in seedFilesFor("golden/go")).toBe(true);
    expect("main.go" in seedFilesFor("golden/omnibus")).toBe(true);
    // Regression: these contain "go" but must NOT seed Go files.
    expect("main.go" in seedFilesFor("golden/django")).toBe(false);
    expect("main.go" in seedFilesFor("golden/mongo")).toBe(false);
    expect("main.go" in seedFilesFor("golden")).toBe(false);
    expect("main.py" in seedFilesFor("golden/python")).toBe(true);
    expect("index.ts" in seedFilesFor("golden/typescript")).toBe(true);
  });
});

describe("agent-script (fuzz)", () => {
  it("respondTo: non-empty, first event echoes the prompt verbatim", () => {
    fc.assert(
      fc.property(agentArb, fc.string(), fc.array(fc.string()), (agent, prompt, files) => {
        const out = respondTo(agent, prompt, files);
        expect(out.length).toBeGreaterThan(0);
        expect(out[0]).toEqual({ kind: "user", text: prompt });
      }),
    );
  });

  it("scriptFor: non-empty for any file list (incl. empty / all-.md), ends with a reply", () => {
    fc.assert(
      fc.property(agentArb, fc.array(fc.string()), (agent, files) => {
        const out = scriptFor(agent, files);
        expect(out.length).toBeGreaterThan(0);
        expect(out[out.length - 1]?.kind).toBe("say");
      }),
    );
  });
});
