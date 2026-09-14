// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { AgentSessionDto, WorkspaceDto } from "@edd/api-contracts";

import { orderSessions, presentSession, shortCwd } from "../lib/agent-sessions";
import { TESTID } from "../lib/testids";

/**
 * The workspace's Claude/Codex sessions, as last reported by its idle-agent.
 * Rendered for a stopped workspace as readily as a running one — the list is
 * the control plane's copy, so it survives the volume being detached — and it
 * says so: the rows describe the last report, timestamped, not a live probe.
 */
export function AgentSessions({
  sessions,
  reportedAt,
  workspaceState,
  resume,
}: {
  sessions: readonly AgentSessionDto[] | undefined;
  reportedAt: string | undefined;
  workspaceState: WorkspaceDto["state"];
  /** Present when the workspace is stopped and can be woken from here. */
  resume: (() => void) | undefined;
}) {
  const reported = sessions !== undefined;
  const ordered = sessions === undefined ? [] : orderSessions(sessions, workspaceState);
  const waiting = ordered.filter((s) => presentSession(s, workspaceState) === "waiting").length;
  return (
    <section
      className="stack"
      style={{ gap: 8 }}
      data-testid={TESTID.workspaceSessions}
      data-reported={reported ? "1" : "0"}
      data-count={String(ordered.length)}
    >
      <h2>Agent sessions</h2>
      {!reported ? (
        <p className="state-note">
          no session report yet — the workspace lists its Claude and Codex sessions once it has
          booted and reported in
        </p>
      ) : ordered.length === 0 ? (
        <p className="state-note">no agent sessions{reportedAt === undefined ? "" : ` as of ${new Date(reportedAt).toLocaleString()}`}</p>
      ) : (
        <>
          <table className="mono" style={{ fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--dim)" }}>
                <th style={{ padding: "2px 8px 2px 0" }}>session</th>
                <th style={{ padding: "2px 8px" }}>command</th>
                <th style={{ padding: "2px 8px" }}>directory</th>
                <th style={{ padding: "2px 8px" }}>state</th>
                <th style={{ padding: "2px 0 2px 8px" }}>last seen</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((s) => {
                const shown = presentSession(s, workspaceState);
                return (
                  <tr
                    key={s.name}
                    data-testid={TESTID.workspaceSession}
                    data-name={s.name}
                    data-command={s.command}
                    data-live={s.live ? "1" : "0"}
                    data-status={shown}
                  >
                    <td style={{ padding: "2px 8px 2px 0" }}>{s.name}</td>
                    <td style={{ padding: "2px 8px" }}>{s.command}</td>
                    <td style={{ padding: "2px 8px" }} title={s.cwd}>
                      {shortCwd(s.cwd)}
                    </td>
                    <td style={{ padding: "2px 8px" }}>
                      <span
                        className="badge"
                        style={{
                          color:
                            shown === "running"
                              ? "var(--st-running, inherit)"
                              : shown === "ended"
                                ? "var(--dim)"
                                : undefined,
                        }}
                      >
                        {shown}
                      </span>
                    </td>
                    <td style={{ padding: "2px 0 2px 8px" }}>
                      {new Date(s.lastSeenAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="state-note" style={{ margin: 0 }}>
            {reportedAt === undefined ? "last report" : `reported ${new Date(reportedAt).toLocaleString()}`}
            {workspaceState === "stopped" && waiting > 0 && (
              <>
                {" "}
                — {waiting === 1 ? "one session is" : `${String(waiting)} sessions are`} waiting on
                the paused volume; resuming brings{" "}
                {waiting === 1 ? "it" : "them"} back with the resume command staged.
                {resume !== undefined && (
                  <>
                    {" "}
                    <button type="button" className="btn" onClick={resume}>
                      Resume workspace
                    </button>
                  </>
                )}
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}
