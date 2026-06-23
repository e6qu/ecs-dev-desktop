// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type JSX } from "react";

import { respondTo, scriptFor, type AgentEvent } from "../lib/agent-script";
import { AGENT_LABELS, type AgentKind } from "../lib/demo-types";
import { AgentChat } from "./AgentChat";
import { AgentTerminal } from "./AgentTerminal";

type Surface = "terminal" | "chat";

// The agent surface in the IDE: a Terminal and a Chat view of the SAME session, with a prompt
// input. Scripted by default (no backend); the opt-in real BYO-key mode is the next slice.
export function AgentPanel({
  agent,
  fileNames,
}: {
  agent: AgentKind;
  fileNames: readonly string[];
}): JSX.Element {
  const [events, setEvents] = useState<AgentEvent[]>(() => scriptFor(agent, fileNames));
  const [revealed, setRevealed] = useState(1);
  const [surface, setSurface] = useState<Surface>("terminal");
  const [input, setInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reveal one event at a time for the "running" animation.
  useEffect(() => {
    if (revealed >= events.length) return;
    const t = window.setTimeout(() => {
      setRevealed((r) => r + 1);
    }, 750);
    return () => {
      window.clearTimeout(t);
    };
  }, [revealed, events.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [revealed]);

  const visible = events.slice(0, revealed);
  const running = revealed < events.length;

  return (
    <div className="agent-panel">
      <div className="agent-panel-head">
        <div className="agent-tabs">
          <button
            type="button"
            className={surface === "terminal" ? "agent-tab active" : "agent-tab"}
            onClick={() => {
              setSurface("terminal");
            }}
          >
            Terminal
          </button>
          <button
            type="button"
            className={surface === "chat" ? "agent-tab active" : "agent-tab"}
            onClick={() => {
              setSurface("chat");
            }}
          >
            Chat
          </button>
        </div>
        <div className="agent-panel-meta">
          <span className="agent-name">{AGENT_LABELS[agent]}</span>
          <button
            type="button"
            className="agent-key-btn"
            onClick={() => {
              setShowKey((s) => !s);
            }}
          >
            🔑 Use my own key
          </button>
        </div>
      </div>

      {showKey ? (
        <div className="agent-key-note">
          Real mode runs an in-browser agent loop against your Anthropic/OpenAI key (no key leaves
          your machine). It lands in the next slice — for now this is a scripted session.
        </div>
      ) : null}

      <div className="agent-scroll" ref={scrollRef}>
        {surface === "terminal" ? (
          <AgentTerminal agent={agent} events={visible} running={running} />
        ) : (
          <AgentChat agent={agent} events={visible} running={running} />
        )}
      </div>

      <form
        className="agent-input"
        onSubmit={(e) => {
          e.preventDefault();
          const prompt = input.trim();
          if (prompt === "") return;
          setEvents((ev) => [...ev, ...respondTo(agent, prompt, fileNames)]);
          setInput("");
        }}
      >
        <span className="agent-input-prompt">❯</span>
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
          }}
          placeholder={`Ask ${AGENT_LABELS[agent]} to change the code…`}
          aria-label="Agent prompt"
        />
        <button type="submit" className="demo-primary">
          Send
        </button>
      </form>
    </div>
  );
}
