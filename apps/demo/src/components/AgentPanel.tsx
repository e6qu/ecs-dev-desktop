// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type JSX } from "react";

import { PROVIDER_LABEL, providerFor, setKey } from "../lib/agent-key";
import { runLive } from "../lib/agent-live";
import { respondTo, scriptFor, type AgentEvent } from "../lib/agent-script";
import { AGENT_LABELS, type AgentKind } from "../lib/demo-types";
import type { WorkspaceFiles } from "../lib/ide-files";
import { AgentChat } from "./AgentChat";
import { AgentTerminal } from "./AgentTerminal";

type Surface = "terminal" | "chat";

// The agent surface in the IDE: a Terminal + a Chat view of the SAME session. Scripted by default;
// an opt-in REAL mode runs an in-browser call against the visitor's own provider key.
export function AgentPanel({
  agent,
  files,
}: {
  agent: AgentKind;
  files: WorkspaceFiles;
}): JSX.Element {
  const fileNames = Object.keys(files);
  const provider = providerFor(agent);
  const [events, setEvents] = useState<AgentEvent[]>(() => scriptFor(agent, fileNames));
  const [revealed, setRevealed] = useState(1);
  const [surface, setSurface] = useState<Surface>("terminal");
  const [input, setInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [live, setLive] = useState(false);
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reveal scripted events one at a time for the "running" animation (live replies append whole).
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
  }, [revealed, pending]);

  const visible = events.slice(0, revealed);
  const running = revealed < events.length || pending;

  const send = (prompt: string): void => {
    if (!live) {
      setEvents((ev) => [...ev, ...respondTo(agent, prompt, fileNames)]);
      return;
    }
    setEvents((ev) => [...ev, { kind: "user", text: prompt }]);
    setRevealed((r) => r + 1);
    setPending(true);
    void runLive(agent, prompt, files)
      .then((reply) => {
        setEvents((ev) => [...ev, ...reply]);
        setRevealed((r) => r + reply.length);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setEvents((ev) => [...ev, { kind: "error", text: msg }]);
        setRevealed((r) => r + 1);
        // Don't leave the user stuck in a quietly-broken live mode — fall back to scripted.
        setLive(false);
      })
      .finally(() => {
        setPending(false);
      });
  };

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
          <span className="agent-name">
            {AGENT_LABELS[agent]}
            {live ? (
              <span className="agent-live-dot" title="Real mode (your key)">
                {" "}
                ● live
              </span>
            ) : (
              <span className="agent-scripted"> · scripted</span>
            )}
          </span>
          <button
            type="button"
            className="agent-key-btn"
            onClick={() => {
              setShowKey((s) => !s);
            }}
          >
            🔑 {live ? "Key set" : "Use my own key"}
          </button>
        </div>
      </div>

      {showKey ? (
        <div className="agent-key-note">
          <p>
            Run the agent for real against your own <strong>{PROVIDER_LABEL[provider]}</strong> key.
            It is kept only in this tab’s sessionStorage and sent only to {PROVIDER_LABEL[provider]}{" "}
            directly.
            {provider === "openai"
              ? " (OpenAI usually blocks direct browser calls, so Codex live may fail — Claude Code works.)"
              : ""}
          </p>
          <div className="agent-key-row">
            <input
              type="password"
              value={keyDraft}
              placeholder={`${PROVIDER_LABEL[provider]} API key`}
              onChange={(e) => {
                setKeyDraft(e.target.value);
              }}
              aria-label="API key"
            />
            <button
              type="button"
              className="demo-primary"
              onClick={() => {
                if (keyDraft.trim() === "") return;
                setKey(provider, keyDraft.trim());
                setKeyDraft("");
                setLive(true);
                setShowKey(false);
              }}
            >
              Enable real mode
            </button>
            {live ? (
              <button
                type="button"
                className="demo-ghost"
                onClick={() => {
                  setLive(false);
                }}
              >
                Back to scripted
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="agent-scroll" ref={scrollRef} role="log" aria-live="polite">
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
          if (prompt === "" || pending) return;
          setInput("");
          send(prompt);
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
        <button type="submit" className="demo-primary" disabled={pending}>
          Send
        </button>
      </form>
    </div>
  );
}
