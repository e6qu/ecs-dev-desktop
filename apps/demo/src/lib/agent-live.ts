// SPDX-License-Identifier: AGPL-3.0-or-later
// The opt-in REAL agent mode: a minimal in-browser call to the visitor's own provider, returning
// the same AgentEvent shape the scripted mode uses. Claude Code → Anthropic's browser-direct
// Messages API (CORS-allowed via the dangerous-direct header). Codex → OpenAI Chat Completions
// (OpenAI generally BLOCKS browser CORS, so this often fails — surfaced clearly, not hidden).
import { z } from "zod";

import type { AgentEvent } from "./agent-script";
import { getKey, PROVIDER_LABEL, providerFor } from "./agent-key";
import type { AgentKind } from "./demo-types";

// Current default models (these drift — surfaced via API errors if stale, and configurable later).
const MODEL = { anthropic: "claude-sonnet-4-6", openai: "gpt-4o" } as const;
const MAX_TOKENS = 1024;

export interface LiveRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function systemPrompt(agent: AgentKind, files: Record<string, string>): string {
  const ctx = Object.entries(files)
    .map(([p, c]) => `// ${p}\n${c}`)
    .join("\n\n");
  const who = agent === "claude-code" ? "Claude Code" : "Codex";
  return `You are ${who}, a concise AI coding agent working in one workspace. Answer briefly and concretely. Current files:\n\n${ctx}`;
}

/** Pure: build the provider request for a prompt (testable without the network). */
export function buildLiveRequest(
  agent: AgentKind,
  key: string,
  prompt: string,
  files: Record<string, string>,
): LiveRequest {
  const system = systemPrompt(agent, files);
  if (providerFor(agent) === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL.anthropic,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    };
  }
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL.openai,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  };
}

const anthropicResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const openaiResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

/** Pure: extract the assistant text from a provider response (testable). */
export function parseLiveResponse(agent: AgentKind, json: unknown): string {
  if (providerFor(agent) === "anthropic") {
    const parsed = anthropicResponse.parse(json);
    return parsed.content
      .map((c) => c.text ?? "")
      .join("")
      .trim();
  }
  const parsed = openaiResponse.parse(json);
  return parsed.choices[0]?.message.content.trim() ?? "";
}

/** Run a real turn: call the provider and return the agent's reply event(s) (the caller adds the
 * user turn). Throws on a missing key or an API error — surfaced in the panel. */
export async function runLive(
  agent: AgentKind,
  prompt: string,
  files: Record<string, string>,
): Promise<AgentEvent[]> {
  const provider = providerFor(agent);
  const key = getKey(provider);
  if (key === null || key === "") {
    throw new Error(`Add your ${PROVIDER_LABEL[provider]} API key to run ${agent} live.`);
  }
  const req = buildLiveRequest(agent, key, prompt, files);
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${PROVIDER_LABEL[provider]} API ${String(res.status)}: ${detail.slice(0, 200)}`,
    );
  }
  const text = parseLiveResponse(agent, await res.json());
  return [{ kind: "say", text: text === "" ? "(empty response)" : text }];
}
