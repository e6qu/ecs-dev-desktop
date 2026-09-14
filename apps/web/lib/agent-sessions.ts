// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AgentSessionDto, WorkspaceDto } from "@edd/api-contracts";

/**
 * What a session row on the status page says about a session, derived from the
 * registry entry the workspace last reported and the workspace's own state.
 *
 * The registry is a snapshot from the last heartbeat. While the workspace runs,
 * `live` is current to within a heartbeat. Once the workspace has stopped, no
 * tmux session exists anywhere — the report is what WAS running, and every row
 * becomes "waiting": its transcript is on the volume and the resume command is
 * staged for the next boot. Saying "running" about a session inside a stopped
 * workspace would be a lie the user would act on.
 */
export type SessionPresentation = "running" | "waiting" | "ended";

export function presentSession(
  session: AgentSessionDto,
  workspaceState: WorkspaceDto["state"],
): SessionPresentation {
  if (workspaceState !== "running") return session.resumeCommand === null ? "ended" : "waiting";
  if (session.live) return "running";
  return session.resumeCommand === null ? "ended" : "waiting";
}

/** The last path segment is what a user recognises a project by; the full path
 * stays in the title attribute. */
export function shortCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed === "") return cwd;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Sessions worth acting on first: running, then waiting, then ended; most
 * recently seen first within each group. */
export function orderSessions(
  sessions: readonly AgentSessionDto[],
  workspaceState: WorkspaceDto["state"],
): AgentSessionDto[] {
  const rank: Record<SessionPresentation, number> = { running: 0, waiting: 1, ended: 2 };
  return [...sessions].sort((a, b) => {
    const byState = rank[presentSession(a, workspaceState)] - rank[presentSession(b, workspaceState)];
    if (byState !== 0) return byState;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}
