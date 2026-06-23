// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import type { AgentEvent } from "../lib/agent-script";
import { AGENT_LABELS, type AgentKind } from "../lib/demo-types";

// Renders the scripted/real agent session as a terminal (the iconic CLI experience).
export function AgentTerminal({
  agent,
  events,
  running,
}: {
  agent: AgentKind;
  events: readonly AgentEvent[];
  running: boolean;
}): JSX.Element {
  const prompt = agent === "claude-code" ? "claude" : "codex";
  return (
    <div className="agent-term">
      <div className="agent-term-banner">
        {AGENT_LABELS[agent]} · workspace shell — type a task below
      </div>
      {events.map((e, i) => (
        <div key={i} className="agent-term-line">
          {e.kind === "user" ? (
            <span>
              <span className="agent-term-prompt">{prompt} ❯</span> {e.text}
            </span>
          ) : e.kind === "think" ? (
            <span className="agent-term-think">· {e.text}</span>
          ) : e.kind === "tool" ? (
            <span>
              <span className="agent-term-tool">⏺ {e.name}</span>(
              <span className="agent-term-arg">{e.detail}</span>)
              {e.result !== undefined ? (
                <div className="agent-term-result">⎿ {e.result}</div>
              ) : null}
            </span>
          ) : (
            <span className="agent-term-say">{e.text}</span>
          )}
        </div>
      ))}
      {running ? <span className="agent-cursor">▋</span> : null}
    </div>
  );
}
