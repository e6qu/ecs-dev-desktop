// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { WorkspaceDto, WorkspaceLogsDto } from "@edd/api-contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";

import { TESTID } from "../lib/testids";
import { usePoll } from "../lib/usePoll";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceActions } from "./WorkspaceActions";

const api = new ApiClient({ baseUrl: "" });
const STATUS_POLL_MS = 3000;
const LOGS_POLL_MS = 8000;

/**
 * Live per-workspace status view (/workspaces/[id]): what a user lands on right
 * after starting a session. Polls the workspace itself plus its container log
 * slice, and keys "ready" off the agent's `functional` self-report — NOT `state`:
 * a fresh workspace's DB state is `running` the moment ECS accepts the task,
 * while the container may still be pulling/booting for a minute or two. The
 * first heartbeat's functional=ok is the real "your desktop is usable" signal.
 */
export function WorkspaceLive({ id }: { id: string }) {
  const loadWs = useCallback(() => api.getWorkspace(id), [id]);
  const loadLogs = useCallback(() => api.getWorkspaceLogs(id), [id]);
  const { data: ws, error } = usePoll<WorkspaceDto>(loadWs, STATUS_POLL_MS, "workspace not found");
  const { data: logs } = usePoll<WorkspaceLogsDto>(loadLogs, LOGS_POLL_MS, "logs unavailable");

  // Follow the log tail as new lines arrive (unless the panel isn't rendered).
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const lineCount = logs?.lines.length ?? 0;
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [lineCount]);

  if (ws === null) {
    return error !== null ? (
      <div className="notice" role="alert">
        could not load this workspace: {error}
      </div>
    ) : (
      <p className="state-note" role="status">
        loading workspace…
      </p>
    );
  }

  const ready = ws.state === "running" && ws.functional === "ok";
  const booting = ws.state === "running" && ws.functional === undefined;
  const phase = ready
    ? "Your dev desktop is ready."
    : booting
      ? "Starting your dev desktop — pulling the image and booting the editor (this can take a minute or two on first start)…"
      : ws.state === "provisioning"
        ? "Waking your dev desktop from its snapshot…"
        : ws.functional === "degraded"
          ? "Running, but degraded — see the log below for what the agent reported."
          : ws.state === "stopped"
            ? "Paused (snapshotted) — start it to pick up where you left off."
            : `Workspace is ${ws.state}.`;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section
        className="stack"
        style={{ gap: 12 }}
        data-testid={TESTID.workspaceStatusHero}
        data-status={ws.state}
        data-ready={ready ? "1" : "0"}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <StatusBadge state={ws.state} />
          {ws.functional === "degraded" && (
            <span className="badge" data-testid={TESTID.workspaceDegraded}>
              degraded
            </span>
          )}
          <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
            {ws.imageName ?? ws.baseImage}
          </span>
        </div>
        <p style={{ fontSize: 16 }} role="status">
          {phase}
        </p>
        {(booting || ws.state === "provisioning") && (
          <p className="mono" style={{ color: "var(--dim)", fontSize: 12 }} aria-busy="true">
            this page updates automatically — no need to reload
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {ready && (
            <a
              className="btn primary"
              href={`/w/${ws.id}/`}
              data-testid={TESTID.workspaceOpen}
              data-href={`/w/${ws.id}/`}
            >
              Open editor
            </a>
          )}
          <WorkspaceActions id={ws.id} actions={ws.availableActions} />
          <Link href="/workspaces" className="btn">
            all workspaces
          </Link>
        </div>
        {ws.sshCommand !== undefined && (
          <code className="mono" data-testid={TESTID.workspaceSshCommand} data-host={ws.id}>
            {ws.sshCommand}
          </code>
        )}
        {ws.repoUrl !== undefined && (
          <p className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
            repository: {ws.repoUrl}
          </p>
        )}
      </section>

      <section>
        <h2>Boot &amp; runtime log</h2>
        <div
          className="mono"
          data-testid={TESTID.workspaceBootLog}
          data-available={String(logs?.available ?? false)}
          style={{
            maxHeight: 320,
            overflowY: "auto",
            fontSize: 12,
            border: "1px solid var(--line, #333)",
            borderRadius: 6,
            padding: "8px 10px",
          }}
        >
          {logs === null ? (
            <p className="state-note">loading logs…</p>
          ) : !logs.available ? (
            <p className="state-note">{logs.note}</p>
          ) : logs.lines.length === 0 ? (
            <p className="state-note">no log lines yet — the task is still coming up</p>
          ) : (
            logs.lines.map((l, i) => (
              <div key={`${l.at}-${String(i)}`} data-level={l.level}>
                <span style={{ color: "var(--dim)" }}>{new Date(l.at).toLocaleTimeString()} </span>
                <span style={{ color: l.level === "error" ? "var(--st-error)" : undefined }}>
                  {l.message}
                </span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}
