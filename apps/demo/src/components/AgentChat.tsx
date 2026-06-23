// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import type { AgentEvent } from "../lib/agent-script";
import { AGENT_LABELS, type AgentKind } from "../lib/demo-types";

// Renders the SAME agent session as a chat panel (messages + tool-call cards) — the webview-style
// surface, alongside the terminal.
export function AgentChat({
  agent,
  events,
  running,
}: {
  agent: AgentKind;
  events: readonly AgentEvent[];
  running: boolean;
}): JSX.Element {
  return (
    <div className="agent-chat">
      {events.map((e, i) => {
        if (e.kind === "user") {
          return (
            <div key={i} className="agent-msg agent-msg-user">
              {e.text}
            </div>
          );
        }
        if (e.kind === "think") {
          return (
            <div key={i} className="agent-think-bubble">
              {e.text}
            </div>
          );
        }
        if (e.kind === "tool") {
          return (
            <div key={i} className="agent-tool-card">
              <span className="agent-tool-name">{e.name}</span>
              <code>{e.detail}</code>
              {e.result !== undefined ? <div className="agent-tool-result">{e.result}</div> : null}
            </div>
          );
        }
        return (
          <div key={i} className="agent-msg agent-msg-assistant">
            <span className="agent-msg-who">{AGENT_LABELS[agent]}</span>
            {e.text}
          </div>
        );
      })}
      {running ? <div className="agent-typing">{AGENT_LABELS[agent]} is working…</div> : null}
    </div>
  );
}
