// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildLiveRequest, parseLiveResponse } from "./agent-live";

const FILES = { "main.go": "package main\nfunc main(){}\n" };

describe("buildLiveRequest", () => {
  it("targets Anthropic with the browser-direct header for Claude Code", () => {
    const req = buildLiveRequest("claude-code", "sk-ant-test", "hi", FILES);
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant-test");
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(req.body).toContain("main.go"); // file context included
  });

  it("targets OpenAI with bearer auth for Codex", () => {
    const req = buildLiveRequest("codex", "sk-openai-test", "hi", FILES);
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-openai-test");
  });
});

describe("parseLiveResponse", () => {
  it("extracts text from an Anthropic messages response", () => {
    const json = {
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    expect(parseLiveResponse("claude-code", json)).toBe("hello world");
  });

  it("extracts text from an OpenAI chat-completions response", () => {
    const json = { choices: [{ message: { content: "  hi there  " } }] };
    expect(parseLiveResponse("codex", json)).toBe("hi there");
  });

  it("throws (fails loud) on a malformed response", () => {
    expect(() => parseLiveResponse("claude-code", { nope: true })).toThrow();
  });
});
