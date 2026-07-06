// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import "@xterm/xterm/css/xterm.css";

import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { TESTID } from "../lib/testids";

/** Close codes from the relay (mirrors lib/spectate-relay.ts). */
const NO_PUBLISHER_CODE = 4404;
const SHARING_ENDED_CODE = 4410;

/** Retry budget while hunting for the replica that holds the publisher, or
 * waiting for the owner's editor tab to come online after sharing was enabled. */
const MAX_RETRIES = 40;
const RETRY_MS = 1500;

type Phase = "connecting" | "live" | "ended" | "unavailable";

interface CursorState {
  line: number;
  col: number;
  sel: { sl: number; sc: number; el: number; ec: number } | null;
}

/**
 * Read-only live view of the owner's editor session, rendered from the mirror
 * stream (never a connection to the workspace). The entire view sits under a
 * full-viewport interaction-blocking overlay (recorded product decision): every
 * pointer/keyboard event is swallowed, so spectating can't even toggle local UI
 * state — the security boundary itself is the absent write path.
 */
export function SpectateViewer({ id, owner }: { id: string; owner: string }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [cursor, setCursor] = useState<CursorState>({ line: 1, col: 1, sel: null });
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [focused, setFocused] = useState(true);
  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    // Write-only mirror terminal: no stdin is ever attached.
    const term = new Terminal({
      fontSize: 13,
      disableStdin: true,
      cursorBlink: false,
      theme: { background: "#1e1e1e" },
    });
    if (termHost.current !== null) term.open(termHost.current);
    termRef.current = term;

    let attempts = 0;
    let closed = false;
    let sock: WebSocket | null = null;

    const connect = (): void => {
      if (closed) return;
      const url = new URL(`/api/spectate/${id}/subscribe`, window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      sock = new WebSocket(url);
      sock.addEventListener("open", () => {
        setPhase("live");
      });
      sock.addEventListener("message", (e: MessageEvent) => {
        if (typeof e.data !== "string") return;
        let frame: unknown;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return;
        }
        const f = frame as Record<string, unknown>;
        switch (f.t) {
          case "file":
            setFilePath(typeof f.path === "string" ? f.path : null);
            setContent(typeof f.content === "string" ? f.content : "");
            break;
          case "cursor":
            setCursor({
              line: typeof f.line === "number" ? f.line : 1,
              col: typeof f.col === "number" ? f.col : 1,
              sel: (f.sel ?? null) as CursorState["sel"],
            });
            break;
          case "mouse":
            if (typeof f.x === "number" && typeof f.y === "number") setMouse({ x: f.x, y: f.y });
            break;
          case "focus":
            setFocused(f.focused === true && f.visible === true);
            break;
          case "term":
            if (typeof f.data === "string") termRef.current?.write(f.data);
            break;
          default:
            break; // unknown frame types are ignored (forward-compatible)
        }
      });
      sock.addEventListener("close", (e: CloseEvent) => {
        if (closed) return;
        if (e.code === SHARING_ENDED_CODE) {
          setPhase("ended");
          return;
        }
        // NO_PUBLISHER: retry — a fresh connection may land on the replica
        // holding the owner's stream (v1 per-replica relay), or the owner's
        // tab may simply not be open yet. Anything else: transient, same retry.
        attempts += 1;
        if (e.code === NO_PUBLISHER_CODE ? attempts <= MAX_RETRIES : attempts <= 5) {
          setPhase("connecting");
          window.setTimeout(connect, RETRY_MS);
        } else {
          setPhase("unavailable");
        }
      });
    };
    connect();

    return () => {
      closed = true;
      sock?.close();
      term.dispose();
    };
  }, [id]);

  const lines = content.split("\n");
  return (
    <div style={{ position: "relative" }} data-testid={TESTID.spectateViewer} data-phase={phase}>
      {/* Persistent read-only banner */}
      <div
        className="notice"
        role="status"
        style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}
      >
        <span>
          Viewing <strong className="mono">{owner}</strong>&apos;s session — read-only
          {focused ? "" : " · owner's window unfocused"}
        </span>
        <span className="mono" style={{ color: "var(--dim)" }}>
          {phase === "live" ? "● live" : phase}
        </span>
      </div>

      {phase === "ended" && (
        <div className="notice" role="alert">
          Sharing ended — the owner stopped sharing or closed their editor.
        </div>
      )}
      {phase === "unavailable" && (
        <div className="notice" role="alert">
          No live mirror right now. The owner has sharing enabled, but their editor tab isn&apos;t
          publishing (or uses OpenVSCode, which doesn&apos;t support mirroring yet).
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        <section>
          <div className="mono" style={{ color: "var(--dim)", fontSize: 12, marginBottom: 4 }}>
            {filePath ?? "no file open"} · cursor {cursor.line}:{cursor.col}
          </div>
          <pre
            className="mono"
            style={{
              maxHeight: "40vh",
              overflow: "auto",
              background: "#1e1e1e",
              color: "#d4d4d4",
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              lineHeight: "18px",
              margin: 0,
            }}
          >
            {lines.map((ln, i) => (
              <div
                key={i}
                style={i + 1 === cursor.line ? { background: "rgba(120,160,255,0.18)" } : undefined}
              >
                {ln === "" ? " " : ln}
              </div>
            ))}
          </pre>
        </section>
        <section>
          <div className="mono" style={{ color: "var(--dim)", fontSize: 12, marginBottom: 4 }}>
            terminal (mirrors from when sharing started — no scrollback backfill)
          </div>
          <div ref={termHost} style={{ background: "#1e1e1e", borderRadius: 6, padding: 4 }} />
        </section>
      </div>

      {/* Owner's mouse position, normalized to our render area */}
      {mouse !== null && phase === "live" && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${String(mouse.x * 100)}%`,
            top: `${String(mouse.y * 100)}%`,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "var(--accent, #9fef00)",
            boxShadow: "0 0 6px var(--accent, #9fef00)",
            pointerEvents: "none",
            zIndex: 41,
            transition: "left 60ms linear, top 60ms linear",
          }}
        />
      )}

      {/* Full interaction-blocking shield (recorded decision): swallows every
          pointer event over the mirrored render. Keyboard never reaches the
          mirror since nothing under it is focusable through the shield. */}
      <div
        aria-hidden="true"
        data-testid={TESTID.spectateShield}
        style={{ position: "absolute", inset: 0, zIndex: 40, cursor: "not-allowed" }}
      />
    </div>
  );
}
