// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { respondTo, scriptFor } from "./agent-script";

describe("agent script", () => {
  it("opens a session that references the workspace's primary (non-doc) file", () => {
    const events = scriptFor("claude-code", ["README.md", "main.go", "go.mod"]);
    expect(events[0]?.kind).toBe("user");
    // It targets main.go (not the README), and ends with an assistant message.
    expect(events.some((e) => e.kind === "tool" && e.detail === "main.go")).toBe(true);
    expect(events.at(-1)?.kind).toBe("say");
  });

  it("falls back to the first file when there is no non-doc file", () => {
    const events = scriptFor("codex", ["README.md"]);
    expect(events.length).toBeGreaterThan(0);
  });

  it("responds to a typed prompt, echoing it as the user turn", () => {
    const out = respondTo("claude-code", "please fix the bug in the parser", ["main.go"]);
    expect(out[0]).toEqual({ kind: "user", text: "please fix the bug in the parser" });
    expect(out.some((e) => e.kind === "say")).toBe(true);
  });
});
